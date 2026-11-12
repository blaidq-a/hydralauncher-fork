import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

import axios from "axios";
import { app, shell } from "electron";

import type { AppUpdateStatus } from "@types";
import { logger } from "./logger";
import { compareVersions } from "./update-version";

/** Repository the fork's own releases (and one-click updates) come from. */
const FORK_REPOSITORY = "blaidq-a/hydralauncher-fork";
/** Original Hydra repository, only used to tell users a new release exists. */
const UPSTREAM_REPOSITORY = "hydralauncher/hydra";
/**
 * Upstream Hydra version this fork is currently merged with. Update it after
 * every upstream merge; the fork's own version (package.json) is independent
 * so fork-only releases can be published between upstream versions.
 */
export const UPSTREAM_BASE_VERSION = "4.4.1";

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MIN_CHECK_GAP_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** Hosts GitHub serves release assets from (including redirects). */
const TRUSTED_DOWNLOAD_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: {
    name: string;
    browser_download_url: string;
    /** "sha256:<hex>", provided by GitHub for release assets. */
    digest?: string | null;
  }[];
}

const isTrustedDownloadUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      TRUSTED_DOWNLOAD_HOSTS.includes(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
};

/** Keeps a release tag usable as part of a file name. */
const toSafeFileVersion = (version: string) =>
  version.replaceAll(/[^0-9A-Za-z.-]/g, "_").slice(0, 40) || "update";

const parseSha256Digest = (digest: string | null | undefined) => {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest ?? "");
  return match ? match[1].toLowerCase() : null;
};

const sha256OfFile = async (filePath: string) => {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
};

const fetchLatestRelease = async (repository: string) => {
  const response = await axios.get<GitHubRelease>(
    `https://api.github.com/repos/${repository}/releases/latest`,
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { Accept: "application/vnd.github+json" },
    }
  );

  return response.data;
};

export class UpdateManager {
  private static checkInterval: NodeJS.Timeout | null = null;
  private static lastCheckTime = 0;
  private static status: AppUpdateStatus = { fork: null, upstream: null };
  /** Kept in the main process only; the renderer can never choose it. */
  private static installerUrl: string | null = null;
  private static installerSha256: string | null = null;
  private static isInstalling = false;

  public static async initialize(): Promise<void> {
    await this.checkForUpdates();
    this.startPeriodicCheck();
  }

  public static startPeriodicCheck() {
    if (this.checkInterval) return;

    this.checkInterval = setInterval(() => {
      void this.checkForUpdates();
    }, CHECK_INTERVAL_MS);
  }

  public static stopPeriodicCheck() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  public static getStatus(): AppUpdateStatus {
    return this.status;
  }

  /** Returns true when a newer fork build can be installed. */
  public static async checkForUpdates(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastCheckTime < MIN_CHECK_GAP_MS) {
      return this.status.fork !== null;
    }
    this.lastCheckTime = now;

    const [fork, upstream] = await Promise.allSettled([
      this.checkForkRelease(),
      this.checkUpstreamRelease(),
    ]);

    if (fork.status === "rejected") {
      logger.error(
        "[UpdateManager] Failed to check fork releases",
        fork.reason
      );
    }
    if (upstream.status === "rejected") {
      logger.warn(
        "[UpdateManager] Failed to check upstream Hydra releases",
        upstream.reason
      );
    }

    this.status = {
      fork: fork.status === "fulfilled" ? fork.value : this.status.fork,
      upstream:
        upstream.status === "fulfilled" ? upstream.value : this.status.upstream,
    };

    await this.notifyRenderer();
    return this.status.fork !== null;
  }

  private static async checkForkRelease(): Promise<AppUpdateStatus["fork"]> {
    const release = await fetchLatestRelease(FORK_REPOSITORY);
    const latestVersion = release.tag_name.replace(/^v/i, "");
    const currentVersion = app.getVersion();

    logger.log(
      `[UpdateManager] Fork latest: ${latestVersion}, current: ${currentVersion}`
    );

    if (release.draft || compareVersions(latestVersion, currentVersion) <= 0) {
      this.installerUrl = null;
      return null;
    }

    const installer = release.assets.find((asset) =>
      asset.name.toLowerCase().endsWith("-setup.exe")
    );
    const canInstall =
      process.platform === "win32" &&
      !process.env.PORTABLE_EXECUTABLE_FILE &&
      !!installer &&
      isTrustedDownloadUrl(installer.browser_download_url);

    this.installerUrl = canInstall ? installer!.browser_download_url : null;
    this.installerSha256 = canInstall
      ? parseSha256Digest(installer!.digest)
      : null;

    return {
      version: latestVersion,
      releaseUrl: release.html_url,
      canInstall,
    };
  }

  private static async checkUpstreamRelease(): Promise<
    AppUpdateStatus["upstream"]
  > {
    const release = await fetchLatestRelease(UPSTREAM_REPOSITORY);
    const latestVersion = release.tag_name.replace(/^v/i, "");

    if (compareVersions(latestVersion, UPSTREAM_BASE_VERSION) <= 0) {
      return null;
    }

    return { version: latestVersion, releaseUrl: release.html_url };
  }

  private static async notifyRenderer() {
    try {
      const { WindowManager } = await import("./window-manager");
      WindowManager.sendToAppWindows("update-available", this.status);
    } catch (error) {
      logger.error("[UpdateManager] Failed to notify renderer", error);
    }
  }

  /**
   * Downloads the fork installer found by the last check and runs it
   * silently. The installer closes Hydra, updates it and starts it again.
   */
  public static async downloadAndInstallUpdate(): Promise<void> {
    const fork = this.status.fork;

    if (!fork) throw new Error("No update is available");

    if (!fork.canInstall || !this.installerUrl) {
      await shell.openExternal(fork.releaseUrl);
      return;
    }

    if (this.isInstalling) return;
    this.isInstalling = true;

    try {
      // A fresh private folder, so nothing can be planted at a known path.
      const downloadDirectory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "hydra-update-")
      );
      const installerPath = path.join(
        downloadDirectory,
        `Hydra-${toSafeFileVersion(fork.version)}-setup.exe`
      );

      logger.log(`[UpdateManager] Downloading fork update ${fork.version}`);

      const response = await axios.get<Readable>(this.installerUrl, {
        responseType: "stream",
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxRedirects: 5,
        beforeRedirect: (options) => {
          const redirectUrl = `${options.protocol}//${options.hostname}${options.path ?? ""}`;
          if (!isTrustedDownloadUrl(redirectUrl)) {
            throw new Error("Update download redirected to an untrusted host");
          }
        },
      });

      await pipeline(response.data, fs.createWriteStream(installerPath));

      if (this.installerSha256) {
        const actual = await sha256OfFile(installerPath);
        if (actual !== this.installerSha256) {
          await fs.promises.rm(downloadDirectory, {
            recursive: true,
            force: true,
          });
          throw new Error(
            "The downloaded update does not match the published checksum"
          );
        }
      } else {
        logger.warn(
          "[UpdateManager] The release did not publish a checksum for the installer"
        );
      }

      logger.log("[UpdateManager] Update downloaded, starting the installer");

      // Detached so the installer outlives Hydra; --force-run restarts it.
      const installer = spawn(installerPath, ["/S", "--force-run"], {
        detached: true,
        stdio: "ignore",
      });
      installer.unref();

      setTimeout(() => app.quit(), 1000);
    } catch (error) {
      this.isInstalling = false;
      logger.error("[UpdateManager] Failed to download/install update", error);
      throw error;
    }
  }
}
