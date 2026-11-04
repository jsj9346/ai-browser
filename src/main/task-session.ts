// The isolated, egress-controlled session behind a task. The spike showed each layer alone has gaps:
// webRequest misses WebRTC, WebTransport and raw CDP requests, so all layers are on, and a failure stops the task.
import { session, type Session, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { blockedRequest, EgressAllowlist, type Blocked } from "../egress";
import { parseWebUrl } from "../policy";
import { EgressProxy } from "./egress-proxy";

const PROXY_APPLY_TIMEOUT_MS = 5_000;

export interface BlockedRequest extends Blocked {
  url: string;
  isPageNavigation: boolean;
}

export interface TaskSession {
  session: Session;
  allowlist: EgressAllowlist;
  dispose(): Promise<void>;
}

export interface TaskSessionOptions {
  onBlocked: (blocked: BlockedRequest) => void;
  /** Security tests map fixture hosts to loopback. The app does not set this. */
  connectHost?: (host: string) => string;
}

/** setProxy can resolve shortly before the proxy applies, so a page must not load until it has. */
async function waitForProxy(pageSession: Session, expected: string): Promise<void> {
  const deadline = Date.now() + PROXY_APPLY_TIMEOUT_MS;
  for (const probe of ["https://egress-check.invalid/", "http://127.0.0.1/"]) {
    let resolved = await pageSession.resolveProxy(probe);
    while (resolved !== expected) {
      if (Date.now() > deadline) throw new Error(`Proxy not applied to ${probe}: ${resolved}`);
      await new Promise((r) => setTimeout(r, 25));
      resolved = await pageSession.resolveProxy(probe);
    }
  }
}

export async function createTaskSession(options: TaskSessionOptions): Promise<TaskSession> {
  const allowlist = new EgressAllowlist();
  const proxy = new EgressProxy(allowlist, options.connectHost);
  const pageSession = session.fromPartition(`task-${randomUUID()}`);

  // Cancel everything first, so nothing can slip out while the proxy starts.
  pageSession.webRequest.onBeforeRequest((details, callback) => {
    const blocked = blockedRequest(details.url, allowlist);
    if (blocked) {
      options.onBlocked({ ...blocked, url: details.url, isPageNavigation: details.resourceType === "mainFrame" });
    }
    callback({ cancel: blocked !== null });
  });
  pageSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  pageSession.setPermissionCheckHandler(() => false);
  pageSession.on("will-download", (event) => event.preventDefault());

  try {
    const port = await proxy.listen();
    // Chromium skips the proxy for loopback unless told otherwise, and a dev machine's local servers matter.
    await pageSession.setProxy({ proxyRules: `http://127.0.0.1:${port}`, proxyBypassRules: "<-loopback>" });
    await waitForProxy(pageSession, `PROXY 127.0.0.1:${port}`);
  } catch (error) {
    proxy.close();
    throw error;
  }

  return {
    session: pageSession,
    allowlist,
    async dispose() {
      proxy.close();
      await pageSession.clearStorageData();
    },
  };
}

/** Applies the per-page rules. Call this before the page loads anything. */
export function protectPage(contents: WebContents): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  // A task has one page for now, so a page that opens a window continues in the same view.
  contents.setWindowOpenHandler(({ url }) => {
    if (parseWebUrl(url)) contents.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
}
