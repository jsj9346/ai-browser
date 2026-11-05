// App entry: one window with the task page on the left and the agent panel on the right.
import { app, BaseWindow, dialog, ipcMain, Menu, session, WebContentsView, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { cookieEncryptionEnabled } from "./fuses";
import type { PanelProfiles } from "./ipc";
import { applyEgressSwitches } from "./process-switches";
import { profilePartition, Profiles } from "./profiles";
import { canEncrypt, Settings } from "./settings";
import { Task, type TaskOptions } from "./task";

declare const __E2E_API_BASE__: string;

const PANEL_WIDTH = 400;

applyEgressSwitches();

if (__E2E_API_BASE__ && process.env.E2E_USER_DATA) app.setPath("userData", process.env.E2E_USER_DATA);

/** What only test builds change. Fixture hosts look public to login mode but connect to this machine. */
function e2eOverrides(): Pick<TaskOptions, "connectHost" | "loginLimits"> {
  if (!__E2E_API_BASE__) return {};
  const { E2E_LOGIN_IDLE_MS: idleMs, E2E_LOGIN_MAX_MS: maxMs } = process.env;
  return {
    connectHost: (host) => (host.endsWith(".e2e.test") ? "127.0.0.1" : host),
    ...(idleMs && maxMs ? { loginLimits: { idleMs: Number(idleMs), maxMs: Number(maxMs) } } : {}),
  };
}

/** Profiles keep logins on disk, so they need both encrypted cookies and a real keyring behind them. */
function profilesAvailable(): boolean {
  if (__E2E_API_BASE__ && process.env.E2E_ASSUME_KEYRING) return true;
  return canEncrypt() && cookieEncryptionEnabled();
}

async function createWindow(settings: Settings, profiles: Profiles): Promise<void> {
  const win = new BaseWindow({ width: 1300, height: 860, title: "neo-browser" });

  const panelSession = session.fromPartition("panel");
  panelSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  panelSession.setPermissionCheckHandler(() => false);
  const panel = new WebContentsView({
    webPreferences: {
      session: panelSession,
      preload: join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });
  const toPanel = (channel: string, value: unknown) => {
    if (!panel.webContents.isDestroyed()) panel.webContents.send(channel, value);
  };
  panel.webContents.on("will-navigate", (event) => event.preventDefault());
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Approvals are answered only in the panel, which task pages and the model cannot reach.
  let nextConfirmId = 1;
  const pendingConfirms = new Map<number, (answer: boolean) => void>();
  const settleConfirm = (id: number, answer: boolean) => {
    const resolve = pendingConfirms.get(id);
    if (!resolve) return;
    pendingConfirms.delete(id);
    toPanel("confirm:closed", id);
    resolve(answer);
  };
  const denyPendingConfirms = () => {
    for (const id of [...pendingConfirms.keys()]) settleConfirm(id, false);
  };

  let currentProfile: string | null = null;
  const panelProfiles = (): PanelProfiles => ({
    available: profilesAvailable(),
    items: profiles.list().map(({ id, name }) => ({ id, name })),
    current: currentProfile,
    hosts: currentProfile ? task.allowedHosts : [],
  });
  const createTask = (profileId: string | null) => {
    const profile = profileId ? profiles.get(profileId) : undefined;
    return Task.create({
      confirm: (message) =>
        new Promise((resolve) => {
          const id = nextConfirmId++;
          pendingConfirms.set(id, resolve);
          toPanel("confirm:request", { id, message });
        }),
      onEvent: (event) => toPanel("agent:event", event),
      onUrl: (url) => toPanel("page:url", url),
      onHostBlocked: (host) => toPanel("egress:blocked", host),
      onLogin: (state) => toPanel("login:state", state),
      ...(profile
        ? {
            profile: {
              partition: profilePartition(profile.id),
              hosts: profile.hosts,
              onHostsChanged: (hosts: string[]) => {
                profiles.setHosts(profile.id, hosts);
                toPanel("profiles:state", panelProfiles());
              },
            },
          }
        : {}),
      ...e2eOverrides(),
    });
  };
  let task = await createTask(null);

  const layout = () => {
    const { width, height } = win.getContentBounds();
    task.view.setBounds({ x: 0, y: 0, width: Math.max(0, width - PANEL_WIDTH), height });
    panel.setBounds({ x: Math.max(0, width - PANEL_WIDTH), y: 0, width: Math.min(width, PANEL_WIDTH), height });
  };
  win.contentView.addChildView(task.view);
  win.contentView.addChildView(panel);

  /** A task's login boundary never changes, so another profile means another task. */
  const switchTask = async (profileId: string | null) => {
    const next = await createTask(profileId);
    const previous = task;
    win.contentView.removeChildView(previous.view);
    win.contentView.addChildView(next.view, 0);
    task = next;
    currentProfile = profileId;
    layout();
    previous.close();
  };
  layout();
  win.on("resize", layout);

  const handle = (channel: string, listener: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender !== panel.webContents) throw new Error("Not allowed");
      return listener(...args);
    });
  };
  handle("settings:get", () => settings.forPanel());
  handle("settings:save", (input: { apiKey: string; model: string }) => {
    settings.save({ apiKey: String(input.apiKey), model: String(input.model) });
    return settings.forPanel();
  });
  handle("page:navigate", (url: string) => task.navigate(String(url)));
  handle("task:run", (prompt: string) => {
    if (!settings.apiKey) return { level: "error", text: "먼저 API 키를 저장해 주세요.", needsKey: true };
    return task.run(String(prompt), settings.apiKey, settings.selectedModel);
  });
  handle("task:stop", () => {
    task.stop();
    denyPendingConfirms();
  });
  handle("egress:allow", (host: string) => task.allowBlockedHost(String(host)));
  handle("login:start", (url: string) => task.startLogin(String(url)));
  handle("login:reopen", () => task.reopenLogin());
  handle("login:finish", () => task.finishLogin());
  handle("login:cancel", () => task.cancelLogin());
  handle("login:choose", (hosts: unknown) => task.chooseLoginHosts(Array.isArray(hosts) ? hosts.map(String) : []));
  handle("profiles:get", () => panelProfiles());
  handle("profiles:create", async (name: string) => {
    if (!profilesAvailable() || task.busy) return panelProfiles();
    const profile = profiles.create(String(name));
    if (profile) await switchTask(profile.id);
    return panelProfiles();
  });
  handle("profiles:select", async (id: string | null) => {
    const target = id === null ? null : String(id);
    if (task.busy || target === currentProfile) return panelProfiles();
    if (target !== null && (!profilesAvailable() || !profiles.get(target))) return panelProfiles();
    await switchTask(target);
    return panelProfiles();
  });
  handle("profiles:delete", async (id: string) => {
    const target = String(id);
    if (task.busy || !profiles.get(target)) return panelProfiles();
    if (currentProfile === target) await switchTask(null);
    const stored = session.fromPartition(profilePartition(target));
    await stored.clearData();
    await stored.clearStorageData();
    await stored.cookies.flushStore();
    profiles.markDeleted(target);
    return panelProfiles();
  });
  handle("profiles:remove-host", (host: string) => {
    task.removeAllowedHost(String(host));
    return panelProfiles();
  });
  handle("confirm:answer", (id: number, answer: boolean) => settleConfirm(Number(id), answer === true));

  win.on("closed", () => {
    denyPendingConfirms();
    task.close();
    if (!panel.webContents.isDestroyed()) panel.webContents.close();
    app.quit();
  });

  void panel.webContents.loadFile(join(__dirname, "panel.html"));
}

app.whenReady().then(() => {
  // No View menu: reload and DevTools shortcuts should not reach task pages. Paste needs the Edit menu.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "editMenu" as const },
    ]),
  );
  const settings = new Settings();
  settings.load();
  const profiles = new Profiles(app.getPath("userData"));
  profiles.load();
  createWindow(settings, profiles).catch((error) => {
    dialog.showErrorBox("neo-browser", `외부 전송 통제를 설정하지 못해 작업을 시작하지 않습니다.\n${error}`);
    app.quit();
  });
});

app.on("window-all-closed", () => app.quit());
