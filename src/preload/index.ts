import { contextBridge, ipcRenderer } from "electron";
import type { TaskHubApi } from "../shared/task-hub-api";

const appGetVersionChannel = "app:get-version";

const api: TaskHubApi = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke(appGetVersionChannel),
  },
};

contextBridge.exposeInMainWorld("taskHub", api);
