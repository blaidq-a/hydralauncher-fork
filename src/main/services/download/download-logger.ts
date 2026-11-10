// Fork: the HTTP downloader also runs inside a worker thread, where the
// Electron-bound app logger is not available. It logs through this small
// bridge instead; the main process points it at the app logger and the worker
// forwards entries to the main process.

type LogMethod = (...args: unknown[]) => void;

export interface DownloadLogger {
  log: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

let target: DownloadLogger | null = null;

export const setDownloadLogger = (next: DownloadLogger | null) => {
  target = next;
};

export const logger: DownloadLogger = {
  log: (...args) => target?.log(...args),
  info: (...args) => target?.info(...args),
  warn: (...args) => target?.warn(...args),
  error: (...args) => target?.error(...args),
};
