// Drives the login flow in real Electron with its sandbox on. Fixture hosts ending in .e2e.test look public to
// login mode but connect to this machine. Only the Anthropic API is faked, so this says nothing about real
// sites or real model behavior. See e2e/run.mjs for why this uses a debugging port.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electronPath from "electron";
import { connect } from "./cdp-client.mjs";

if (process.platform === "linux" && !process.env.DISPLAY) {
  const { status } = spawnSync("xvfb-run", ["-a", process.execPath, ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(status ?? 1);
}

const API_PORT = 18483;
const SITE_PORT = 18484;
const DEBUG_PORT = 18485;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const CDN = `http://cdn.e2e.test:${SITE_PORT}`;
const IDP = `http://idp.e2e.test:${SITE_PORT}`;
const NEW_HOST = `http://new.e2e.test:${SITE_PORT}`;
const LOCAL = `http://localhost:${SITE_PORT}`;
const COOKIE_VALUE = "neo-e2e-cookie-value";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
}

execFileSync("node", ["build.mjs"], { env: { ...process.env, E2E_API_BASE: `http://127.0.0.1:${API_PORT}` }, stdio: "inherit" });

const hits = [];
const hit = (url) => hits.includes(url);
const site = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  hits.push(`${url.host}${url.pathname}`);
  const html = (body, headers = {}) => res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*", ...headers }).end(`<!doctype html>${body}`);
  switch (url.pathname) {
    case "/start":
      return html(`<title>Sign in</title><h1>Sign in here</h1><img alt="" src="${CDN}/cdn.png"><script>window.got=null;addEventListener("message",(e)=>{window.got=e.data});</script>`);
    case "/popup":
      return html(`<title>Provider</title><script>if(opener)opener.postMessage("login-ok","*")</script>`);
    case "/session":
      return html("<p>signed in</p>", { "set-cookie": `sid=${COOKIE_VALUE}; Path=/; Max-Age=86400; HttpOnly` });
    case "/whoami":
      return html(`<p id="me">${/(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "anonymous"}</p>`);
    default:
      return html("<p>page</p>");
  }
}).listen(SITE_PORT);

let script = [];
const results = [];
let apiCalls = 0;
let lastRequest = null;
const api = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw);
    lastRequest = body;
    for (const block of Array.isArray(body.messages.at(-1).content) ? body.messages.at(-1).content : []) {
      if (block.type === "tool_result") results.push(typeof block.content === "string" ? block.content : JSON.stringify(block.content));
    }
    const step = apiCalls++;
    const next = script.shift();
    const base = { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    const message = next
      ? { ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu_${step}`, name: next, input: next === "read_page" ? { offset: 0 } : {} }] }
      : { ...base, stop_reason: "end_turn", content: [{ type: "text", text: "끝냈습니다" }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
  });
}).listen(API_PORT);

const views = async () => (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).filter((t) => t.type === "page");
async function findView(match) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = await views().then((all) => all.find((t) => match(t.url)), () => null);
    if (found) return found;
    await sleep(100);
  }
  throw new Error("view did not appear");
}

let runningApp = null;

/** Starts the app and returns its panel. Every launch of one data folder sees what the last one saved. */
async function launch(userData, env = {}) {
  const app = spawn(electronPath, [`--remote-debugging-port=${DEBUG_PORT}`, resolve("dist-e2e/main.cjs")], {
    env: { ...process.env, E2E_USER_DATA: userData, ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  runningApp = app;
  const panel = await connect((await findView((url) => url.endsWith("/panel.html"))).webSocketDebuggerUrl);
  await panel.send("Runtime.enable");
  await panel.waitFor(`document.readyState === "complete" && document.querySelector("#profile").options.length > 0`);
  return {
    panel,
    async quit() {
      panel.close();
      const exited = new Promise((r) => app.once("exit", r));
      app.kill();
      await Promise.race([exited, sleep(10_000).then(() => app.kill("SIGKILL"))]);
      await sleep(300); // The debugging port must be free for the next launch.
    },
  };
}

const clickText = (panel, scope, text) => panel.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent === ${JSON.stringify(text)}).click()`);
const openAddress = async (panel, url) => {
  await panel.fill("#url", url);
  await panel.click("#address button");
};
const startLogin = async (panel, url) => {
  await panel.fill("#url", url);
  await panel.click("#login-start");
};
const phaseIs = (panel, phase) => panel.waitFor(`document.querySelector("#login").dataset.phase === ${JSON.stringify(phase)} && !document.querySelector("#login").hidden`);
const loginEnded = (panel) => panel.waitFor(`document.querySelector("#login").hidden`);
const pageReach = (page, url) => page.gesture(`fetch(${JSON.stringify(url)},{mode:"no-cors"}).then(()=>"reached",()=>"blocked")`);
const hostsText = (panel) => panel.evaluate(`document.querySelector("#profile-hosts").textContent`); // Inside a closed <details>, so innerText is empty.
const whoami = async (page) => {
  await page.waitFor(`!!document.querySelector("#me")`);
  return page.evaluate(`document.querySelector("#me").textContent`);
};
const openPage = async (match) => connect((await findView(match)).webSocketDebuggerUrl);

async function temporarySessionFlow(userData) {
  const { panel, quit } = await launch(userData);
  await panel.fill("#api-key", "sk-ant-test");
  await panel.click("#settings-form button[type=submit]");
  await panel.waitFor(`document.querySelector("#api-key").placeholder.includes("저장된")`);

  check("profiles are off without a keyring", await panel.evaluate(`document.querySelector("#profile").disabled && document.querySelector("#profile-form").hidden && document.querySelector("#profile-hint").textContent.includes("쓸 수 없습니다")`));

  await startLogin(panel, "http://login.example.test/");
  await panel.waitFor(panel.exists(".error"));
  check("login refuses a plain http site", (await panel.text(".error")).includes("https"));
  check("refused login does not start", await panel.evaluate(`document.querySelector("#login").hidden`));

  await openAddress(panel, `${SITE}/start`);
  await panel.waitFor(`[...document.querySelectorAll(".blocked")].some((e) => e.textContent.includes("cdn.e2e.test"))`);
  check("before login, another host stays blocked", !hit(`cdn.e2e.test:${SITE_PORT}/cdn.png`));

  await startLogin(panel, `${SITE}/start`);
  await phaseIs(panel, "open");
  await panel.waitFor(`document.querySelector("#url").value === ${JSON.stringify(`${SITE}/start`)}`);
  for (let i = 0; i < 40 && !hit(`cdn.e2e.test:${SITE_PORT}/cdn.png`); i++) await sleep(50);
  check("during login, another host loads", hit(`cdn.e2e.test:${SITE_PORT}/cdn.png`));

  const page = await openPage((url) => url === `${SITE}/start`);
  await page.gesture(`window.__popup = window.open(${JSON.stringify(`${IDP}/popup`)}); 1`);
  await page.waitFor(`window.got === "login-ok"`);
  check("a popup reports back through window.opener", true);
  const popup = await openPage((url) => url === `${IDP}/popup`);
  check("a popup has no access to the app", await popup.evaluate(`typeof require === "undefined" && typeof process === "undefined" && typeof panelApi === "undefined"`));
  popup.close();

  const localBefore = hits.length;
  check("login does not open local addresses", (await pageReach(page, `${LOCAL}/local-probe`)) === "blocked" && hits.length === localBefore);
  page.close();

  await openAddress(panel, `${SITE}/other`);
  await panel.waitFor(`[...document.querySelectorAll(".error")].some((e) => e.textContent.includes("로그인 중"))`);
  check("the address bar cannot widen egress during login", !hit(`127.0.0.1:${SITE_PORT}/other`));

  await clickText(panel, "#login-actions", "완료");
  await phaseIs(panel, "choosing");
  const offered = await panel.evaluate(`[...document.querySelectorAll("#login-hosts input")].map((b) => [b.value, b.checked])`);
  const offeredHost = (name) => offered.find(([host]) => host === name);
  check("hosts login reached are offered", !!offeredHost("cdn.e2e.test") && !!offeredHost("idp.e2e.test"), JSON.stringify(offered));
  check("only the start host is checked by default", offered.filter(([, checked]) => checked).map(([h]) => h).join() === "127.0.0.1", JSON.stringify(offered));
  check("a local host blocked during login is not offered", !offeredHost("localhost"), JSON.stringify(offered));
  const { data } = await panel.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(process.env.E2E_LOGIN_SHOT ?? "dist-e2e/panel-login.png", Buffer.from(data, "base64"));

  await panel.evaluate(`document.querySelector('#login-hosts input[value="cdn.e2e.test"]').click()`);
  await clickText(panel, "#login-actions", "확인");
  await loginEnded(panel);
  await sleep(200);
  check("popups close when login ends", !(await views()).some((v) => v.url.includes("/popup")));

  const after = await openPage((url) => url === `${SITE}/start`);
  check("a chosen host stays reachable", (await pageReach(after, `${CDN}/after-chosen`)) === "reached");
  check("an unchosen host is blocked again", (await pageReach(after, `${IDP}/after-unchosen`)) === "blocked" && !hit(`idp.e2e.test:${SITE_PORT}/after-unchosen`));
  const opened = await after.gesture(`window.open(${JSON.stringify(`${SITE}/same-view`)}) === null`);
  check("outside login, a page cannot open a popup", opened === true);
  await sleep(300);
  check("outside login, window.open stays in the same view", !(await views()).some((v) => v.url === `${SITE}/start`));
  after.close();
  await sleep(200);

  // The agent asks, the user decides, and the same debugger path works again afterwards.
  await openAddress(panel, `${SITE}/start`);
  await sleep(300);
  script = ["read_page", "request_login", "request_login", "read_page"];
  results.length = 0;
  await panel.fill("#task", "로그인이 필요한 작업");
  await panel.click("#run");
  await panel.waitFor(panel.exists(".confirm"));
  const asked = await panel.text(".confirm");
  check("the agent's request shows the page's real host", asked.includes(`127.0.0.1:${SITE_PORT}`), asked);
  await clickText(panel, ".confirm", "거부");
  // The next prompt can replace this one at once, so wait for the record of the answer instead of an empty log.
  await panel.waitFor(`[...document.querySelectorAll(".action")].some((e) => e.textContent.startsWith("거부:"))`);
  await panel.waitFor(panel.exists(".confirm"));
  check("a declined request did not start login", await panel.evaluate(`document.querySelector("#login").hidden`));
  await clickText(panel, ".confirm", "승인");
  await phaseIs(panel, "open");
  const callsDuringLogin = apiCalls;
  check("the run controls stay disabled during login", await panel.evaluate(`document.querySelector("#run").disabled && document.querySelector("#login-start").disabled`));
  await sleep(800);
  check("the model is not called while the user signs in", apiCalls === callsDuringLogin);
  await clickText(panel, "#login-actions", "완료");
  await phaseIs(panel, "choosing");
  await clickText(panel, "#login-actions", "확인");
  await loginEnded(panel);
  await panel.waitFor(panel.exists(".answer"));
  check("the model read a declined result", results[1]?.includes("declined"), results[1]);
  check("the model learned that login finished", results[2]?.includes("finished signing in") && !results[2].includes("cdn.e2e.test"), results[2]);
  check("the agent reads the page again after login", results[3]?.includes("Sign in here") && results[3].includes("<untrusted_page"), results[3]);

  // Stopping during login ends it and leaves the conversation usable.
  script = ["request_login"];
  results.length = 0;
  await panel.fill("#task", "다시 로그인");
  await panel.waitFor(`!document.querySelector("#run").disabled`);
  await panel.click("#run");
  await panel.waitFor(panel.exists(".confirm"));
  await clickText(panel, ".confirm", "승인");
  await phaseIs(panel, "open");
  await panel.click("#stop");
  await loginEnded(panel);
  await panel.waitFor(`[...document.querySelectorAll(".progress")].some((e) => e.textContent.includes("중지"))`);
  check("stop ends login and the task", true);
  await panel.waitFor(`!document.querySelector("#run").disabled`);
  const answers = await panel.evaluate(`document.querySelectorAll(".answer").length`);
  await panel.fill("#task", "이어서");
  await panel.click("#run");
  await panel.waitFor(`document.querySelectorAll(".answer").length === ${answers + 1}`);
  const toolResults = lastRequest.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");
  check("the conversation continues after a stop, with the login's result", toolResults.at(-1)?.content.includes("cancelled"), JSON.stringify(toolResults.at(-1)));

  check("no uncaught errors in the panel", panel.errors.length === 0, panel.errors.join("; "));
  await quit();
}

async function profileFlow(userData) {
  // Short limits, so idle freezing and the deadline happen during the test.
  const limits = { E2E_ASSUME_KEYRING: "1", E2E_LOGIN_IDLE_MS: "1500", E2E_LOGIN_MAX_MS: "9000" };
  let { panel, quit } = await launch(userData, limits);

  await panel.fill("#profile-name", "업무");
  await panel.evaluate(`document.querySelector("#profile-form").requestSubmit()`);
  await panel.waitFor(panel.exists(".profile-confirm"));
  const warning = await panel.text(".profile-confirm");
  check("creating a profile warns about plain text storage", warning.includes("localStorage") && warning.includes("평문"), warning);
  check("nothing is created before the user confirms", await panel.evaluate(`document.querySelector("#profile").options.length === 1`));
  await clickText(panel, ".profile-confirm", "만들기");
  await panel.waitFor(`document.querySelector("#profile-current").textContent === "업무"`);

  await openAddress(panel, `${SITE}/session`);
  await panel.waitFor(`[...document.querySelectorAll("#profile-hosts li")].some((e) => e.textContent.includes("127.0.0.1"))`);
  check("a host the user allowed is listed on the profile", true);
  const sessionPage = await openPage((url) => url === `${SITE}/session`);
  await sessionPage.waitFor(`document.body?.innerText.includes("signed in")`);
  sessionPage.close();
  await sleep(200);

  await startLogin(panel, `${SITE}/start`);
  await phaseIs(panel, "open");
  for (let i = 0; i < 20 && !hit(`cdn.e2e.test:${SITE_PORT}/cdn.png`); i++) await sleep(50);
  await phaseIs(panel, "frozen");
  const page = await openPage((url) => url === `${SITE}/start`);
  check("after idle time, a host already reached still works", (await pageReach(page, `${CDN}/frozen`)) === "reached");
  check("after idle time, a new host is blocked", (await pageReach(page, `${NEW_HOST}/frozen`)) === "blocked" && !hit(`new.e2e.test:${SITE_PORT}/frozen`));
  await clickText(panel, "#login-actions", "다시 열기");
  await phaseIs(panel, "open");
  check("reopening lets a new host through", (await pageReach(page, `${NEW_HOST}/reopened`)) === "reached");
  page.close();
  await panel.waitFor(`document.querySelector("#login").dataset.phase === "choosing"`, 12_000);
  check("the deadline ends login even without a click", true);
  await clickText(panel, "#login-actions", "취소");
  await loginEnded(panel);
  check("cancelling keeps none of login's hosts", !(await hostsText(panel)).includes("cdn.e2e.test"));
  await quit();

  const partitions = readdirSync(join(userData, "Partitions")).filter((name) => name.startsWith("profile-"));
  check("the profile has its own folder", partitions.length === 1, partitions.join());
  const folder = join(userData, "Partitions", partitions[0]);
  const cookies = readFileSync(join(folder, "Cookies"));
  check("the login cookie is not stored in plain text", !cookies.includes(COOKIE_VALUE) && cookies.includes("v10"));

  ({ panel, quit } = await launch(userData, limits));
  check("a restart starts in a temporary session", (await panel.evaluate(`document.querySelector("#profile-current").textContent`)) === "임시 세션");
  await panel.evaluate(`(() => { const s = document.querySelector("#profile"); s.value = [...s.options].find((o) => o.textContent === "업무").value; s.dispatchEvent(new Event("change")); })()`);
  await panel.waitFor(panel.exists(".profile-confirm"));
  await clickText(panel, ".profile-confirm", "바꾸기");
  await panel.waitFor(`document.querySelector("#profile-current").textContent === "업무"`);
  check("allowed hosts come back with the profile", (await hostsText(panel)).includes("127.0.0.1"));

  await openAddress(panel, `${SITE}/whoami`);
  const profilePage = await openPage((url) => url === `${SITE}/whoami`);
  check("the login survives a restart", (await whoami(profilePage)) === COOKIE_VALUE);
  profilePage.close();

  await panel.evaluate(`(() => { const s = document.querySelector("#profile"); s.value = ""; s.dispatchEvent(new Event("change")); })()`);
  await panel.waitFor(panel.exists(".profile-confirm"));
  await clickText(panel, ".profile-confirm", "바꾸기");
  await panel.waitFor(`document.querySelector("#profile-current").textContent === "임시 세션"`);
  await openAddress(panel, `${SITE}/whoami`);
  await sleep(300);
  const temporary = await openPage((url) => url === `${SITE}/whoami`);
  check("a temporary session cannot see the profile's login", (await whoami(temporary)) === "anonymous");
  temporary.close();

  await panel.evaluate(`(() => { const s = document.querySelector("#profile"); s.value = [...s.options].find((o) => o.textContent === "업무").value; s.dispatchEvent(new Event("change")); })()`);
  await panel.waitFor(panel.exists(".profile-confirm"));
  await clickText(panel, ".profile-confirm", "바꾸기");
  await panel.waitFor(`document.querySelector("#profile-current").textContent === "업무"`);
  await panel.evaluate(`[...document.querySelectorAll("#profile-hosts li")].find((e) => e.textContent.includes("127.0.0.1")).querySelector("button").click()`);
  await panel.waitFor(`!document.querySelector("#profile-hosts").textContent.includes("127.0.0.1")`);
  check("the user can remove an allowed host", true);

  await panel.click("#profile-delete");
  await panel.waitFor(panel.exists(".profile-confirm"));
  await clickText(panel, ".profile-confirm", "삭제");
  await panel.waitFor(`document.querySelector("#profile-current").textContent === "임시 세션" && document.querySelector("#profile").options.length === 1`);
  check("no uncaught errors in the panel", panel.errors.length === 0, panel.errors.join("; "));
  await quit();
  const stillReadable = existsSync(join(folder, "Cookies")) && readFileSync(join(folder, "Cookies")).includes("v10");
  check("deleting a profile clears its cookies at once", !stillReadable);

  ({ panel, quit } = await launch(userData, limits));
  check("a deleted profile's folder is gone after a restart", !existsSync(folder));
  await quit();
}

const dirs = [mkdtempSync(join(tmpdir(), "neo-browser-login-a-")), mkdtempSync(join(tmpdir(), "neo-browser-login-b-"))];
const watchdog = setTimeout(() => {
  console.error("FAIL  test timed out");
  runningApp?.kill("SIGKILL");
  process.exit(1);
}, 150_000);
try {
  await temporarySessionFlow(dirs[0]);
  await profileFlow(dirs[1]);
} catch (error) {
  failures++;
  console.error("FAIL ", error);
  runningApp?.kill("SIGKILL");
} finally {
  clearTimeout(watchdog);
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  site.close();
  api.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
