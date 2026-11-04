import Anthropic from "@anthropic-ai/sdk";
import { runAgent, type AgentEvent, type AgentOutcome } from "./agent";
import { CdpBrowser } from "./browser";
import { ToolExecutor } from "./tools";

declare const __E2E_API_BASE__: string;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = el<HTMLElement>("log");
const taskForm = el<HTMLFormElement>("task-form");
const taskInput = el<HTMLTextAreaElement>("task");
const runButton = el<HTMLButtonElement>("run");
const stopButton = el<HTMLButtonElement>("stop");
const apiKeyInput = el<HTMLInputElement>("api-key");
const modelInput = el<HTMLSelectElement>("model");
const settings = el<HTMLDetailsElement>("settings");

const messages: Anthropic.Beta.BetaMessageParam[] = [];
let controller: AbortController | null = null;
let cancelPendingConfirm: (() => void) | null = null;

/** Page-derived text reaches this function, so it must only ever use textContent. */
function append(className: string, text: string): HTMLElement {
  log.querySelector(".empty")?.remove();
  const line = document.createElement("p");
  line.className = className;
  line.textContent = text;
  log.append(line);
  log.scrollTop = log.scrollHeight;
  return line;
}

function confirmWithUser(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    log.querySelector(".empty")?.remove();
    const card = document.createElement("div");
    card.className = "confirm";
    const text = document.createElement("p");
    text.textContent = message;
    const buttons = document.createElement("div");
    const finish = (answer: boolean) => {
      cancelPendingConfirm = null;
      card.remove();
      append("action", `${answer ? "승인" : "거부"}: ${message}`);
      resolve(answer);
    };
    const deny = document.createElement("button");
    deny.textContent = "거부";
    deny.onclick = () => finish(false);
    const approve = document.createElement("button");
    approve.textContent = "승인";
    approve.className = "approve";
    approve.onclick = () => finish(true);
    buttons.append(deny, approve);
    card.append(text, buttons);
    cancelPendingConfirm = () => finish(false);
    log.append(card);
    log.scrollTop = log.scrollHeight;
    deny.focus();
  });
}

const ACTION_LABELS: Record<string, string> = {
  read_page: "페이지 읽기",
  screenshot: "화면 캡처",
  click: "클릭",
  type_text: "입력",
  press_key: "키 누르기",
  scroll: "스크롤",
  navigate: "이동",
  go_back: "뒤로 가기",
};

function showEvent(event: AgentEvent): void {
  switch (event.type) {
    case "progress":
      append("progress", event.text);
      break;
    case "action": {
      const input = event.input as { url?: string; key?: string; direction?: string };
      const detail = input.url ?? input.key ?? input.direction ?? "";
      append("action", `${ACTION_LABELS[event.name] ?? event.name} ${detail}`.trim());
      break;
    }
    case "action_failed":
      append("action error", event.message);
      break;
    case "answer":
      append("answer", event.text);
      break;
  }
}

const OUTCOME_MESSAGES: Partial<Record<AgentOutcome, string>> = {
  stopped: "작업을 중지했습니다.",
  step_limit: "단계 한도에 도달해 멈췄습니다. 이어서 진행하려면 다시 지시해 주세요.",
  refused: "모델이 이 요청을 거절했습니다.",
  truncated: "응답이 너무 길어 중단되었습니다. 작업을 더 작게 나눠 주세요.",
  session_ended: "탭이 닫혔거나 디버깅이 취소되어 작업을 끝냈습니다.",
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

async function targetTabId(): Promise<number> {
  if (__E2E_API_BASE__) {
    const override = new URLSearchParams(location.search).get("tabId");
    if (override) return Number(override);
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) throw new Error("현재 탭을 찾지 못했습니다.");
  return tab.id;
}

async function runTask(task: string): Promise<void> {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) {
    settings.open = true;
    apiKeyInput.focus();
    append("error", "먼저 API 키를 저장해 주세요.");
    return;
  }

  append("task", task);
  taskInput.value = "";
  runButton.disabled = true;
  stopButton.hidden = false;
  controller = new AbortController();

  let browser: CdpBrowser | null = null;
  try {
    browser = await CdpBrowser.attach(await targetTabId());
    const executor = new ToolExecutor(browser, confirmWithUser);
    await executor.begin();
    const client = new Anthropic({
      apiKey: String(apiKey),
      // The key belongs to the user and stays in their browser.
      dangerouslyAllowBrowser: true,
      ...(__E2E_API_BASE__ ? { baseURL: __E2E_API_BASE__ } : {}),
    });
    const outcome = await runAgent({
      client,
      model: modelInput.value,
      task,
      messages,
      executor,
      signal: controller.signal,
      onEvent: showEvent,
    });
    const notice = OUTCOME_MESSAGES[outcome];
    if (notice) append(outcome === "stopped" ? "progress" : "error", notice);
  } catch (error) {
    append("error", describeError(error));
  } finally {
    await browser?.dispose();
    controller = null;
    runButton.disabled = false;
    stopButton.hidden = true;
  }
}

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const task = taskInput.value.trim();
  if (task && !controller) void runTask(task);
});

taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    taskForm.requestSubmit();
  }
});

stopButton.addEventListener("click", () => {
  controller?.abort();
  cancelPendingConfirm?.();
});

el<HTMLFormElement>("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({ apiKey: apiKeyInput.value.trim(), model: modelInput.value });
  settings.open = false;
});

void chrome.storage.local.get(["apiKey", "model"]).then(({ apiKey, model }) => {
  if (apiKey) apiKeyInput.value = String(apiKey);
  else settings.open = true;
  if (model) modelInput.value = String(model);
});
