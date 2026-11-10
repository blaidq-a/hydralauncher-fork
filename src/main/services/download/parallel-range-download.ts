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
const CONNECTION_START_INTERVAL_MS = 500;
const RATE_LIMIT_RETRY_MIN_MS = 2000;
const RATE_LIMIT_RETRY_MAX_MS = 16_000;
/**
 * Fork: a refused request is retried on the same connection with a growing
 * wait (2, 4, 8, 16 s) before the connection is given up. Gofile keeps
 * counting just-closed connections for a while; dropping one after a few
 * seconds made the speed fall for the ~15 s it took to add it back.
 */
const RATE_LIMIT_RETRIES_PER_RANGE = 4;
/**
 * Fork: a connection error (connect timeout, reset) on one range retries
 * only that range. Upstream failed the whole attempt, which closed every
 * connection, halved their number and triggered 429s on reconnect.
 */
const NETWORK_RETRY_DELAY_MS = 1000;
const isNetworkError = (error: unknown): boolean => {
  if (error instanceof TypeError) return true; // undici "fetch failed"/"terminated"
  const code =
    (error as { code?: unknown; cause?: { code?: unknown } })?.cause?.code ??
    (error as { code?: unknown })?.code;
  return (
    typeof code === "string" &&
    /^(UND_ERR|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH)/.test(
      code
    )
  );
};
/**
 * Fork: hosts like Gofile return an occasional 429 when a connection asks
 * for its next range; without this the connection count only went down over
 * a long download. After a quiet period a dropped connection is added back.
 */
const CONNECTION_REGROW_QUIET_MS = 15_000;
const CONNECTION_REGROW_CHECK_MS = 5_000;
/**
 * Fork: after a 429 the connection count that triggered it becomes a ceiling,
 * so the download does not keep hitting the host's limit (seen on Gofile:
 * 15 -> 12 -> 15 -> 12 every ~30 s). The ceiling is raised one step only
 * after a long quiet period. 429s arriving together count as one event.
 */
const CONNECTION_CEILING_PROBE_QUIET_MS = 60_000;
// Fork: 429s keep arriving for a while once a host starts refusing; lowering
// the limit on each one walked Gofile down from 13 to 6 connections in 20 s.
const RATE_LIMIT_BURST_WINDOW_MS = 15_000;
/**
 * Fork: like FDM, a connection that runs out of work takes over the second
 * half of the largest range still downloading instead of stopping. With
 * very large ranges each connection makes one request for a big part of the
 * file, so hosts that refuse frequent requests (Gofile) are rarely asked.
 */
const MIN_SPLIT_BYTES = 16 * 1024 * 1024;

const describeError = (error: unknown) => {
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string"
    ? code
    : error instanceof Error
      ? error.message
      : String(error);
};

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
  // Fork: large hoster ranges are shrunk for small files so every
  // connection still gets a range.
  if (maxRanges === Infinity) {
    const remaining = missingRanges(state).reduce(
      (sum, [start, end]) => sum + end - start,
      0
    );
    rangeSize = Math.min(
      rangeSize,
      Math.max(PARALLEL_RANGE_SIZE, Math.ceil(remaining / connectionCount))
    );
  }
  const rangeSizeFor = (index: number) =>
    staggerFirstRound && index > 0 && index < connectionCount
      ? Math.max(1, Math.round((rangeSize * index) / connectionCount))
      : rangeSize;
  // Fork: reuse the first response for whatever range it covers, so a
  // response for a whole large range is not left open unused.
  const probeRange = /^bytes (\d+)-(\d+)\//i.exec(
    firstResponse.status === 206
      ? (firstResponse.headers.get("content-range") ?? "")
      : ""
  );
  for (const [start, end] of missingRanges(state)) {
    let offset = start;
    if (
      jobs.length === 0 &&
      maxRanges === Infinity &&
      probeRange &&
      Number(probeRange[1]) === start &&
      Number(probeRange[2]) < end
    ) {
      offset = Number(probeRange[2]) + 1;
      jobs.push({ start, end: offset - 1 });
    }
    while (offset < end && jobs.length < maxRanges) {
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
  // Starts "quiet" now, so connections are only added back after the
  // initial ramp-up has had time to settle.
  let lastRateLimitAt = Date.now();
  let pendingStarts = 0;
  let connectionCeiling = Number.POSITIVE_INFINITY;
  let lastCeilingDropAt = 0;
  const rateLimitedRanges = new Map<number, number>();
  // Ranges currently streaming, with how far each has got (written plus
  // buffered bytes); used to split the largest one for an idle connection.
  const streamingRanges = new Map<ByteRange, () => number>();
  const splittableRange = () => {
    if (maxRanges !== Infinity) return null;
    let best: ByteRange | null = null;
    let bestRemaining = 2 * MIN_SPLIT_BYTES - 1;
    for (const [range, streamed] of streamingRanges) {
      const remaining = range.end + 1 - (range.start + streamed());
      if (remaining > bestRemaining) {
        best = range;
        bestRemaining = remaining;
      }
    }
    return best ? { range: best, remaining: bestRemaining } : null;
  };
  const splitLargestRange = (): ByteRange | undefined => {
    const candidate = splittableRange();
    if (!candidate) return undefined;
    const { range, remaining } = candidate;
    const middle = range.end + 1 - Math.floor(remaining / 2);
    const job = { start: middle, end: range.end };
    // The running connection stops reading at its new end.
    range.end = middle - 1;
    return job;
  };
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

    const requeueRemainder = (receivedBytes: number, reason?: string) => {
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
        `[JsHttpDownloader] Range #${rangeNumber} ${reason ?? `stalled for ${RANGE_STALL_TIMEOUT_MS / 1000}s`}; retrying only that range (${retries}/${MAX_RANGE_STALL_RETRIES})`
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
        if (!signal.aborted && isNetworkError(error)) {
          requeueRemainder(0, `could not connect (${describeError(error)})`);
          await waitFor(NETWORK_RETRY_DELAY_MS, signal);
          return;
        }
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
      lastRateLimitAt = Date.now();

      // A single 429 is often momentary (a just-finished connection still
      // counted by the server): wait and try again before giving up a
      // connection for good.
      const rateLimitAttempts = rateLimitedRanges.get(range.start) ?? 0;
      if (rateLimitAttempts < RATE_LIMIT_RETRIES_PER_RANGE) {
        rateLimitedRanges.set(range.start, rateLimitAttempts + 1);
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const waitMs = Math.min(
          RATE_LIMIT_RETRY_MAX_MS,
          Math.max(
            RATE_LIMIT_RETRY_MIN_MS * 2 ** rateLimitAttempts,
            Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0
          )
        );
        await waitFor(waitMs, signal);
        return;
      }

      const connectionsAtLimit = activeConnections;
      activeConnections -= 1;
      // One limit hit lowers the ceiling by one; the rest of a burst of
      // simultaneous refusals is refilled by the regrow timer.
      if (Date.now() - lastCeilingDropAt > RATE_LIMIT_BURST_WINDOW_MS) {
        connectionCeiling = Math.max(1, connectionsAtLimit - 1);
        lastCeilingDropAt = Date.now();
      }
      logger.log(
        `[JsHttpDownloader] Server limited parallel connections (HTTP ${response.status}); continuing with ${activeConnections}, limit ${connectionCeiling}`
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
    let buffered = 0;
    let networkError: unknown = null;
    // The request covered this much even if the range is split later.
    const requestedLength = range.end - range.start + 1;
    streamingRanges.set(range, () => received + buffered);
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
        buffered = 0;
        await writeChunk(block);
      };
      for await (const chunk of chunks) {
        if (received + pendingBytes + chunk.length > requestedLength) {
          throw new ParallelRangeUnsupportedError(
            "The server sent more data than the requested byte range"
          );
        }
        armStallTimer();
        await beforeChunk(chunk.length);
        signal.throwIfAborted();
        if (checkpointError) throw checkpointError;
        // Another connection may have taken over the end of this range.
        const room = range.end - range.start + 1 - received - pendingBytes;
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (part.length > 0) {
          pendingChunks.push(part);
          pendingBytes += part.length;
          buffered = pendingBytes;
        }
        if (
          pendingBytes >= WRITE_BATCH_BYTES ||
          received + pendingBytes >= range.end - range.start + 1
        ) {
          await flushPending();
        }
        if (received >= range.end - range.start + 1) break;
        if (Date.now() - lastCheckpoint >= RANGE_CHECKPOINT_INTERVAL_MS) {
          lastCheckpoint = Date.now();
          persistInBackground();
        }
        signal.throwIfAborted();
      }
      await flushPending();
    } catch (error) {
      // A stalled or dropped body read rejects; keep what was written and
      // retry the rest of this range only.
      if (signal.aborted) throw error;
      if (!stalled) {
        if (!isNetworkError(error)) throw error;
        networkError = error;
      }
    } finally {
      streamingRanges.delete(range);
      stopStallTimer();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (stalled && !signal.aborted && received < range.end - range.start + 1) {
      requeueRemainder(received);
      return;
    }
    if (networkError && received < range.end - range.start + 1) {
      requeueRemainder(
        received,
        `lost its connection (${describeError(networkError)})`
      );
      await waitFor(NETWORK_RETRY_DELAY_MS, signal);
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
      // Fork: a requeued range is inserted at nextJob, so nextJob must not
      // run past the end of the list.
      if (nextJob < jobs.length) return runRange(jobs[nextJob++]);
      const split = splitLargestRange();
      return split ? runRange(split) : undefined;
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
      pendingStarts += 1;
      try {
        await waitFor(index * CONNECTION_START_INTERVAL_MS, signal);
      } finally {
        pendingStarts -= 1;
      }
    }
    return worker();
  };
  // Workers can be added while the download runs (see regrow below), so
  // track them in a set and wait until all of them settle.
  const runningWorkers = new Set<Promise<void>>();
  let workerError: unknown = null;
  let hasWorkerError = false;
  const track = (run: Promise<void>) => {
    const tracked: Promise<void> = run
      .catch((error: unknown) => {
        if (!hasWorkerError) {
          hasWorkerError = true;
          workerError = error;
          abort();
        }
      })
      .finally(() => runningWorkers.delete(tracked));
    runningWorkers.add(tracked);
  };
  // With splitting, every connection can get work even if there are fewer
  // ranges than connections at the start.
  const targetConnections =
    maxRanges === Infinity
      ? connectionCount
      : Math.min(connectionCount, jobs.length);
  const regrowTimer = setInterval(() => {
    const quietFor = Date.now() - lastRateLimitAt;
    if (
      hasWorkerError ||
      signal.aborted ||
      activeConnections + pendingStarts >= targetConnections ||
      (nextJob >= jobs.length && !splittableRange()) ||
      quietFor < CONNECTION_REGROW_QUIET_MS
    ) {
      return;
    }
    if (activeConnections + pendingStarts >= connectionCeiling) {
      // Probe one connection above the learned limit after a long quiet.
      if (quietFor < CONNECTION_CEILING_PROBE_QUIET_MS) return;
      connectionCeiling += 1;
      lastRateLimitAt = Date.now();
    }
    track(worker());
    logger.log(
      `[JsHttpDownloader] Adding a connection back (${activeConnections}/${Math.min(targetConnections, connectionCeiling)})`
    );
  }, CONNECTION_REGROW_CHECK_MS);
  try {
    await persist();
    for (let index = 0; index < targetConnections; index++) {
      track(startWorker(index));
    }
    while (runningWorkers.size > 0) {
      await Promise.race(runningWorkers);
    }
    if (hasWorkerError) throw workerError;
    return missingRanges(state).length === 0;
  } finally {
    clearInterval(regrowTimer);
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
