import { registerEvent } from "../register-event";

export const restartAndInstallUpdate = () => {
  return undefined;
};

const restartAndInstallUpdateEvent = async (
  _event: Electron.IpcMainInvokeEvent
) => restartAndInstallUpdate();

registerEvent("restartAndInstallUpdate", restartAndInstallUpdateEvent);
