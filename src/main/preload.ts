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
  startLogin: (url) => ipcRenderer.invoke("login:start", url),
  reopenLogin: () => ipcRenderer.invoke("login:reopen"),
  finishLogin: () => ipcRenderer.invoke("login:finish"),
  cancelLogin: () => ipcRenderer.invoke("login:cancel"),
  chooseLoginHosts: (hosts) => ipcRenderer.invoke("login:choose", hosts),
  getProfiles: () => ipcRenderer.invoke("profiles:get"),
  createProfile: (name) => ipcRenderer.invoke("profiles:create", name),
  selectProfile: (id) => ipcRenderer.invoke("profiles:select", id),
  deleteProfile: (id) => ipcRenderer.invoke("profiles:delete", id),
  removeProfileHost: (host) => ipcRenderer.invoke("profiles:remove-host", host),
  onLogin: on("login:state"),
  onProfiles: on("profiles:state"),
  onAgentEvent: on("agent:event"),
  onConfirm: on("confirm:request"),
  onConfirmClosed: on("confirm:closed"),
  onPageUrl: on("page:url"),
  onHostBlocked: on("egress:blocked"),
};

contextBridge.exposeInMainWorld("panelApi", api);
