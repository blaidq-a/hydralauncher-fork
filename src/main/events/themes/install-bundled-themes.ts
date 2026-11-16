// Fork: installs the theme pack shipped with the app (resources/themes/*.css)
// into the user's theme list in one click. Themes are matched by name, so
// running it again updates them instead of adding duplicates; the active
// theme stays active.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Theme } from "@types";
import { themesSublevel } from "@main/level";
import { bundledThemesPath } from "@main/constants";
import {
  achievementNotificationPresenter,
  logger,
  WindowManager,
} from "@main/services";
import { registerEvent } from "../register-event";

const THEME_PACK_AUTHOR_ID = "njOw0lVj";
const THEME_PACK_AUTHOR_NAME = "blaidq";
const THEME_PACK_PREFIX = "Blaidq V2.2";

const installBundledThemes = async (_event: Electron.IpcMainInvokeEvent) => {
  const files = (await fs.readdir(bundledThemesPath))
    .filter((file) => file.endsWith(".css"))
    .sort();

  const existing = await themesSublevel.values().all();
  const now = new Date();
  let activeUpdated = false;

  for (const file of files) {
    const name = `${THEME_PACK_PREFIX} ${path.basename(file, ".css")}`;
    const code = await fs.readFile(path.join(bundledThemesPath, file), "utf8");
    const current = existing.find((theme) => theme.name === name);

    const theme: Theme = {
      id: current?.id ?? crypto.randomUUID(),
      name,
      isActive: current?.isActive ?? false,
      author: THEME_PACK_AUTHOR_ID,
      authorName: THEME_PACK_AUTHOR_NAME,
      code,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };

    await themesSublevel.put(theme.id, theme);
    if (theme.isActive) activeUpdated = true;
  }

  if (activeUpdated) {
    WindowManager.mainWindow?.webContents.send("on-custom-theme-updated");
    achievementNotificationPresenter.notifyThemeUpdated();
  }

  logger.info(`[Themes] Installed ${files.length} bundled themes`);
  return files.length;
};

registerEvent("installBundledThemes", installBundledThemes);
