import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { downloadsSublevel } from "@main/level";
import { Downloader } from "@shared";
import type { Download } from "@types";
import { logger } from "../logger";
import { SystemPath } from "../system-path";

/**
 * Fork builds before the v4.4.0 merge stored MegaDB as 15 and Buzzheavier as
 * 16. Upstream now uses those ids for Epic and FileKeeper, so the fork moved
 * its hosters to 100/101. Only records whose URI really points at those
 * hosters are rewritten; genuine Epic/FileKeeper downloads stay untouched.
 */
const LEGACY_FORK_DOWNLOADERS: Record<number, Downloader> = {
  15: Downloader.MegaDB,
  16: Downloader.Buzzheavier,
};

const LEGACY_HOSTS: Record<number, string[]> = {
  15: ["megadb.net", "megadb.xyz"],
  16: [
    "buzzheavier.com",
    "bzzhr.to",
    "bzzhr.co",
    "fuckingfast.net",
    "flashbang.sh",
  ],
};

const matchesHost = (uri: string, hosts: string[]) => {
  try {
    const hostname = new URL(uri.trim()).hostname.toLowerCase();
    return hosts.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
};

export const remapLegacyForkDownloader = (
  download: Pick<Download, "downloader" | "uri">
): Downloader | null => {
  const legacyId = download.downloader as number;
  const target = LEGACY_FORK_DOWNLOADERS[legacyId];
  if (target === undefined) return null;

  return matchesHost(download.uri, LEGACY_HOSTS[legacyId]) ? target : null;
};

const getForkCheckpointPaths = (filePath: string) => {
  const resolved = path.resolve(filePath);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = createHash("sha1").update(key).digest("hex");
  const checkpointDirectory = path.join(
    SystemPath.getPath("userData"),
    "download-checkpoints"
  );

  return [
    `${filePath}.hydra-segments.json`,
    `${filePath}.hydra-segments.json.tmp`,
    path.join(checkpointDirectory, `${hash}.json`),
    path.join(checkpointDirectory, `${hash}.json.tmp`),
  ];
};

const isUnfinished = (download: Download) =>
  download.status !== "complete" &&
  download.status !== "seeding" &&
  download.status !== "removed" &&
  download.progress < 1;

/**
 * The old fork engine preallocated the whole file and tracked progress in its
 * own checkpoint. The upstream engine would treat such a full-size partial as
 * finished, and those checkpoints could be corrupted by a segment-split bug,
 * so unfinished fork partials are discarded and restart cleanly.
 */
const resetForkPartial = async (key: string, download: Download) => {
  if (!download.folderName || !isUnfinished(download)) return false;

  const filePath = path.join(download.downloadPath, download.folderName);
  const checkpointPaths = getForkCheckpointPaths(filePath);
  if (!checkpointPaths.some((checkpoint) => fs.existsSync(checkpoint))) {
    return false;
  }

  await Promise.all([
    fs.promises.rm(filePath, { force: true }),
    ...checkpointPaths.map((checkpoint) =>
      fs.promises.rm(checkpoint, { force: true })
    ),
  ]);

  await downloadsSublevel.put(key, {
    ...download,
    bytesDownloaded: 0,
    progress: 0,
    status: download.status === "active" ? "paused" : download.status,
  });

  logger.warn(
    `[ForkMigration] Discarded legacy partial download for ${key}; it will restart from the beginning`
  );
  return true;
};

export const migrateForkDownloads = async () => {
  try {
    for await (const [key, download] of downloadsSublevel.iterator()) {
      let current = download;
      const remapped = remapLegacyForkDownloader(current);

      if (remapped !== null) {
        current = { ...current, downloader: remapped };
        await downloadsSublevel.put(key, current);
        logger.info(
          `[ForkMigration] Remapped downloader for ${key} to ${Downloader[remapped]}`
        );
      }

      await resetForkPartial(key, current);
    }

    await fs.promises.rm(
      path.join(SystemPath.getPath("userData"), "download-checkpoints"),
      { recursive: true, force: true }
    );
  } catch (error) {
    logger.error("[ForkMigration] Failed to migrate fork downloads", error);
  }
};
