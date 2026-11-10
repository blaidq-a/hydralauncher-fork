import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Worker } from "node:worker_threads";

import type { JsHttpDownloaderStatus } from "./js-http-downloader.js";
import type {
  DownloadWorkerRequest,
  DownloadWorkerResponse,
} from "./threaded-js-http-downloader-protocol.js";
import { ThreadedJsHttpDownloader } from "./threaded-js-http-downloader.js";

class FakeWorker extends EventEmitter {
  readonly sent: DownloadWorkerRequest[] = [];
  terminated = false;

  postMessage(message: DownloadWorkerRequest) {
    this.sent.push(message);
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }

  reply(message: DownloadWorkerResponse) {
    this.emit("message", message);
  }

  lastRequest<T extends DownloadWorkerRequest["type"]>(type: T) {
    return [...this.sent]
      .reverse()
      .find((message) => message.type === type) as Extract<
      DownloadWorkerRequest,
      { type: T }
    >;
  }
}

const status = (
  overrides: Partial<JsHttpDownloaderStatus>
): JsHttpDownloaderStatus => ({
  folderName: "Game.rar",
  fileSize: 100,
  progress: 0.5,
  downloadSpeed: 10,
  numPeers: 0,
  numSeeds: 0,
  status: "active",
  bytesDownloaded: 50,
  isReconnecting: false,
  isRecovering: false,
  recoveryProgress: 0,
  ...overrides,
});

const create = () => {
  const workers: FakeWorker[] = [];
  const downloader = ThreadedJsHttpDownloader.tryCreate(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  assert.ok(downloader);
  return { downloader, workers };
};

const options = { url: "https://cdn.example/game.rar", savePath: "C:/Games" };

describe("ThreadedJsHttpDownloader", () => {
  it("caches worker status and stops the worker when the download completes", async () => {
    const { downloader, workers } = create();
    const [worker] = workers;

    const run = downloader.startDownload(options);
    const start = worker.lastRequest("start");
    assert.deepEqual(start.options, options);

    worker.reply({ type: "status", status: status({ bytesDownloaded: 75 }) });
    assert.equal(downloader.getDownloadStatus()?.bytesDownloaded, 75);

    worker.reply({
      type: "status",
      status: status({ status: "complete", progress: 1 }),
    });
    worker.reply({ type: "settled", id: start.id });
    await run;

    assert.equal(downloader.getDownloadStatus()?.status, "complete");
    assert.equal(worker.terminated, true);
  });

  it("rebuilds worker errors with their name, code and properties", async () => {
    const { downloader, workers } = create();
    const [worker] = workers;

    const run = downloader.startDownload(options);
    worker.reply({
      type: "status",
      status: status({ status: "error" }),
    });
    worker.reply({
      type: "settled",
      id: worker.lastRequest("start").id,
      error: {
        name: "HttpDownloadStatusError",
        message: "The download link is not available (HTTP 403).",
        props: { statusCode: 403, retryable: false },
        cause: { message: "socket hang up", code: "ECONNRESET" },
      },
    });

    await assert.rejects(run, (error: Error & Record<string, unknown>) => {
      assert.equal(error.name, "HttpDownloadStatusError");
      assert.equal(error.statusCode, 403);
      assert.equal(
        (error.cause as Error & { code?: string }).code,
        "ECONNRESET"
      );
      return true;
    });
  });

  it("pauses immediately and keeps the worker so the file can be cancelled", async () => {
    const { downloader, workers } = create();
    const [worker] = workers;

    const run = downloader.startDownload(options);
    worker.reply({ type: "status", status: status({}) });

    downloader.pauseDownload();
    assert.equal(downloader.getDownloadStatus()?.status, "paused");
    assert.equal(downloader.getDownloadStatus()?.downloadSpeed, 0);
    assert.ok(worker.lastRequest("pause"));

    worker.reply({ type: "status", status: status({ status: "paused" }) });
    worker.reply({ type: "settled", id: worker.lastRequest("start").id });
    await run;
    await downloader.waitForIdle();
    assert.equal(worker.terminated, false);

    downloader.cancelDownload();
    const cancel = worker.lastRequest("cancel");
    assert.equal(cancel.deleteFile, true);
    worker.reply({ type: "settled", id: cancel.id });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.terminated, true);
  });

  it("fails the running download when the worker crashes", async () => {
    const { downloader, workers } = create();
    const [worker] = workers;

    const run = downloader.startDownload(options);
    worker.emit("error", new Error("worker crashed"));

    await assert.rejects(run, /worker crashed/);
    assert.equal(downloader.getDownloadStatus()?.status, "error");
  });

  it("falls back when a worker thread cannot be created", () => {
    assert.equal(
      ThreadedJsHttpDownloader.tryCreate(() => {
        throw new Error("no worker support");
      }),
      null
    );
  });
});
