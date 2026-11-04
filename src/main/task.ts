// One task: its own in-memory, egress-controlled session, one page view, and the conversation with the model.
import Anthropic from "@anthropic-ai/sdk";
import { WebContentsView, type WebContents } from "electron";
import { runAgent, type AgentEvent, type AgentOutcome } from "../agent";
import { CdpBrowser } from "../browser";
import type { EgressControl } from "../egress";
import { GatedCdp, type CdpTransport } from "../gated-cdp";
import { parseWebUrl } from "../policy";
import { ToolExecutor, type Confirm } from "../tools";
import type { Notice } from "./ipc";
import { createTaskSession, protectPage, type BlockedRequest, type TaskSession } from "./task-session";

declare const __E2E_API_BASE__: string;

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
  private readonly egress: EgressControl = {
    allow: (url) => this.taskSession.allowlist.allow(url.hostname),
    takeBlockedNavigation: () => {
      const url = this.blockedNavigation;
      this.blockedNavigation = null;
      return url;
    },
  };

  /** Rejects if egress control cannot be set up, so a task never runs without it. */
  static async create(
    confirm: Confirm,
    onEvent: (event: AgentEvent) => void,
    onUrl: (url: string) => void,
    onHostBlocked: (host: string) => void,
  ): Promise<Task> {
    let task: Task | null = null;
    const taskSession = await createTaskSession({ onBlocked: (blocked) => task?.onBlocked(blocked) });
    task = new Task(taskSession, confirm, onEvent, onUrl, onHostBlocked);
    return task;
  }

  private constructor(
    taskSession: TaskSession,
    private readonly confirm: Confirm,
    private readonly onEvent: (event: AgentEvent) => void,
    onUrl: (url: string) => void,
    private readonly onHostBlocked: (host: string) => void,
  ) {
    this.taskSession = taskSession;
    this.view = new WebContentsView({
      webPreferences: { session: taskSession.session, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    });
    const contents = this.view.webContents;
    protectPage(contents);
    const report = () => onUrl(contents.getURL());
    contents.on("did-navigate", report);
    contents.on("did-navigate-in-page", report);
  }

  private onBlocked(blocked: BlockedRequest): void {
    if (blocked.isPageNavigation) this.blockedNavigation = blocked.url;
    if (blocked.host && !this.offeredHosts.has(blocked.host)) {
      this.offeredHosts.add(blocked.host);
      this.onHostBlocked(blocked.host);
    }
  }

  /** Only hosts the guard actually blocked can be allowed this way. */
  allowBlockedHost(host: string): void {
    if (this.offeredHosts.delete(host)) this.taskSession.allowlist.allow(host);
  }

  get running(): boolean {
    return this.controller !== null;
  }

  /** Opens a page the user asked for. Returns an error message, or null when it loaded. */
  async navigate(raw: string): Promise<string | null> {
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

  async run(prompt: string, apiKey: string, model: string): Promise<Notice | null> {
    if (this.running) return { level: "error", text: "이미 작업이 진행 중입니다." };
    const controller = new AbortController();
    this.controller = controller;
    let transport: ReturnType<typeof attachDebugger> | null = null;
    try {
      transport = attachDebugger(this.view.webContents);
      const browser = await CdpBrowser.attach(new GatedCdp(transport));
      const executor = new ToolExecutor(browser, this.confirm, this.egress);
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
        onEvent: this.onEvent,
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
  }

  close(): void {
    this.stop();
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    void this.taskSession.dispose();
  }
}
