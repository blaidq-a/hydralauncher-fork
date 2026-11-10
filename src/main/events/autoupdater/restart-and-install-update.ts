import { registerEvent } from "../register-event";
import { UpdateManager } from "@main/services/update-manager";

// The installer URL is resolved by the main process from the fork's GitHub
// release; the renderer can only ask to install what was found.
export const restartAndInstallUpdate = async (
  _event: Electron.IpcMainInvokeEvent
) => UpdateManager.downloadAndInstallUpdate();

registerEvent("restartAndInstallUpdate", restartAndInstallUpdate);
