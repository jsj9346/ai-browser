// App entry: one window with the task page on the left and the agent panel on the right.
import { app, BaseWindow, dialog, ipcMain, Menu, session, WebContentsView, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { applyEgressSwitches } from "./process-switches";
import { Settings } from "./settings";
import { Task } from "./task";

declare const __E2E_API_BASE__: string;

const PANEL_WIDTH = 400;

applyEgressSwitches();

if (__E2E_API_BASE__ && process.env.E2E_USER_DATA) app.setPath("userData", process.env.E2E_USER_DATA);

async function createWindow(settings: Settings): Promise<void> {
  const win = new BaseWindow({ width: 1300, height: 860, title: "AI Browser" });

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

  const task = await Task.create(
    (message) =>
      new Promise((resolve) => {
        const id = nextConfirmId++;
        pendingConfirms.set(id, resolve);
        toPanel("confirm:request", { id, message });
      }),
    (event) => toPanel("agent:event", event),
    (url) => toPanel("page:url", url),
    (host) => toPanel("egress:blocked", host),
  );

  const layout = () => {
    const { width, height } = win.getContentBounds();
    task.view.setBounds({ x: 0, y: 0, width: Math.max(0, width - PANEL_WIDTH), height });
    panel.setBounds({ x: Math.max(0, width - PANEL_WIDTH), y: 0, width: Math.min(width, PANEL_WIDTH), height });
  };
  win.contentView.addChildView(task.view);
  win.contentView.addChildView(panel);
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
  createWindow(settings).catch((error) => {
    dialog.showErrorBox("AI Browser", `외부 전송 통제를 설정하지 못해 작업을 시작하지 않습니다.\n${error}`);
    app.quit();
  });
});

app.on("window-all-closed", () => app.quit());
