import { registerEvent } from "../register-event";
import { UpdateManager } from "@main/services/update-manager";

const getUpdateStatus = async (_event: Electron.IpcMainInvokeEvent) =>
  UpdateManager.getStatus();

registerEvent("getUpdateStatus", getUpdateStatus);
