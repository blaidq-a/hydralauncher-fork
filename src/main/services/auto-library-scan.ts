// Fork: keeps the library in sync with the default downloads folder. Runs the
// installed-games scan shortly after startup and again whenever a new folder
// shows up in the downloads path, adding games without asking.
import fs from "node:fs";

import { getDownloadsPath } from "@main/events/helpers/get-downloads-path";
import { logger } from "./logger";

const STARTUP_DELAY_MS = 60 * 1000;
/** Gives copies/extractions time to finish before the folder is inspected. */
const NEW_FOLDER_DELAY_MS = 3 * 60 * 1000;

let watcher: fs.FSWatcher | null = null;
let watchedPath: string | null = null;
let scanTimer: NodeJS.Timeout | null = null;

const scheduleScan = (delayMs: number) => {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanTimer = null;
    void runScan();
  }, delayMs);
};

const ensureWatcher = async () => {
  const downloadsPath = await getDownloadsPath().catch(() => null);
  if (!downloadsPath || downloadsPath === watchedPath) return;

  watcher?.close();
  watcher = null;
  watchedPath = null;

  try {
    watcher = fs.watch(downloadsPath, { persistent: false }, (eventType) => {
      // "rename" fires when an entry is created or removed in the folder.
      if (eventType === "rename") scheduleScan(NEW_FOLDER_DELAY_MS);
    });
    watcher.on("error", (error) => {
      logger.warn("[AutoLibraryScan] Downloads folder watcher failed", error);
      watcher?.close();
      watcher = null;
      watchedPath = null;
    });
    watchedPath = downloadsPath;
  } catch (error) {
    logger.warn(
      `[AutoLibraryScan] Could not watch downloads folder ${downloadsPath}`,
      error
    );
  }
};

const runScan = async () => {
  try {
    const { runAutomaticLibraryScan } = await import(
      "@main/events/library/scan-installed-games"
    );
    await runAutomaticLibraryScan();
  } catch (error) {
    logger.error("[AutoLibraryScan] Scan failed", error);
  }

  // The downloads path may have changed in the settings since the last run.
  await ensureWatcher();
};

export const startAutoLibraryScan = () => {
  void ensureWatcher();
  scheduleScan(STARTUP_DELAY_MS);
};
