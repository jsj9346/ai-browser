// Which hosts a task may reach. Pure, so the request guard and the proxy share one decision.

/** Schemes that do not send anything over the network. Anything else needs an allowed host. */
const LOCAL_SCHEMES = new Set(["about:", "blob:", "data:"]);
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

export class EgressAllowlist {
  private readonly hosts = new Set<string>();

  allow(host: string): void {
    this.hosts.add(host.toLowerCase());
  }

  has(host: string): boolean {
    return this.hosts.has(host.toLowerCase());
  }
}

export interface Blocked {
  /** The host to offer for approval, or null when no approval can help (e.g. file:). */
  host: string | null;
}

/** Returns why this URL may not be requested, or null if it may. Unparseable URLs are blocked. */
export function blockedRequest(raw: string, allowlist: EgressAllowlist): Blocked | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { host: null };
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return null;
  if (!NETWORK_SCHEMES.has(url.protocol)) return { host: null };
  return allowlist.has(url.hostname) ? null : { host: url.hostname };
}

/** What the tools need from egress control. The model has no tool that reaches `allow` directly. */
export interface EgressControl {
  /** The user approved this site. */
  allow(url: URL): void;
  /** The last page navigation the guard stopped, if any. Reading it clears it. */
  takeBlockedNavigation(): string | null;
}
