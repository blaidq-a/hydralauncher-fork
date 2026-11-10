// Fork: runs one JsHttpDownloader inside a worker thread so network, TLS and
// disk work never compete with the Electron main thread (window moves, IPC).
// The main process talks to it through ThreadedJsHttpDownloader.
import { parentPort, workerData } from "node:worker_threads";

import { setDownloadLogger } from "./download-logger";
import { JsHttpDownloader } from "./js-http-downloader";
import { configureRangeStateDirectory } from "./range-download-state";
import type {
  DownloadWorkerRequest,
  DownloadWorkerResponse,
  SerializedDownloadError,
} from "./threaded-js-http-downloader-protocol";

const port = parentPort;
if (!port) throw new Error("The download worker must run in a worker thread");

const STATUS_INTERVAL_MS = 250;

const send = (message: DownloadWorkerResponse) => port.postMessage(message);

const formatLogArgument = (value: unknown): string => {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const forward =
  (level: "log" | "info" | "warn" | "error") =>
  (...args: unknown[]) =>
    send({ type: "log", level, args: args.map(formatLogArgument) });

setDownloadLogger({
  log: forward("log"),
  info: forward("info"),
  warn: forward("warn"),
  error: forward("error"),
});

const serializeError = (error: unknown): SerializedDownloadError => {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error), props: {} };
  }

  const props: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(error)) {
    if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    ) {
      props[key] = value as string | number | boolean | null;
    }
  }

  const cause = error.cause as
    | { message?: unknown; code?: unknown }
    | undefined;

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    props,
    cause: cause
      ? {
          message:
            typeof cause.message === "string" ? cause.message : undefined,
          code: typeof cause.code === "string" ? cause.code : undefined,
        }
      : undefined,
  };
};

const { rangeStateDirectory } = workerData as { rangeStateDirectory?: string };
if (rangeStateDirectory) configureRangeStateDirectory(rangeStateDirectory);

const downloader = new JsHttpDownloader();

const sendStatus = () =>
  send({ type: "status", status: downloader.getDownloadStatus() });

const statusTimer = setInterval(sendStatus, STATUS_INTERVAL_MS);

port.on("message", (message: DownloadWorkerRequest) => {
  switch (message.type) {
    case "start":
      downloader.startDownload(message.options).then(
        () => {
          sendStatus();
          send({ type: "settled", id: message.id });
        },
        (error: unknown) => {
          sendStatus();
          send({
            type: "settled",
            id: message.id,
            error: serializeError(error),
          });
        }
      );
      break;
    case "pause":
      downloader.pauseDownload();
      sendStatus();
      break;
    case "cancel":
      downloader.cancelDownload(message.deleteFile);
      sendStatus();
      send({ type: "settled", id: message.id });
      break;
    case "waitForIdle":
      downloader.waitForIdle().then(
        () => send({ type: "settled", id: message.id }),
        () => send({ type: "settled", id: message.id })
      );
      break;
    case "setSpeedLimit":
      downloader.setMaxDownloadSpeedBytesPerSecond(message.limit);
      break;
    case "reconnect":
      downloader.reconnect();
      break;
    case "setReconnecting":
      downloader.setReconnecting(message.value);
      sendStatus();
      break;
    case "dispose":
      clearInterval(statusTimer);
      port.close();
      break;
  }
});
