// Fork: main-process side of a JsHttpDownloader that runs in a worker thread.
// High-speed downloads used to saturate the Electron main thread (network
// chunks, TLS and file writes), which made the window move at ~10 fps. The
// worker does all of that work; this class mirrors the JsHttpDownloader API
// so DownloadManager can use either one.
import type { Worker, WorkerOptions } from "node:worker_threads";

import createDownloadWorker from "./js-http-downloader.worker?nodeWorker";
import { logger } from "../logger";
import type { JsHttpDownloaderStatus } from "./js-http-downloader";
import { getRangeStateDirectory } from "./range-download-state.js";
import type {
  DownloadWorkerRequest,
  DownloadWorkerResponse,
  SerializedDownloadError,
  ThreadedDownloadOptions,
} from "./threaded-js-http-downloader-protocol";

export type DownloadWorkerFactory = (options: WorkerOptions) => Worker;

const deserializeError = (serialized: SerializedDownloadError): Error => {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack) error.stack = serialized.stack;
  Object.assign(error, serialized.props);
  if (serialized.cause) {
    error.cause = Object.assign(new Error(serialized.cause.message ?? ""), {
      code: serialized.cause.code,
    });
  }
  return error;
};

export class ThreadedJsHttpDownloader {
  /** Paused downloaders keep their worker until a newer download starts. */
  private static readonly idleInstances = new Set<ThreadedJsHttpDownloader>();

  private worker: Worker | null = null;
  private status: JsHttpDownloaderStatus | null = null;
  private speedLimit: number | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private activeRun: Promise<void> | null = null;

  constructor(
    private readonly createWorker: DownloadWorkerFactory = createDownloadWorker
  ) {}

  /** Returns null when a worker thread cannot be started here. */
  static tryCreate(
    createWorker: DownloadWorkerFactory = createDownloadWorker
  ): ThreadedJsHttpDownloader | null {
    const downloader = new ThreadedJsHttpDownloader(createWorker);
    try {
      downloader.ensureWorker();
      return downloader;
    } catch (error) {
      logger.error(
        "[ThreadedJsHttpDownloader] Could not start a download worker; downloading in the main process",
        error
      );
      return null;
    }
  }

  setMaxDownloadSpeedBytesPerSecond(limit: number | null): void {
    this.speedLimit = limit;
    this.post({ type: "setSpeedLimit", limit });
  }

  async startDownload(options: ThreadedDownloadOptions): Promise<void> {
    if (this.activeRun) {
      logger.log(
        "[ThreadedJsHttpDownloader] Download already in progress, resuming..."
      );
      return this.waitForIdle();
    }

    // Only one download runs at a time; release workers of older paused runs.
    for (const instance of ThreadedJsHttpDownloader.idleInstances) {
      if (instance !== this) instance.dispose();
    }
    ThreadedJsHttpDownloader.idleInstances.delete(this);

    const worker = this.ensureWorker();
    this.post({ type: "setSpeedLimit", limit: this.speedLimit });
    this.status = { ...(this.status ?? this.emptyStatus()), status: "active" };

    const run = this.request((id) => ({ type: "start", id, options }));
    this.activeRun = run;

    try {
      await run;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
      if (this.worker === worker) {
        if (this.status?.status === "paused") {
          ThreadedJsHttpDownloader.idleInstances.add(this);
        } else {
          this.dispose();
        }
      }
    }
  }

  async waitForIdle(): Promise<void> {
    if (!this.activeRun) return;
    await this.activeRun.catch(() => undefined);
  }

  pauseDownload(): void {
    if (this.status && this.status.status === "active") {
      this.status = { ...this.status, status: "paused", downloadSpeed: 0 };
    }
    this.post({ type: "pause" });
  }

  cancelDownload(deleteFile = true): void {
    ThreadedJsHttpDownloader.idleInstances.delete(this);
    if (!this.worker) return;

    const worker = this.worker;
    this.request((id) => ({ type: "cancel", id, deleteFile }))
      .catch((error: unknown) =>
        logger.error("[ThreadedJsHttpDownloader] Cancel failed", error)
      )
      .finally(() => {
        if (this.worker === worker && !this.activeRun) this.dispose();
      });
    this.status = null;
  }

  getDownloadStatus(): JsHttpDownloaderStatus | null {
    return this.status;
  }

  reconnect(): void {
    this.post({ type: "reconnect" });
  }

  setReconnecting(value: boolean): void {
    if (this.status) {
      this.status = {
        ...this.status,
        isReconnecting: value,
        downloadSpeed: value ? 0 : this.status.downloadSpeed,
      };
    }
    this.post({ type: "setReconnecting", value });
  }

  /** Stops the worker thread; any request still pending is rejected. */
  dispose(): void {
    ThreadedJsHttpDownloader.idleInstances.delete(this);
    const worker = this.worker;
    if (!worker) return;

    this.worker = null;
    worker.postMessage({ type: "dispose" } satisfies DownloadWorkerRequest);
    void worker.terminate();
    this.rejectPending(new Error("The download worker was stopped"));
  }

  private emptyStatus(): JsHttpDownloaderStatus {
    return {
      folderName: "",
      fileSize: 0,
      progress: 0,
      downloadSpeed: 0,
      numPeers: 0,
      numSeeds: 0,
      status: "paused",
      bytesDownloaded: 0,
      isReconnecting: false,
      isRecovering: false,
      recoveryProgress: 0,
    };
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = this.createWorker({
      workerData: { rangeStateDirectory: getRangeStateDirectory() },
    });
    worker.on("message", (message: DownloadWorkerResponse) =>
      this.handleMessage(message)
    );
    worker.on("error", (error) => {
      logger.error("[ThreadedJsHttpDownloader] Download worker crashed", error);
      this.failWorker(worker, error);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.failWorker(
          worker,
          new Error(`The download worker exited unexpectedly (${code})`)
        );
      }
    });

    this.worker = worker;
    return worker;
  }

  private failWorker(worker: Worker, error: Error) {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.status) this.status = { ...this.status, status: "error" };
    this.rejectPending(error);
  }

  private rejectPending(error: Error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private handleMessage(message: DownloadWorkerResponse) {
    switch (message.type) {
      case "status":
        this.status = message.status;
        break;
      case "settled": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(deserializeError(message.error));
        else pending.resolve();
        break;
      }
      case "log":
        logger[message.level](...message.args);
        break;
    }
  }

  private post(message: DownloadWorkerRequest) {
    this.worker?.postMessage(message);
  }

  private request(build: (id: number) => DownloadWorkerRequest): Promise<void> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("No download worker"));

    const id = this.nextRequestId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage(build(id));
    });
  }
}
