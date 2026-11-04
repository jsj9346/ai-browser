// Loaded only into the panel. Task pages run without a preload script.
import { contextBridge, ipcRenderer } from "electron";
import type { PanelApi } from "./ipc";

const on = (channel: string) => (listener: (value: any) => void) => {
  ipcRenderer.on(channel, (_event, value) => listener(value));
};

const api: PanelApi = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (input) => ipcRenderer.invoke("settings:save", input),
  navigate: (url) => ipcRenderer.invoke("page:navigate", url),
  runTask: (prompt) => ipcRenderer.invoke("task:run", prompt),
  stop: () => ipcRenderer.invoke("task:stop"),
  answerConfirm: (id, answer) => ipcRenderer.invoke("confirm:answer", id, answer),
  allowHost: (host) => ipcRenderer.invoke("egress:allow", host),
  onAgentEvent: on("agent:event"),
  onConfirm: on("confirm:request"),
  onConfirmClosed: on("confirm:closed"),
  onPageUrl: on("page:url"),
  onHostBlocked: on("egress:blocked"),
};

contextBridge.exposeInMainWorld("panelApi", api);
