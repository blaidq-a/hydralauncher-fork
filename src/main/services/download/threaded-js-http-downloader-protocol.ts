// Fork: messages exchanged between ThreadedJsHttpDownloader (main process)
// and js-http-downloader.worker.ts. Options must be structured-cloneable, so
// no callbacks or shared objects cross the thread boundary.
import type {
  JsHttpDownloaderOptions,
  JsHttpDownloaderStatus,
} from "./js-http-downloader";

export type ThreadedDownloadOptions = Omit<
  JsHttpDownloaderOptions,
  "refreshUrl" | "throttle" | "beforeComplete"
>;

export type DownloadWorkerRequest =
  | { type: "start"; id: number; options: ThreadedDownloadOptions }
  | { type: "pause" }
  | { type: "cancel"; id: number; deleteFile: boolean }
  | { type: "waitForIdle"; id: number }
  | { type: "setSpeedLimit"; limit: number | null }
  | { type: "reconnect" }
  | { type: "setReconnecting"; value: boolean }
  | { type: "dispose" };

export interface SerializedDownloadError {
  name: string;
  message: string;
  stack?: string;
  props: Record<string, string | number | boolean | null>;
  cause?: { message?: string; code?: string };
}

export type DownloadWorkerResponse =
  | { type: "status"; status: JsHttpDownloaderStatus | null }
  | { type: "settled"; id: number; error?: SerializedDownloadError }
  | {
      type: "log";
      level: "log" | "info" | "warn" | "error";
      args: string[];
    };
