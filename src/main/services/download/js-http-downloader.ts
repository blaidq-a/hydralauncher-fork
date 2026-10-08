import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import https from "node:https";
import { Readable, Transform, Writable, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import axios, { type AxiosResponse } from "axios";
import { logger } from "../logger.js";
import {
  areDownloadByteRangesComplete,
  areDownloadByteRangesContiguous,
  applySkip,
  clampProgress,
  computeFileSize,
  createDownloadByteRanges,
  createPositionalWriteStream,
  isDownloadCompleteOnDisk,
  isRetryableDownloadError,
  isRetryableHttpStatus,
  MAX_BUDGET_RESETS,
  MAX_RESTARTS_FROM_ZERO,
  MAX_SEGMENT_RANGE_BYTES,
  MAX_SEGMENTED_DOWNLOAD_CONNECTIONS,
  MIN_DYNAMIC_SPLIT_RANGE_BYTES,
  MIN_SEGMENTED_DOWNLOAD_SIZE,
  parseRetryAfterMs,
  PROGRESS_RESET_THRESHOLD_BYTES,
  resolveResumeAction,
  SEGMENTED_DOWNLOAD_CONNECTIONS,
  shouldResetRetryBudget,
  splitDownloadByteRange,
  stallDetected,
} from "./js-http-downloader-helpers.js";

export interface JsHttpDownloaderStatus {
  folderName: string;
  fileSize: number;
  progress: number;
  downloadSpeed: number;
  numPeers: number;
  numSeeds: number;
  status: "active" | "paused" | "complete" | "error";
  bytesDownloaded: number;
  isReconnecting: boolean;
  isRecovering: boolean;
  recoveryProgress: number;
  isSegmented?: boolean;
  isMerging?: boolean;
}

export interface JsHttpDownloaderOptions {
  url: string;
  savePath: string;
  filename?: string;
  headers?: Record<string, string>;
  maxConnections?: number;
}

const MAX_RETRY_ATTEMPTS = 10;
const MAX_STATUS_RETRY_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 20000;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 15000;
const STALL_TIMEOUT_MS = 30000;
const STALL_CHECK_INTERVAL_MS = 2000;
const RECONNECT_RETRY_DELAY_MS = 500;
const RANGE_PROBE_TIMEOUT_MS = 15000;
const DOWNLOAD_BUFFER_SIZE = 512 * 1024; // Reduced from 1MB to 512KB for lower memory footprint
const SEGMENT_STALL_TIMEOUT_MS = 25000;
const SEGMENT_CHECKPOINT_INTERVAL_MS = 5000;
const SEGMENT_RETRY_LIMIT = 8;
const SEGMENT_RETRY_BACKOFF_MS = 500;

class DownloadHttpAgent extends http.Agent {
  constructor() {
    super({
      keepAlive: true,
      maxSockets: MAX_SEGMENTED_DOWNLOAD_CONNECTIONS,
      maxFreeSockets: MAX_SEGMENTED_DOWNLOAD_CONNECTIONS,
    });
  }

  override createConnection(
    options: http.ClientRequestArgs,
    callback?: (error: Error | null, socket: Duplex) => void
  ): Duplex | null | undefined {
    const bufferedOptions = Object.assign({}, options, {
      highWaterMark: DOWNLOAD_BUFFER_SIZE,
    });
    return super.createConnection(bufferedOptions, callback);
  }
}

class DownloadHttpsAgent extends https.Agent {
  constructor() {
    super({
      keepAlive: true,
      maxSockets: MAX_SEGMENTED_DOWNLOAD_CONNECTIONS,
      maxFreeSockets: MAX_SEGMENTED_DOWNLOAD_CONNECTIONS,
    });
  }

  override createConnection(
    options: http.ClientRequestArgs,
    callback?: (error: Error | null, socket: Duplex) => void
  ): Duplex | null | undefined {
    const bufferedOptions = Object.assign({}, options, {
      highWaterMark: DOWNLOAD_BUFFER_SIZE,
    });
    return super.createConnection(bufferedOptions, callback);
  }
}

const downloadHttpAgent = new DownloadHttpAgent();
const downloadHttpsAgent = new DownloadHttpsAgent();

function getAxiosHeader(
  response: AxiosResponse<Readable>,
  name: string
): string | null {
  const value = response.headers[name.toLowerCase()];
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return null;
  return String(value);
}

export const DEFAULT_DOWNLOAD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";
const MEGADB_REFERER = "https://steamrip.com/";

function applyMegaDBReferer(
  url: string,
  headers: Record<string, string>
): Record<string, string> {
  let hostname: string | undefined;

  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return headers;
  }

  const isMegaDBUrl =
    hostname === "megadb.net" ||
    hostname === "megadb.xyz" ||
    hostname.endsWith(".megadb.net") ||
    hostname.endsWith(".megadb.xyz");

  if (!isMegaDBUrl) return headers;

  const hasReferer = Object.keys(headers).some(
    (key) => key.toLowerCase() === "referer"
  );

  if (hasReferer) return headers;

  return {
    ...headers,
    Referer: MEGADB_REFERER,
  };
}

class HttpDownloadStatusError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly retryable = false,
    public readonly retryAfterMs: number | null = null
  ) {
    super(`The download link is not available (HTTP ${statusCode}).`);
    this.name = "HttpDownloadStatusError";
  }
}

class SegmentDownloadError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "SegmentDownloadError";
  }
}

interface SegmentedDownloadCheckpoint {
  version: 2;
  fileSize: number;
  segmentCount: number;
  ranges: Array<{ start: number; end: number }>;
  offsets: number[];
  etag: string | null;
  lastModified: string | null;
}

type SegmentedDownloadResult =
  | { kind: "complete" }
  | { kind: "fallback"; resumeByte: number }
  | { kind: "unsupported" };

interface ActiveSegmentedDownload extends SegmentedDownloadCheckpoint {
  targetPath: string;
  checkpointPath: string;
  lastCheckpointAt: number;
}

const getContiguousSegmentedBytes = (
  checkpoint: SegmentedDownloadCheckpoint
): number => {
  const ranges = checkpoint.ranges
    .map((range, index) => ({
      ...range,
      offset: checkpoint.offsets[index] ?? 0,
    }))
    .sort((left, right) => left.start - right.start);
  let contiguousBytes = 0;

  for (const range of ranges) {
    if (range.start > contiguousBytes) break;
    const rangeEnd = Math.min(range.end + 1, range.start + range.offset);
    contiguousBytes = Math.max(contiguousBytes, rangeEnd);
  }

  return contiguousBytes;
};

function isDownloadByteRange(
  value: unknown
): value is { start: number; end: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    "start" in value &&
    Number.isSafeInteger(value.start) &&
    "end" in value &&
    Number.isSafeInteger(value.end)
  );
}

function getSegmentedCheckpointPath(filePath: string): string {
  return `${filePath}.hydra-segments.json`;
}

export class JsHttpDownloader {
  constructor(private readonly onProgress?: () => void) {}

  private abortController: AbortController | null = null;
  private writeStream: fs.WriteStream | null = null;
  private readonly segmentedWriteStreams = new Set<Writable>();
  private readonly pendingSegmentedFileDeletions = new Set<string>();
  private segmentedTargetHandleClosed: Promise<void> | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private activeDownloadPromise: Promise<void> | null = null;
  private segmentedDownload: ActiveSegmentedDownload | null = null;
  private currentOptions: JsHttpDownloaderOptions | null = null;
  private resolvedFilename: string | null = null;

  private bytesDownloaded = 0;
  private fileSize = 0;
  private downloadSpeed = 0;
  private status: "active" | "paused" | "complete" | "error" = "paused";
  private folderName = "";
  private lastSpeedUpdate = Date.now();
  private bytesAtLastSpeedUpdate = 0;
  private isDownloading = false;

  private retryCount = 0;
  private statusRetryCount = 0;
  private budgetResets = 0;
  private attemptBytesReceived = 0;
  private restartCount = 0;
  private pendingReadSince: number | null = null;
  private stallCheckInterval: NodeJS.Timeout | null = null;
  private isPaused = false;
  private isStallRetry = false;
  private isReconnecting = false;
  private isReconnectRetry = false;
  private isRecovering = false;
  private isSegmented = false;
  private isMerging = false;
  private singleConnectionRequiredUrls = new Set<string>();
  private recoverBytesTotal = 0;
  private recoverBytesDone = 0;
  private recoverSpeedLastUpdate = Date.now();
  private recoverBytesAtLastUpdate = 0;
  private maxDownloadSpeedBytesPerSecond: number | null = null;
  private throttleWindowStart = Date.now();
  private bytesTransferredInThrottleWindow = 0;
  private throttleQueue: Promise<void> = Promise.resolve();

  setMaxDownloadSpeedBytesPerSecond(limit: number | null): void {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      this.maxDownloadSpeedBytesPerSecond = null;
    } else {
      this.maxDownloadSpeedBytesPerSecond = Math.floor(limit);
    }

    this.resetThrottleWindow();
  }

  async startDownload(options: JsHttpDownloaderOptions): Promise<void> {
    if (this.isDownloading) {
      logger.log(
        "[JsHttpDownloader] Download already in progress, resuming..."
      );
      return this.resumeDownload();
    }

    this.currentOptions = options;
    this.isPaused = false;
    this.retryCount = 0;
    this.statusRetryCount = 0;
    this.budgetResets = 0;
    this.attemptBytesReceived = 0;
    this.restartCount = 0;
    this.isStallRetry = false;
    this.isReconnecting = false;
    this.isReconnectRetry = false;
    this.resetRecoveryState();
    this.fileSize = 0;
    this.resolvedFilename = null;
    this.pendingReadSince = null;
    this.resetThrottleWindow();
    const downloadPromise = this.startDownloadWithRetry();
    this.activeDownloadPromise = downloadPromise;
    try {
      await downloadPromise;
    } finally {
      if (this.activeDownloadPromise === downloadPromise) {
        this.activeDownloadPromise = null;
      }
    }
  }

  private async startDownloadWithRetry(): Promise<void> {
    if (!this.currentOptions) return;

    try {
      while (!this.isPaused) {
        if (!this.currentOptions) return;

        this.abortController = new AbortController();
        this.status = "active";
        this.isDownloading = true;
        this.isStallRetry = false;
        this.pendingReadSince = null;
        this.attemptBytesReceived = 0;
        this.isSegmented = false;
        this.isMerging = false;

        const { url, savePath, filename, headers = {} } = this.currentOptions;
        const { filePath, startByte, usedFallback } = this.prepareDownloadPath(
          savePath,
          filename,
          url
        );
        const requestHeaders = this.buildRequestHeaders(
          url,
          headers,
          startByte
        );

        this.startStallDetection();

        try {
          await this.executeDownload(
            url,
            requestHeaders,
            filePath,
            startByte,
            savePath,
            usedFallback
          );
          break;
        } catch (err) {
          const shouldRetry = await this.handleDownloadErrorWithRetry(
            err as Error
          );
          if (!shouldRetry) {
            break;
          }
        } finally {
          this.stopStallDetection();
          this.cleanupResources();
        }
      }
    } finally {
      this.isDownloading = false;
    }
  }

  private startStallDetection(): void {
    this.stopStallDetection();
    this.stallCheckInterval = setInterval(() => {
      if (this.status !== "active" || this.isPaused || this.isStallRetry) {
        return;
      }

      if (stallDetected(this.pendingReadSince, Date.now(), STALL_TIMEOUT_MS)) {
        const blockedSeconds = Math.round(
          (Date.now() - (this.pendingReadSince ?? Date.now())) / 1000
        );
        logger.log(
          `[JsHttpDownloader] Read blocked for ${blockedSeconds}s with no data, triggering retry`
        );
        this.triggerRetry();
      }
    }, STALL_CHECK_INTERVAL_MS);
  }

  private stopStallDetection(): void {
    if (this.stallCheckInterval) {
      clearInterval(this.stallCheckInterval);
      this.stallCheckInterval = null;
    }
  }

  private triggerRetry(): void {
    this.isStallRetry = true;
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  private async handleDownloadErrorWithRetry(err: Error): Promise<boolean> {
    if (this.isPaused) {
      logger.log("[JsHttpDownloader] Download paused/cancelled by user");
      this.status = "paused";
      return false;
    }

    const wasStallRetry = this.isStallRetry;
    const wasReconnect = this.isReconnectRetry;
    this.isReconnectRetry = false;
    const isAbortError = err.name === "AbortError";
    const isRetryable =
      wasStallRetry || wasReconnect || isRetryableDownloadError(err);
    const transientStatus =
      err instanceof HttpDownloadStatusError && err.retryable;

    this.maybeResetRetryBudget();

    if (transientStatus) {
      return this.handleTransientStatusError(err as HttpDownloadStatusError);
    }

    if (wasReconnect) {
      logger.log(
        `[JsHttpDownloader] Reconnecting after a network change; resuming in ${RECONNECT_RETRY_DELAY_MS}ms`
      );
      await this.sleep(RECONNECT_RETRY_DELAY_MS);
      return !this.isPaused;
    }

    if (isRetryable && this.retryCount < MAX_RETRY_ATTEMPTS) {
      this.retryCount++;
      this.isReconnecting = true;
      this.downloadSpeed = 0;
      const delay = Math.min(
        INITIAL_RETRY_DELAY_MS * Math.pow(2, this.retryCount - 1),
        MAX_RETRY_DELAY_MS
      );

      const reason = wasStallRetry ? "stall detected" : err.message;
      logger.log(
        `[JsHttpDownloader] Retryable error (${reason}). ` +
          `Retry ${this.retryCount}/${MAX_RETRY_ATTEMPTS} in ${delay}ms`
      );

      await this.sleep(delay);
      return !this.isPaused;
    }

    if (wasStallRetry) {
      this.handleDownloadError(
        new Error(
          "Download stalled repeatedly and could not be resumed after multiple retries."
        )
      );
      return false;
    }

    if (isAbortError) {
      logger.log("[JsHttpDownloader] Download aborted");
      this.status = "paused";
      return false;
    }

    this.handleDownloadError(err);
    return false;
  }

  private maybeResetRetryBudget(): void {
    if (
      shouldResetRetryBudget(
        this.attemptBytesReceived,
        this.budgetResets,
        PROGRESS_RESET_THRESHOLD_BYTES,
        MAX_BUDGET_RESETS
      )
    ) {
      logger.log(
        "[JsHttpDownloader] Data is flowing again; resetting retry budget"
      );
      this.retryCount = 0;
      this.statusRetryCount = 0;
      this.budgetResets += 1;
    }
  }

  private async handleTransientStatusError(
    statusError: HttpDownloadStatusError
  ): Promise<boolean> {
    if (this.statusRetryCount >= MAX_STATUS_RETRY_ATTEMPTS) {
      this.handleDownloadError(
        new Error(
          `The download server is rate-limiting or temporarily unavailable (HTTP ${statusError.statusCode}). Try again later or use another source.`
        )
      );
      return false;
    }

    this.statusRetryCount++;
    const backoff = Math.min(
      INITIAL_RETRY_DELAY_MS * Math.pow(2, this.statusRetryCount - 1),
      MAX_RETRY_DELAY_MS
    );
    const delay =
      statusError.retryAfterMs === null
        ? backoff
        : Math.min(statusError.retryAfterMs, MAX_RETRY_AFTER_MS);
    logger.log(
      `[JsHttpDownloader] Server unavailable (HTTP ${statusError.statusCode}). ` +
        `Retry ${this.statusRetryCount}/${MAX_STATUS_RETRY_ATTEMPTS} in ${delay}ms`
    );
    await this.sleep(delay);
    return !this.isPaused;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private resetThrottleWindow(): void {
    this.throttleWindowStart = Date.now();
    this.bytesTransferredInThrottleWindow = 0;
  }

  private async applyThrottle(chunkSize: number): Promise<void> {
    const limit = this.maxDownloadSpeedBytesPerSecond;
    if (!limit) return;

    const previous = this.throttleQueue;
    let release!: () => void;
    this.throttleQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      while (!this.isPaused && !this.abortController?.signal.aborted) {
        const now = Date.now();
        const elapsed = now - this.throttleWindowStart;

        if (elapsed >= 1000) {
          this.throttleWindowStart = now;
          this.bytesTransferredInThrottleWindow = 0;
        }

        const availableBytes = limit - this.bytesTransferredInThrottleWindow;
        if (
          availableBytes >= chunkSize ||
          this.bytesTransferredInThrottleWindow === 0
        ) {
          this.bytesTransferredInThrottleWindow += chunkSize;
          return;
        }

        const waitMs = Math.max(1, 1000 - elapsed);
        await this.sleep(waitMs);
      }
    } finally {
      release();
    }
  }

  private prepareDownloadPath(
    savePath: string,
    filename: string | undefined,
    url: string
  ): { filePath: string; startByte: number; usedFallback: boolean } {
    const extractedFilename =
      this.resolvedFilename || filename || this.extractFilename(url);
    const usedFallback = !extractedFilename;
    const resolvedFilename = extractedFilename || "download";
    this.folderName = resolvedFilename;
    const filePath = path.join(savePath, resolvedFilename);

    if (!fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    const targetDir = path.dirname(filePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    let startByte = 0;
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (
        this.segmentedDownload?.targetPath !== filePath &&
        !fs.existsSync(getSegmentedCheckpointPath(filePath))
      ) {
        startByte = stats.size;
      }
      if (startByte > 0) {
        logger.log(
          `[JsHttpDownloader] Resuming download from byte ${startByte}`
        );
      } else if (stats.size > 0) {
        logger.log(
          "[JsHttpDownloader] Resuming segmented download from saved byte offsets"
        );
      }
    }

    this.bytesDownloaded = startByte;
    this.resetSpeedTracking();
    return { filePath, startByte, usedFallback };
  }

  private buildRequestHeaders(
    url: string,
    headers: Record<string, string>,
    startByte: number
  ): Record<string, string> {
    const requestHeaders: Record<string, string> = applyMegaDBReferer(url, {
      ...headers,
    });

    const hasUserAgentHeader = Object.keys(requestHeaders).some(
      (key) => key.toLowerCase() === "user-agent"
    );

    if (!hasUserAgentHeader) {
      requestHeaders["User-Agent"] = DEFAULT_DOWNLOAD_USER_AGENT;
    }

    const hasAcceptEncoding = Object.keys(requestHeaders).some(
      (key) => key.toLowerCase() === "accept-encoding"
    );

    if (!hasAcceptEncoding) {
      requestHeaders["Accept-Encoding"] = "identity";
    }

    if (startByte > 0) {
      requestHeaders["Range"] = `bytes=${startByte}-`;
    }
    return requestHeaders;
  }

  private resetSpeedTracking(): void {
    this.lastSpeedUpdate = Date.now();
    this.bytesAtLastSpeedUpdate = this.bytesDownloaded;
    this.downloadSpeed = 0;
  }

  private parseFileSize(response: Response, startByte: number): void {
    const size = computeFileSize({
      status: response.status,
      contentRange: response.headers.get("content-range"),
      contentLength: response.headers.get("content-length"),
      startByte,
    });

    if (size !== null) {
      this.fileSize = size;
    }
  }

  private parseContentRangeStart(response: Response): number | null {
    const contentRange = response.headers.get("content-range");
    if (!contentRange) return null;

    const match = /bytes\s+(\d+)-/i.exec(contentRange);
    if (!match) return null;

    const start = Number.parseInt(match[1], 10);
    return Number.isFinite(start) ? start : null;
  }

  private async executeDownload(
    url: string,
    requestHeaders: Record<string, string>,
    filePath: string,
    startByte: number,
    savePath: string,
    usedFallback: boolean
  ): Promise<void> {
    if (this.singleConnectionRequiredUrls.has(url)) {
      logger.log(
        `[JsHttpDownloader] URL has already failed segmented mode; forcing a single-connection download for ${url}`
      );
    } else if (startByte === 0) {
      const segmentedResult = await this.tryExecuteSegmentedDownload(
        url,
        requestHeaders,
        filePath,
        savePath,
        usedFallback
      );
      if (segmentedResult.kind === "complete") return;
      if (segmentedResult.kind === "fallback") {
        startByte = segmentedResult.resumeByte;
        requestHeaders = this.buildRequestHeaders(
          url,
          this.currentOptions?.headers ?? {},
          startByte
        );
        this.bytesDownloaded = startByte;
        this.resetSpeedTracking();
        this.onProgress?.();
      }
    }

    const response = await fetch(url, {
      headers: requestHeaders,
      signal: this.abortController?.signal,
    });

    const contentType = response.headers.get("content-type") ?? "unknown";
    const contentLength = response.headers.get("content-length") ?? "unknown";
    logger.log(
      `[JsHttpDownloader] Response status=${response.status} content-type=${contentType} content-length=${contentLength}`
    );

    const localFileSize = await fs.promises
      .stat(filePath)
      .then((stat) => stat.size)
      .catch(() => -1);
    const remoteTotalSize = computeFileSize({
      status: response.status,
      contentRange: response.headers.get("content-range"),
      contentLength: response.headers.get("content-length"),
      startByte,
    });

    if (
      startByte > 0 &&
      remoteTotalSize !== null &&
      isDownloadCompleteOnDisk(localFileSize, remoteTotalSize)
    ) {
      this.fileSize = remoteTotalSize;
      this.bytesDownloaded = remoteTotalSize;
      this.status = "complete";
      this.retryCount = 0;
      this.downloadSpeed = 0;
      this.isSegmented = false;
      this.isMerging = false;
      this.resetRecoveryState();

      logger.log(
        `[JsHttpDownloader] Resume validation passed: local file already matches remote size ${remoteTotalSize} bytes; skipping redundant re-download.`
      );
      return;
    }

    if (response.status === 416 && startByte > 0) {
      if (remoteTotalSize !== null && startByte === remoteTotalSize) {
        logger.warn(
          `[JsHttpDownloader] Resume validation failed: local file size ${localFileSize} does not match remote size ${remoteTotalSize}; restarting from zero.`
        );
      }

      throw new Error(
        `[JsHttpDownloader] Range not satisfiable for resumed download (local=${startByte}, remote=${remoteTotalSize ?? "unknown"}). Keeping local file and aborting to avoid restart from zero.`
      );
    }

    if (response.status >= 400) {
      throw new HttpDownloadStatusError(
        response.status,
        isRetryableHttpStatus(response.status),
        parseRetryAfterMs(response.headers.get("retry-after"), Date.now())
      );
    }

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Detect HTML error pages served with 200 status (e.g. expired CDN links)
    if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml")
    ) {
      throw new Error(
        `The download link returned a web page instead of a file. It may have expired or be invalid.`
      );
    }

    const action = resolveResumeAction({
      startByte,
      status: response.status,
      partialStart: this.parseContentRangeStart(response),
    });

    let { flags, skipBytes, restart } = action;

    const contentEncoding = (response.headers.get("content-encoding") ?? "")
      .toLowerCase()
      .trim();
    if (contentEncoding && contentEncoding !== "identity" && startByte > 0) {
      logger.log(
        `[JsHttpDownloader] Response is "${contentEncoding}"-encoded; byte-offset resume is unreliable, restarting from byte 0`
      );
      flags = "w";
      skipBytes = 0;
      restart = true;
    }

    if (restart) {
      this.restartCount += 1;
      if (this.restartCount > MAX_RESTARTS_FROM_ZERO) {
        throw new Error(
          "The server keeps refusing to resume and the download cannot make progress; aborting to avoid endless re-downloads."
        );
      }
      this.bytesDownloaded = 0;
      this.resetSpeedTracking();
      logger.log(
        `[JsHttpDownloader] Restarting the file from byte 0 (restart ${this.restartCount}/${MAX_RESTARTS_FROM_ZERO}).`
      );
    } else if (action.rangeIgnored) {
      this.beginRecovery(skipBytes);
      logger.log(
        `[JsHttpDownloader] Server ignored the Range header (HTTP 200). Re-downloading ${skipBytes} bytes to preserve the existing partial.`
      );
    } else if (skipBytes > 0) {
      logger.log(
        `[JsHttpDownloader] Partial response started before the resume offset; discarding ${skipBytes} overlapping body bytes.`
      );
    }

    this.parseFileSize(response, startByte);

    // Resolve the on-disk filename once and pin it for the download's
    // lifetime so a later restart cannot orphan the existing partial.
    const writingFreshFile = flags === "w";
    let actualFilePath = filePath;
    if (writingFreshFile && this.resolvedFilename === null) {
      const urlDerivedFilename = path.basename(filePath);
      const headerFilename = this.parseContentDisposition(
        response.headers.get("content-disposition")
      );
      if (headerFilename) {
        if (headerFilename !== urlDerivedFilename) {
          logger.log(
            `[JsHttpDownloader] Filename mismatch detected. URL-derived="${urlDerivedFilename}" header-derived="${headerFilename}"`
          );
        }
        actualFilePath = path.join(savePath, headerFilename);
        this.folderName = headerFilename;
        this.resolvedFilename = headerFilename;
        const targetDir = path.dirname(actualFilePath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        logger.log(
          `[JsHttpDownloader] Using filename from Content-Disposition: ${headerFilename}`
        );
      } else {
        this.resolvedFilename = path.basename(actualFilePath);
        if (usedFallback) {
          logger.log(
            "[JsHttpDownloader] Content-Disposition filename not found, using fallback filename"
          );
        }
      }
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    this.writeStream = fs.createWriteStream(actualFilePath, {
      flags,
      highWaterMark: DOWNLOAD_BUFFER_SIZE,
    });

    const readableStream = this.createReadableStream(
      response.body.getReader(),
      skipBytes
    );
    await pipeline(
      readableStream,
      this.createDownloadBufferStream(),
      this.writeStream
    );

    this.status = "complete";
    this.retryCount = 0;
    this.statusRetryCount = 0;
    this.budgetResets = 0;
    this.restartCount = 0;
    this.isReconnecting = false;
    this.singleConnectionRequiredUrls.delete(url);
    this.resetRecoveryState();
    this.downloadSpeed = 0;
    logger.log(
      `[JsHttpDownloader] Download complete (${this.bytesDownloaded} bytes)`
    );
    this.onProgress?.();
  }

  private async tryExecuteSegmentedDownload(
    url: string,
    requestHeaders: Record<string, string>,
    filePath: string,
    savePath: string,
    usedFallback: boolean
  ): Promise<SegmentedDownloadResult> {
    if (this.singleConnectionRequiredUrls.has(url)) {
      logger.log(
        `[JsHttpDownloader] Skipping segmented probe for ${url} because a prior segmented attempt failed`
      );
      return { kind: "unsupported" };
    }

    const probeController = new AbortController();
    const parentSignal = this.abortController?.signal;
    const abortProbe = () => probeController.abort();
    parentSignal?.addEventListener("abort", abortProbe, { once: true });
    const timeout = setTimeout(
      () => probeController.abort(),
      RANGE_PROBE_TIMEOUT_MS
    );

    let probe: AxiosResponse<Readable>;
    try {
      probe = await axios.get<Readable>(url, {
        headers: {
          ...requestHeaders,
          "Accept-Encoding": "identity",
          Range: "bytes=0-0",
        },
        signal: probeController.signal,
        responseType: "stream",
        decompress: false,
        httpAgent: downloadHttpAgent,
        httpsAgent: downloadHttpsAgent,
        validateStatus: () => true,
      });
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      logger.warn(
        "[JsHttpDownloader] Range capability probe failed; falling back to a single connection",
        error
      );
      return { kind: "unsupported" };
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortProbe);
    }

    const contentRange = getAxiosHeader(probe, "content-range");
    const rangeMatch = contentRange
      ? /^bytes\s+0-0\/(\d+)$/i.exec(contentRange.trim())
      : null;
    const fileSize = rangeMatch ? Number.parseInt(rangeMatch[1], 10) : 0;
    const contentType = (
      getAxiosHeader(probe, "content-type") ?? ""
    ).toLowerCase();
    const contentEncoding = (
      getAxiosHeader(probe, "content-encoding") ?? ""
    ).toLowerCase();
    const supportsRanges =
      probe.status === 206 &&
      Number.isSafeInteger(fileSize) &&
      fileSize >= MIN_SEGMENTED_DOWNLOAD_SIZE &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml") &&
      (!contentEncoding || contentEncoding === "identity");

    if (supportsRanges) {
      for await (const _chunk of probe.data) {
        // Read the one-byte probe to allow the keep-alive socket to be reused.
      }
    } else {
      probe.data.destroy();
    }

    if (!supportsRanges) {
      if (probe.status >= 400) {
        throw new HttpDownloadStatusError(
          probe.status,
          isRetryableHttpStatus(probe.status),
          parseRetryAfterMs(getAxiosHeader(probe, "retry-after"), Date.now())
        );
      }
      return { kind: "unsupported" };
    }

    const maxConnections = Math.min(
      MAX_SEGMENTED_DOWNLOAD_CONNECTIONS,
      Math.max(
        SEGMENTED_DOWNLOAD_CONNECTIONS,
        Math.floor(
          this.currentOptions?.maxConnections ??
            MAX_SEGMENTED_DOWNLOAD_CONNECTIONS
        )
      )
    );

    let targetPath = filePath;
    const headerFilename = this.parseContentDisposition(
      getAxiosHeader(probe, "content-disposition")
    );
    if (headerFilename) {
      targetPath = path.join(savePath, headerFilename);
      this.folderName = headerFilename;
      this.resolvedFilename = headerFilename;
    } else if (usedFallback) {
      logger.log(
        "[JsHttpDownloader] Range probe did not provide a filename; using fallback filename"
      );
    }

    const checkpointPath = getSegmentedCheckpointPath(targetPath);
    const savedCheckpoint = await this.readSegmentedCheckpoint(checkpointPath);
    const initialSegmentCount = Math.max(
      maxConnections,
      Math.ceil(fileSize / MAX_SEGMENT_RANGE_BYTES)
    );
    const initialRanges = createDownloadByteRanges(
      fileSize,
      initialSegmentCount
    );
    const etag = getAxiosHeader(probe, "etag");
    const lastModified = getAxiosHeader(probe, "last-modified");
    const canResumeCheckpoint =
      savedCheckpoint !== null &&
      this.isCheckpointCompatible(
        savedCheckpoint,
        fileSize,
        savedCheckpoint.ranges
      );
    if (
      canResumeCheckpoint &&
      savedCheckpoint &&
      ((savedCheckpoint.etag && etag && savedCheckpoint.etag !== etag) ||
        (savedCheckpoint.lastModified &&
          lastModified &&
          savedCheckpoint.lastModified !== lastModified))
    ) {
      logger.warn(
        "[JsHttpDownloader] Remote validators changed but the file size and saved byte ranges still match; preserving the partial offsets for resume"
      );
    }
    const ranges = canResumeCheckpoint
      ? savedCheckpoint.ranges.map((range) => ({ ...range }))
      : initialRanges;
    if (ranges.length < 2) return { kind: "unsupported" };

    let offsets =
      canResumeCheckpoint && savedCheckpoint
        ? [...savedCheckpoint.offsets]
        : ranges.map(() => 0);
    const targetExists = fs.existsSync(targetPath);
    if (
      savedCheckpoint &&
      offsets.every((offset) => offset === 0) &&
      targetExists &&
      fs.statSync(targetPath).size > 0
    ) {
      logger.warn(
        "[JsHttpDownloader] Segmented checkpoint no longer matches the remote file; restarting its byte ranges"
      );
    }

    const targetHandle = await fs.promises.open(
      targetPath,
      targetExists ? "r+" : "w+"
    );
    let resolveTargetHandleClosed!: () => void;
    const targetHandleClosed = new Promise<void>((resolve) => {
      resolveTargetHandleClosed = resolve;
    });
    this.segmentedTargetHandleClosed = targetHandleClosed;
    let targetStats: fs.Stats | null;
    try {
      targetStats = targetExists ? await targetHandle.stat() : null;
      const validExistingData = canResumeCheckpoint && targetStats !== null;

      // The target is preallocated to fileSize, so its size says nothing about
      // how much was actually written; only the checkpoint offsets are reliable.
      if (!validExistingData) {
        offsets = ranges.map(() => 0);
      }
      // Extend a short partial in place; never discard existing download bytes.
      await targetHandle.truncate(fileSize);
    } catch (error) {
      try {
        await targetHandle.close();
        if (this.pendingSegmentedFileDeletions.delete(targetPath)) {
          await Promise.all([
            fs.promises.rm(targetPath, { force: true }),
            fs.promises.rm(checkpointPath, { force: true }),
          ]);
        }
      } finally {
        resolveTargetHandleClosed();
        this.segmentedTargetHandleClosed = null;
      }
      throw error;
    }

    const checkpoint: ActiveSegmentedDownload = {
      version: 2,
      fileSize,
      segmentCount: ranges.length,
      ranges,
      offsets,
      etag,
      lastModified,
      targetPath,
      checkpointPath,
      lastCheckpointAt: 0,
    };
    this.segmentedDownload = checkpoint;
    this.fileSize = fileSize;
    this.bytesDownloaded = offsets.reduce((total, offset) => total + offset, 0);
    this.isSegmented = true;
    this.isMerging = false;
    this.resetSpeedTracking();

    const segmentController = new AbortController();
    const abortSegments = () => segmentController.abort();
    parentSignal?.addEventListener("abort", abortSegments, { once: true });

    logger.log(
      `[JsHttpDownloader] Server supports byte ranges; downloading ${fileSize} bytes directly to the target in ${ranges.length} segments`
    );

    let completed = false;
    let fallbackToSingleConnection = false;
    let fallbackResumeByte = 0;
    try {
      await this.persistSegmentedCheckpoint(checkpoint);
      await this.downloadSegmentsWithFallback({
        url,
        requestHeaders,
        fileSize,
        ranges,
        checkpoint,
        targetHandle,
        controller: segmentController,
        maxConnections,
      });

      await this.persistSegmentedCheckpoint(checkpoint, true);

      // Verify all byte ranges are truly complete before declaring success
      const allSegmentsComplete = ranges.every((range, idx) => {
        const expected = range.end - range.start + 1;
        const actual = checkpoint.offsets[idx] ?? 0;
        if (actual < expected) {
          logger.error(
            `[JsHttpDownloader] Segment ${idx} incomplete: ${actual}/${expected} bytes written`
          );
          return false;
        }
        return true;
      });

      if (!allSegmentsComplete) {
        throw new Error(
          "Segmented download ended but some segments are incomplete."
        );
      }

      if (
        !areDownloadByteRangesComplete(ranges, checkpoint.offsets, fileSize)
      ) {
        throw new Error(
          "Segmented download ended before all target-file byte ranges were written."
        );
      }

      // Verify actual file size before finalizing
      const finalStat = await targetHandle.stat();
      if (finalStat.size < fileSize) {
        throw new Error(
          `Target file incomplete: ${finalStat.size}/${fileSize} bytes. Resuming would be needed.`
        );
      }

      await targetHandle.truncate(fileSize);
      if (this.checkpointTimer) {
        clearTimeout(this.checkpointTimer);
        this.checkpointTimer = null;
      }
      await fs.promises.rm(checkpointPath, { force: true });

      this.status = "complete";
      this.retryCount = 0;
      this.statusRetryCount = 0;
      this.budgetResets = 0;
      this.restartCount = 0;
      this.isReconnecting = false;
      this.isMerging = false;
      this.singleConnectionRequiredUrls.delete(url);
      this.resetRecoveryState();
      this.bytesDownloaded = fileSize;
      this.downloadSpeed = 0;
      this.segmentedDownload = null;
      completed = true;
      logger.log(
        `[JsHttpDownloader] Segmented download completed directly in the target file (${this.bytesDownloaded} bytes)`
      );
      return { kind: "complete" };
    } catch (error) {
      const wasUserAborted =
        this.isPaused || (this.abortController?.signal?.aborted ?? false);

      if (wasUserAborted) {
        logger.log(
          "[JsHttpDownloader] Segmented download was paused; preserving the partial file and checkpoint for resume."
        );
        throw error;
      }

      logger.warn(
        "[JsHttpDownloader] Segmented download was unreliable; resuming with a single connection from the contiguous downloaded prefix.",
        error
      );
      this.singleConnectionRequiredUrls.add(url);
      this.segmentedDownload = null;
      this.isSegmented = false;
      this.isMerging = false;
      fallbackToSingleConnection = true;
      fallbackResumeByte = getContiguousSegmentedBytes(checkpoint);

      return { kind: "fallback", resumeByte: fallbackResumeByte };
    } finally {
      parentSignal?.removeEventListener("abort", abortSegments);
      this.isMerging = false;
      if (!completed && this.segmentedDownload === checkpoint) {
        await this.persistSegmentedCheckpoint(checkpoint, true).catch(
          (error: unknown) => {
            logger.error(
              "[JsHttpDownloader] Failed to persist segmented download offsets",
              error
            );
          }
        );
      }
      for (const writeStream of this.segmentedWriteStreams) {
        writeStream.destroy();
      }
      this.segmentedWriteStreams.clear();
      try {
        await targetHandle.close();
        if (this.pendingSegmentedFileDeletions.delete(targetPath)) {
          await Promise.all([
            fs.promises.rm(targetPath, { force: true }),
            fs.promises.rm(checkpointPath, { force: true }),
          ]);
        }
        if (fallbackToSingleConnection) {
          await fs.promises.truncate(targetPath, fallbackResumeByte);
          await fs.promises.rm(checkpointPath, { force: true });
          this.fileSize = fileSize;
          this.bytesDownloaded = fallbackResumeByte;
          this.resetSpeedTracking();
          this.onProgress?.();
        }
        if (completed) {
          this.isSegmented = false;
          this.onProgress?.();
        }
      } finally {
        resolveTargetHandleClosed();
        if (this.segmentedTargetHandleClosed === targetHandleClosed) {
          this.segmentedTargetHandleClosed = null;
        }
      }
    }
  }

  private async downloadSegmentsWithFallback(input: {
    url: string;
    requestHeaders: Record<string, string>;
    fileSize: number;
    ranges: Array<{ start: number; end: number }>;
    checkpoint: ActiveSegmentedDownload;
    targetHandle: fs.promises.FileHandle;
    controller: AbortController;
    maxConnections: number;
  }): Promise<void> {
    const {
      url,
      requestHeaders,
      fileSize,
      ranges,
      checkpoint,
      targetHandle,
      controller,
      maxConnections,
    } = input;

    // Early exit: if all segments are already fully downloaded, skip the download loop entirely
    const allSegmentsAlreadyComplete = ranges.every((range, idx) => {
      const expectedSize = range.end - range.start + 1;
      const actualSize = checkpoint.offsets[idx] ?? 0;
      return actualSize >= expectedSize;
    });

    if (allSegmentsAlreadyComplete) {
      logger.log(
        "[JsHttpDownloader] All segments already fully downloaded; skipping download loop"
      );
      return;
    }

    const retryCounts = ranges.map(() => 0);
    const pendingSegments = ranges.map((_range, index) => index);
    const activeSegmentControllers = new Map<number, AbortController>();
    const splitRequestedSegments = new Set<number>();
    let concurrency = Math.min(
      SEGMENTED_DOWNLOAD_CONNECTIONS,
      maxConnections,
      ranges.length
    );
    let activeRequests = 0;
    let scheduledRetries = 0;
    let failure: Error | null = null;

    await new Promise<void>((resolve, reject) => {
      const finishIfDone = () => {
        if (failure && activeRequests === 0) {
          reject(failure);
          return true;
        }

        if (
          !failure &&
          pendingSegments.length === 0 &&
          activeRequests === 0 &&
          scheduledRetries === 0
        ) {
          resolve();
          return true;
        }

        return false;
      };

      const requestSplitLongestActiveSegment = (): boolean => {
        let candidateIndex = -1;
        let largestRemainingBytes = 0;

        for (const segmentIndex of activeSegmentControllers.keys()) {
          if (splitRequestedSegments.has(segmentIndex)) continue;
          const range = ranges[segmentIndex];
          const rangeSize = range.end - range.start + 1;
          const remainingBytes = rangeSize - checkpoint.offsets[segmentIndex];
          if (remainingBytes > largestRemainingBytes) {
            candidateIndex = segmentIndex;
            largestRemainingBytes = remainingBytes;
          }
        }

        if (
          candidateIndex < 0 ||
          largestRemainingBytes < MIN_DYNAMIC_SPLIT_RANGE_BYTES * 2
        ) {
          return false;
        }

        if (
          !splitDownloadByteRange(
            ranges[candidateIndex],
            checkpoint.offsets[candidateIndex],
            MIN_DYNAMIC_SPLIT_RANGE_BYTES
          )
        ) {
          return false;
        }

        splitRequestedSegments.add(candidateIndex);
        activeSegmentControllers.get(candidateIndex)?.abort();
        return true;
      };

      const pump = () => {
        if (failure) {
          finishIfDone();
          return;
        }

        while (activeRequests < concurrency && !failure) {
          if (
            pendingSegments.length === 0 &&
            activeRequests > 0 &&
            !requestSplitLongestActiveSegment()
          ) {
            break;
          }
          const segmentIndex = pendingSegments.shift();
          if (segmentIndex === undefined) break;
          const segmentController = new AbortController();
          const abortSegment = () => segmentController.abort();
          controller.signal.addEventListener("abort", abortSegment, {
            once: true,
          });
          activeSegmentControllers.set(segmentIndex, segmentController);
          activeRequests += 1;
          void this.downloadSegment({
            url,
            requestHeaders,
            fileSize,
            range: ranges[segmentIndex],
            checkpoint,
            targetHandle,
            segmentIndex,
            segmentCount: ranges.length,
            signal: segmentController.signal,
          })
            .then(() => {
              if (
                failure ||
                splitRequestedSegments.has(segmentIndex) ||
                controller.signal.aborted
              ) {
                return;
              }

              const nextConcurrency = Math.min(maxConnections, concurrency + 1);
              if (nextConcurrency > concurrency) {
                concurrency = nextConcurrency;
                logger.info(
                  `[JsHttpDownloader] Increasing segmented download concurrency to ${concurrency}/${maxConnections} after a successful range`
                );
              }
            })
            .catch((error: unknown) => {
              if (splitRequestedSegments.has(segmentIndex)) return;
              if (failure) return;
              const segmentError =
                error instanceof Error ? error : new Error(String(error));
              const canRetry =
                error instanceof SegmentDownloadError
                  ? error.retryable
                  : isRetryableDownloadError(segmentError);

              if (
                controller.signal.aborted ||
                !canRetry ||
                retryCounts[segmentIndex] >= SEGMENT_RETRY_LIMIT
              ) {
                failure = segmentError;
                controller.abort();
                return;
              }

              retryCounts[segmentIndex] += 1;
              concurrency = Math.max(
                SEGMENTED_DOWNLOAD_CONNECTIONS,
                Math.floor(concurrency / 2)
              );
              const backoffMs = Math.min(
                SEGMENT_RETRY_BACKOFF_MS * 2 ** (retryCounts[segmentIndex] - 1),
                8000
              );
              const retryAfterMs =
                error instanceof SegmentDownloadError
                  ? error.retryAfterMs
                  : null;
              const delayMs = Math.max(
                backoffMs,
                Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS)
              );

              logger.warn(
                `[JsHttpDownloader] Retrying segment ${segmentIndex + 1}/${ranges.length} after ${delayMs}ms; concurrent segment limit reduced to ${concurrency}`,
                segmentError
              );
              scheduledRetries += 1;
              setTimeout(() => {
                scheduledRetries -= 1;
                pendingSegments.unshift(segmentIndex);
                pump();
              }, delayMs);
            })
            .finally(() => {
              controller.signal.removeEventListener("abort", abortSegment);
              activeSegmentControllers.delete(segmentIndex);
              activeRequests -= 1;
              if (splitRequestedSegments.delete(segmentIndex)) {
                const splitRanges = splitDownloadByteRange(
                  ranges[segmentIndex],
                  checkpoint.offsets[segmentIndex],
                  MIN_DYNAMIC_SPLIT_RANGE_BYTES
                );
                if (splitRanges) {
                  const [leftRange, rightRange] = splitRanges;
                  const rightIndex = segmentIndex + 1;
                  ranges.splice(segmentIndex, 1, leftRange, rightRange);
                  checkpoint.ranges.splice(
                    segmentIndex,
                    1,
                    leftRange,
                    rightRange
                  );
                  checkpoint.offsets.splice(
                    segmentIndex,
                    1,
                    checkpoint.offsets[segmentIndex],
                    0
                  );
                  retryCounts.splice(segmentIndex, 1, 0, 0);
                  checkpoint.segmentCount = ranges.length;
                  pendingSegments.unshift(rightIndex);
                  logger.log(
                    `[JsHttpDownloader] Split remaining segment ${segmentIndex + 1} at byte ${rightRange.start} to keep an idle connection working`
                  );
                }
                pendingSegments.unshift(segmentIndex);
              }
              if (!failure) pump();
              finishIfDone();
            });
        }

        finishIfDone();
      };

      if (controller.signal.aborted) {
        failure = new Error("Segmented download was aborted.");
      } else {
        pump();
      }
    });
  }

  private async downloadSegment(input: {
    url: string;
    requestHeaders: Record<string, string>;
    fileSize: number;
    range: { start: number; end: number };
    checkpoint: ActiveSegmentedDownload;
    targetHandle: fs.promises.FileHandle;
    segmentIndex: number;
    segmentCount: number;
    signal: AbortSignal;
  }): Promise<void> {
    const {
      url,
      requestHeaders,
      fileSize,
      range,
      checkpoint,
      targetHandle,
      segmentIndex,
      segmentCount,
      signal,
    } = input;
    const expectedSegmentSize = range.end - range.start + 1;
    let existingBytes = checkpoint.offsets[segmentIndex];

    if (existingBytes > expectedSegmentSize) {
      this.bytesDownloaded = Math.max(0, this.bytesDownloaded - existingBytes);
      checkpoint.offsets[segmentIndex] = 0;
      existingBytes = 0;
      this.onProgress?.();
    }
    if (existingBytes === expectedSegmentSize) return;

    const requestStart = range.start + existingBytes;
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    signal.addEventListener("abort", abortAttempt, { once: true });
    let inactivityTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    const resetInactivityTimer = (active = true) => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = null;
      if (!active) return;
      inactivityTimer = setTimeout(() => {
        timedOut = true;
        attemptController.abort();
      }, SEGMENT_STALL_TIMEOUT_MS);
    };
    const cleanupAttempt = () => {
      signal.removeEventListener("abort", abortAttempt);
      if (inactivityTimer) clearTimeout(inactivityTimer);
    };
    resetInactivityTimer();

    let segmentResponse: AxiosResponse<Readable>;
    try {
      segmentResponse = await axios.get<Readable>(url, {
        headers: {
          ...requestHeaders,
          "Accept-Encoding": "identity",
          Range: `bytes=${requestStart}-${range.end}`,
        },
        signal: attemptController.signal,
        responseType: "stream",
        decompress: false,
        httpAgent: downloadHttpAgent,
        httpsAgent: downloadHttpsAgent,
        validateStatus: () => true,
      });
    } catch (error) {
      cleanupAttempt();
      if (timedOut) {
        throw new SegmentDownloadError(
          `Range segment ${segmentIndex + 1}/${segmentCount} stalled for ${Math.round(SEGMENT_STALL_TIMEOUT_MS / 1000)} seconds before receiving data.`,
          true
        );
      }
      throw error;
    }

    if (segmentResponse.status !== 206 && segmentResponse.status !== 200) {
      const retryable =
        segmentResponse.status === 429 || segmentResponse.status >= 500;
      const retryAfterMs = parseRetryAfterMs(
        getAxiosHeader(segmentResponse, "retry-after"),
        Date.now()
      );
      segmentResponse.data.destroy();
      cleanupAttempt();
      throw new SegmentDownloadError(
        `Range segment ${segmentIndex + 1}/${segmentCount} failed with HTTP ${segmentResponse.status}.`,
        retryable,
        retryAfterMs
      );
    }

    const expectedContentRange = new RegExp(
      `^bytes\\s+${requestStart}-${range.end}/${fileSize}$`,
      "i"
    );
    const actualContentRange =
      getAxiosHeader(segmentResponse, "content-range")?.trim() ?? "";
    const segmentContentType =
      getAxiosHeader(segmentResponse, "content-type") ?? "";
    const segmentContentEncoding =
      getAxiosHeader(segmentResponse, "content-encoding") ?? "";
    const rangeIgnoredByServer = segmentResponse.status === 200;
    const hasExpectedRangeResponse =
      segmentResponse.status === 206 &&
      expectedContentRange.test(actualContentRange);
    if (
      (!rangeIgnoredByServer && !hasExpectedRangeResponse) ||
      segmentContentType.toLowerCase().includes("text/html") ||
      segmentContentType.toLowerCase().includes("application/xhtml") ||
      (segmentContentEncoding &&
        segmentContentEncoding.toLowerCase() !== "identity")
    ) {
      segmentResponse.data.destroy();
      cleanupAttempt();
      throw new SegmentDownloadError(
        `Range segment ${segmentIndex + 1}/${segmentCount} was not served correctly (Content-Range: ${actualContentRange || "missing"}).`,
        true
      );
    }

    const writeStream = createPositionalWriteStream(
      targetHandle,
      range.start + existingBytes,
      DOWNLOAD_BUFFER_SIZE,
      async (writtenBytes) => {
        checkpoint.offsets[segmentIndex] += writtenBytes;
        this.bytesDownloaded += writtenBytes;
        this.updateSpeed();
        this.onProgress?.();
      },
      attemptController.signal
    );
    this.segmentedWriteStreams.add(writeStream);
    try {
      const responseBodyStream = this.createReadableStream(
        Readable.toWeb(
          segmentResponse.data
        ).getReader() as ReadableStreamDefaultReader<Uint8Array>,
        rangeIgnoredByServer ? requestStart : 0,
        false,
        resetInactivityTimer
      );

      let remainingBytesToWrite = expectedSegmentSize - existingBytes;
      const rangeGuard = new Transform({
        transform(chunk, _encoding, callback) {
          if (remainingBytesToWrite <= 0) {
            callback();
            return;
          }

          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const writableBytes = Math.min(buffer.length, remainingBytesToWrite);
          if (writableBytes > 0) {
            this.push(buffer.subarray(0, writableBytes));
            remainingBytesToWrite -= writableBytes;
          }
          callback();
        },
      });

      if (rangeIgnoredByServer) {
        await pipeline(
          responseBodyStream,
          rangeGuard,
          this.createDownloadBufferStream(),
          writeStream,
          { signal: attemptController.signal }
        );
      } else {
        await pipeline(
          responseBodyStream,
          this.createDownloadBufferStream(),
          writeStream,
          { signal: attemptController.signal }
        );
      }

      // Clamp to expected size if minor buffer padding overage
      if (checkpoint.offsets[segmentIndex] > expectedSegmentSize) {
        const excess = checkpoint.offsets[segmentIndex] - expectedSegmentSize;
        this.bytesDownloaded = Math.max(0, this.bytesDownloaded - excess);
        checkpoint.offsets[segmentIndex] = expectedSegmentSize;
      }

      // Check if segment is truly complete
      if (checkpoint.offsets[segmentIndex] < expectedSegmentSize) {
        throw new SegmentDownloadError(
          `Range segment ${segmentIndex + 1}/${segmentCount} stream ended prematurely (${checkpoint.offsets[segmentIndex]}/${expectedSegmentSize} bytes).`,
          true
        );
      }

      // Persist checkpoint after successful segment completion
      await this.persistSegmentedCheckpoint(checkpoint);
    } catch (error) {
      if (timedOut) {
        throw new SegmentDownloadError(
          `Range segment ${segmentIndex + 1}/${segmentCount} stalled for ${Math.round(SEGMENT_STALL_TIMEOUT_MS / 1000)} seconds; retrying from its last saved offset.`,
          true
        );
      }
      throw error;
    } finally {
      cleanupAttempt();
      segmentResponse.data.destroy();
      this.segmentedWriteStreams.delete(writeStream);
    }
  }

  private async readSegmentedCheckpoint(
    checkpointPath: string
  ): Promise<SegmentedDownloadCheckpoint | null> {
    try {
      const content = await fs.promises.readFile(checkpointPath, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!this.isSegmentedCheckpoint(parsed)) {
        await fs.promises.rm(checkpointPath, { force: true });
        throw new Error("Invalid segmented download checkpoint format.");
      }

      return {
        ...parsed,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      logger.warn(
        `[JsHttpDownloader] Ignoring unreadable segmented checkpoint ${checkpointPath}`,
        error
      );
      return null;
    }
  }

  private isSegmentedCheckpoint(
    value: unknown
  ): value is SegmentedDownloadCheckpoint {
    if (value === null || typeof value !== "object") return false;
    if (!("version" in value) || value.version !== 2) return false;
    if (
      !("fileSize" in value) ||
      typeof value.fileSize !== "number" ||
      !Number.isSafeInteger(value.fileSize) ||
      !("segmentCount" in value) ||
      typeof value.segmentCount !== "number" ||
      !Number.isSafeInteger(value.segmentCount) ||
      value.segmentCount < 2 ||
      value.segmentCount > value.fileSize
    ) {
      return false;
    }

    if (!("ranges" in value) || !Array.isArray(value.ranges)) return false;
    const ranges = value.ranges.filter(isDownloadByteRange);
    if (
      ranges.length !== value.ranges.length ||
      ranges.length !== value.segmentCount ||
      !areDownloadByteRangesContiguous(ranges, value.fileSize)
    ) {
      return false;
    }

    if (!("offsets" in value) || !Array.isArray(value.offsets)) return false;
    const offsets = value.offsets.filter(
      (offset): offset is number =>
        typeof offset === "number" && Number.isSafeInteger(offset)
    );
    if (
      offsets.length !== value.offsets.length ||
      offsets.length !== ranges.length ||
      offsets.some(
        (offset, index) =>
          offset < 0 || offset > ranges[index].end - ranges[index].start + 1
      )
    ) {
      return false;
    }

    if (
      !("etag" in value) ||
      !(typeof value.etag === "string" || value.etag === null) ||
      !("lastModified" in value) ||
      !(typeof value.lastModified === "string" || value.lastModified === null)
    ) {
      return false;
    }

    return true;
  }

  private isCheckpointCompatible(
    checkpoint: SegmentedDownloadCheckpoint,
    fileSize: number,
    ranges: Array<{ start: number; end: number }>
  ): boolean {
    if (
      checkpoint.fileSize !== fileSize ||
      checkpoint.segmentCount !== ranges.length ||
      checkpoint.ranges.length !== ranges.length ||
      checkpoint.ranges.some(
        (range, index) =>
          range.start !== ranges[index].start || range.end !== ranges[index].end
      ) ||
      checkpoint.offsets.length !== ranges.length ||
      checkpoint.offsets.some(
        (offset, index) =>
          offset < 0 || offset > ranges[index].end - ranges[index].start + 1
      )
    ) {
      return false;
    }

    return true;
  }

  private persistSegmentedCheckpoint(
    checkpoint: ActiveSegmentedDownload,
    force = false
  ): Promise<void> {
    if (force && this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }

    const writeCheckpoint = () => {
      const serialized: SegmentedDownloadCheckpoint = {
        version: checkpoint.version,
        fileSize: checkpoint.fileSize,
        segmentCount: checkpoint.segmentCount,
        ranges: checkpoint.ranges.map((range) => ({ ...range })),
        offsets: [...checkpoint.offsets],
        etag: checkpoint.etag,
        lastModified: checkpoint.lastModified,
      };
      const tempPath = `${checkpoint.checkpointPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(serialized), "utf8");
      fs.renameSync(tempPath, checkpoint.checkpointPath);
      checkpoint.lastCheckpointAt = Date.now();
    };

    if (force) {
      writeCheckpoint();
      return Promise.resolve();
    }

    if (!this.checkpointTimer) {
      const delay = Math.max(
        0,
        SEGMENT_CHECKPOINT_INTERVAL_MS -
          (Date.now() - checkpoint.lastCheckpointAt)
      );
      this.checkpointTimer = setTimeout(() => {
        this.checkpointTimer = null;
        try {
          writeCheckpoint();
        } catch (error) {
          logger.error(
            "[JsHttpDownloader] Failed to update segmented checkpoint",
            error
          );
        }
      }, delay);
    }

    return Promise.resolve();
  }

  private parseContentDisposition(
    header: string | null | undefined
  ): string | undefined {
    if (!header) return undefined;

    const filenameStarMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
    if (filenameStarMatch?.[1]) {
      const rawValue = filenameStarMatch[1].trim().replace(/^["']|["']$/g, "");
      const encodedPart = rawValue.includes("''")
        ? rawValue.split("''").slice(1).join("''")
        : rawValue;
      const decoded = this.decodeFilenameValue(encodedPart);
      if (decoded) return decoded;
    }

    const filenameMatch = /filename\s*=\s*([^;]+)/i.exec(header);
    if (filenameMatch?.[1]) {
      const rawValue = filenameMatch[1].trim().replace(/^["']|["']$/g, "");
      const decoded = this.decodeFilenameValue(rawValue);
      if (decoded) return decoded;
    }

    return undefined;
  }

  private createDownloadBufferStream(): Transform {
    let chunks: Buffer[] = [];
    let bufferedBytes = 0;

    return new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        bufferedBytes += chunk.length;

        while (bufferedBytes >= DOWNLOAD_BUFFER_SIZE) {
          const block = Buffer.concat(chunks, bufferedBytes);
          this.push(block.subarray(0, DOWNLOAD_BUFFER_SIZE));
          const remainder = block.subarray(DOWNLOAD_BUFFER_SIZE);
          chunks = remainder.length > 0 ? [remainder] : [];
          bufferedBytes = remainder.length;
        }

        callback();
      },
      flush(callback) {
        if (bufferedBytes > 0) {
          this.push(Buffer.concat(chunks, bufferedBytes));
        }
        callback();
      },
    });
  }

  private decodeFilenameValue(value: string): string | undefined {
    const normalized = value.trim();
    if (!normalized) return undefined;

    const sanitize = (name: string) =>
      path
        .basename(name)
        .replaceAll(/[<>:"/\\|?*]/g, "_")
        .split("")
        .filter((char) => char.charCodeAt(0) >= 32)
        .join("")
        .trim();

    try {
      const decoded = decodeURIComponent(normalized);
      const sanitized = sanitize(decoded);
      return sanitized || undefined;
    } catch {
      const sanitized = sanitize(normalized);
      return sanitized || undefined;
    }
  }

  private resetRecoveryState(): void {
    this.isRecovering = false;
    this.isSegmented = false;
    this.isMerging = false;
    this.recoverBytesTotal = 0;
    this.recoverBytesDone = 0;
    this.recoverBytesAtLastUpdate = 0;
  }

  private beginRecovery(totalBytes: number): void {
    this.isRecovering = true;
    this.isReconnecting = false;
    this.recoverBytesTotal = totalBytes;
    this.recoverBytesDone = 0;
    this.recoverBytesAtLastUpdate = 0;
    this.recoverSpeedLastUpdate = Date.now();
    this.downloadSpeed = 0;
  }

  private trackRecoveredBytes(skipped: number): void {
    if (!this.isRecovering || skipped <= 0) return;

    this.recoverBytesDone += skipped;
    const now = Date.now();
    const elapsed = (now - this.recoverSpeedLastUpdate) / 1000;
    if (elapsed >= 1) {
      this.downloadSpeed = Math.max(
        0,
        (this.recoverBytesDone - this.recoverBytesAtLastUpdate) / elapsed
      );
      this.recoverSpeedLastUpdate = now;
      this.recoverBytesAtLastUpdate = this.recoverBytesDone;
    }
  }

  private finishRecovery(): void {
    if (!this.isRecovering) return;

    this.isRecovering = false;
    this.recoverBytesDone = this.recoverBytesTotal;
    this.resetSpeedTracking();
  }

  private createReadableStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    skipBytes = 0,
    trackProgress = true,
    onData?: (active?: boolean) => void
  ): Readable {
    const applyThrottle = this.applyThrottle.bind(this);
    const markReadPending = () => {
      if (trackProgress) this.pendingReadSince = Date.now();
    };
    const clearReadPending = () => {
      if (trackProgress) this.pendingReadSince = null;
    };
    const countReceived = (length: number) => {
      this.attemptBytesReceived += length;
    };
    const applyRecoveryTracking = (
      plan: ReturnType<typeof applySkip>,
      length: number
    ) => {
      const skipped = plan.shouldWrite ? plan.writeOffset : length;
      if (skipped > 0) this.trackRecoveredBytes(skipped);
      if (plan.newRemainingToSkip === 0) this.finishRecovery();
    };
    const onChunk = (length: number) => {
      if (!trackProgress) return;
      if (this.isReconnecting) {
        this.isReconnecting = false;
      }
      this.bytesDownloaded += length;
      this.updateSpeed();
      this.onProgress?.();
    };
    let remainingToSkip = skipBytes;

    return new Readable({
      read() {
        void (async () => {
          try {
            for (;;) {
              markReadPending();
              onData?.();
              const { done, value } = await reader.read();
              onData?.(false);
              clearReadPending();

              if (done) {
                if (remainingToSkip > 0) {
                  this.destroy(
                    new Error(
                      `[JsHttpDownloader] Server body shorter than the existing partial (missing ${remainingToSkip} bytes); refusing to append a truncated file.`
                    )
                  );
                  return;
                }
                this.push(null);
                return;
              }

              countReceived(value.length);

              const plan = applySkip(remainingToSkip, value.length);
              remainingToSkip = plan.newRemainingToSkip;
              applyRecoveryTracking(plan, value.length);
              if (!plan.shouldWrite) {
                continue;
              }

              const chunk =
                plan.writeOffset > 0 ? value.subarray(plan.writeOffset) : value;
              await applyThrottle(chunk.length);
              onChunk(chunk.length);
              this.push(Buffer.from(chunk));
              return;
            }
          } catch (err) {
            clearReadPending();
            this.destroy(err as Error);
          }
        })();
      },
      destroy(err, callback) {
        reader
          .cancel()
          .catch(() => undefined)
          .finally(() => callback(err));
      },
    });
  }

  private handleDownloadError(err: Error): void {
    this.isReconnecting = false;
    this.resetRecoveryState();
    if (
      err.name === "AbortError" ||
      (err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE"
    ) {
      logger.log("[JsHttpDownloader] Download aborted");
      this.status = "paused";
    } else {
      logger.error("[JsHttpDownloader] Download error:", err);
      this.status = "error";
      throw err;
    }
  }

  private async resumeDownload(): Promise<void> {
    if (!this.currentOptions) {
      throw new Error("No download options available for resume");
    }

    // Force persist any pending checkpoint before resuming
    if (this.segmentedDownload && this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
      await this.persistSegmentedCheckpoint(this.segmentedDownload, true);
    }

    this.isDownloading = false;
    this.isPaused = false;
    this.retryCount = 0;
    this.statusRetryCount = 0;
    this.budgetResets = 0;
    this.attemptBytesReceived = 0;
    this.restartCount = 0;
    this.isStallRetry = false;
    this.isReconnecting = false;
    this.isReconnectRetry = false;
    this.resetRecoveryState();
    this.pendingReadSince = null;
    await this.startDownloadWithRetry();
  }

  setReconnecting(value: boolean): void {
    this.isReconnecting = value;
    if (value) {
      this.downloadSpeed = 0;
    }
  }

  reconnect(): void {
    if (!this.isDownloading || this.isPaused) return;

    logger.log(
      "[JsHttpDownloader] Network change detected; reconnecting and resuming"
    );
    this.isReconnecting = true;
    this.isReconnectRetry = true;
    this.downloadSpeed = 0;
    this.pendingReadSince = null;
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  stopForNoNetwork(): void {
    logger.log(
      "[JsHttpDownloader] No internet connection; pausing download and keeping the partial file"
    );
    this.isReconnecting = false;
    this.pauseDownload();
  }

  async pauseDownload(): Promise<void> {
    logger.log("[JsHttpDownloader] Pausing download");
    this.isPaused = true;
    this.pendingReadSince = null;
    this.stopStallDetection();
    if (this.abortController) {
      this.abortController.abort();
    }
    await this.activeDownloadPromise;
    this.status = "paused";
    this.downloadSpeed = 0;
  }

  async cancelDownload(deleteFile = true): Promise<void> {
    logger.log("[JsHttpDownloader] Cancelling download");
    this.isPaused = true;
    this.pendingReadSince = null;
    this.stopStallDetection();

    if (this.abortController) {
      this.abortController.abort();
    }

    const filePath =
      deleteFile && this.currentOptions && this.status !== "complete"
        ? path.join(this.currentOptions.savePath, this.folderName)
        : null;
    const isSegmentedFile =
      filePath !== null &&
      (this.segmentedDownload?.targetPath === filePath ||
        this.segmentedTargetHandleClosed !== null);
    const streamsToClose = [
      ...(this.writeStream ? [this.writeStream] : []),
      ...this.segmentedWriteStreams,
    ];
    const waitForClose = (stream: Writable) =>
      stream.closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => stream.once("close", resolve));
    const streamClosePromises = streamsToClose.map(waitForClose);
    const targetHandleClosed = isSegmentedFile
      ? this.segmentedTargetHandleClosed
      : null;

    if (isSegmentedFile && filePath) {
      this.pendingSegmentedFileDeletions.add(filePath);
    }

    this.cleanupResources();
    await Promise.all(streamClosePromises);
    if (targetHandleClosed) await targetHandleClosed;

    if (filePath && !isSegmentedFile) {
      const checkpointPath = getSegmentedCheckpointPath(filePath);
      try {
        await Promise.all([
          fs.promises.rm(filePath, { force: true }),
          fs.promises.rm(checkpointPath, { force: true }),
        ]);
        logger.log("[JsHttpDownloader] Deleted partial download files");
      } catch (error) {
        logger.error(
          "[JsHttpDownloader] Failed to delete partial files",
          error
        );
        throw error;
      }
    }

    this.segmentedDownload = null;

    this.reset();
  }

  getDownloadStatus(): JsHttpDownloaderStatus | null {
    if (!this.currentOptions && this.status !== "active") {
      return null;
    }

    let progress = 0;
    if (this.status === "complete") {
      progress = 1;
    } else if (this.fileSize > 0) {
      progress = clampProgress(this.bytesDownloaded / this.fileSize);
    }

    return {
      folderName: this.folderName,
      fileSize: this.fileSize,
      progress,
      downloadSpeed: this.downloadSpeed,
      numPeers: 0,
      numSeeds: 0,
      status: this.status,
      bytesDownloaded: this.bytesDownloaded,
      isReconnecting: this.isReconnecting,
      isRecovering: this.isRecovering,
      isSegmented: this.isSegmented,
      isMerging: this.isMerging,
      recoveryProgress:
        this.recoverBytesTotal > 0
          ? clampProgress(this.recoverBytesDone / this.recoverBytesTotal)
          : 0,
    };
  }

  private updateSpeed(): void {
    const now = Date.now();
    const elapsed = (now - this.lastSpeedUpdate) / 1000;

    if (elapsed >= 1) {
      const bytesDelta = this.bytesDownloaded - this.bytesAtLastSpeedUpdate;
      this.downloadSpeed = bytesDelta / elapsed;
      this.lastSpeedUpdate = now;
      this.bytesAtLastSpeedUpdate = this.bytesDownloaded;
    }
  }

  private extractFilename(url: string): string | undefined {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const pathParts = pathname.split("/");
      const filename = pathParts.at(-1);

      if (filename?.includes(".") && filename.length > 0) {
        return decodeURIComponent(filename);
      }
    } catch {
      // Invalid URL
    }
    return undefined;
  }

  private cleanupResources(): void {
    if (this.writeStream) {
      this.writeStream.destroy();
      this.writeStream = null;
    }
    for (const writeStream of this.segmentedWriteStreams) {
      writeStream.destroy();
    }
    this.segmentedWriteStreams.clear();
    this.abortController = null;
  }

  private reset(): void {
    this.currentOptions = null;
    this.resolvedFilename = null;
    this.bytesDownloaded = 0;
    this.fileSize = 0;
    this.downloadSpeed = 0;
    this.status = "paused";
    this.folderName = "";
    this.isDownloading = false;
    this.retryCount = 0;
    this.statusRetryCount = 0;
    this.budgetResets = 0;
    this.attemptBytesReceived = 0;
    this.restartCount = 0;
    this.pendingReadSince = null;
    this.isStallRetry = false;
    this.isReconnecting = false;
    this.isReconnectRetry = false;
    this.resetRecoveryState();
    this.resetThrottleWindow();
  }
}
