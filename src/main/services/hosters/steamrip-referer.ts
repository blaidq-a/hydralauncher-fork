import axios from "axios";

import { downloadSourcesSublevel } from "@main/level";
import { logger } from "../logger";
import { HOSTER_USER_AGENT } from "./hoster-user-agent";
import {
  buildSteamRipPageIndex,
  normalizeHosterUri,
  type SourceFile,
} from "./steamrip-referer-core";

export const STEAMRIP_FALLBACK_REFERER = "https://steamrip.com/";

const SOURCE_CACHE_TTL_MS = 30 * 60 * 1000;
const SOURCE_FETCH_TIMEOUT_MS = 20_000;

const sourceCache = new Map<
  string,
  { pageByUri: Map<string, string>; loadedAt: number }
>();

const loadSourceIndex = async (sourceUrl: string) => {
  const cached = sourceCache.get(sourceUrl);
  if (cached && Date.now() - cached.loadedAt < SOURCE_CACHE_TTL_MS) {
    return cached.pageByUri;
  }

  const response = await axios.get<SourceFile>(sourceUrl, {
    headers: { "User-Agent": HOSTER_USER_AGENT, Accept: "application/json" },
    timeout: SOURCE_FETCH_TIMEOUT_MS,
    responseType: "json",
  });

  const pageByUri = buildSteamRipPageIndex(response.data ?? {});
  sourceCache.set(sourceUrl, { pageByUri, loadedAt: Date.now() });
  return pageByUri;
};

/**
 * Finds the SteamRIP game page that links to a hoster URI, using the
 * `descriptionHtml` of the matching entry in the user's own download sources.
 * Hydra's API does not forward that field, so the source JSON is read here.
 * Falls back to the SteamRIP home page when nothing matches.
 */
export const findSteamRipRefererForUri = async (
  uri: string
): Promise<string> => {
  const key = normalizeHosterUri(uri);

  let sources: { url?: string; name?: string }[] = [];
  try {
    sources = await downloadSourcesSublevel.values().all();
  } catch (error) {
    logger.warn("[SteamRIP] Could not read local download sources", error);
  }

  // Check SteamRIP sources first so other large sources are rarely fetched.
  const isSteamRipSource = (source: { url?: string; name?: string }) =>
    /steamrip/i.test(`${source.name ?? ""} ${source.url ?? ""}`);
  sources = [
    ...sources.filter(isSteamRipSource),
    ...sources.filter((source) => !isSteamRipSource(source)),
  ];

  for (const source of sources) {
    if (!source.url) continue;

    try {
      const pageUrl = (await loadSourceIndex(source.url)).get(key);
      if (pageUrl) return pageUrl;
    } catch (error) {
      logger.warn(
        `[SteamRIP] Could not read download source ${source.url}`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return STEAMRIP_FALLBACK_REFERER;
};
