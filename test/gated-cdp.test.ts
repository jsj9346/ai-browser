import { describe, expect, it, vi } from "vitest";
import { CdpBrowser, SessionEndedError } from "../src/browser";
import { cdpRejection, EXPRESSIONS, GatedCdp, SELECT_CONTENTS, type CdpTransport } from "../src/gated-cdp";

describe("cdpRejection", () => {
  it("blocks the commands the spike used to break isolation and egress control", () => {
    for (const method of [
      "Target.getTargets",
      "Target.attachToTarget",
      "Network.loadNetworkResource",
      "Network.getAllCookies",
      "Storage.getCookies",
      "Browser.close",
    ]) {
      expect(cdpRejection(method)).toContain("not allowed");
    }
  });

  it("only evaluates fixed code", () => {
    expect(cdpRejection("Runtime.evaluate", { expression: EXPRESSIONS.href })).toBeNull();
    expect(cdpRejection("Runtime.evaluate", { expression: "document.cookie" })).not.toBeNull();
    expect(cdpRejection("Runtime.evaluate", {})).not.toBeNull();
    expect(cdpRejection("Runtime.callFunctionOn", { functionDeclaration: SELECT_CONTENTS })).toBeNull();
    expect(cdpRejection("Runtime.callFunctionOn", { functionDeclaration: "function () { fetch('x') }" })).not.toBeNull();
  });

  it("only navigates to web URLs", () => {
    expect(cdpRejection("Page.navigate", { url: "https://a.example/" })).toBeNull();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings"]) {
      expect(cdpRejection("Page.navigate", { url })).not.toBeNull();
    }
  });
});

function transport(send: CdpTransport["send"], endedReason: string | null = null): CdpTransport {
  return { send, endedReason };
}

describe("GatedCdp", () => {
  it("never reaches the transport for a rejected command", async () => {
    const send = vi.fn(async () => ({}));
    await expect(new GatedCdp(transport(send)).send("Target.getTargets")).rejects.toThrow("not allowed");
    expect(send).not.toHaveBeenCalled();
  });

  it("passes allowed commands through", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    await expect(new GatedCdp(transport(send)).send("Page.enable")).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("Page.enable", undefined);
  });
});

describe("CdpBrowser", () => {
  it("every command it sends passes the gate", async () => {
    const sent: string[] = [];
    const send = vi.fn(async (method: string): Promise<any> => {
      sent.push(method);
      switch (method) {
        case "Accessibility.getFullAXTree":
          return { nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 7 }] };
        case "Runtime.evaluate":
          return { result: { value: "complete" } };
        case "DOM.describeNode":
          return { node: { attributes: ["TYPE", "text"] } };
        case "DOM.getContentQuads":
          return { quads: [[0, 0, 2, 0, 2, 2, 0, 2]] };
        case "DOM.resolveNode":
          return { object: { objectId: "o" } };
        case "Page.getLayoutMetrics":
          return { cssVisualViewport: { clientWidth: 100, clientHeight: 100 } };
        case "Page.getNavigationHistory":
          return { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] };
        case "Page.navigate":
          return {};
        case "Page.captureScreenshot":
          return { data: "AAAA" };
        default:
          return {};
      }
    });
    const browser = await CdpBrowser.attach(new GatedCdp(transport(send)));
    await browser.outline();
    expect((await browser.describe(7)).attributes).toEqual({ type: "text" });
    await browser.click(7);
    await browser.type(7, "x");
    await browser.pressKey("Tab");
    await browser.scroll("down");
    await browser.navigate("https://a.example/");
    await browser.back();
    await browser.screenshot();
    expect(sent).toContain("Input.insertText");
    expect(sent).toContain("Runtime.callFunctionOn");
  });

  it("ends the session once debugging has ended", async () => {
    const live = { send: vi.fn(async () => ({})), endedReason: null as string | null };
    const browser = await CdpBrowser.attach(new GatedCdp(live));
    live.endedReason = "target_closed";
    await expect(browser.url()).rejects.toBeInstanceOf(SessionEndedError);
  });

  it("rejects refs that did not come from the latest outline", async () => {
    const browser = await CdpBrowser.attach(new GatedCdp(transport(vi.fn(async () => ({})))));
    await expect(browser.describe(99)).rejects.toThrow("Unknown ref");
  });
});
