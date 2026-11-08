import path from "node:path";

import { isRedistributablePath } from "../helpers/game-executable-ranking.js";

export type ProcessMap = Map<string, Set<string>>;

/**
 * Windows paths are case-insensitive and may be reported with either slash
 * style, so compare them in a normalized, lower-cased form.
 */
export const normalizeWindowsPath = (value: string) =>
  path.win32.normalize(value.replaceAll("/", "\\")).toLowerCase();

export interface WindowsProcessIndex {
  /** Normalized full paths of every running process. */
  paths: string[];
}

export const buildWindowsProcessIndex = (
  processMap: ProcessMap
): WindowsProcessIndex => {
  const paths: string[] = [];

  for (const processPaths of processMap.values()) {
    for (const processPath of processPaths) {
      if (processPath) paths.push(normalizeWindowsPath(processPath));
    }
  }

  return { paths };
};

const MIN_GAME_DIRECTORY_DEPTH = 2;

const getDirectoryDepth = (normalizedDirectory: string) =>
  normalizedDirectory.split("\\").filter(Boolean).length - 1;

/**
 * Matches a game executable against the running processes on Windows.
 *
 * 1. Exact (case-insensitive) path match.
 * 2. Any process running from the game's own folder (or a subfolder). Many
 *    games start through a small launcher that spawns the real binary
 *    elsewhere in the install (e.g. `Binaries/Win64/*-Shipping.exe`) and then
 *    exits, which previously made Hydra think the game was closed.
 */
export const matchWindowsGameProcess = (
  executablePath: string,
  index: WindowsProcessIndex,
  { allowFolderMatch }: { allowFolderMatch: boolean }
): boolean => {
  const normalizedExecutable = normalizeWindowsPath(executablePath);

  if (index.paths.includes(normalizedExecutable)) return true;

  if (!allowFolderMatch) return false;
  if (path.win32.extname(normalizedExecutable) !== ".exe") return false;

  const gameDirectory = path.win32.dirname(normalizedExecutable);

  // Never treat a drive root or a shared library root (e.g. C:\Games) as the
  // game folder, otherwise unrelated games would be matched.
  if (getDirectoryDepth(gameDirectory) < MIN_GAME_DIRECTORY_DEPTH) {
    return false;
  }

  const directoryPrefix = `${gameDirectory}\\`;

  return index.paths.some((processPath) => {
    if (!processPath.startsWith(directoryPrefix)) return false;
    if (path.win32.extname(processPath) !== ".exe") return false;

    const relativePath = processPath.slice(directoryPrefix.length);
    return !isRedistributablePath(relativePath);
  });
};
