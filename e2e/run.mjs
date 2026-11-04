// Runs the built app in real Electron with its sandbox on. Only the Anthropic API is faked: tool calls run
// against a real page through webContents.debugger, and the fake reads refs from the real read_page output.
//
// The test drives the panel through a debugging port instead of Playwright, because Playwright's Electron
// launcher adds --no-sandbox and hung on this app. Electron refuses webContents.debugger while another client
// is attached, so the task page is only inspected while no task is running.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electronPath from "electron";

// A server has no display, so run under a virtual one.
if (process.platform === "linux" && !process.env.DISPLAY) {
  const { status } = spawnSync("xvfb-run", ["-a", process.execPath, ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(status ?? 1);
}

const API_PORT = 18473;
const SITE_PORT = 18474;
const DEBUG_PORT = 18475;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const OTHER = `http://localhost:${SITE_PORT}`;
const IPV6 = `http://[::1]:${SITE_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
}

execFileSync("node", ["build.mjs"], { env: { ...process.env, E2E_API_BASE: `http://127.0.0.1:${API_PORT}` }, stdio: "inherit" });

const siteHits = [];
const site = createServer((req, res) => {
  siteHits.push(req.url);
  const file = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
  try {
    const html = readFileSync(join("e2e/site", file), "utf8").replaceAll("OTHER_ORIGIN", OTHER).replaceAll("IPV6_ORIGIN", IPV6);
    res.writeHead(200, { "content-type": "text/html" }).end(html);
  } catch {
    res.writeHead(404).end();
  }
}).listen(SITE_PORT);

// Each step reads the latest tool result and returns the next model reply.
const results = [];
const refOf = (label) => {
  const outline = results.findLast((r) => r.includes("<untrusted_page")) ?? "";
  const match = outline.match(new RegExp(`\\[(\\d+)\\] \\w+ "${label}"`));
  if (!match) throw new Error(`no ref for ${label} in:\n${outline}`);
  return Number(match[1]);
};
const use = (name, input) => ({ name, input });
const script = [
  () => use("read_page", { offset: 0 }),
  () => use("type_text", { ref: refOf("Your name"), text: "Kim", submit: false }),
  () => use("click", { ref: refOf("Say hello") }),
  () => use("read_page", { offset: 0 }),
  () => use("click", { ref: refOf("Delete account") }), // Declined.
  () => use("read_page", { offset: 0 }),
  () => use("click", { ref: refOf("Delete account") }), // Approved.
  () => use("read_page", { offset: 0 }),
  () => use("type_text", { ref: refOf("Password"), text: "hunter2", submit: false }),
  () => use("screenshot", {}),
  () => use("navigate", { url: "javascript:alert(1)" }),
  () => use("click", { ref: refOf("Leave site") }), // Declined after the page moved.
  () => use("read_page", { offset: 0 }),
  () => use("navigate", { url: `${OTHER}/other.html` }), // Approved.
  () => use("read_page", { offset: 0 }),
  () => use("go_back", {}),
  () => use("read_page", { offset: 0 }),
  () => use("click", { ref: refOf("Open second tab") }),
  () => use("read_page", { offset: 0 }),
];

const requests = [];
const api = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw);
    requests.push({ url: req.url, headers: req.headers, body });
    const last = body.messages.at(-1);
    for (const block of Array.isArray(last.content) ? last.content : []) {
      if (block.type === "tool_result") {
        results.push(typeof block.content === "string" ? block.content : JSON.stringify(block.content));
      }
    }
    const step = requests.length - 1;
    const base = { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    let message;
    try {
      const next = script[step]?.();
      message = next
        ? {
            ...base,
            stop_reason: "tool_use",
            content: [
              { type: "thinking", thinking: `step ${step}`, signature: `sig${step}` },
              { type: "tool_use", id: `tu_${step}`, ...next },
            ],
          }
        : { ...base, stop_reason: "end_turn", content: [{ type: "text", text: "모든 작업을 끝냈습니다" }] };
    } catch (error) {
      message = { ...base, stop_reason: "end_turn", content: [{ type: "text", text: `SCRIPT ERROR ${error.message}` }] };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
  });
}).listen(API_PORT);

/** A minimal CDP client for one view of the app. */
async function connect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("could not connect to view"));
  });
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  const waitFor = async (expression, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for: ${expression}`);
  };
  const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  return {
    send,
    evaluate,
    waitFor,
    errors,
    close: () => ws.close(),
    fill: (selector, value) => evaluate(`${q(selector)}.value = ${JSON.stringify(value)}`),
    click: (selector) => evaluate(`${q(selector)}.click()`),
    text: (selector) => evaluate(`${q(selector)}.innerText`),
    value: (selector) => evaluate(`${q(selector)}.value`),
    exists: (selector) => `!!${q(selector)}`,
  };
}

async function views() {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return (await response.json()).filter((t) => t.type === "page");
}

async function findView(match) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = await views().then((all) => all.find((t) => match(t.url)), () => null);
    if (found) return found;
    await sleep(100);
  }
  throw new Error("view did not appear");
}

const isPanel = (url) => url.endsWith("/panel.html");
const userData = mkdtempSync(join(tmpdir(), "ai-browser-e2e-"));
const appArgs = [`--remote-debugging-port=${DEBUG_PORT}`, resolve("dist-e2e/main.cjs")];
const app = spawn(electronPath, appArgs, {
  env: { ...process.env, E2E_USER_DATA: userData },
  stdio: ["ignore", "ignore", "pipe"],
});
let appLog = "";
app.stderr.on("data", (d) => (appLog += d));
let appExited = false;
app.on("exit", () => (appExited = true));

// Tear down rather than hang if the app stops responding.
const watchdog = setTimeout(() => {
  console.error("FAIL  test timed out");
  app.kill("SIGKILL");
  process.exit(1);
}, 120_000);

try {
  const panel = await connect((await findView(isPanel)).webSocketDebuggerUrl);
  await panel.send("Runtime.enable");
  await panel.waitFor(`document.readyState === "complete"`);

  await panel.waitFor(`document.querySelector("#api-key").placeholder.startsWith("sk-ant")`);
  await panel.fill("#api-key", "sk-ant-test");
  await panel.click("#settings-form button[type=submit]");
  await panel.waitFor(`document.querySelector("#api-key").placeholder.includes("저장된")`);
  check("key is not left in the panel after saving", (await panel.value("#api-key")) === "");

  await panel.fill("#url", "file:///etc/passwd");
  await panel.click("#address button");
  await panel.waitFor(panel.exists(".error"));
  check("address bar rejects file: URLs", (await panel.text(".error")).includes("http"));
  await panel.evaluate(`document.querySelector(".error").remove()`);

  await panel.fill("#url", `${SITE}/`);
  await panel.click("#address button");
  await panel.waitFor(`document.querySelector("#url").value === ${JSON.stringify(`${SITE}/`)}`);

  const page = await connect((await findView((url) => url === `${SITE}/`)).webSocketDebuggerUrl);
  check(
    "task page has no access to the app",
    await page.evaluate(`typeof require === "undefined" && typeof process === "undefined" && typeof panelApi === "undefined"`),
  );
  page.close();
  await sleep(200); // Electron refuses webContents.debugger until this client has gone.

  const blockedText = () => panel.evaluate(`[...document.querySelectorAll(".blocked")].map((e) => e.textContent).join("|")`);
  await panel.waitFor(`document.querySelectorAll(".blocked").length === 2`);
  const blockedHosts = await blockedText();
  check("blocked hosts are shown to the user", blockedHosts.includes("localhost") && blockedHosts.includes("[::1]"), blockedHosts);
  check("blocked images never reached the server", !siteHits.some((u) => u.endsWith(".png")), siteHits.join(","));

  await panel.evaluate(`[...document.querySelectorAll(".blocked")].find((e) => e.textContent.includes("[::1]")).querySelector("button").click()`);
  await sleep(100);
  await panel.click("#address button");
  const allowDeadline = Date.now() + 5_000;
  while (!siteHits.includes("/after-allow.png") && Date.now() < allowDeadline) await sleep(50);
  check("a host the user allowed is reachable", siteHits.includes("/after-allow.png"), siteHits.join(","));
  check("other hosts stay blocked after that", !siteHits.includes("/beacon.png"), siteHits.join(","));
  await sleep(300);

  await panel.fill("#task", "테스트 작업을 수행해 줘");
  await panel.click("#run");

  // Scripted answers to approval prompts, in the order they should appear.
  const answers = [
    ["Delete account", "거부"],
    ["Delete account", "승인"],
    ["/other.html", "거부"],
    ["/other.html", "승인"],
  ];
  let declinedHitsOther = null;
  for (const [expected, button] of answers) {
    if (expected === "/other.html" && button === "승인") declinedHitsOther = siteHits.includes("/other.html");
    await panel.waitFor(panel.exists(".confirm"));
    const text = await panel.text(".confirm");
    check(`approval shown: ${expected} -> ${button}`, text.includes(expected), text);
    await panel.evaluate(`[...document.querySelectorAll(".confirm button")].find((b) => b.textContent === ${JSON.stringify(button)}).click()`);
    await panel.waitFor(`!${panel.exists(".confirm")}`);
  }

  await panel.waitFor(panel.exists(".answer"), 30_000);
  check("final answer shown", (await panel.text(".answer")).includes("끝냈습니다"));
  check("no script errors from fake model", !results.some((r) => r.includes("SCRIPT ERROR")) && !(await panel.text("#log")).includes("SCRIPT ERROR"));

  check("read_page returned real page outline", results[0].includes('button "Say hello"') && results[0].includes("<untrusted_page"), results[0]);
  check("hidden text is not sent to the model", !results.some((r) => r.includes("HIDDEN_INJECTION")));
  check("typing and clicking changed the page", results[3].includes("Hello Kim"), results[3]);
  check("declined click returned a declined result", results[4].includes("declined"), results[4]);
  check("declined click left the page unchanged", results[5].includes("Account active"), results[5]);
  check("approved click ran", results[7].includes("Account deleted"), results[7]);
  check("password field was blocked", results[8].includes("Blocked"), results[8]);
  check("password was not typed", !results.some((r) => r.includes("hunter2")));
  check("screenshot returned an image", results[9].includes('"media_type":"image/jpeg"'), results[9].slice(0, 200));
  check("javascript: URL was rejected", results[10].includes("Only http"), results[10]);
  check("declined cross-origin click stayed on the page", results[11].includes("not allowed") && results[12].includes("Say hello"), results[11]);
  check("declined click sent nothing to the other site", declinedHitsOther === false);
  check("approved navigation reached the other site", results[14].includes("FOREIGN_SITE_CONTENT"), results[14]);
  check("page that opens a window continues in the same view", results[18].includes("SECOND_TAB_CONTENT"), results[18]);

  const first = requests[0];
  check("request goes to /v1/messages", first.url.split("?")[0] === "/v1/messages", first.url);
  check(
    "request sends the API key from the main process",
    (first.headers["x-api-key"] ?? first.headers.authorization ?? "").includes("sk-ant-test") && !("anthropic-dangerous-direct-browser-access" in first.headers),
    Object.keys(first.headers).join(", "),
  );
  check("request sends both beta headers", /thinking-display-updates-2026-08-18/.test(first.headers["anthropic-beta"]) && /server-side-fallback-2026-07-01/.test(first.headers["anthropic-beta"]), first.headers["anthropic-beta"]);
  check("thinking blocks are sent back unchanged", requests[1].body.messages[1].content[0].signature === "sig0");

  // A second task can only attach if the first one detached the debugger.
  await panel.waitFor(`!document.querySelector("#run").disabled`);
  await panel.fill("#task", "이어서 하나 더");
  await panel.click("#run");
  await panel.waitFor(`document.querySelectorAll(".answer").length === 2`);
  check("debugger detaches after the task", !(await panel.text("#log")).includes("attached"));
  check("follow-up task keeps the conversation", requests.at(-1).body.messages[0].content === "테스트 작업을 수행해 줘");
  check("no uncaught errors in the panel", panel.errors.length === 0, panel.errors.join("; "));

  const { data } = await panel.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(process.env.E2E_SHOT ?? "dist-e2e/panel.png", Buffer.from(data, "base64"));
  panel.close();
} catch (error) {
  failures++;
  console.error("FAIL ", error);
  if (appExited) console.error(appLog.slice(-2000));
} finally {
  clearTimeout(watchdog);
  app.kill();
  rmSync(userData, { recursive: true, force: true });
  site.close();
  api.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
