import type { AgentEvent } from "../agent";
import type { LoginState } from "../egress";
import type { PanelApi, PanelProfiles, PanelSettings } from "../main/ipc";

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
  request_login: "로그인 요청",
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

const loginSection = el<HTMLElement>("login");
const loginStatus = el<HTMLElement>("login-status");
const loginHosts = el<HTMLUListElement>("login-hosts");
const loginActions = el<HTMLElement>("login-actions");
const loginStart = el<HTMLButtonElement>("login-start");

function actionButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (primary) button.className = "approve";
  button.onclick = onClick;
  return button;
}

const LOGIN_MESSAGES: Record<LoginState["phase"], string> = {
  open: "로그인 모드입니다. 에이전트는 멈춰 있고 공인 호스트가 모두 열려 있습니다. 왼쪽 페이지에서 로그인한 뒤 완료를 눌러 주세요.",
  frozen: "입력이 없거나 화면이 잠겨 범위를 줄였습니다. 지금까지 접속한 호스트만 통과합니다. 인증을 기다리는 중이면 그대로 두어도 됩니다.",
  choosing: "계속 허용할 호스트를 골라 주세요. 고르지 않은 호스트는 다시 막힙니다.",
};

/** Hosts come from the page, so they only ever go through textContent. */
function showHostChoice(state: LoginState): void {
  loginHosts.replaceChildren(
    ...state.seenHosts.map((host) => {
      const item = document.createElement("li");
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = host;
      box.checked = host === state.startHost;
      label.append(box, ` ${host}`);
      item.append(label);
      return item;
    }),
  );
  loginHosts.hidden = false;
}

function chosenHosts(): string[] {
  return [...loginHosts.querySelectorAll<HTMLInputElement>("input:checked")].map((box) => box.value);
}

panelApi.onLogin((state) => {
  loginSection.hidden = state === null;
  loginStart.disabled = state !== null || running;
  if (!running) runButton.disabled = state !== null;
  loginHosts.hidden = true;
  if (!state) return;
  const until = new Date(state.deadline).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  loginStatus.textContent = `${state.startHost}: ${LOGIN_MESSAGES[state.phase]}${state.phase === "choosing" ? "" : ` ${until}까지 유효합니다.`}`;
  loginSection.dataset.phase = state.phase;
  const cancel = actionButton("취소", () => void panelApi.cancelLogin());
  if (state.phase === "choosing") {
    showHostChoice(state);
    loginActions.replaceChildren(cancel, actionButton("확인", () => void panelApi.chooseLoginHosts(chosenHosts()), true));
  } else if (state.phase === "frozen") {
    loginActions.replaceChildren(
      cancel,
      actionButton("다시 열기", () => void panelApi.reopenLogin()),
      actionButton("완료", () => void panelApi.finishLogin(), true),
    );
  } else {
    loginActions.replaceChildren(cancel, actionButton("완료", () => void panelApi.finishLogin(), true));
  }
});

loginStart.addEventListener("click", async () => {
  const raw = urlInput.value.trim();
  if (!raw) {
    append("error", "로그인할 주소를 입력해 주세요.");
    return;
  }
  const error = await panelApi.startLogin(raw.includes("://") ? raw : `https://${raw}`);
  if (error) append("error", error);
});

const profileSelect = el<HTMLSelectElement>("profile");
const profileCurrent = el<HTMLElement>("profile-current");
const profileHint = el<HTMLElement>("profile-hint");
const profileHosts = el<HTMLUListElement>("profile-hosts");
const profileForm = el<HTMLFormElement>("profile-form");
const profileName = el<HTMLInputElement>("profile-name");
const profileDelete = el<HTMLButtonElement>("profile-delete");
let profilesState: PanelProfiles | null = null;

function askInPanel(message: string, approveLabel: string): Promise<boolean> {
  log.querySelector(".empty")?.remove();
  return new Promise((resolve) => {
    const card = document.createElement("div");
    card.className = "confirm profile-confirm";
    const text = document.createElement("p");
    text.textContent = message;
    const buttons = document.createElement("div");
    const settle = (answer: boolean) => {
      card.remove();
      resolve(answer);
    };
    const deny = actionButton("취소", () => settle(false));
    buttons.append(deny, actionButton(approveLabel, () => settle(true), true));
    card.append(text, buttons);
    log.append(card);
    log.scrollTop = log.scrollHeight;
    deny.focus();
  });
}

function showProfiles(state: PanelProfiles): void {
  profilesState = state;
  const options = [{ id: "", name: "임시 세션" }, ...state.items];
  profileSelect.replaceChildren(
    ...options.map(({ id, name }) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = name;
      return option;
    }),
  );
  profileSelect.value = state.current ?? "";
  profileSelect.disabled = !state.available;
  profileCurrent.textContent = options.find((o) => o.id === (state.current ?? ""))?.name ?? "임시 세션";
  profileForm.hidden = !state.available;
  profileDelete.hidden = state.current === null;
  profileHint.textContent = state.available
    ? "임시 세션은 작업이 끝나면 로그인이 사라집니다. 프로필은 로그인과 허용한 호스트를 저장합니다."
    : "이 시스템에서는 쿠키를 안전하게 암호화할 수 없어 프로필을 쓸 수 없습니다. 임시 세션만 사용합니다.";
  profileHosts.replaceChildren(
    ...state.hosts.map((host) => {
      const item = document.createElement("li");
      item.textContent = `${host} `;
      item.append(actionButton("빼기", () => void panelApi.removeProfileHost(host).then(showProfiles)));
      return item;
    }),
  );
}

/** Another session means another task, so nothing from this one carries over. */
function resetForNewTask(): void {
  log.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = "주소를 열고 할 일을 알려 주세요.";
  log.append(empty);
  urlInput.value = "";
}

profileSelect.addEventListener("change", async () => {
  const target = profileSelect.value || null;
  const proceed = await askInPanel("세션을 바꾸면 현재 작업과 대화가 사라집니다. 바꿀까요?", "바꾸기");
  if (!proceed) {
    profileSelect.value = profilesState?.current ?? "";
    return;
  }
  const state = await panelApi.selectProfile(target);
  showProfiles(state);
  if (state.current === target) resetForNewTask();
  else append("error", "작업이나 로그인이 진행 중이라 세션을 바꾸지 못했습니다.");
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = profileName.value.trim();
  if (!name) return;
  const proceed = await askInPanel(
    "프로필은 로그인을 이 컴퓨터에 저장합니다. 쿠키는 암호화되지만 localStorage와 캐시는 평문으로 남아, 이 컴퓨터의 파일을 읽을 수 있는 사람이나 프로그램이 볼 수 있습니다. 현재 작업과 대화는 사라집니다. 만들까요?",
    "만들기",
  );
  if (!proceed) return;
  const before = profilesState?.current;
  const state = await panelApi.createProfile(name);
  showProfiles(state);
  if (state.current === before) {
    append("error", "작업이나 로그인이 진행 중이라 프로필을 만들지 못했습니다.");
    return;
  }
  profileName.value = "";
  resetForNewTask();
});

profileDelete.addEventListener("click", async () => {
  const id = profilesState?.current;
  if (!id) return;
  const proceed = await askInPanel("이 프로필의 로그인과 허용한 호스트를 삭제하고 임시 세션으로 돌아갑니다. 삭제할까요?", "삭제");
  if (!proceed) return;
  const state = await panelApi.deleteProfile(id);
  showProfiles(state);
  if (state.items.some((item) => item.id === id)) append("error", "작업이나 로그인이 진행 중이라 삭제하지 못했습니다.");
  else resetForNewTask();
});

panelApi.onProfiles(showProfiles);

async function runTask(task: string): Promise<void> {
  append("task", task);
  taskInput.value = "";
  running = true;
  runButton.disabled = true;
  loginStart.disabled = true;
  profileSelect.disabled = true;
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
    loginStart.disabled = false;
    profileSelect.disabled = !profilesState?.available;
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
void panelApi.getProfiles().then(showProfiles);
