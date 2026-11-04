// Runs the built extension in real Chromium. Only the Anthropic API is faked: tool calls run against
// a real page through chrome.debugger, and the fake reads refs from the real read_page output.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const API_PORT = 18473;
const SITE_PORT = 18474;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const OTHER = `http://localhost:${SITE_PORT}`;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
}

execFileSync("node", ["build.mjs"], { env: { ...process.env, E2E_API_BASE: `http://127.0.0.1:${API_PORT}` }, stdio: "inherit" });

const site = createServer((req, res) => {
  const file = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
  try {
    const html = readFileSync(join("e2e/site", file), "utf8").replace("OTHER_ORIGIN", OTHER);
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
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
    "content-type": "application/json",
  };
  if (req.method === "OPTIONS") return res.writeHead(204, headers).end();
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
    res.writeHead(200, headers).end(JSON.stringify(message));
  });
}).listen(API_PORT);

const cache = join(homedir(), ".cache/ms-playwright");
const revision = readdirSync(cache).find((d) => /^chromium-\d+$/.test(d));
const executablePath = join(cache, revision, "chrome-linux64/chrome");
const extension = resolve("dist-e2e");
const context = await chromium.launchPersistentContext("", {
  executablePath,
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;

  const fixture = await context.newPage();
  await fixture.goto(`${SITE}/`);

  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${SITE}/`);
  await worker.evaluate(() => chrome.storage.local.set({ apiKey: "sk-ant-test" }));

  // Open the panel in its own window so the fixture stays the active tab, as with a real side panel.
  const panelPromise = context.waitForEvent("page");
  await worker.evaluate(
    (url) => chrome.windows.create({ url, type: "popup", width: 420, height: 720 }),
    `chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`,
  );
  const panel = await panelPromise;
  await panel.waitForLoadState();
  const pageErrors = [];
  panel.on("pageerror", (e) => pageErrors.push(e.message));

  await panel.fill("#task", "테스트 작업을 수행해 줘");
  await panel.click("#run");

  // Scripted answers to approval prompts, in the order they should appear.
  const answers = [
    ["Delete account", "거부"],
    ["Delete account", "승인"],
    ["/other.html", "거부"],
    ["/other.html", "승인"],
  ];
  for (const [expected, button] of answers) {
    const card = panel.locator(".confirm");
    await card.waitFor({ timeout: 20_000 });
    const text = await card.innerText();
    check(`approval shown: ${expected} -> ${button}`, text.includes(expected), text);
    if (button === "거부" && expected === "Delete account") {
      check("page unchanged while approval is pending", (await fixture.textContent("#danger")) === "Account active");
    }
    await card.getByRole("button", { name: button, exact: true }).click();
    await card.waitFor({ state: "detached" });
  }

  await panel.locator(".answer").waitFor({ timeout: 30_000 });
  check("final answer shown", (await panel.locator(".answer").innerText()).includes("끝냈습니다"));
  check("no script errors from fake model", !results.some((r) => r.includes("SCRIPT ERROR")) && !(await panel.locator("#log").innerText()).includes("SCRIPT ERROR"));

  check("read_page returned real page outline", results[0].includes('button "Say hello"') && results[0].includes("<untrusted_page"), results[0]);
  check("hidden text is not sent to the model", !results.some((r) => r.includes("HIDDEN_INJECTION")));
  check("typing and clicking changed the page", results[3].includes("Hello Kim"), results[3]);
  check("declined click returned a declined result", results[4].includes("declined"), results[4]);
  check("approved click ran", results[7].includes("Account deleted"), results[7]);
  check("password field was blocked", results[8].includes("Blocked"), results[8]);
  check("password was not typed", (await fixture.inputValue("#pw").catch(() => "")) === "");
  check("screenshot returned an image", results[9].includes('"media_type":"image/jpeg"'), results[9].slice(0, 200));
  check("javascript: URL was rejected", results[10].includes("Only http"), results[10]);
  check("declined cross-origin click went back", results[11].includes("not allowed") && results[12].includes("Say hello"), results[11]);
  check("approved navigation reached the other site", results[14].includes("FOREIGN_SITE_CONTENT"), results[14]);
  check("agent followed the newly opened tab", results[18].includes("SECOND_TAB_CONTENT"), results[18]);

  const first = requests[0];
  check("request goes to /v1/messages", first.url.split("?")[0] === "/v1/messages", first.url);
  check("request sends the API key and browser access header", first.headers.authorization === "Bearer sk-ant-test" && first.headers["anthropic-dangerous-direct-browser-access"] === "true", JSON.stringify(first.headers));
  check("request sends both beta headers", /thinking-display-updates-2026-08-18/.test(first.headers["anthropic-beta"]) && /server-side-fallback-2026-07-01/.test(first.headers["anthropic-beta"]), first.headers["anthropic-beta"]);
  check("thinking blocks are sent back unchanged", requests[1].body.messages[1].content[0].signature === "sig0");
  check("no uncaught errors in the panel", pageErrors.length === 0, pageErrors.join("; "));

  await panel.waitForFunction(() => !document.getElementById("run").disabled);
  const attached = await worker.evaluate(async () => (await chrome.debugger.getTargets()).filter((t) => t.attached && t.extensionId === chrome.runtime.id).length).catch(() => -1);
  check("debugger detaches after the task", attached === 0, `attached=${attached}`);
  await panel.setViewportSize({ width: 420, height: 720 });
  await panel.screenshot({ path: process.env.E2E_SHOT ?? "dist-e2e/panel.png" });
} catch (error) {
  failures++;
  console.error("FAIL ", error);
} finally {
  await context.close();
  site.close();
  api.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
