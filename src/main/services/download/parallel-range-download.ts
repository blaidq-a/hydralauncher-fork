import { runDownloadQueue } from "./download-work-queue.js";
import { logger } from "./download-logger.js";
import fs from "node:fs";
import {
  markSavedRange,
  missingRanges,
  rangeResourceId,
  readRangeState,
  removeRangeState,
  saveRangeState,
  type RangeDownloadState,
} from "./range-download-state.js";

const PARALLEL_RANGE_FAILURE_LIMIT = 2;
// Fork: raised from 16. Some hosters cap every connection at a few MB/s
// (Buzzheavier ~3.5 MB/s), so line speed needs more connections.
export const MAX_PARALLEL_CONNECTIONS = 32;
// Fork: the checkpoint fsyncs the whole (often 50-100 GB) file. Doing it
// every second forced constant disk flushes and stalled the connection that
// waited for it; checkpoints now run in the background every few seconds.
const RANGE_CHECKPOINT_INTERVAL_MS = 5000;
/**
 * Fork: network chunks are only 16-64 KB. Writing each one separately meant
 * thousands of write calls per second sharing libuv's four file threads (and
 * every one inspected by antivirus filters), which capped the total speed no
 * matter how many connections were used. Each range now writes 2 MB blocks.
 */
const WRITE_BATCH_BYTES = 2 * 1024 * 1024;
/**
 * Fork: a single connection that stops receiving data is restarted on its
 * own. Upstream only had the downloader-wide 30 s stall check, which aborted
 * every connection (and on hosters with dozens of connections, restarted all
 * of them) because one of them hung.
 */
const RANGE_STALL_TIMEOUT_MS = 20_000;
const MAX_RANGE_STALL_RETRIES = 5;

/**
 * Fork: thrown inside a worker whose connection the server refused with
 * 429/503 while other connections keep working. The worker stops, its range
 * goes back to the queue, and the download continues with one connection
 * less; it settles at the number of connections the host allows.
 */
class RetireConnectionSignal extends Error {}

/**
 * Fork: open connections gradually (like FDM) instead of all at once; some
 * hosters (Gofile) answer a burst of simultaneous requests with HTTP 429.
 */
const CONNECTION_START_INTERVAL_MS = 250;
const RATE_LIMIT_RETRY_MIN_MS = 1000;
const RATE_LIMIT_RETRY_MAX_MS = 5000;

const waitFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
const STRONG_LAST_MODIFIED_AGE_MS = 60_000;

export const PARALLEL_RANGE_SIZE = 8 * 1024 * 1024;
export const PARALLEL_RANGE_COUNT = 4;
export const MAX_PARALLEL_RANGE_SIZE = 256 * 1024 * 1024;

export function getRangeSizeForRequestBudget(
  totalBytes: number,
  maxRanges: number
): number {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return PARALLEL_RANGE_SIZE;
  }
  const units = Math.ceil(totalBytes / (maxRanges * PARALLEL_RANGE_SIZE));
  return Math.min(
    MAX_PARALLEL_RANGE_SIZE,
    Math.max(PARALLEL_RANGE_SIZE, units * PARALLEL_RANGE_SIZE)
  );
}

export class ParallelRangeUnsupportedError extends Error {
  readonly retryable = true;
}

export class ParallelRangeHttpStatusError extends Error {
  constructor(
    readonly statusCode: number,
    readonly retryAfter: string | null
  ) {
    super(`Byte range server returned HTTP ${statusCode}`);
  }
}

export function shouldDowngradeParallelRanges(
  error: unknown,
  failureCount: number
): boolean {
  return (
    error instanceof ParallelRangeUnsupportedError ||
    failureCount >= PARALLEL_RANGE_FAILURE_LIMIT
  );
}

/**
 * Fork: connection count to use after a parallel attempt failed, or null to
 * stop using byte ranges. Upstream switched to a single connection after any
 * two transient failures, which on per-connection throttled hosters dropped
 * the rest of the download to a few MB/s. Now only a server that does not
 * honour ranges disables them; rate limits halve the connections down to 2,
 * other transient failures down to 4.
 */
export function reduceParallelConnections(
  current: number,
  error: unknown
): number | null {
  if (error instanceof ParallelRangeUnsupportedError) return null;

  const rateLimited =
    error instanceof ParallelRangeHttpStatusError &&
    (error.statusCode === 429 || error.statusCode === 503);
  const minimum = rateLimited ? 2 : 4;

  if (current <= minimum) return current;
  return Math.max(minimum, Math.floor(current / 2));
}

export function getRangeTotal(
  response: Response,
  start: number,
  end: number
): number | null {
  if (response.status !== 206) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(
    response.headers.get("content-range") ?? ""
  );
  if (!match) return null;

  const [, actualStart, actualEnd, totalValue] = match;
  const total = Number(totalValue);
  const encoding = response.headers.get("content-encoding")?.toLowerCase();
  if (
    Number(actualStart) !== start ||
    Number(actualEnd) !== Math.min(end, total - 1) ||
    !Number.isSafeInteger(total) ||
    total <= start ||
    (encoding && encoding !== "identity")
  ) {
    return null;
  }

  const length = response.headers.get("content-length");
  if (length && Number(length) !== Number(actualEnd) - start + 1) {
    return null;
  }
  return total;
}

export function getStrongRangeValidator(response: Response): string | null {
  const etag = response.headers.get("etag");
  if (etag !== null) {
    return /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) ? etag : null;
  }
  const modified = response.headers.get("last-modified");
  const date = response.headers.get("date");
  // RFC 9110 8.8.2.2 permits a date validator when the clocks are far enough
  // apart. Keep the conservative 60-second margin used by older HTTP specs.
  return modified &&
    date &&
    Number.isFinite(Date.parse(modified)) &&
    Number.isFinite(Date.parse(date)) &&
    Date.parse(date) - Date.parse(modified) >= STRONG_LAST_MODIFIED_AGE_MS
    ? modified
    : null;
}

export function getRangeResumeCapability(
  response: Response,
  requestedRange: string | undefined,
  ifRange?: string
): "unknown" | "supported" | "unsupported" {
  const range = /^bytes=(\d+)-(\d*)$/.exec(requestedRange ?? "");
  if (!range) return "unknown";
  if (
    /^(text\/html|application\/xhtml)/i.test(
      response.headers.get("content-type") ?? ""
    )
  ) {
    return "unknown";
  }
  // A changed If-Range validator legitimately returns the entire resource.
  if (response.status === 200) return ifRange ? "unknown" : "unsupported";
  const start = Number(range[1]);
  const end = range[2] ? Number(range[2]) : Number.MAX_SAFE_INTEGER;
  return getRangeTotal(response, start, end) !== null ? "supported" : "unknown";
}

export interface ParallelRangeDownloadOptions {
  url: string;
  headers: Record<string, string>;
  firstResponse: Response;
  filePath: string;
  startByte: number;
  total: number;
  rangeSize?: number;
  connectionCount?: number;
  maxRanges?: number;
  resourceId?: string;
  signal: AbortSignal;
  abort: () => void;
  beforeChunk: (length: number) => Promise<void>;
  beforeComplete?: () => Promise<void>;
  afterChunk: (length: number) => void;
  onReadPending: (offset: number, pending: boolean) => void;
}

interface ByteRange {
  start: number;
  end: number;
}

export async function downloadParallelRanges({
  url,
  headers,
  firstResponse,
  filePath,
  startByte,
  total,
  rangeSize = PARALLEL_RANGE_SIZE,
  connectionCount = PARALLEL_RANGE_COUNT,
  maxRanges = Infinity,
  resourceId,
  signal,
  abort,
  beforeChunk,
  beforeComplete,
  afterChunk,
  onReadPending,
}: ParallelRangeDownloadOptions): Promise<boolean> {
  const validator = getStrongRangeValidator(firstResponse);
  if (!validator) {
    await firstResponse.body?.cancel();
    throw new ParallelRangeUnsupportedError(
      "The download server did not provide a byte-range validator"
    );
  }
  const saved = readRangeState(filePath);
  if (
    saved &&
    (saved.total !== total ||
      saved.validator !== validator ||
      saved.resourceId !== rangeResourceId(resourceId))
  ) {
    await firstResponse.body?.cancel();
    throw new Error(
      "The download resource changed. Keeping the saved partial file."
    );
  }
  if (
    !Number.isSafeInteger(rangeSize) ||
    rangeSize <= 0 ||
    !Number.isSafeInteger(connectionCount) ||
    connectionCount < 1 ||
    connectionCount > MAX_PARALLEL_CONNECTIONS ||
    !(
      maxRanges === Infinity ||
      (Number.isSafeInteger(maxRanges) && maxRanges > 0)
    )
  ) {
    await firstResponse.body?.cancel();
    throw new Error("Invalid parallel download limits");
  }
  const state: RangeDownloadState = saved ?? {
    version: 1,
    total,
    validator,
    resourceId: rangeResourceId(resourceId),
    ranges: startByte > 0 ? [[0, startByte]] : [],
  };
  const jobs: ByteRange[] = [];
  // Fork: when every connection starts with an equally sized range they all
  // finish (and pause for a new request) at the same moment, which shows up
  // as a regular dip in speed. Staggering the first round of ranges keeps the
  // request gaps spread out. Request-budgeted downloads keep equal ranges.
  const staggerFirstRound = maxRanges === Infinity && connectionCount > 1;
  const rangeSizeFor = (index: number) =>
    staggerFirstRound && index > 0 && index < connectionCount
      ? Math.max(1, Math.round((rangeSize * index) / connectionCount))
      : rangeSize;
  for (const [start, end] of missingRanges(state)) {
    for (let offset = start; offset < end && jobs.length < maxRanges; ) {
      const next = Math.min(offset + rangeSizeFor(jobs.length), end);
      jobs.push({ start: offset, end: next - 1 });
      offset = next;
    }
    if (jobs.length >= maxRanges) break;
  }
  const file = await fs.promises.open(filePath, "r+");
  let lastCheckpoint = Date.now();
  let checkpoint: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    // Snapshot before sync so the map never claims bytes that sync did not see.
    const snapshot = {
      ...state,
      ranges: state.ranges.map(([start, end]): [number, number] => [
        start,
        end,
      ]),
    };
    checkpoint = checkpoint.then(async () => {
      await file.sync();
      await saveRangeState(filePath, snapshot);
    });
    return checkpoint;
  };
  let checkpointError: unknown = null;
  const persistInBackground = () => {
    persist().catch((error: unknown) => {
      checkpointError ??= error;
    });
  };
  let nextJob = 0;
  let firstUsed = false;
  let activeConnections = 0;
  const rateLimitedRanges = new Set<number>();
  // Numbers ranges in log messages.
  let rangeCounter = 0;
  const stallRetries = new Map<number, number>();
  const runRange = async (range: ByteRange): Promise<void> => {
    signal.throwIfAborted();
    const rangeNumber = ++rangeCounter;

    // Per-range stall watchdog; re-armed whenever data arrives.
    const rangeController = new AbortController();
    const abortRange = () => rangeController.abort(signal.reason);
    signal.addEventListener("abort", abortRange, { once: true });
    let stalled = false;
    let cancelBody: (() => void) | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        rangeController.abort();
        cancelBody?.();
      }, RANGE_STALL_TIMEOUT_MS);
    };
    const stopStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
      signal.removeEventListener("abort", abortRange);
    };

    const requeueRemainder = (receivedBytes: number) => {
      const retries = (stallRetries.get(range.start) ?? 0) + 1;
      stallRetries.set(range.start, retries);
      if (retries > MAX_RANGE_STALL_RETRIES) {
        const error = new Error("A byte range stalled repeatedly") as Error & {
          retryable: boolean;
        };
        error.retryable = true;
        throw error;
      }
      const remainder = { start: range.start + receivedBytes, end: range.end };
      stallRetries.set(remainder.start, retries);
      // Next in line, so the first free connection resumes it right away
      // instead of leaving it for the very end of the download.
      jobs.splice(nextJob, 0, remainder);
      logger.log(
        `[JsHttpDownloader] Range #${rangeNumber} stalled for ${RANGE_STALL_TIMEOUT_MS / 1000}s; retrying only that range (${retries}/${MAX_RANGE_STALL_RETRIES})`
      );
    };

    armStallTimer();
    let response: Response;
    const probeTotal = getRangeTotal(firstResponse, range.start, range.end);
    if (!firstUsed && probeTotal === total) {
      firstUsed = true;
      response = firstResponse;
    } else {
      onReadPending(range.start, true);
      try {
        response = await fetch(url, {
          headers: {
            ...headers,
            Range: `bytes=${range.start}-${range.end}`,
            "If-Range": validator,
          },
          signal: rangeController.signal,
        });
      } catch (error) {
        if (stalled && !signal.aborted) {
          stopStallTimer();
          requeueRemainder(0);
          return;
        }
        stopStallTimer();
        throw error;
      } finally {
        onReadPending(range.start, false);
      }
    }
    if (
      (response.status === 429 || response.status === 503) &&
      activeConnections > 1
    ) {
      await response.body?.cancel().catch(() => undefined);
      stopStallTimer();
      jobs.splice(nextJob, 0, range);

      // A single 429 is often momentary (a just-finished connection still
      // counted by the server): wait and try again before giving up a
      // connection for good.
      if (!rateLimitedRanges.has(range.start)) {
        rateLimitedRanges.add(range.start);
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const waitMs = Math.min(
          RATE_LIMIT_RETRY_MAX_MS,
          Math.max(
            RATE_LIMIT_RETRY_MIN_MS,
            Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0
          )
        );
        await waitFor(waitMs, signal);
        return;
      }

      activeConnections -= 1;
      logger.log(
        `[JsHttpDownloader] Server limited parallel connections (HTTP ${response.status}); continuing with ${activeConnections}`
      );
      throw new RetireConnectionSignal();
    }
    rateLimitedRanges.delete(range.start);
    if (
      getRangeTotal(response, range.start, range.end) !== total ||
      getStrongRangeValidator(response) !== validator
    ) {
      await response.body?.cancel();
      stopStallTimer();
      if (response.status >= 400) {
        throw new ParallelRangeHttpStatusError(
          response.status,
          response.headers.get("retry-after")
        );
      }
      throw new ParallelRangeUnsupportedError(
        "The download server stopped serving matching byte ranges"
      );
    }
    if (!response.body) {
      stopStallTimer();
      throw new Error("Range response body is null");
    }
    const reader = response.body.getReader();
    cancelBody = () => {
      reader.cancel().catch(() => undefined);
    };
    armStallTimer();
    let received = 0;
    const writeChunk = async (
      chunk: Uint8Array,
      written = 0
    ): Promise<void> => {
      if (written === chunk.length) return;
      const offset = range.start + received;
      const result = await file.write(
        chunk,
        written,
        chunk.length - written,
        offset
      );
      if (!result.bytesWritten)
        throw new Error("Could not write the downloaded byte range");
      markSavedRange(state, offset, offset + result.bytesWritten);
      received += result.bytesWritten;
      afterChunk(result.bytesWritten);
      return writeChunk(chunk, written + result.bytesWritten);
    };
    try {
      const chunks: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            onReadPending(range.start, true);
            try {
              return await reader.read();
            } finally {
              onReadPending(range.start, false);
            }
          },
        }),
      };
      // Bytes held in memory are not marked as saved until written, so a
      // pause or failure only re-downloads them; the saved map stays exact.
      let pendingChunks: Uint8Array[] = [];
      let pendingBytes = 0;
      const flushPending = async () => {
        if (pendingBytes === 0) return;
        const block =
          pendingChunks.length === 1
            ? pendingChunks[0]
            : Buffer.concat(pendingChunks, pendingBytes);
        pendingChunks = [];
        pendingBytes = 0;
        await writeChunk(block);
      };
      for await (const chunk of chunks) {
        if (
          received + pendingBytes + chunk.length >
          range.end - range.start + 1
        ) {
          throw new ParallelRangeUnsupportedError(
            "The server sent more data than the requested byte range"
          );
        }
        armStallTimer();
        await beforeChunk(chunk.length);
        signal.throwIfAborted();
        if (checkpointError) throw checkpointError;
        pendingChunks.push(chunk);
        pendingBytes += chunk.length;
        if (pendingBytes >= WRITE_BATCH_BYTES) await flushPending();
        if (Date.now() - lastCheckpoint >= RANGE_CHECKPOINT_INTERVAL_MS) {
          lastCheckpoint = Date.now();
          persistInBackground();
        }
        signal.throwIfAborted();
      }
      await flushPending();
    } catch (error) {
      // A stalled body read may reject instead of ending; keep what was
      // written and retry the rest of this range only.
      if (!stalled || signal.aborted) throw error;
    } finally {
      stopStallTimer();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (stalled && !signal.aborted && received < range.end - range.start + 1) {
      requeueRemainder(received);
      return;
    }
    if (received !== range.end - range.start + 1) {
      const error = new Error(
        "Byte range ended before its expected size"
      ) as Error & { retryable: boolean };
      error.retryable = true;
      throw error;
    }
  };
  const worker = () => {
    activeConnections += 1;
    return runDownloadQueue(() => {
      const job = jobs[nextJob++];
      return job ? runRange(job) : undefined;
    }, signal).then(
      () => {
        // Ran out of work; no longer counts as an open connection.
        activeConnections -= 1;
      },
      (error: unknown) => {
        // A retired connection was already uncounted; the others carry on.
        if (error instanceof RetireConnectionSignal) return;
        throw error;
      }
    );
  };
  const startWorker = async (index: number) => {
    if (index > 0) {
      await waitFor(index * CONNECTION_START_INTERVAL_MS, signal);
    }
    return worker();
  };
  let workers: Promise<void>[] = [];
  try {
    await persist();
    workers = Array.from(
      { length: Math.min(connectionCount, jobs.length) },
      (_, index) => startWorker(index)
    );
    try {
      await Promise.all(workers);
    } catch (error) {
      abort();
      await Promise.allSettled(workers);
      throw error;
    }
    return missingRanges(state).length === 0;
  } finally {
    try {
      await persist();
    } finally {
      await file.close();
      if (!firstUsed) await firstResponse.body?.cancel().catch(() => undefined);
    }
    if (missingRanges(state).length === 0) {
      await beforeComplete?.();
      removeRangeState(filePath);
    }
  }
}
