import { describe, expect, it, vi } from "vitest";
import type { Browser } from "../src/browser";
import { blockedRequest, EgressAllowlist } from "../src/egress";
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
});
