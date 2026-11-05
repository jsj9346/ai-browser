import type Anthropic from "@anthropic-ai/sdk";
import { KEYS, type Browser, type KeyName } from "./browser";
import type { EgressControl, LoginEnd } from "./egress";
import { blockedInputReason, isLoginUrlAllowed, isSensitiveClick, isSensitiveSubmit, parseWebUrl } from "./policy";

/** Asks the user to approve an action and resolves with their answer. */
export type Confirm = (message: string) => Promise<boolean>;

/** Hands the page to the user for signing in. The model never sees the page while this runs. */
export interface LoginControl {
  active(): boolean;
  /** Resolves when login ends, with a browser for the page, because debugging was detached meanwhile. */
  run(url: URL): Promise<{ end: LoginEnd; browser: Browser }>;
}

const object = (properties: Record<string, object>) => ({
  type: "object" as const,
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const ref = { type: "integer", description: "Element ref from the latest read_page output" };

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "read_page",
    description:
      "Read the current page as an accessibility outline. Interactive elements have a [ref] to pass to other tools. Refs can go stale when the page changes.",
    input_schema: object({
      offset: { type: "integer", description: "Character offset to continue from. Use 0 to start." },
    }),
  },
  {
    name: "screenshot",
    description: "Capture the visible part of the page. Use it when layout or images matter.",
    input_schema: object({}),
  },
  {
    name: "click",
    description: "Click an element.",
    input_schema: object({ ref }),
  },
  {
    name: "type_text",
    description: "Replace the content of a text field, optionally pressing Enter afterwards.",
    input_schema: object({
      ref,
      text: { type: "string" },
      submit: { type: "boolean", description: "Press Enter after typing" },
    }),
  },
  {
    name: "press_key",
    description: "Press a key on the focused element.",
    input_schema: object({ key: { type: "string", enum: Object.keys(KEYS) } }),
  },
  {
    name: "scroll",
    description: "Scroll the page by most of one screen.",
    input_schema: object({ direction: { type: "string", enum: ["up", "down"] } }),
  },
  {
    name: "navigate",
    description: "Open an http or https URL in the current tab.",
    input_schema: object({ url: { type: "string" } }),
  },
  {
    name: "go_back",
    description: "Go to the previous page in this tab.",
    input_schema: object({}),
  },
  {
    name: "request_login",
    description:
      "Ask the user to sign in on the current page. The agent pauses and cannot see the page until the user finishes. Refs from before are invalid afterwards.",
    input_schema: object({}),
  },
].map((tool) => ({ ...tool, strict: true }));

const PAGE_CHUNK = 40_000;
const DECLINED = "The user declined this action. Do not retry it. Tell the user or choose another approach.";
const LOGIN_RESULTS: Record<LoginEnd, string> = {
  completed: "The user finished signing in.",
  cancelled: "The user cancelled signing in.",
  timed_out: "Signing in ran out of time.",
};

export interface ToolOutput {
  content: string | Anthropic.Beta.BetaImageBlockParam[];
  isError?: boolean;
}

export class ToolExecutor {
  private readonly approvedOrigins = new Set<string>();
  private pendingBlocked: string | null = null;

  constructor(
    private browser: Browser,
    private readonly confirm: Confirm,
    private readonly egress: EgressControl,
    private readonly login?: LoginControl,
  ) {}

  /** The user started the task on this page, so its origin is trusted for the task. */
  async begin(): Promise<void> {
    const url = parseWebUrl(await this.browser.url());
    if (url) this.approvedOrigins.add(url.origin);
  }

  async run(name: string, input: any): Promise<ToolOutput> {
    if (this.login?.active()) return { content: "Not run: the user is signing in.", isError: true };
    this.egress.takeBlockedNavigation(); // Only a block caused by this action counts.
    switch (name) {
      case "read_page":
        return this.readPage(input.offset);
      case "screenshot":
        return {
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: await this.browser.screenshot() },
            },
          ],
        };
      case "click":
        return this.click(input.ref);
      case "type_text":
        return this.typeText(input.ref, input.text, input.submit);
      case "press_key":
        return this.pressKey(input.key);
      case "scroll":
        await this.browser.scroll(input.direction);
        return { content: `Scrolled ${input.direction}.` };
      case "navigate":
        return this.navigate(input.url);
      case "go_back":
        await this.tolerateBlock(() => this.browser.back());
        return this.afterAction("Went back.");
      case "request_login":
        return this.requestLogin();
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  }

  private async readPage(offset: number): Promise<ToolOutput> {
    const page = await this.browser.outline();
    const start = Math.max(0, offset);
    const end = start + PAGE_CHUNK;
    const more =
      end < page.text.length ? `\n[Page continues. Call read_page with offset=${end}.]` : "";
    // Keep page text from closing the wrapper and posing as content outside it.
    const body = page.text.slice(start, end).replaceAll("</untrusted_page", "<​/untrusted_page");
    const title = page.title.replaceAll("</untrusted_page", "<​/untrusted_page");
    return {
      content:
        `URL: ${page.url}\n<untrusted_page title=${JSON.stringify(title)}>\n${body}\n</untrusted_page>${more}`,
    };
  }

  private async click(target: number): Promise<ToolOutput> {
    const element = await this.browser.describe(target);
    if (
      isSensitiveClick(element.role, element.name) &&
      !(await this.confirm(`"${element.name}" ${element.role}을(를) 클릭할까요?`))
    ) {
      return { content: DECLINED };
    }
    await this.browser.click(target);
    return this.afterAction("Clicked.");
  }

  private async typeText(target: number, text: string, submit: boolean): Promise<ToolOutput> {
    const element = await this.browser.describe(target);
    const blocked = blockedInputReason(element.attributes);
    if (blocked) {
      return {
        content: `Blocked: the agent may not type into a ${blocked}. Ask the user to fill it in.`,
        isError: true,
      };
    }
    if (
      submit &&
      isSensitiveSubmit(element.role) &&
      !(await this.confirm(`"${element.name}" 입력란에 다음 내용을 넣고 제출할까요?\n${text}`))
    ) {
      return { content: DECLINED };
    }
    await this.browser.type(target, text);
    if (!submit) return { content: "Typed." };
    await this.browser.pressKey("Enter");
    return this.afterAction("Typed and submitted.");
  }

  private async pressKey(key: KeyName): Promise<ToolOutput> {
    if (key === "Enter" && !(await this.confirm("Enter 키를 누를까요? 양식이 제출될 수 있습니다."))) {
      return { content: DECLINED };
    }
    await this.browser.pressKey(key);
    return this.afterAction(`Pressed ${key}.`);
  }

  private async navigate(raw: string): Promise<ToolOutput> {
    const url = parseWebUrl(raw);
    if (!url) return { content: "Only http and https URLs are allowed.", isError: true };
    if (
      !this.approvedOrigins.has(url.origin) &&
      !(await this.confirm(`새 사이트로 이동할까요?\n${url.href}`))
    ) {
      return { content: DECLINED };
    }
    this.approve(url);
    await this.tolerateBlock(() => this.browser.navigate(url.href));
    return this.afterAction("Navigated.");
  }

  /** Takes no input and shows the page's real host, so neither the model nor a page can word this prompt. */
  private async requestLogin(): Promise<ToolOutput> {
    if (!this.login) return { content: "Signing in is not available here.", isError: true };
    const url = parseWebUrl(await this.browser.url());
    if (!url || !isLoginUrlAllowed(url)) {
      return { content: "Signing in can only start on an https page.", isError: true };
    }
    const asked = `${url.host}에 로그인할까요?\n승인하면 에이전트가 멈추고, 로그인이 끝날 때까지 공인 호스트가 모두 열립니다.`;
    if (!(await this.confirm(asked))) return { content: DECLINED };
    const { end, browser } = await this.login.run(url);
    this.browser = browser;
    const current = await browser.url();
    const page = parseWebUrl(current);
    // The user finished here, so like the page a task starts on, this origin is trusted.
    if (end === "completed" && page) this.approvedOrigins.add(page.origin);
    return { content: `${LOGIN_RESULTS[end]} Current URL: ${current}` };
  }

  private approve(url: URL): void {
    this.approvedOrigins.add(url.origin);
    this.egress.allow(url);
  }

  /** A navigation the guard stopped fails here, and afterAction then asks the user about it. */
  private async tolerateBlock(action: () => Promise<void>): Promise<void> {
    let blocked: string | null = null;
    try {
      await action();
    } catch (error) {
      blocked = this.egress.takeBlockedNavigation();
      if (!blocked) throw error;
      this.pendingBlocked = blocked;
    }
  }

  /**
   * Clicks and key presses can try to leave the approved sites without going through navigate.
   * The egress guard stops those before the request is sent, and the user decides here.
   * A page on an allowed host that was not approved in this run still needs approval to continue.
   */
  private async afterAction(done: string): Promise<ToolOutput> {
    const blocked = this.pendingBlocked ?? this.egress.takeBlockedNavigation();
    this.pendingBlocked = null;
    if (blocked) {
      const target = parseWebUrl(blocked);
      if (target && (await this.confirm(`페이지가 새 사이트로 이동하려고 합니다. 허용할까요?\n${target.href}`))) {
        this.approve(target);
        await this.browser.navigate(target.href);
        return { content: `${done} Current URL: ${await this.browser.url()}` };
      }
      // A stopped navigation can leave the browser's error page in place of the page.
      if (!parseWebUrl(await this.browser.url())) await this.browser.back().catch(() => {});
      return { content: `${done} The page tried to move to ${blocked}, which was not allowed, so it stayed here.` };
    }
    const current = await this.browser.url();
    if (current === "about:blank") return { content: `${done} Current URL: ${current}` };
    const url = parseWebUrl(current);
    if (url && this.approvedOrigins.has(url.origin)) {
      return { content: `${done} Current URL: ${current}` };
    }
    if (url && (await this.confirm(`페이지가 새 사이트로 이동했습니다. 여기서 계속할까요?\n${current}`))) {
      this.approve(url);
      return { content: `${done} Current URL: ${current}` };
    }
    await this.browser.back().catch(() => {});
    return { content: `${done} The page moved to ${current}, which was not allowed, so the agent went back.` };
  }
}
