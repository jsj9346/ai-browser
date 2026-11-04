// The only path from this app to CDP. Raw CDP can read other sessions' cookies and skip request
// blocking (both shown by the spike), so only the commands the Browser implementation needs get through.
import { parseWebUrl } from "./policy";

export interface CdpTransport {
  send(method: string, params?: object): Promise<any>;
  /** Why the debugging session ended, or null while it is alive. */
  readonly endedReason: string | null;
}

export const EXPRESSIONS = {
  readyState: "document.readyState",
  href: "location.href",
  title: "document.title",
} as const;

export const SELECT_CONTENTS = `function () {
  if (typeof this.select === "function") return this.select();
  if (this.isContentEditable) getSelection().selectAllChildren(this);
}`;

const ALLOWED = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "DOM.describeNode",
  "DOM.enable",
  "DOM.focus",
  "DOM.getContentQuads",
  "DOM.resolveNode",
  "DOM.scrollIntoViewIfNeeded",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Page.captureScreenshot",
  "Page.enable",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Runtime.callFunctionOn",
  "Runtime.enable",
  "Runtime.evaluate",
]);
const FIXED_EXPRESSIONS = new Set<unknown>(Object.values(EXPRESSIONS));

/** Returns why this command may not be sent, or null if it may. */
export function cdpRejection(method: string, params: Record<string, unknown> = {}): string | null {
  if (!ALLOWED.has(method)) return `CDP command not allowed: ${method}`;
  if (method === "Runtime.evaluate" && !FIXED_EXPRESSIONS.has(params.expression)) {
    return "Runtime.evaluate only runs fixed expressions";
  }
  if (method === "Runtime.callFunctionOn" && params.functionDeclaration !== SELECT_CONTENTS) {
    return "Runtime.callFunctionOn only runs fixed functions";
  }
  if (method === "Page.navigate" && !parseWebUrl(String(params.url))) {
    return "Page.navigate only opens http and https URLs";
  }
  return null;
}

export class GatedCdp {
  constructor(private readonly transport: CdpTransport) {}

  get endedReason(): string | null {
    return this.transport.endedReason;
  }

  async send<T = any>(method: string, params?: object): Promise<T> {
    const rejected = cdpRejection(method, params as Record<string, unknown> | undefined);
    if (rejected) throw new Error(rejected);
    return this.transport.send(method, params);
  }
}
