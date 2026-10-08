import { downloadsSublevel, levelKeys } from "@main/level";
import { registerEvent } from "../register-event";
import { DownloadManager, WindowManager } from "@main/services";
import { Downloader } from "@shared";
import type { GameShop } from "@types";

const pauseGameSeed = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const downloadKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(downloadKey);

  if (!download || download.downloader !== Downloader.Torrent) return;

  await downloadsSublevel.put(downloadKey, {
    ...download,
    status: "complete",
    shouldSeed: false,
  });
  WindowManager.sendDownloadsUpdated();

  await DownloadManager.pauseSeeding(downloadKey);
};

registerEvent("pauseGameSeed", pauseGameSeed);
