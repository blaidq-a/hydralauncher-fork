import { registerEvent } from "../register-event";
import { UpdateManager } from "@main/services/update-manager";

export const restartAndInstallUpdate = async (downloadUrl: string) => {
  if (!downloadUrl) {
    throw new Error("Download URL is required for update installation");
  }
  return UpdateManager.downloadAndInstallUpdate(downloadUrl);
};

const restartAndInstallUpdateEvent = async (
  _event: Electron.IpcMainInvokeEvent,
  downloadUrl: string
) => restartAndInstallUpdate(downloadUrl);

registerEvent("restartAndInstallUpdate", restartAndInstallUpdateEvent);
