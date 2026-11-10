// Fork: downloads single hoster files with aria2 (bundled aria2c.exe, the
// 1.37.0 build upstream Hydra shipped before it moved to its own engine).
// aria2 keeps every connection independent: a refused or dropped connection
// is retried on its own while the others keep streaming, which held Gofile
// at full speed where the JS range engine kept dropping connections.
//
// One aria2c process runs per download and is controlled over JSON-RPC on
// 127.0.0.1 with a random secret. URL and headers (cookies, tokens) go over
// RPC, never on the command line. Pausing shuts aria2 down; its .aria2
// control file next to the download lets the next start resume.
import cp from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { app } from "electron";

import { logger } from "../logger";
import type { JsHttpDownloaderStatus } from "./js-http-downloader";

export interface Aria2DownloadOptions {
  url: string;
  savePath: string;
  filename?: string;
  headers?: Record<string, string>;
  /** Connections to the server (aria2 allows at most 16). */
  connections?: number;
}

interface Aria2Status {
  status: "active" | "waiting" | "paused" | "error" | "complete" | "removed";
  totalLength: string;
  completedLength: string;
  downloadSpeed: string;
  errorCode?: string;
  errorMessage?: string;
  files?: { path: string }[];
}

const POLL_INTERVAL_MS = 500;
const RPC_READY_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 16;

export const getAria2BinaryPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "aria2c.exe")
    : path.join(__dirname, "..", "..", "binaries", "aria2c.exe");

const getFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("Could not find a free port for aria2"))
      );
    });
  });

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Aria2Downloader {
  private process: cp.ChildProcess | null = null;
  private port = 0;
  private secret = "";
  private gid: string | null = null;
  private status: JsHttpDownloaderStatus | null = null;
  private speedLimit: number | null = null;
  private filePath: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeRun: Promise<void> | null = null;
  private settle: ((error?: Error) => void) | null = null;
  private stopping = false;

  /** Returns null where aria2 is not available (non-Windows, missing exe). */
  static tryCreate(): Aria2Downloader | null {
    if (process.platform !== "win32") return null;
    if (!fs.existsSync(getAria2BinaryPath())) {
      logger.warn("[Aria2] aria2c.exe not found; using the JS downloader");
      return null;
    }
    return new Aria2Downloader();
  }

  setMaxDownloadSpeedBytesPerSecond(limit: number | null): void {
    this.speedLimit = limit;
    if (!this.process) return;
    this.rpc("aria2.changeGlobalOption", [
      { "max-overall-download-limit": String(limit ?? 0) },
    ]).catch((error: unknown) =>
      logger.warn("[Aria2] Could not change the speed limit", error)
    );
  }

  async startDownload(options: Aria2DownloadOptions): Promise<void> {
    if (this.activeRun) return this.waitForIdle();

    this.stopping = false;
    this.status = {
      folderName: options.filename ?? "",
      fileSize: 0,
      progress: 0,
      downloadSpeed: 0,
      numPeers: 0,
      numSeeds: 0,
      status: "active",
      bytesDownloaded: 0,
      isReconnecting: false,
      isRecovering: false,
      recoveryProgress: 0,
    };

    const run = new Promise<void>((resolve, reject) => {
      this.settle = (error) => {
        this.settle = null;
        if (error) reject(error);
        else resolve();
      };
    });
    this.activeRun = run;

    try {
      await this.launch(options);
    } catch (error) {
      await this.shutdown();
      this.finish(error instanceof Error ? error : new Error(String(error)));
    }

    try {
      await run;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  async waitForIdle(): Promise<void> {
    if (!this.activeRun) return;
    await this.activeRun.catch(() => undefined);
  }

  pauseDownload(): void {
    if (this.status?.status === "active") {
      this.status = { ...this.status, status: "paused", downloadSpeed: 0 };
    }
    logger.log("[Aria2] Pausing download");
    void this.shutdown().then(() => this.finish());
  }

  cancelDownload(deleteFile = true): void {
    const filePath = this.filePath;
    this.status = null;
    void this.shutdown().then(() => {
      this.finish();
      if (!deleteFile || !filePath) return;
      for (const target of [filePath, `${filePath}.aria2`]) {
        fs.promises
          .rm(target, { force: true })
          .catch((error: unknown) =>
            logger.error(`[Aria2] Could not delete ${target}`, error)
          );
      }
    });
  }

  getDownloadStatus(): JsHttpDownloaderStatus | null {
    return this.status;
  }

  /** aria2 retries dropped connections by itself. */
  reconnect(): void {
    // Nothing to do: aria2 reconnects each connection on its own.
  }

  setReconnecting(value: boolean): void {
    if (this.status) this.status = { ...this.status, isReconnecting: value };
  }

  dispose(): void {
    void this.shutdown().then(() => this.finish());
  }

  private async launch(options: Aria2DownloadOptions) {
    this.port = await getFreePort();
    this.secret = crypto.randomBytes(24).toString("hex");
    const connections = Math.min(
      MAX_CONNECTIONS,
      Math.max(1, options.connections ?? MAX_CONNECTIONS)
    );

    const args = [
      "--enable-rpc=true",
      "--rpc-listen-all=false",
      `--rpc-listen-port=${this.port}`,
      `--rpc-secret=${this.secret}`,
      `--stop-with-process=${process.pid}`,
      "--quiet=true",
      "--console-log-level=error",
      "--summary-interval=0",
      // Resume only from aria2's own control file. A file without one may
      // be a sparse partial from the JS engine and is downloaded again.
      "--continue=false",
      "--allow-overwrite=true",
      "--auto-file-renaming=false",
      // "none" made Windows zero-fill the file up to each far-off write while
      // aria2 waited, so only one connection made progress for the first
      // 10-15 s of a large download. "trunc" sets the size up front.
      "--file-allocation=trunc",
      "--disk-cache=64M",
      "--auto-save-interval=5",
      `--max-connection-per-server=${connections}`,
      `--split=${connections}`,
      "--min-split-size=16M",
      "--max-tries=0",
      "--retry-wait=3",
      "--connect-timeout=15",
      "--timeout=30",
      "--max-file-not-found=5",
      "--content-disposition-default-utf8=true",
      "--remote-time=false",
      `--max-overall-download-limit=${this.speedLimit ?? 0}`,
    ];

    const child = cp.spawn(getAria2BinaryPath(), args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    child.stderr?.on("data", (data: Buffer) =>
      logger.warn(`[Aria2] ${data.toString().trim()}`)
    );
    child.on("exit", (code) => {
      if (this.process !== child) return;
      this.process = null;
      this.stopPolling();
      if (!this.stopping) {
        this.finish(new Error(`aria2 exited unexpectedly (code ${code})`));
      }
    });

    await this.waitForRpc();

    const headers = Object.entries(options.headers ?? {}).map(
      ([name, value]) => `${name}: ${value}`
    );
    this.gid = await this.rpc<string>("aria2.addUri", [
      [options.url],
      {
        dir: options.savePath,
        ...(options.filename ? { out: options.filename } : {}),
        header: headers,
      },
    ]);
    logger.log(
      `[Aria2] Download started with up to ${connections} connections`
    );
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private async waitForRpc() {
    const deadline = Date.now() + RPC_READY_TIMEOUT_MS;
    for (;;) {
      try {
        await this.rpc("aria2.getVersion", []);
        return;
      } catch (error) {
        if (!this.process) throw new Error("aria2 could not start");
        if (Date.now() > deadline) throw error;
        await delay(100);
      }
    }
  }

  private async poll() {
    if (!this.gid || this.stopping) return;
    let result: Aria2Status;
    try {
      result = await this.rpc<Aria2Status>("aria2.tellStatus", [
        this.gid,
        [
          "status",
          "totalLength",
          "completedLength",
          "downloadSpeed",
          "errorCode",
          "errorMessage",
          "files",
        ],
      ]);
    } catch {
      return; // The exit handler reports a crashed process.
    }
    if (this.stopping || !this.status) return;

    const total = Number(result.totalLength);
    const completed = Number(result.completedLength);
    const filePath = result.files?.[0]?.path;
    if (filePath) this.filePath = path.normalize(filePath);

    this.status = {
      ...this.status,
      folderName: filePath ? path.basename(filePath) : this.status.folderName,
      fileSize: total,
      bytesDownloaded: completed,
      progress: total > 0 ? completed / total : 0,
      downloadSpeed: Number(result.downloadSpeed),
    };

    if (result.status === "complete") {
      this.status = {
        ...this.status,
        status: "complete",
        progress: 1,
        bytesDownloaded: total,
        downloadSpeed: 0,
      };
      logger.log("[Aria2] Download complete");
      await this.shutdown();
      this.finish();
    } else if (result.status === "error" || result.status === "removed") {
      this.status = { ...this.status, status: "error", downloadSpeed: 0 };
      const error = new Error(
        `aria2 download failed: ${result.errorMessage ?? "unknown error"} (code ${result.errorCode ?? "?"})`
      );
      await this.shutdown();
      this.finish(error);
    }
  }

  private finish(error?: Error) {
    this.stopPolling();
    this.settle?.(error);
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Stops aria2; it writes its control file so the download can resume. */
  private async shutdown() {
    this.stopping = true;
    this.stopPolling();
    const child = this.process;
    if (!child) return;

    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve())
    );
    await this.rpc("aria2.forceShutdown", []).catch(() => undefined);
    const timedOut = await Promise.race([
      exited.then(() => false),
      delay(SHUTDOWN_TIMEOUT_MS).then(() => true),
    ]);
    if (timedOut) {
      logger.warn("[Aria2] aria2 did not stop in time; killing it");
      child.kill();
      await exited;
    }
    if (this.process === child) this.process = null;
  }

  private async rpc<T = unknown>(
    method: string,
    params: unknown[]
  ): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params: [`token:${this.secret}`, ...params],
      }),
    });
    const body = (await response.json()) as {
      result?: T;
      error?: { message: string };
    };
    if (body.error) throw new Error(`aria2 ${method}: ${body.error.message}`);
    return body.result as T;
  }
}
