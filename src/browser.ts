import { formatAxTree, type AXNode, type RefInfo } from "./ax";
import { EXPRESSIONS, SELECT_CONTENTS, type GatedCdp } from "./gated-cdp";

export interface ElementInfo extends RefInfo {
  attributes: Record<string, string>;
}

/** What the tools need from a browser. The agent is tested against a fake of this. */
export interface Browser {
  url(): Promise<string>;
  outline(): Promise<{ title: string; url: string; text: string }>;
  describe(ref: number): Promise<ElementInfo>;
  click(ref: number): Promise<void>;
  type(ref: number, text: string): Promise<void>;
  pressKey(key: KeyName): Promise<void>;
  scroll(direction: "up" | "down"): Promise<void>;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  screenshot(): Promise<string>;
}

/** The session cannot continue, e.g. the page was closed. */
export class SessionEndedError extends Error {}

export const KEYS = {
  Enter: { code: 13, text: "\r" },
  Tab: { code: 9 },
  Escape: { code: 27 },
  Backspace: { code: 8 },
  ArrowUp: { code: 38 },
  ArrowDown: { code: 40 },
  ArrowLeft: { code: 37 },
  ArrowRight: { code: 39 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
} as const;
export type KeyName = keyof typeof KEYS;

const COMMAND_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CdpBrowser implements Browser {
  private refs = new Map<number, RefInfo>();

  private constructor(private readonly cdp: GatedCdp) {}

  static async attach(cdp: GatedCdp): Promise<CdpBrowser> {
    const browser = new CdpBrowser(cdp);
    for (const domain of ["Page", "DOM", "Runtime", "Accessibility"]) {
      await browser.send(`${domain}.enable`);
    }
    return browser;
  }

  private async send<T = any>(method: string, params?: object): Promise<T> {
    const ended = () => new SessionEndedError(`Debugging ended: ${this.cdp.endedReason}`);
    if (this.cdp.endedReason) throw ended();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out`)), COMMAND_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.cdp.send<T>(method, params), timeout]);
    } catch (error) {
      if (this.cdp.endedReason) throw ended();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Waits for loading to finish. */
  private async settle(): Promise<void> {
    await sleep(300);
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const { result } = await this.send("Runtime.evaluate", { expression: EXPRESSIONS.readyState });
        if (result.value === "complete") return;
      } catch (error) {
        if (error instanceof SessionEndedError) throw error;
        // The execution context is replaced during navigation. Try again.
      }
      await sleep(150);
    }
  }

  async url(): Promise<string> {
    const { result } = await this.send("Runtime.evaluate", { expression: EXPRESSIONS.href });
    return String(result.value);
  }

  async outline() {
    const { nodes } = await this.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    const { text, refs } = formatAxTree(nodes);
    this.refs = refs;
    const { result } = await this.send("Runtime.evaluate", { expression: EXPRESSIONS.title });
    return { title: String(result.value ?? ""), url: await this.url(), text };
  }

  async describe(ref: number): Promise<ElementInfo> {
    const info = this.refs.get(ref);
    if (!info) throw new Error(`Unknown ref ${ref}. Call read_page to get current refs.`);
    const { node } = await this.send("DOM.describeNode", { backendNodeId: ref });
    const flat: string[] = node.attributes ?? [];
    const attributes: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) attributes[flat[i]!.toLowerCase()] = flat[i + 1]!;
    return { ...info, attributes };
  }

  async click(ref: number): Promise<void> {
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref });
    const { quads } = await this.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: ref });
    const quad = quads[0];
    if (!quad) throw new Error("The element is not visible on the page.");
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    const button = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...button });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...button });
    await this.settle();
  }

  async type(ref: number, text: string): Promise<void> {
    await this.send("DOM.focus", { backendNodeId: ref });
    const { object } = await this.send("DOM.resolveNode", { backendNodeId: ref });
    await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: SELECT_CONTENTS,
    });
    await this.send("Input.insertText", { text });
  }

  async pressKey(key: KeyName): Promise<void> {
    const spec = KEYS[key];
    const base = { key, code: key, windowsVirtualKeyCode: spec.code, nativeVirtualKeyCode: spec.code };
    const text = "text" in spec ? { text: spec.text, unmodifiedText: spec.text } : {};
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await this.settle();
  }

  async scroll(direction: "up" | "down"): Promise<void> {
    const { cssVisualViewport: view } = await this.send("Page.getLayoutMetrics");
    const distance = view.clientHeight * 0.8;
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: view.clientWidth / 2,
      y: view.clientHeight / 2,
      deltaX: 0,
      deltaY: direction === "down" ? distance : -distance,
    });
    await sleep(250);
  }

  async navigate(url: string): Promise<void> {
    const { errorText } = await this.send("Page.navigate", { url });
    if (errorText) throw new Error(`Navigation failed: ${errorText}`);
    await this.settle();
  }

  async back(): Promise<void> {
    const { currentIndex, entries } = await this.send("Page.getNavigationHistory");
    const entry = entries[currentIndex - 1];
    if (!entry) throw new Error("There is no previous page.");
    await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    await this.settle();
  }

  async screenshot(): Promise<string> {
    const { data } = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
    return data;
  }
}
