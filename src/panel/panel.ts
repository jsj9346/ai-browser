import type { AgentEvent } from "../agent";
import type { PanelApi, PanelSettings } from "../main/ipc";

declare const panelApi: PanelApi;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = el<HTMLElement>("log");
const urlInput = el<HTMLInputElement>("url");
const taskForm = el<HTMLFormElement>("task-form");
const taskInput = el<HTMLTextAreaElement>("task");
const runButton = el<HTMLButtonElement>("run");
const stopButton = el<HTMLButtonElement>("stop");
const apiKeyInput = el<HTMLInputElement>("api-key");
const modelInput = el<HTMLSelectElement>("model");
const settings = el<HTMLDetailsElement>("settings");
const keyHint = el<HTMLElement>("key-hint");

let running = false;

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

const confirmCards = new Map<number, { card: HTMLElement; message: string; answer: boolean }>();

panelApi.onConfirm(({ id, message }) => {
  log.querySelector(".empty")?.remove();
  const card = document.createElement("div");
  card.className = "confirm";
  const text = document.createElement("p");
  text.textContent = message;
  const buttons = document.createElement("div");
  const entry = { card, message, answer: false };
  const answer = (value: boolean) => {
    entry.answer = value;
    void panelApi.answerConfirm(id, value);
  };
  const deny = document.createElement("button");
  deny.textContent = "거부";
  deny.onclick = () => answer(false);
  const approve = document.createElement("button");
  approve.textContent = "승인";
  approve.className = "approve";
  approve.onclick = () => answer(true);
  buttons.append(deny, approve);
  card.append(text, buttons);
  confirmCards.set(id, entry);
  log.append(card);
  log.scrollTop = log.scrollHeight;
  deny.focus();
});

panelApi.onConfirmClosed((id) => {
  const entry = confirmCards.get(id);
  if (!entry) return;
  confirmCards.delete(id);
  entry.card.remove();
  append("action", `${entry.answer ? "승인" : "거부"}: ${entry.message}`);
});

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

panelApi.onAgentEvent((event: AgentEvent) => {
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
});

panelApi.onHostBlocked((host) => {
  const line = append("blocked", `차단됨: ${host}`);
  const allow = document.createElement("button");
  allow.textContent = "허용";
  allow.onclick = () => {
    allow.remove();
    line.textContent = `허용함: ${host} (페이지를 다시 열면 적용됩니다)`;
    void panelApi.allowHost(host);
  };
  line.append(" ", allow);
});

panelApi.onPageUrl((url) => {
  urlInput.value = url;
});

async function runTask(task: string): Promise<void> {
  append("task", task);
  taskInput.value = "";
  running = true;
  runButton.disabled = true;
  stopButton.hidden = false;
  try {
    const notice = await panelApi.runTask(task);
    if (notice) append(notice.level, notice.text);
    if (notice?.needsKey) {
      settings.open = true;
      apiKeyInput.focus();
    }
  } catch (error) {
    append("error", error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
    runButton.disabled = false;
    stopButton.hidden = true;
  }
}

el<HTMLFormElement>("address").addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = urlInput.value.trim();
  if (!raw) return;
  const error = await panelApi.navigate(raw.includes("://") ? raw : `https://${raw}`);
  if (error) append("error", error);
});

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const task = taskInput.value.trim();
  if (task && !running) void runTask(task);
});

taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    taskForm.requestSubmit();
  }
});

stopButton.addEventListener("click", () => void panelApi.stop());

function showSettings(current: PanelSettings): void {
  modelInput.value = current.model;
  apiKeyInput.value = "";
  apiKeyInput.placeholder = current.hasKey ? "저장된 키 사용 중" : "sk-ant-...";
  keyHint.textContent = current.keyPersisted
    ? "키는 암호화해 이 컴퓨터에 저장합니다."
    : "이 시스템에서는 키를 암호화할 수 없어 저장하지 않습니다. 앱을 끄면 다시 입력해야 합니다.";
  if (!current.hasKey) settings.open = true;
}

el<HTMLFormElement>("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showSettings(await panelApi.saveSettings({ apiKey: apiKeyInput.value.trim(), model: modelInput.value }));
  settings.open = false;
});

void panelApi.getSettings().then(showSettings);
