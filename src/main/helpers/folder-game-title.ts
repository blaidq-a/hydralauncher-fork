// Fork: turns a release folder name into a searchable game title and decides
// whether a catalogue title matches it with enough confidence to add the game
// to the library automatically. Pure helpers so they can be unit tested.

const RELEASE_TAGS = [
  "steamrip",
  "steamrip com",
  "ankergames",
  "fitgirl",
  "fitgirl repack",
  "dodi",
  "dodi repack",
  "elamigos",
  "ofme",
  "online fix",
  "codex",
  "rune",
  "tenoke",
  "flt",
  "empress",
  "skidrow",
  "plaza",
  "razor1911",
  "darksiders",
  "tinyiso",
  "p2p",
  "gog",
  "repack",
  "portable",
  "multi\\d+",
];

const RELEASE_TAG_PATTERN = new RegExp(
  `(?:^|\\s)(?:${RELEASE_TAGS.join("|")})(?=\\s|$)`,
  "gi"
);

const ARCHIVE_EXTENSION_PATTERN = /\.(?:rar|zip|7z|\d{3})$/i;
const ARCHIVE_PART_PATTERN = /\.part\d+$/i;

/**
 * Folder names an archive is extracted into ("Game.rar" -> "Game"; a
 * multi-part "Game.part1.rar" -> "Game.part1" and "Game"), lower-cased.
 * Returns null when the file is not an archive.
 */
export const getArchiveFolderNames = (fileName: string): string[] | null => {
  if (!ARCHIVE_EXTENSION_PATTERN.test(fileName)) return null;

  const baseName = fileName.replace(ARCHIVE_EXTENSION_PATTERN, "");
  const withoutPart = baseName.replace(ARCHIVE_PART_PATTERN, "");

  return [...new Set([baseName, withoutPart])]
    .filter(Boolean)
    .map((name) => name.toLowerCase());
};

/**
 * Version and build markers such as "v1.14.1k", "Build 12345", "Update 3".
 * Applied while dots are still present so "v1.14.1k" is removed as a whole.
 */
const VERSION_PATTERN =
  /(?:^|[\s.])(?:v\s?\d[\w.]*|build\s?\d+|update\s?\d+|\d+(?:\.\d+)+)(?=[\s.]|$)/gi;

export const cleanFolderGameTitle = (folderName: string): string =>
  folderName
    // Bracketed and parenthesised tags: [FitGirl Repack], (2023), {GOG}
    .replaceAll(/[[({][^\])}]*[\])}]/g, " ")
    .replaceAll(/\.com\b/gi, " ")
    .replaceAll(/[_\-+]+/g, " ")
    .replaceAll(VERSION_PATTERN, " ")
    .replaceAll(/\.+/g, " ")
    .replaceAll(RELEASE_TAG_PATTERN, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

/** Lower-case letters and digits only; "Call of Duty®: Black Ops" -> "callofdutyblackops". */
export const toCompactTitle = (title: string): string =>
  title
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "");

const withoutLeadingThe = (compact: string) =>
  compact.startsWith("the") ? compact.slice(3) : compact;

export const isConfidentTitleMatch = (
  folderTitle: string,
  catalogueTitle: string
): boolean => {
  const folder = toCompactTitle(folderTitle);
  const catalogue = toCompactTitle(catalogueTitle);

  // Very short names ("Dead", "Run") match too many unrelated games.
  if (folder.length < 4 || catalogue.length < 4) return false;

  return (
    folder === catalogue ||
    withoutLeadingThe(folder) === withoutLeadingThe(catalogue)
  );
};

/**
 * Picks the single catalogue result that confidently matches the folder.
 * Returns null when nothing or more than one distinct game matches.
 */
export const pickConfidentTitleMatch = <
  T extends { objectId: string; title: string },
>(
  folderTitle: string,
  results: T[]
): T | null => {
  const matches = results.filter((result) =>
    isConfidentTitleMatch(folderTitle, result.title)
  );
  const distinct = new Map(matches.map((match) => [match.objectId, match]));

  return distinct.size === 1 ? [...distinct.values()][0] : null;
};
