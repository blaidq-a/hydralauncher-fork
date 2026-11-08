// Fork: keeps the library in sync with the default downloads folder. Runs the
// installed-games scan shortly after startup and again whenever a new folder
// shows up in the downloads path, adding games without asking.
import fs from "node:fs";
import path from "node:path";

import { getDownloadsPath } from "@main/events/helpers/get-downloads-path";
import { getArchiveFolderNames } from "@main/helpers/folder-game-title";
import { logger } from "./logger";

const STARTUP_DELAY_MS = 60 * 1000;
/** An archive was deleted: its extraction finished, scan almost right away. */
const ARCHIVE_REMOVED_DELAY_MS = 10 * 1000;
/** A folder appeared without an archive (e.g. a copy): give it time to land. */
const NEW_FOLDER_DELAY_MS = 3 * 60 * 1000;

let watcher: fs.FSWatcher | null = null;
let watchedPath: string | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let scanDueAt = 0;

/** Schedules a scan, keeping an already planned earlier one. */
const scheduleScan = (delayMs: number) => {
  const dueAt = Date.now() + delayMs;
  if (scanTimer && scanDueAt <= dueAt) return;

  if (scanTimer) clearTimeout(scanTimer);
  scanDueAt = dueAt;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scanDueAt = 0;
    void runScan();
  }, delayMs);
};

const handleDownloadsFolderChange = (
  downloadsPath: string,
  fileName: string | null
) => {
  if (!fileName) {
    scheduleScan(NEW_FOLDER_DELAY_MS);
    return;
  }

  if (getArchiveFolderNames(fileName)) {
    // A new archive is ignored until it disappears; its removal means the
    // extraction (by Hydra or a script) is complete.
    if (!fs.existsSync(path.join(downloadsPath, fileName))) {
      scheduleScan(ARCHIVE_REMOVED_DELAY_MS);
    }
    return;
  }

  scheduleScan(NEW_FOLDER_DELAY_MS);
};

const ensureWatcher = async () => {
  const downloadsPath = await getDownloadsPath().catch(() => null);
  if (!downloadsPath || downloadsPath === watchedPath) return;

  watcher?.close();
  watcher = null;
  watchedPath = null;

  try {
    watcher = fs.watch(
      downloadsPath,
      { persistent: false },
      (eventType, fileName) => {
        // "rename" fires when an entry is created or removed in the folder.
        if (eventType === "rename") {
          handleDownloadsFolderChange(downloadsPath, fileName);
        }
      }
    );
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
