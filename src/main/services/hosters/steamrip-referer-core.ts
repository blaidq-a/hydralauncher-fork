// Pure helpers (no Electron/LevelDB imports) so they can be unit tested.

export interface SourceDownloadEntry {
  uris?: unknown;
  descriptionHtml?: unknown;
}

export interface SourceFile {
  downloads?: unknown;
}

const STEAMRIP_HREF_PATTERN =
  /href\s*=\s*(["'])(https?:\/\/(?:www\.)?steamrip\.com\/[^"']*)\1/i;

/** Normalizes a hoster page link so equivalent spellings compare equal. */
export const normalizeHosterUri = (uri: string): string => {
  try {
    const url = new URL(uri.trim());
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${hostname}${pathname}`;
  } catch {
    return uri.trim().toLowerCase().replace(/\/+$/, "");
  }
};

export const extractSteamRipPageUrl = (
  descriptionHtml: unknown
): string | null => {
  if (typeof descriptionHtml !== "string") return null;

  const match = STEAMRIP_HREF_PATTERN.exec(descriptionHtml);
  if (!match) return null;

  try {
    const url = new URL(match[2].replaceAll("&amp;", "&"));
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
};

export const buildSteamRipPageIndex = (
  source: SourceFile
): Map<string, string> => {
  const pageByUri = new Map<string, string>();
  if (!Array.isArray(source.downloads)) return pageByUri;

  for (const entry of source.downloads as SourceDownloadEntry[]) {
    if (!entry || !Array.isArray(entry.uris)) continue;

    const pageUrl = extractSteamRipPageUrl(entry.descriptionHtml);
    if (!pageUrl) continue;

    for (const uri of entry.uris) {
      if (typeof uri === "string") {
        pageByUri.set(normalizeHosterUri(uri), pageUrl);
      }
    }
  }

  return pageByUri;
};
