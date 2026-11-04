// Tests the real task session (src/main/task-session.ts) against every isolation and egress path the spike
// found. Each egress path also runs in an unguarded control session. A path that never reaches the canary in
// the control proves nothing about the guard, so it is reported as NOT_TRIGGERED, not as a pass.
// Raw CDP is used here on purpose: it shows what still holds if a command ever got past GatedCdp.
import { app, BrowserWindow, netLog, session, type Session } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Socket } from "node:net";
import { applyEgressSwitches } from "../src/main/process-switches";
import { createTaskSession, protectPage, type TaskSession } from "../src/main/task-session";

const A = "a.spike.test";
const B = "b.spike.test";
const CANARY = "canary.spike.test";
const SITE_PORT = 18501;
const toLoopback = (host: string) => (host.endsWith(".spike.test") ? "127.0.0.1" : host);

// The DNS switch applies to the whole process, so its control needs another process. The runner starts this
// file twice: hardened like the app, and once with --control to show the checks can detect a lookup.
const CONTROL_PROCESS = process.argv.includes("--control");
const MAP_FIXTURES = "MAP *.spike.test 127.0.0.1 , ";
if (CONTROL_PROCESS) app.commandLine.appendSwitch("host-resolver-rules", MAP_FIXTURES.slice(0, -3));
else applyEgressSwitches(MAP_FIXTURES);
// Service workers, WebTransport and speculation rules need a secure context; the fixtures are plain HTTP.
app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", `http://${A}:${SITE_PORT}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Status = "PASS" | "FAIL" | "NOT_TRIGGERED";
const counts: Record<Status, number> = { PASS: 0, FAIL: 0, NOT_TRIGGERED: 0 };
function record(status: Status, name: string, detail = "") {
  counts[status]++;
  console.log(`${status.padEnd(14)}${name}${detail ? ` :: ${detail}` : ""}`);
}
const expectTrue = (name: string, ok: boolean, detail = "") => record(ok ? "PASS" : "FAIL", name, detail);
const listen = (server: Server, port = 0) =>
  new Promise<number>((resolve) => server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

const SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => { e.waitUntil(fetch(e.data, { mode: "no-cors" }).catch(() => {})); });`;

const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const html = (body: string, headers = {}) => res.writeHead(200, { "content-type": "text/html", ...headers }).end(body);
  const text = (body: string, type = "text/plain") => res.writeHead(200, { "content-type": type }).end(body);
  const to = url.searchParams.get("to") ?? "";
  switch (url.pathname) {
    case "/login":
      res.setHeader("set-cookie", `sid=${url.searchParams.get("user")}; Path=/; HttpOnly; SameSite=Lax`);
      return text("ok");
    case "/whoami":
      return text(/(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "anonymous");
    case "/sw.js":
      return text(SW, "text/javascript");
    case "/worker.js":
      return text(`onmessage = (e) => fetch(e.data, { mode: "no-cors" }).catch(() => {});`, "text/javascript");
    case "/wt-worker.js":
      return text(`onmessage = (e) => { const w = new WebTransport(e.data); w.ready.catch(() => {}); w.closed.catch(() => {}); };`, "text/javascript");
    case "/static-preconnect":
      return html(`<!doctype html><head><link rel="preconnect" href="${to}"><link rel="preconnect" href="${to}" crossorigin></head><body>page</body>`, { link: `<${to}>; rel=preconnect` });
    case "/static-speculation":
      return html(`<!doctype html><script type="speculationrules">${JSON.stringify({ prefetch: [{ urls: [to], eagerness: "immediate" }] })}</script><body>page</body>`);
    case "/static-dns":
      return html(`<!doctype html><head><link rel="dns-prefetch" href="//${Buffer.from(to, "base64url").toString()}"></head><body>page</body>`);
    default:
      return html(`<!doctype html><title>${url.pathname}</title><body>page</body>`);
  }
});

// Records every path that reached the canary, plus raw TCP connections and UDP packets.
const canaryHits = new Set<string>();
let tcpConnections = 0;
const canary = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  canaryHits.add(path);
  res.setHeader("connection", "close");
  if (path.includes("eventsource")) return res.writeHead(200, { "content-type": "text/event-stream" }).end("data: x\n\n");
  res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html>canary");
});
const acceptWebSocket = (req: IncomingMessage, socket: Duplex) => {
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
};
site.on("upgrade", acceptWebSocket);
canary.on("connection", () => tcpConnections++);
canary.on("upgrade", (req, socket: Socket) => {
  canaryHits.add(new URL(req.url ?? "/", "http://x").pathname);
  acceptWebSocket(req, socket);
  socket.end();
});
const newTask = async (...hosts: string[]): Promise<TaskSession> => {
  const task = await createTaskSession({ onBlocked: () => {}, connectHost: toLoopback });
  hosts.forEach((h) => task.allowlist.allow(h));
  return task;
};

function open(s: Session, guarded: boolean): BrowserWindow {
  const w = new BrowserWindow({ show: false, webPreferences: { session: s, sandbox: true, contextIsolation: true } });
  if (guarded) protectPage(w.webContents);
  return w;
}
async function withPage<T>(s: Session, url: string, run: (w: BrowserWindow) => Promise<T>): Promise<T> {
  const w = open(s, true);
  try {
    await w.loadURL(url);
    return await run(w);
  } finally {
    w.destroy();
  }
}
const whoami = (s: Session, origin: string) =>
  withPage(s, `${origin}/whoami`, (w) => w.webContents.executeJavaScript("document.body.innerText")) as Promise<string>;

async function isolationTests(originA: string, originB: string): Promise<void> {
  const [taskA, taskB] = await Promise.all([newTask(A, B), newTask(A, B)]);

  expectTrue("new task session starts with no login", (await whoami(taskA.session, originA)) === "anonymous");
  await withPage(taskA.session, `${originA}/login?user=task-a`, async () => {});
  expectTrue("a login stays in its own task", (await whoami(taskA.session, originA)) === "task-a");
  expectTrue("a login does not cross to another site", (await whoami(taskA.session, originB)) === "anonymous");
  expectTrue("a login does not reach another task", (await whoami(taskB.session, originA)) === "anonymous");

  const write = `localStorage.setItem("mark","a"); new Promise((res,rej)=>{const r=indexedDB.open("spike",1);r.onupgradeneeded=()=>r.result.createObjectStore("s");r.onsuccess=()=>{r.result.close();res(true)};r.onerror=()=>rej(r.error)})`;
  const read = `Promise.all([Promise.resolve(localStorage.getItem("mark")), indexedDB.databases().then(d=>d.map(x=>x.name))])`;
  await withPage(taskA.session, `${originA}/`, (w) => w.webContents.executeJavaScript(write));
  const [mark, dbs] = await withPage(taskB.session, `${originA}/`, (w) => w.webContents.executeJavaScript(read));
  expectTrue("storage does not reach another task", mark === null && dbs.length === 0, JSON.stringify({ mark, dbs }));

  await withPage(taskB.session, `${originA}/`, async (w) => {
    w.webContents.debugger.attach("1.3");
    const { cookies } = await w.webContents.debugger.sendCommand("Storage.getCookies");
    expectTrue("raw CDP cookie read sees no other task's login", !JSON.stringify(cookies).includes("task-a"));
    await w.webContents.debugger.sendCommand("Network.clearBrowserCookies");
    await w.webContents.debugger.sendCommand("Storage.setCookies", { cookies: [{ name: "planted", value: "x", domain: A, path: "/" }] });
  });
  expectTrue("raw CDP cookie clear leaves another task alone", (await whoami(taskA.session, originA)) === "task-a");
  expectTrue("raw CDP cookie write does not reach another task", (await taskA.session.cookies.get({ name: "planted" })).length === 0);

  await withPage(taskB.session, `${originB}/`, async (w) => {
    await w.webContents.executeJavaScript(`window.open(${JSON.stringify(`${originA}/whoami`)}); 1`, true);
    await sleep(500);
    expectTrue("window.open makes no new window", BrowserWindow.getAllWindows().length === 1);
    expectTrue("window.open stays in the task's session", (await w.webContents.executeJavaScript("document.body.innerText")) === "anonymous");
  });

  await taskA.dispose();
  expectTrue("ending a task wipes its login", (await taskA.session.cookies.get({})).length === 0);
  await taskB.dispose();
}

interface Vector {
  name: string;
  page?: (target: string) => string;
  js?: (target: string) => string;
  cdp?: (target: string) => [string, object];
  /** What counts as reaching the canary. Defaults to an HTTP request for this path. */
  evidence?: "tcp" | "udp";
}

const el = (tag: string, props: string) => `(()=>{const e=document.createElement(${JSON.stringify(tag)});${props};document.body.append(e);})()`;
const q = JSON.stringify;
const wt = (url: string) => `self.__w=new WebTransport(${q(url)});self.__w.ready.catch(()=>{});self.__w.closed.catch(()=>{})`;
const vectors = (udpPort: number): Vector[] => [
  { name: "preconnect", evidence: "tcp", page: (t) => `/static-preconnect?to=${encodeURIComponent(new URL(t).origin)}` },
  { name: "fetch", js: (t) => `fetch(${q(t)},{mode:"no-cors"}).catch(()=>{})` },
  { name: "fetch-keepalive", js: (t) => `fetch(${q(t)},{mode:"no-cors",method:"POST",body:"x",keepalive:true}).catch(()=>{})` },
  { name: "xhr", js: (t) => `(()=>{const x=new XMLHttpRequest();x.open("GET",${q(t)});x.send();})()` },
  { name: "beacon", js: (t) => `navigator.sendBeacon(${q(t)},"x")` },
  { name: "img", js: (t) => el("img", `e.src=${q(t)}`) },
  { name: "script", js: (t) => el("script", `e.src=${q(t)}`) },
  { name: "stylesheet", js: (t) => el("link", `e.rel="stylesheet";e.href=${q(t)}`) },
  { name: "css-background", js: (t) => el("div", `e.style.background="url(${t})";e.textContent="x"`) },
  { name: "font", js: (t) => `new FontFace("f","url(${t})").load().catch(()=>{})` },
  { name: "video", js: (t) => el("video", `e.preload="auto";e.src=${q(t)}`) },
  { name: "iframe", js: (t) => el("iframe", `e.src=${q(t)}`) },
  { name: "form-post", js: (t) => `(()=>{const f=document.createElement("iframe");f.name="ff";document.body.append(f);const e=document.createElement("form");e.method="POST";e.action=${q(t)};e.target="ff";document.body.append(e);e.submit();})()` },
  { name: "link-prefetch", js: (t) => el("link", `e.rel="prefetch";e.href=${q(t)}`) },
  { name: "link-preload", js: (t) => el("link", `e.rel="preload";e.as="image";e.href=${q(t)}`) },
  { name: "speculation-prefetch", page: (t) => `/static-speculation?to=${encodeURIComponent(t)}` },
  { name: "a-ping", js: (t) => `(()=>{const a=document.createElement("a");a.href="#x";a.ping=${q(t)};document.body.append(a);a.click();})()` },
  { name: "eventsource", js: (t) => `new EventSource(${q(t)})` },
  { name: "websocket", js: (t) => `new WebSocket(${q(t.replace("http:", "ws:"))})` },
  { name: "dedicated-worker", js: (t) => `new Worker("/worker.js").postMessage(${q(t)})` },
  { name: "service-worker", js: (t) => `navigator.serviceWorker.register("/sw.js").then(async()=>{const r=await navigator.serviceWorker.ready;r.active.postMessage(${q(t)});})` },
  { name: "window-open", js: (t) => `window.open(${q(t)});1` },
  { name: "meta-refresh", js: (t) => el("meta", `e.httpEquiv="refresh";e.content="0;url=${t}"`) },
  { name: "location-assign", js: (t) => `setTimeout(()=>{location.href=${q(t)}},0);1` },
  { name: "raw-cdp-Page.navigate", cdp: (t) => ["Page.navigate", { url: t }] },
  { name: "raw-cdp-loadNetworkResource", cdp: (t) => ["Network.loadNetworkResource", { url: t, options: { disableCache: true, includeCredentials: false } }] },
  {
    name: "webrtc-stun",
    evidence: "udp",
    js: () => `(()=>{const p=new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${udpPort}"}]});p.createDataChannel("x");p.createOffer().then(o=>p.setLocalDescription(o));window.__p=p;})();1`,
  },
  {
    name: "webtransport-host",
    evidence: "udp",
    js: () => `${wt(`https://${CANARY}:${udpPort}/x`)};1`,
  },
  {
    name: "webtransport-ip-literal",
    evidence: "udp",
    js: () => `${wt(`https://127.0.0.1:${udpPort}/x`)};1`,
  },
  {
    name: "webtransport-dedicated-worker",
    evidence: "udp",
    js: () => `new Worker("/wt-worker.js").postMessage(${q(`https://127.0.0.1:${udpPort}/x`)});1`,
  },
  {
    name: "webtransport-blob-worker",
    evidence: "udp",
    js: () => `new Worker(URL.createObjectURL(new Blob([${q(`${wt(`https://127.0.0.1:${udpPort}/x`)}`)}],{type:"text/javascript"})));1`,
  },
  {
    name: "webtransport-blob-iframe",
    evidence: "udp",
    js: () => `(()=>{const e=document.createElement("iframe");e.src=URL.createObjectURL(new Blob([${q(`<script>${wt(`https://127.0.0.1:${udpPort}/x`)}<\/script>`)}],{type:"text/html"}));document.body.append(e);})();1`,
  },
  {
    name: "webtransport-srcdoc-iframe",
    evidence: "udp",
    js: () => `(()=>{const e=document.createElement("iframe");e.srcdoc=${q(`<script>${wt(`https://127.0.0.1:${udpPort}/x`)}<\/script>`)};document.body.append(e);})();1`,
  },
];

async function runVector(s: Session, guarded: boolean, origin: string, canaryOrigin: string, name: string): Promise<boolean> {
  const tag = `/v/${name}`;
  canaryHits.clear();
  tcpConnections = 0;
  // A fresh port each run: QUIC keeps retransmitting after its page is gone, which would count against the next run.
  let udpPackets = 0;
  const udp = createSocket("udp4");
  udp.on("message", () => udpPackets++);
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const v = vectors(udp.address().port).find((x) => x.name === name)!;
  const target = `${canaryOrigin}${tag}`;
  const w = open(s, guarded);
  w.webContents.on("did-create-window", (child) => setTimeout(() => !child.isDestroyed() && child.destroy(), 1500));
  const reached = () => (v.evidence === "tcp" ? tcpConnections > 0 : v.evidence === "udp" ? udpPackets > 0 : canaryHits.has(tag));
  try {
    await w.loadURL(`${origin}${v.page?.(target) ?? "/"}`);
    if (v.js) await w.webContents.executeJavaScript(v.js(target), true).catch(() => {});
    if (v.cdp) {
      const [method, params] = v.cdp(target);
      const dbg = w.webContents.debugger;
      dbg.attach("1.3");
      const extra = method === "Network.loadNetworkResource" ? { frameId: (await dbg.sendCommand("Page.getFrameTree")).frameTree.frame.id } : {};
      await dbg.sendCommand(method, { ...params, ...extra }).catch(() => {});
    }
    for (let i = 0; i < 30 && !reached(); i++) await sleep(100);
    return reached();
  } finally {
    if (!w.isDestroyed()) w.destroy();
    udp.close();
  }
}

async function egressTests(origin: string, canaryOrigin: string): Promise<void> {
  let n = 0;
  for (const v of vectors(0)) {
    const control = session.fromPartition(`control-${++n}`);
    const task = await newTask(A);
    const controlReached = await runVector(control, false, origin, canaryOrigin, v.name);
    const guardedReached = await runVector(task.session, true, origin, canaryOrigin, v.name);
    await task.dispose();
    const detail = `control=${controlReached} guarded=${guardedReached}`;
    if (guardedReached) record("FAIL", `egress: ${v.name}`, detail);
    else if (!controlReached) record("NOT_TRIGGERED", `egress: ${v.name}`, detail);
    else record("PASS", `egress: ${v.name}`, detail);
  }
}

/** An allowed page must still work through the proxy, or the guard would pass by breaking everything. */
async function positiveTests(originA: string, originB: string): Promise<void> {
  const task = await newTask(A);
  await withPage(task.session, `${originA}/`, async (w) => {
    const body = await w.webContents.executeJavaScript(`fetch("/whoami").then((r) => r.text())`, true);
    expectTrue("allowed host still works through the proxy", body === "anonymous", String(body));
    const socket = await w.webContents.executeJavaScript(`new Promise((r)=>{const x=new WebSocket(${q(`${originA.replace("http:", "ws:")}/ws`)});x.onopen=()=>r("open");x.onerror=()=>r("failed")})`, true);
    expectTrue("allowed host's WebSocket tunnels through the proxy", socket === "open", String(socket));
    const other = await w.webContents.executeJavaScript(`fetch(${q(`${originB}/whoami`)},{mode:"no-cors"}).then(()=>"reached",()=>"blocked")`, true);
    expectTrue("page cannot reach an unlisted host", other === "blocked", String(other));
  });
  await task.dispose();

  // Fixtures are plain HTTP, so this is the one check of real TLS through the tunnel. It needs internet access.
  const real = await newTask("example.com");
  await withPage(real.session, "https://example.com/", async (w) => {
    const title = await w.webContents.executeJavaScript("document.title");
    expectTrue("a real https site loads through the proxy", /example/i.test(title), String(title));
  });
  await real.dispose();
}

const NETLOG_ID = randomBytes(4).toString("hex");
const dnsName = (kind: string) => `${kind}-${NETLOG_ID}.example.com`;
const fetchJs = (host: string) => `fetch("http://${host}/x",{mode:"no-cors"}).catch(()=>{});1`;
const prefetchPage = (origin: string, host: string) => `${origin}/static-dns?to=${Buffer.from(host).toString("base64url")}`;

/** DNS can carry data before any request exists, so read Chromium's own network log. */
async function resolverLog(run: () => Promise<void>): Promise<(host: string) => boolean> {
  const dir = mkdtempSync(join(tmpdir(), "neo-browser-netlog-"));
  const log = join(dir, "netlog.json");
  await netLog.startLogging(log, { captureMode: "default" });
  await run();
  await netLog.stopLogging();
  const parsed = JSON.parse(readFileSync(log, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  const types = new Map<number, string>(Object.entries(parsed.constants.logEventTypes as Record<string, number>).map(([k, v]) => [v, k]));
  return (host) => parsed.events.some((e: any) => (types.get(e.type) ?? "").includes("HOST_RESOLVER") && JSON.stringify(e.params ?? {}).includes(host));
}

/** The hardened half: no lookups, even from a session with no guard at all. */
async function dnsTests(origin: string): Promise<void> {
  const task = await newTask(A);
  const bare = session.fromPartition("dns-no-guard");
  const lookedUp = await resolverLog(async () => {
    await withPage(task.session, prefetchPage(origin, dnsName("prefetch-guarded")), () => sleep(1200));
    await withPage(task.session, `${origin}/`, async (w) => {
      await w.webContents.executeJavaScript(fetchJs(dnsName("fetch-guarded")), true);
      await sleep(800);
    });
    const w = open(bare, false);
    await w.loadURL(`${origin}/`);
    await w.webContents.executeJavaScript(fetchJs(dnsName("no-guard")), true);
    await sleep(800);
    w.destroy();
  });
  await task.dispose();
  expectTrue("dns: dns-prefetch makes no lookup", !lookedUp(dnsName("prefetch-guarded")));
  expectTrue("dns: a blocked fetch makes no lookup", !lookedUp(dnsName("fetch-guarded")));
  expectTrue("dns: even an unguarded session makes no lookup", !lookedUp(dnsName("no-guard")));
}

/**
 * The control half: without the switches these leaks do happen, so the checks above can see them.
 * The names are not mapped, so this makes real DNS lookups for random, meaningless example.com names.
 */
async function controlTests(origin: string): Promise<void> {
  const control = session.fromPartition("dns-control");
  const lookedUp = await resolverLog(async () => {
    const w = open(control, false);
    await w.loadURL(`${origin}/`);
    await w.webContents.executeJavaScript(fetchJs(dnsName("fetch-control")), true);
    await sleep(800);
    await w.loadURL(prefetchPage(origin, dnsName("prefetch-control")));
    await sleep(1200);
    w.destroy();
  });
  expectTrue("control: the log sees a fetch's lookup", lookedUp(dnsName("fetch-control")));
  expectTrue("control: the log sees a dns-prefetch lookup", lookedUp(dnsName("prefetch-control")));
}

async function main(): Promise<void> {
  const sitePort = await listen(site, SITE_PORT);
  const canaryPort = await listen(canary);
  const originA = `http://${A}:${sitePort}`;
  const originB = `http://${B}:${sitePort}`;
  const canaryOrigin = `http://${CANARY}:${canaryPort}`;
  console.log(`electron=${process.versions.electron} chrome=${process.versions.chrome} sandboxDisabled=${app.commandLine.hasSwitch("no-sandbox")}`);

  if (CONTROL_PROCESS) {
    await controlTests(originA);
  } else {
    await isolationTests(originA, originB);
    await positiveTests(originA, originB);
    await egressTests(originA, canaryOrigin);
    await dnsTests(originA);
  }

  console.log(`\nSUMMARY pass=${counts.PASS} fail=${counts.FAIL} not_triggered=${counts.NOT_TRIGGERED}`);
}

app.on("window-all-closed", () => {});
app.whenReady().then(main).then(
  () => app.exit(counts.FAIL ? 1 : 0),
  (error) => {
    console.error("HARNESS ERROR", error);
    app.exit(2);
  },
);
setTimeout(() => {
  console.error("HARNESS TIMEOUT");
  app.exit(3);
}, 280_000);
