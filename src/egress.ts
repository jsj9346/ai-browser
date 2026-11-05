// Which hosts a task may reach. Pure, so the request guard and the proxy share one decision.
import { BlockList, isIP } from "node:net";

/** Schemes that do not send anything over the network. Anything else needs an allowed host. */
const LOCAL_SCHEMES = new Set(["about:", "blob:", "data:"]);
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

export const LOGIN_IDLE_MS = 5 * 60_000;
export const LOGIN_MAX_MS = 30 * 60_000;

/** A login page must not reach dev servers or the local network just because login opened the internet. */
const NON_PUBLIC = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(address, prefix, "ipv6");
}

const stripBrackets = (host: string) => host.replace(/^\[|\]$/g, "");

/** Whether an IP address belongs to this machine or a private network. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return true;
  return NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Judges a host name without resolving it. The proxy checks the addresses a name resolves to. */
function isNonPublicHost(host: string): boolean {
  const bare = stripBrackets(host);
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  return isIP(bare) !== 0 && isNonPublicAddress(bare);
}

export type LoginPhase = "open" | "frozen" | "choosing";
export type LoginEnd = "completed" | "cancelled" | "timed_out";

export interface LoginState {
  phase: LoginPhase;
  startHost: string;
  seenHosts: string[];
  /** When the login ends by itself, in epoch milliseconds. */
  deadline: number;
}

export interface LoginLimits {
  idleMs: number;
  maxMs: number;
}

interface ActiveLogin {
  phase: LoginPhase;
  startHost: string;
  seen: Set<string>;
  deadline: number;
  lastActivity: number;
  idleMs: number;
  timedOut: boolean;
}

export class EgressAllowlist {
  private readonly hosts = new Set<string>();
  private login: ActiveLogin | null = null;

  /** Called when the hosts the user allowed change, so a saved profile can keep them. */
  onChange: ((hosts: string[]) => void) | null = null;

  allow(host: string): void {
    const normalized = host.toLowerCase();
    if (this.hosts.has(normalized)) return;
    this.hosts.add(normalized);
    this.onChange?.(this.list());
  }

  remove(host: string): void {
    if (this.hosts.delete(host.toLowerCase())) this.onChange?.(this.list());
  }

  list(): string[] {
    return [...this.hosts];
  }

  /** The one decision for every request. While login is open, it also records the hosts it lets through. */
  admits(host: string): boolean {
    const normalized = host.toLowerCase();
    if (this.hosts.has(normalized)) return true;
    const login = this.login;
    if (!login) return false;
    if (login.seen.has(normalized)) return true;
    if (login.phase !== "open" || isNonPublicHost(normalized)) return false;
    login.seen.add(normalized);
    return true;
  }

  /** Whether this host may connect to a non-public address: the user named it, or started login on it. */
  trustsLocalAddresses(host: string): boolean {
    const normalized = host.toLowerCase();
    return this.hosts.has(normalized) || this.login?.startHost === normalized;
  }

  get loginState(): LoginState | null {
    const login = this.login;
    if (!login) return null;
    return { phase: login.phase, startHost: login.startHost, seenHosts: [...login.seen], deadline: login.deadline };
  }

  /** The start host is in the seen list from the start, because the user just chose it. */
  beginLogin(startHost: string, now: number, limits: LoginLimits = { idleMs: LOGIN_IDLE_MS, maxMs: LOGIN_MAX_MS }): void {
    const host = startHost.toLowerCase();
    this.login = {
      phase: "open",
      startHost: host,
      seen: new Set([host]),
      deadline: now + limits.maxMs,
      lastActivity: now,
      idleMs: limits.idleMs,
      timedOut: false,
    };
  }

  noteLoginActivity(now: number): void {
    if (this.login) this.login.lastActivity = now;
  }

  /** Applies the idle rule and the deadline. Returns whether the phase changed. */
  tickLogin(now: number, locked: boolean): boolean {
    const login = this.login;
    if (!login || login.phase === "choosing") return false;
    if (now >= login.deadline) {
      login.phase = "choosing";
      login.timedOut = true;
      return true;
    }
    if (login.phase === "open" && (locked || now - login.lastActivity >= login.idleMs)) {
      login.phase = "frozen";
      return true;
    }
    return false;
  }

  /** Reopening never extends the deadline. */
  reopenLogin(now: number): void {
    const login = this.login;
    if (login?.phase !== "frozen") return;
    login.phase = "open";
    login.lastActivity = now;
  }

  finishLogin(): void {
    if (this.login) this.login.phase = "choosing";
  }

  /** Ends login, keeping the chosen hosts. Only hosts login actually reached can be kept. */
  chooseLoginHosts(keep: string[]): LoginEnd | null {
    const login = this.login;
    if (login?.phase !== "choosing") return null;
    this.login = null;
    for (const host of keep) {
      if (login.seen.has(host.toLowerCase())) this.allow(host);
    }
    return login.timedOut ? "timed_out" : "completed";
  }

  cancelLogin(): void {
    this.login = null;
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
  return allowlist.admits(url.hostname) ? null : { host: url.hostname };
}

/** What the tools need from egress control. The model has no tool that reaches `allow` directly. */
export interface EgressControl {
  /** The user approved this site. */
  allow(url: URL): void;
  /** The last page navigation the guard stopped, if any. Reading it clears it. */
  takeBlockedNavigation(): string | null;
}
