import fs from "node:fs";
import path from "node:path";

import { logger } from "@main/services/logger";
import { isRedistributablePath } from "./game-executable-ranking";

export interface ExecutableCandidate {
  relativePath: string;
  sizeInBytes: number;
}

const MAX_SEARCH_DEPTH = 4;

const IGNORED_EXECUTABLE_PATTERN =
  /^(unins\d*|uninstall|setup|install(er)?|launcherpatcher|patcher|updater?\b|crs-|crashreport|crashhandler|crashpad|unitycrashhandler|cefsharp|cefprocess|helper|notification_helper|quicksfv|7z|winrar|unrar|activation|register|redist|vc_?redist|dxsetup|dotnet|ue\d?prereq|easyanticheat|eac|battleye|beservice|steamworks|touchup|dowser|cleanup|repair|config(urator)?|settings|benchmark)/i;

const IGNORED_DIRECTORIES = new Set([
  "_commonredist",
  "commonredist",
  "redist",
  "redists",
  "_redist",
  "__installer",
  "installer",
  "installers",
  "support",
  "tools",
  "engine",
  "easyanticheat",
  "battleye",
  "directx",
  "dotnet",
  "vcredist",
  "prerequisites",
  "_support",
  "crack",
  "fix",
  "update",
]);

const normalizeName = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/\.exe$/gi, "")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();

const tokenize = (value: string) =>
  normalizeName(value)
    .split(" ")
    .filter((token) => token.length >= 2);

const getTitleScore = (relativePath: string, gameTitle: string) => {
  const executableName = normalizeName(path.basename(relativePath));
  const compactExecutable = executableName.replaceAll(" ", "");
  const compactTitle = normalizeName(gameTitle).replaceAll(" ", "");

  if (!compactExecutable || !compactTitle) return 0;
  if (compactExecutable === compactTitle) return 3;
  if (
    compactExecutable.length >= 3 &&
    (compactTitle.includes(compactExecutable) ||
      compactExecutable.includes(compactTitle))
  ) {
    return 2;
  }

  const titleTokens = new Set(tokenize(gameTitle));
  const sharedTokens = tokenize(executableName).filter((token) =>
    titleTokens.has(token)
  );

  return sharedTokens.length > 0 ? 1 : 0;
};

const depthOf = (relativePath: string) =>
  relativePath.split(/[\\/]/).filter(Boolean).length - 1;

const isIgnoredCandidate = (relativePath: string) => {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  const basename = segments.pop() ?? "";

  if (isRedistributablePath(relativePath)) return true;
  if (IGNORED_EXECUTABLE_PATTERN.test(basename)) return true;

  return segments.some((segment) =>
    IGNORED_DIRECTORIES.has(segment.toLowerCase())
  );
};

/**
 * Picks the most likely game executable among candidates when the game is not
 * part of the executable catalogue. Returns null when the choice is ambiguous
 * so that a wrong binary is never bound silently.
 */
export const pickLikelyGameExecutable = (
  candidates: ExecutableCandidate[],
  gameTitle: string
): string | null => {
  const usable = candidates.filter(
    (candidate) => !isIgnoredCandidate(candidate.relativePath)
  );

  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0].relativePath;

  const ranked = usable
    .map((candidate) => ({
      ...candidate,
      titleScore: getTitleScore(candidate.relativePath, gameTitle),
      depth: depthOf(candidate.relativePath),
    }))
    .sort(
      (a, b) =>
        b.titleScore - a.titleScore ||
        a.depth - b.depth ||
        b.sizeInBytes - a.sizeInBytes ||
        a.relativePath.localeCompare(b.relativePath)
    );

  const [best, runnerUp] = ranked;

  if (best.titleScore > runnerUp.titleScore) return best.relativePath;

  // Same title score: only accept a clear winner (shallower, or at least
  // twice the size of the next binary in the same folder depth).
  if (best.depth < runnerUp.depth) return best.relativePath;
  if (best.sizeInBytes >= runnerUp.sizeInBytes * 2) return best.relativePath;

  return null;
};

export const findLikelyGameExecutableInFolder = async (
  folderPath: string,
  gameTitle: string
): Promise<string | null> => {
  if (process.platform !== "win32") return null;

  let entries: fs.Dirent[];

  try {
    entries = await fs.promises.readdir(folderPath, {
      withFileTypes: true,
      recursive: true,
    });
  } catch (err) {
    logger.error(
      `[findLikelyGameExecutableInFolder] Error reading folder ${folderPath}:`,
      err
    );
    return null;
  }

  const candidates: ExecutableCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".exe")) {
      continue;
    }

    const parentPath =
      "parentPath" in entry
        ? entry.parentPath
        : ((entry as unknown as { path?: string }).path ?? folderPath);
    const absolutePath = path.join(parentPath, entry.name);
    const relativePath = path.relative(folderPath, absolutePath);

    if (depthOf(relativePath) > MAX_SEARCH_DEPTH) continue;

    try {
      const stats = await fs.promises.stat(absolutePath);
      candidates.push({ relativePath, sizeInBytes: stats.size });
    } catch {
      // File vanished or is unreadable; skip it.
    }
  }

  const match = pickLikelyGameExecutable(candidates, gameTitle);
  return match ? path.join(folderPath, match) : null;
};
