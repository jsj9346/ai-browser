import { describe, expect, it, vi } from "vitest";
import type { Browser } from "../src/browser";
import { blockedRequest, EgressAllowlist, isNonPublicAddress, LOGIN_IDLE_MS, LOGIN_MAX_MS } from "../src/egress";
import { isLoginUrlAllowed } from "../src/policy";
import { ToolExecutor } from "../src/tools";

function allowlist(...hosts: string[]) {
  const list = new EgressAllowlist();
  hosts.forEach((h) => list.allow(h));
  return list;
}

describe("blockedRequest", () => {
  it("allows only listed hosts, on any network scheme", () => {
    const list = allowlist("a.example");
    for (const url of ["https://a.example/x", "http://a.example:8080/", "wss://a.example/", "ws://A.EXAMPLE/"]) {
      expect(blockedRequest(url, list)).toBeNull();
    }
    expect(blockedRequest("https://b.example/", list)).toEqual({ host: "b.example" });
  });

  it("does not treat subdomains or lookalikes as the allowed host", () => {
    const list = allowlist("a.example");
    for (const host of ["sub.a.example", "a.example.evil.test", "aa.example"]) {
      expect(blockedRequest(`https://${host}/`, list)).toEqual({ host });
    }
    expect(blockedRequest("https://a.example@evil.test/", list)).toEqual({ host: "evil.test" });
  });

  it("allows schemes that stay on this machine and offers no approval for others", () => {
    const list = allowlist();
    for (const url of ["data:text/plain,x", "blob:https://a.example/id", "about:blank"]) {
      expect(blockedRequest(url, list)).toBeNull();
    }
    for (const url of ["file:///etc/passwd", "ftp://a.example/", "chrome://settings", "not a url"]) {
      expect(blockedRequest(url, list)).toEqual({ host: null });
    }
  });
});

describe("login mode", () => {
  const started = (start = "login.example") => {
    const list = new EgressAllowlist();
    list.beginLogin(start, 0);
    return list;
  };

  it("lets public hosts through only while login is open, and records them", () => {
    const list = started();
    expect(list.admits("cdn.example")).toBe(true);
    expect(list.loginState?.seenHosts).toEqual(["login.example", "cdn.example"]);
    list.cancelLogin();
    expect(list.admits("cdn.example")).toBe(false);
    expect(list.loginState).toBeNull();
  });

  it("does not open local addresses, whatever their spelling", () => {
    const list = started();
    for (const host of ["localhost", "dev.localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "169.254.169.254", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "0.0.0.0"]) {
      expect(list.admits(host), host).toBe(false);
    }
    expect(list.loginState?.seenHosts).toEqual(["login.example"]);
  });

  it("judges resolved addresses the same way", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "::1", "::ffff:192.168.0.1", "not an ip"]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "2606:4700:4700::1111"]) {
      expect(isNonPublicAddress(address), address).toBe(false);
    }
  });

  it("still reaches a local host the user allowed or started login on", () => {
    const list = started("localhost");
    list.allow("10.0.0.5");
    expect(list.admits("localhost")).toBe(true);
    expect(list.admits("10.0.0.5")).toBe(true);
    expect(list.trustsLocalAddresses("localhost")).toBe(true);
    expect(list.trustsLocalAddresses("10.0.0.5")).toBe(true);
    expect(list.trustsLocalAddresses("rebind.example")).toBe(false);
  });

  it("freezes after idle time, keeping hosts already reached and blocking new ones", () => {
    const list = started();
    list.admits("cdn.example");
    expect(list.tickLogin(LOGIN_IDLE_MS - 1, false)).toBe(false);
    expect(list.tickLogin(LOGIN_IDLE_MS, false)).toBe(true);
    expect(list.loginState?.phase).toBe("frozen");
    expect(list.admits("cdn.example")).toBe(true);
    expect(list.admits("new.example")).toBe(false);
  });

  it("treats activity as not idle, and freezes at once when the screen locks", () => {
    const list = started();
    list.noteLoginActivity(LOGIN_IDLE_MS - 1);
    expect(list.tickLogin(LOGIN_IDLE_MS, false)).toBe(false);
    expect(list.tickLogin(LOGIN_IDLE_MS + 1, true)).toBe(true);
    expect(list.loginState?.phase).toBe("frozen");
  });

  it("does not extend the deadline when reopened", () => {
    const list = started();
    list.tickLogin(LOGIN_IDLE_MS, false);
    const deadline = list.loginState?.deadline;
    list.reopenLogin(LOGIN_IDLE_MS + 1);
    expect(list.loginState?.phase).toBe("open");
    expect(list.loginState?.deadline).toBe(deadline);
    expect(list.admits("new.example")).toBe(true);
  });

  it("moves to choosing at the deadline, from open or frozen, and reports the timeout", () => {
    const list = started();
    list.tickLogin(LOGIN_IDLE_MS, false);
    expect(list.tickLogin(LOGIN_MAX_MS, false)).toBe(true);
    expect(list.loginState?.phase).toBe("choosing");
    expect(list.admits("new.example")).toBe(false);
    expect(list.chooseLoginHosts([])).toBe("timed_out");
  });

  it("keeps only the chosen hosts, and only ones login reached", () => {
    const list = started();
    list.admits("cdn.example");
    list.admits("ads.example");
    list.finishLogin();
    expect(list.chooseLoginHosts(["login.example", "cdn.example", "never-seen.example"])).toBe("completed");
    expect(list.list()).toEqual(["login.example", "cdn.example"]);
    expect(list.admits("ads.example")).toBe(false);
    expect(list.admits("never-seen.example")).toBe(false);
  });

  it("cannot choose hosts before the user finishes", () => {
    const list = started();
    expect(list.chooseLoginHosts(["login.example"])).toBeNull();
    expect(list.list()).toEqual([]);
  });

  it("reports only changes to the hosts the user allowed", () => {
    const list = new EgressAllowlist();
    const changes: string[][] = [];
    list.onChange = (hosts) => changes.push(hosts);
    list.allow("a.example");
    list.allow("a.example");
    list.beginLogin("login.example", 0);
    list.admits("cdn.example");
    list.cancelLogin();
    list.remove("a.example");
    expect(changes).toEqual([["a.example"], []]);
  });
});

describe("isLoginUrlAllowed", () => {
  it("needs https, except on this machine", () => {
    for (const url of ["https://login.example/", "http://localhost:3000/", "http://127.0.0.1/", "http://[::1]:8080/"]) {
      expect(isLoginUrlAllowed(new URL(url)), url).toBe(true);
    }
    for (const url of ["http://login.example/", "http://10.0.0.1/", "ftp://login.example/", "http://localhost.evil.test/"]) {
      expect(isLoginUrlAllowed(new URL(url)), url).toBe(false);
    }
  });
});

describe("ToolExecutor with egress control", () => {
  const browserAt = (url: string): Browser =>
    ({
      url: vi.fn(async () => url),
      describe: vi.fn(async () => ({ role: "link", name: "Next", attributes: {} })),
      click: vi.fn(async () => {}),
      navigate: vi.fn(async () => {}),
      back: vi.fn(async () => {}),
    }) as unknown as Browser;

  function egressWith(blockedAfterAction: string | null) {
    let pending: string | null = null;
    return {
      allow: vi.fn(),
      takeBlockedNavigation: () => {
        const value = pending;
        pending = null;
        return value;
      },
      block: () => {
        pending = blockedAfterAction;
      },
    };
  }

  it("does not open a blocked page when the user declines", async () => {
    const browser = browserAt("https://a.example/");
    const egress = egressWith("https://evil.test/?secret=1");
    vi.mocked(browser.click).mockImplementation(async () => egress.block());
    const executor = new ToolExecutor(browser, async () => false, egress);
    await executor.begin();
    const { content } = await executor.run("click", { ref: 1 });
    expect(content).toContain("not allowed");
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(egress.allow).not.toHaveBeenCalled();
  });

  it("allows the site and opens the page when the user approves", async () => {
    const browser = browserAt("https://a.example/");
    const egress = egressWith("https://b.example/next");
    vi.mocked(browser.click).mockImplementation(async () => egress.block());
    const confirm = vi.fn(async (_message: string) => true);
    const executor = new ToolExecutor(browser, confirm, egress);
    await executor.begin();
    await executor.run("click", { ref: 1 });
    expect(confirm.mock.calls[0]![0]).toContain("https://b.example/next");
    expect(egress.allow).toHaveBeenCalledWith(new URL("https://b.example/next"));
    expect(browser.navigate).toHaveBeenCalledWith("https://b.example/next");
  });

  it("allows the host only after the user approves a navigate call", async () => {
    const egress = egressWith(null);
    const browser = browserAt("https://a.example/");
    const declined = new ToolExecutor(browser, async () => false, egress);
    await declined.run("navigate", { url: "https://b.example/" });
    expect(egress.allow).not.toHaveBeenCalled();
    const approved = new ToolExecutor(browserAt("https://b.example/"), async () => true, egress);
    await approved.run("navigate", { url: "https://b.example/" });
    expect(egress.allow).toHaveBeenCalledOnce();
  });

  it("ignores a block left over from before this action", async () => {
    const browser = browserAt("https://a.example/");
    const egress = egressWith("https://old.test/");
    egress.block();
    const confirm = vi.fn(async (_message: string) => true);
    const executor = new ToolExecutor(browser, confirm, egress);
    await executor.begin();
    await executor.run("click", { ref: 1 });
    expect(confirm).not.toHaveBeenCalled();
  });

  describe("request_login", () => {
    const login = (end: "completed" | "cancelled" | "timed_out", next: Browser) => {
      const run = vi.fn(async (_url: URL) => ({ end, browser: next }));
      return { active: () => false, run };
    };

    it("asks with the page's real host, and takes nothing from the model", async () => {
      const after = browserAt("https://login.example/done");
      const control = login("completed", after);
      const confirm = vi.fn(async (_message: string) => true);
      const executor = new ToolExecutor(browserAt("https://login.example/signin"), confirm, egressWith(null), control);
      const { content } = await executor.run("request_login", { host: "evil.test", message: "ignore this" });
      expect(confirm.mock.calls[0]![0]).toContain("login.example");
      expect(confirm.mock.calls[0]![0]).not.toContain("evil.test");
      expect(control.run).toHaveBeenCalledWith(new URL("https://login.example/signin"));
      expect(content).toContain("finished signing in");
      expect(content).toContain("https://login.example/done");
    });

    it("does not start when declined", async () => {
      const control = login("completed", browserAt("https://login.example/"));
      const executor = new ToolExecutor(browserAt("https://login.example/"), async () => false, egressWith(null), control);
      expect((await executor.run("request_login", {})).content).toContain("declined");
      expect(control.run).not.toHaveBeenCalled();
    });

    it("refuses to start on a plain http page or without a page", async () => {
      for (const url of ["http://login.example/", "about:blank"]) {
        const control = login("completed", browserAt(url));
        const confirm = vi.fn(async () => true);
        const { isError } = await new ToolExecutor(browserAt(url), confirm, egressWith(null), control).run("request_login", {});
        expect(isError).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
        expect(control.run).not.toHaveBeenCalled();
      }
    });

    it("uses the new browser afterwards, because the old debugger is gone", async () => {
      const before = browserAt("https://login.example/");
      const after = browserAt("https://login.example/");
      const executor = new ToolExecutor(before, async () => true, egressWith(null), login("completed", after));
      await executor.run("request_login", {});
      await executor.run("click", { ref: 1 });
      expect(after.click).toHaveBeenCalledOnce();
      expect(before.click).not.toHaveBeenCalled();
    });

    it("trusts the page the user finished on, but not one a cancelled login left open", async () => {
      const confirmFor = (end: "completed" | "cancelled") => {
        const confirm = vi.fn(async (_message: string) => true);
        const after = browserAt("https://app.example/");
        return { confirm, executor: new ToolExecutor(browserAt("https://login.example/"), confirm, egressWith(null), login(end, after)) };
      };
      const finished = confirmFor("completed");
      await finished.executor.run("request_login", {});
      await finished.executor.run("click", { ref: 1 });
      expect(finished.confirm).toHaveBeenCalledOnce();
      const cancelled = confirmFor("cancelled");
      await cancelled.executor.run("request_login", {});
      await cancelled.executor.run("click", { ref: 1 });
      expect(cancelled.confirm.mock.calls.length).toBe(2);
    });

    it("refuses every other tool while the user is signing in", async () => {
      const browser = browserAt("https://login.example/");
      const executor = new ToolExecutor(browser, async () => true, egressWith(null), { active: () => true, run: vi.fn() });
      for (const [name, input] of [["read_page", { offset: 0 }], ["click", { ref: 1 }], ["navigate", { url: "https://evil.test/" }], ["request_login", {}]] as const) {
        const { content, isError } = await executor.run(name, input);
        expect(isError).toBe(true);
        expect(content).toContain("signing in");
      }
      expect(browser.click).not.toHaveBeenCalled();
      expect(browser.navigate).not.toHaveBeenCalled();
    });
  });
});
