import axios from "axios";
import { app } from "electron";
import { logger } from "./logger";

const GITHUB_OWNER = "blaidq-a";
const GITHUB_REPO = "hydralauncher-fork";
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

interface GitHubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

export class UpdateManager {
  private static checkInterval: NodeJS.Timeout | null = null;
  private static lastCheckTime = 0;
  private static readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  public static async initialize(): Promise<void> {
    // Check for updates on startup
    await this.checkForUpdates();

    // Check periodically
    this.startPeriodicCheck();
  }

  private static startPeriodicCheck() {
    if (this.checkInterval) return;

    this.checkInterval = setInterval(async () => {
      await this.checkForUpdates();
    }, this.CHECK_INTERVAL_MS);
  }

  public static stopPeriodicCheck() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  public static async checkForUpdates(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastCheckTime < 60000) {
      // Don't check more than once per minute
      return false;
    }
    this.lastCheckTime = now;

    try {
      logger.log("[UpdateManager] Checking for updates from GitHub...");

      const response = await axios.get<GitHubRelease>(
        `${GITHUB_API_URL}/releases/latest`,
        { timeout: 10000 }
      );

      const release = response.data;
      const latestVersion = release.tag_name.replace(/^v/, "");
      const currentVersion = app.getVersion();

      logger.log(
        `[UpdateManager] Latest: ${latestVersion}, Current: ${currentVersion}`
      );

      if (this.compareVersions(latestVersion, currentVersion) > 0) {
        logger.log(
          `[UpdateManager] New version available: ${latestVersion}`
        );

        const exeAsset = release.assets.find((asset) =>
          asset.name.includes("setup.exe")
        );

        if (exeAsset) {
          // Notify renderer about available update
          try {
            const wmModule = await import("./window-manager");
            wmModule.WindowManager.sendToAppWindows("update-available", {
              version: latestVersion,
              downloadUrl: exeAsset.browser_download_url,
              releaseUrl: release.html_url,
            });
          } catch (error) {
            logger.error(
              "[UpdateManager] Failed to notify about update availability",
              error
            );
          }

          return true;
        }
      }

      return false;
    } catch (error) {
      logger.error("[UpdateManager] Failed to check for updates", error);
      return false;
    }
  }

  public static async downloadAndInstallUpdate(downloadUrl: string) {
    try {
      logger.log(`[UpdateManager] Downloading update from ${downloadUrl}`);

      const response = await axios.get<NodeJS.ReadableStream>(downloadUrl, {
        responseType: "stream",
        timeout: 300000, // 5 minutes
      });

      const os = await import("node:os");
      const path = await import("node:path");
      const { execSync } = await import("node:child_process");

      const tempDir = os.tmpdir();
      const installerPath = path.join(tempDir, "Hydra-update-setup.exe");

      logger.log(`[UpdateManager] Saving installer to ${installerPath}`);

      const writer = (await import("node:fs")).createWriteStream(
        installerPath
      );

      return new Promise<void>((resolve, reject) => {
        response.data.pipe(writer);

        writer.on("finish", async () => {
          try {
            logger.log("[UpdateManager] Downloaded successfully, installing...");

            // Launch the installer and quit the app
            execSync(`"${installerPath}" /S`, { stdio: "ignore" });

            // Give the installer time to start
            await new Promise((r) => setTimeout(r, 1000));

            app.quit();
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        writer.on("error", (error) => {
          logger.error("[UpdateManager] Error writing installer", error);
          reject(error);
        });

        response.data.on("error", (error) => {
          logger.error("[UpdateManager] Error downloading installer", error);
          reject(error);
        });
      });
    } catch (error) {
      logger.error("[UpdateManager] Failed to download/install update", error);
      throw error;
    }
  }

  private static compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split(".").map(Number);
    const parts2 = v2.split(".").map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;

      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }

    return 0;
  }
}
