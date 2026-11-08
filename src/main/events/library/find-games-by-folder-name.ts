// Fork: finds games in the downloads folder that the executable catalogue does
// not know, by matching the folder name against Hydra's catalogue. Only a
// single, exact (punctuation-insensitive) title match with a reliably detected
// executable is accepted; everything else is skipped and logged, never asked.
import fs from "node:fs";
import path from "node:path";

import {
  cleanFolderGameTitle,
  pickConfidentTitleMatch,
} from "@main/helpers/folder-game-title";
import { findLikelyGameExecutableInFolder } from "@main/helpers/find-likely-game-executable";
import { downloadsSublevel } from "@main/level";
import { logger } from "@main/services";
import { HydraApi } from "@main/services/hydra-api";

/** Folders touched more recently than this may still be extracting. */
const SETTLE_TIME_MS = 2 * 60 * 1000;
const SEARCH_LIMIT = 8;

interface CatalogueSuggestion {
  objectId: string;
  title: string;
  shop: string;
}

const toKey = (value: string) =>
  path.resolve(value).replaceAll("\\", "/").toLowerCase();

const isInside = (childKey: string, parentKey: string) =>
  childKey === parentKey || childKey.startsWith(`${parentKey}/`);

/** Folders Hydra itself is still downloading or extracting into. */
const getBusyFolderKeys = async (downloadsPath: string) => {
  const busy = new Set<string>();
  const downloads = await downloadsSublevel.values().all();

  for (const download of downloads) {
    if (!download.folderName) continue;

    const finished =
      (download.status === "complete" || download.status === "seeding") &&
      !download.extracting;

    if (!finished) {
      busy.add(
        toKey(
          path.join(download.downloadPath ?? downloadsPath, download.folderName)
        )
      );
    }
  }

  return busy;
};

const searchCatalogue = async (title: string) => {
  const results = await HydraApi.get<CatalogueSuggestion[]>(
    "/catalogue/search/suggestions",
    { query: title, limit: SEARCH_LIMIT, shop: "steam" },
    { needsAuth: false }
  );

  return Array.isArray(results)
    ? results.filter((result) => result.shop === "steam")
    : [];
};

export const findGamesByFolderName = async (options: {
  downloadsPath: string;
  /** Executable paths already owned by games (library or found by the scan). */
  claimedExecutablePaths: Iterable<string>;
  /** Object ids already in the library or about to be added. */
  takenObjectIds: Set<string>;
  isCancelled: () => boolean;
}): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  const { downloadsPath } = options;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(downloadsPath, { withFileTypes: true });
  } catch (error) {
    logger.warn(
      `[ScanInstalledGames] Could not read downloads folder ${downloadsPath}`,
      error
    );
    return found;
  }

  const claimedKeys = [...options.claimedExecutablePaths].map(toKey);
  const busyFolders = await getBusyFolderKeys(downloadsPath).catch(
    () => new Set<string>()
  );

  for (const entry of entries) {
    if (options.isCancelled()) break;
    if (!entry.isDirectory()) continue;

    const folderPath = path.join(downloadsPath, entry.name);
    const folderKey = toKey(folderPath);

    if (claimedKeys.some((claimed) => isInside(claimed, folderKey))) continue;
    if (busyFolders.has(folderKey)) continue;

    const stats = await fs.promises.stat(folderPath).catch(() => null);
    if (!stats || Date.now() - stats.mtimeMs < SETTLE_TIME_MS) continue;

    const title = cleanFolderGameTitle(entry.name);
    if (!title) continue;

    let results: CatalogueSuggestion[];
    try {
      results = await searchCatalogue(title);
    } catch (error) {
      logger.warn(
        `[ScanInstalledGames] Catalogue search failed for folder "${entry.name}"`,
        error instanceof Error ? error.message : error
      );
      continue;
    }

    const match = pickConfidentTitleMatch(title, results);
    if (!match) {
      logger.info(
        `[ScanInstalledGames] No confident catalogue match for folder "${entry.name}" (searched "${title}")`
      );
      continue;
    }

    if (
      options.takenObjectIds.has(match.objectId) ||
      found.has(match.objectId)
    ) {
      continue;
    }

    const executablePath = await findLikelyGameExecutableInFolder(
      folderPath,
      match.title
    );
    if (!executablePath) {
      logger.info(
        `[ScanInstalledGames] Folder "${entry.name}" matches ${match.title} but no executable was detected`
      );
      continue;
    }

    logger.info(
      `[ScanInstalledGames] Folder "${entry.name}" matched ${match.title} (${match.objectId}): ${executablePath}`
    );
    found.set(match.objectId, executablePath);
  }

  return found;
};
