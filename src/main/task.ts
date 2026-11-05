// One task: its own in-memory, egress-controlled session, one page view, and the conversation with the model.
import Anthropic from "@anthropic-ai/sdk";
import { powerMonitor, WebContentsView, type BrowserWindow, type WebContents } from "electron";
import { runAgent, type AgentEvent, type AgentOutcome } from "../agent";
import { CdpBrowser, SessionEndedError } from "../browser";
import type { EgressControl, LoginEnd, LoginLimits, LoginState } from "../egress";
import { GatedCdp, type CdpTransport } from "../gated-cdp";
import { isLoginUrlAllowed, parseWebUrl } from "../policy";
import { ToolExecutor, type Confirm } from "../tools";
import type { Notice } from "./ipc";
import { createTaskSession, prepareForLogin, protectPage, type BlockedRequest, type TaskSession } from "./task-session";

declare const __E2E_API_BASE__: string;

const LOGIN_TICK_MS = 5_000;
const LOCK_CHECK_IDLE_SECONDS = 60;

export interface TaskOptions {
  confirm: Confirm;
  onEvent: (event: AgentEvent) => void;
  onUrl: (url: string) => void;
  onHostBlocked: (host: string) => void;
  onLogin: (state: LoginState | null) => void;
  /** Keeps the login and the allowed hosts across tasks. Without it, everything ends with the task. */
  profile?: { partition: string; hosts: string[]; onHostsChanged: (hosts: string[]) => void };
  /** E2E builds map fixture hosts to loopback and shorten the login limits. The app does not set these. */
  connectHost?: (host: string) => string;
  loginLimits?: LoginLimits;
}

const OUTCOME_MESSAGES: Partial<Record<AgentOutcome, string>> = {
  stopped: "작업을 중지했습니다.",
  step_limit: "단계 한도에 도달해 멈췄습니다. 이어서 진행하려면 다시 지시해 주세요.",
  refused: "모델이 이 요청을 거절했습니다.",
  truncated: "응답이 너무 길어 중단되었습니다. 작업을 더 작게 나눠 주세요.",
  session_ended: "페이지가 닫혀 작업을 끝냈습니다.",
};

function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않습니다. 설정을 확인해 주세요.";
  if (error instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 해당 모델을 사용할 수 없습니다.";
  if (error instanceof Anthropic.RateLimitError) return "요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.";
  if (error instanceof Anthropic.BadRequestError) return `잘못된 요청입니다: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return "API에 연결하지 못했습니다. 네트워크를 확인해 주세요.";
  if (error instanceof Anthropic.APIError) return `API 오류(${error.status})가 발생했습니다. 다시 시도해 주세요.`;
  return error instanceof Error ? error.message : String(error);
}

function attachDebugger(contents: WebContents): CdpTransport & { dispose(): void } {
  const { debugger: dbg } = contents;
  let endedReason: string | null = null;
  const onDetach = (_event: unknown, reason: string) => {
    endedReason = reason;
  };
  const onDestroyed = () => {
    endedReason = "the page was closed";
  };
  dbg.attach("1.3");
  dbg.on("detach", onDetach);
  contents.once("destroyed", onDestroyed);
  return {
    send: (method, params) => dbg.sendCommand(method, params as Record<string, unknown> | undefined),
    get endedReason() {
      return endedReason;
    },
    dispose() {
      if (contents.isDestroyed()) return;
      contents.off("destroyed", onDestroyed);
      dbg.off("detach", onDetach);
      if (dbg.isAttached()) dbg.detach();
    },
  };
}

export class Task {
  readonly view: WebContentsView;
  private readonly messages: Anthropic.Beta.BetaMessageParam[] = [];
  private controller: AbortController | null = null;
  private taskSession!: TaskSession;
  private blockedNavigation: string | null = null;
  private readonly offeredHosts = new Set<string>();
  private readonly popups = new Set<BrowserWindow>();
  private loginBusy = false;
  private loginCancelRequested = false;
  private resolveLogin: ((end: LoginEnd) => void) | null = null;
  private readonly egress: EgressControl = {
    allow: (url) => this.taskSession.allowlist.allow(url.hostname),
    takeBlockedNavigation: () => {
      const url = this.blockedNavigation;
      this.blockedNavigation = null;
      return url;
    },
  };

  /** Rejects if egress control cannot be set up, so a task never runs without it. */
  static async create(options: TaskOptions): Promise<Task> {
    let task: Task | null = null;
    const taskSession = await createTaskSession({
      onBlocked: (blocked) => task?.onBlocked(blocked),
      partition: options.profile?.partition,
      connectHost: options.connectHost,
    });
    if (options.profile) {
      options.profile.hosts.forEach((host) => taskSession.allowlist.allow(host));
      taskSession.allowlist.onChange = options.profile.onHostsChanged;
    }
    task = new Task(taskSession, options);
    return task;
  }

  private constructor(
    taskSession: TaskSession,
    private readonly options: TaskOptions,
  ) {
    this.taskSession = taskSession;
    this.view = new WebContentsView({
      webPreferences: { session: taskSession.session, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    });
    const contents = this.view.webContents;
    protectPage(contents, {
      allowed: () => taskSession.allowlist.loginState !== null,
      onCreated: (popup) => this.trackPopup(popup),
    });
    const report = () => options.onUrl(contents.getURL());
    contents.on("did-navigate", report);
    contents.on("did-navigate-in-page", report);
    contents.on("input-event", () => taskSession.allowlist.noteLoginActivity(Date.now()));
  }

  private onBlocked(blocked: BlockedRequest): void {
    if (blocked.isPageNavigation) this.blockedNavigation = blocked.url;
    if (blocked.host && !this.offeredHosts.has(blocked.host)) {
      this.offeredHosts.add(blocked.host);
      this.options.onHostBlocked(blocked.host);
    }
  }

  /** Only hosts the guard actually blocked can be allowed this way. */
  allowBlockedHost(host: string): void {
    if (this.offeredHosts.delete(host)) this.taskSession.allowlist.allow(host);
  }

  removeAllowedHost(host: string): void {
    this.taskSession.allowlist.remove(host);
    this.taskSession.closeDisallowedConnections();
  }

  get allowedHosts(): string[] {
    return this.taskSession.allowlist.list();
  }

  get running(): boolean {
    return this.controller !== null;
  }

  /** Busy tasks keep their login boundary: no address changes, no new runs, no profile switch. */
  get busy(): boolean {
    return this.running || this.loginBusy;
  }

  /** Opens a page the user asked for. Returns an error message, or null when it loaded. */
  async navigate(raw: string): Promise<string | null> {
    if (this.loginBusy) return "로그인 중에는 주소 창으로 이동할 수 없습니다. 로그인 페이지 안에서 이동해 주세요.";
    if (this.running) return "작업이 진행 중일 때는 주소를 바꿀 수 없습니다.";
    const url = parseWebUrl(raw);
    if (!url) return "http 또는 https 주소만 열 수 있습니다.";
    this.egress.allow(url);
    try {
      await this.view.webContents.loadURL(url.href);
      return null;
    } catch (error) {
      return `페이지를 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** The user's own way into login. Returns an error message, or null once login has started. */
  startLogin(raw: string): string | null {
    if (this.busy) return "작업이 진행 중일 때는 로그인을 시작할 수 없습니다.";
    const url = parseWebUrl(raw);
    if (!url || !isLoginUrlAllowed(url)) return "로그인은 https 주소에서만 시작할 수 있습니다.";
    void this.runLogin(url);
    return null;
  }

  private async runLogin(url: URL): Promise<LoginEnd> {
    const { allowlist } = this.taskSession;
    const contents = this.view.webContents;
    this.loginBusy = true;
    this.loginCancelRequested = false;
    const limits = this.options.loginLimits;
    const tick = (locked = powerMonitor.getSystemIdleState(LOCK_CHECK_IDLE_SECONDS) === "locked") => {
      if (allowlist.tickLogin(Date.now(), locked)) this.publishLogin();
    };
    const onSuspend = () => tick(true);
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await prepareForLogin(contents);
      if (this.loginCancelRequested) return "cancelled";
      allowlist.beginLogin(url.hostname, Date.now(), limits);
      this.publishLogin();
      timer = setInterval(tick, limits ? Math.min(LOGIN_TICK_MS, limits.idleMs / 4) : LOGIN_TICK_MS);
      powerMonitor.on("suspend", onSuspend);
      const ended = new Promise<LoginEnd>((resolve) => {
        this.resolveLogin = resolve;
      });
      contents.loadURL(url.href).catch(() => {}); // A failed page is the user's to see and cancel.
      return await ended;
    } catch {
      return "cancelled"; // The page was closed while preparing.
    } finally {
      clearInterval(timer);
      powerMonitor.off("suspend", onSuspend);
      this.resolveLogin = null;
      this.loginBusy = false;
    }
  }

  private publishLogin(): void {
    this.options.onLogin(this.taskSession.allowlist.loginState);
  }

  private trackPopup(popup: BrowserWindow): void {
    this.popups.add(popup);
    popup.once("closed", () => this.popups.delete(popup));
    const contents = popup.webContents;
    // Sign-in popups have no address bar, and the user must be able to see where they are typing.
    const showAddress = () => popup.setTitle(`로그인 창: ${contents.getURL()}`);
    popup.on("page-title-updated", (event) => {
      event.preventDefault();
      showAddress();
    });
    contents.on("did-navigate", showAddress);
    contents.on("did-navigate-in-page", showAddress);
    contents.on("input-event", () => this.taskSession.allowlist.noteLoginActivity(Date.now()));
    showAddress();
  }

  private concludeLogin(end: LoginEnd): void {
    for (const popup of [...this.popups]) popup.destroy();
    this.taskSession.closeDisallowedConnections();
    // Chromium writes cookies out every 30 seconds or so, and a crash should not lose a login just made.
    void this.taskSession.session.cookies.flushStore().catch(() => {});
    this.publishLogin();
    this.resolveLogin?.(end);
  }

  reopenLogin(): void {
    this.taskSession.allowlist.reopenLogin(Date.now());
    this.publishLogin();
  }

  finishLogin(): void {
    this.taskSession.allowlist.finishLogin();
    this.publishLogin();
  }

  chooseLoginHosts(hosts: string[]): void {
    const end = this.taskSession.allowlist.chooseLoginHosts(hosts);
    if (end) this.concludeLogin(end);
  }

  cancelLogin(): void {
    if (!this.loginBusy) return;
    this.loginCancelRequested = true;
    if (!this.taskSession.allowlist.loginState) return; // Still preparing: runLogin checks the flag.
    this.taskSession.allowlist.cancelLogin();
    this.concludeLogin("cancelled");
  }

  async run(prompt: string, apiKey: string, model: string): Promise<Notice | null> {
    if (this.running) return { level: "error", text: "이미 작업이 진행 중입니다." };
    if (this.loginBusy) return { level: "error", text: "로그인을 먼저 끝내 주세요." };
    const controller = new AbortController();
    this.controller = controller;
    let transport: ReturnType<typeof attachDebugger> | null = null;
    try {
      transport = attachDebugger(this.view.webContents);
      const browser = await CdpBrowser.attach(new GatedCdp(transport));
      const contents = this.view.webContents;
      const executor = new ToolExecutor(browser, this.options.confirm, this.egress, {
        active: () => this.loginBusy,
        run: async (url) => {
          transport?.dispose(); // The debugger must not see what the user types.
          transport = null;
          const end = await this.runLogin(url);
          if (contents.isDestroyed()) throw new SessionEndedError("the page was closed");
          transport = attachDebugger(contents);
          return { end, browser: await CdpBrowser.attach(new GatedCdp(transport)) };
        },
      });
      await executor.begin();
      const client = new Anthropic({
        apiKey,
        ...(__E2E_API_BASE__ ? { baseURL: __E2E_API_BASE__ } : {}),
      });
      const outcome = await runAgent({
        client,
        model,
        task: prompt,
        messages: this.messages,
        executor,
        signal: controller.signal,
        onEvent: this.options.onEvent,
      });
      const text = OUTCOME_MESSAGES[outcome];
      return text ? { level: outcome === "stopped" ? "progress" : "error", text } : null;
    } catch (error) {
      return { level: "error", text: describeError(error) };
    } finally {
      transport?.dispose();
      this.controller = null;
    }
  }

  stop(): void {
    this.controller?.abort();
    this.cancelLogin();
  }

  close(): void {
    this.stop();
    for (const popup of [...this.popups]) popup.destroy();
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    void this.taskSession.dispose();
  }
}
