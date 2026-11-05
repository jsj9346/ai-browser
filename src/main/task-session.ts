// The isolated, egress-controlled session behind a task. The spike showed each layer alone has gaps:
// webRequest misses WebRTC, WebTransport and raw CDP requests, so all layers are on, and a failure stops the task.
import { session, type BrowserWindow, type Session, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { blockedRequest, EgressAllowlist, type Blocked } from "../egress";
import { parseWebUrl } from "../policy";
import { EgressProxy, type ProxyOptions } from "./egress-proxy";

const PROXY_APPLY_TIMEOUT_MS = 5_000;

export interface BlockedRequest extends Blocked {
  url: string;
  isPageNavigation: boolean;
}

export interface TaskSession {
  session: Session;
  allowlist: EgressAllowlist;
  closeDisallowedConnections(): void;
  dispose(): Promise<void>;
}

export interface TaskSessionOptions extends ProxyOptions {
  onBlocked: (blocked: BlockedRequest) => void;
  /** A saved profile's partition. Without one, the session is in memory and disposing it wipes it. */
  partition?: string;
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
  const proxy = new EgressProxy(allowlist, { connectHost: options.connectHost, lookup: options.lookup });
  const pageSession = session.fromPartition(options.partition ?? `task-${randomUUID()}`);

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
    closeDisallowedConnections: () => proxy.closeDisallowed(),
    async dispose() {
      proxy.close();
      if (!options.partition) await pageSession.clearStorageData();
    },
  };
}

/**
 * Login opens the internet to this session, so nothing from earlier pages may still be running by then.
 * Leaving a page does not stop its service worker, which measurably kept sending for about 28 seconds.
 */
export async function prepareForLogin(contents: WebContents): Promise<void> {
  await contents.loadURL("about:blank");
  await contents.session.clearStorageData({ storages: ["serviceworkers"] });
}

export interface PopupPolicy {
  allowed(): boolean;
  onCreated(window: BrowserWindow): void;
}

/** Applies the per-page rules. Call this before the page loads anything. */
export function protectPage(contents: WebContents, popups?: PopupPolicy): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setWindowOpenHandler(({ url }) => {
    // Sign-in popups report back through window.opener, so loading them in this view would break them.
    if (popups?.allowed() && (parseWebUrl(url) || url === "about:blank" || url === "")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: { session: contents.session, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
        },
      };
    }
    // Otherwise a task has one page, so a page that opens a window continues in the same view.
    if (parseWebUrl(url)) contents.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  if (popups) {
    contents.on("did-create-window", (child) => {
      protectPage(child.webContents, popups);
      popups.onCreated(child);
    });
  }
}
