import type Anthropic from "@anthropic-ai/sdk";
import { KEYS, type Browser, type KeyName } from "./browser";
import { blockedInputReason, isSensitiveClick, isSensitiveSubmit, parseWebUrl } from "./policy";

/** Asks the user to approve an action and resolves with their answer. */
export type Confirm = (message: string) => Promise<boolean>;

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
].map((tool) => ({ ...tool, strict: true }));

const PAGE_CHUNK = 40_000;
const DECLINED = "The user declined this action. Do not retry it. Tell the user or choose another approach.";

export interface ToolOutput {
  content: string | Anthropic.Beta.BetaImageBlockParam[];
  isError?: boolean;
}

export class ToolExecutor {
  private readonly approvedOrigins = new Set<string>();

  constructor(
    private readonly browser: Browser,
    private readonly confirm: Confirm,
  ) {}

  /** The user started the task on this page, so its origin is trusted for the task. */
  async begin(): Promise<void> {
    const url = parseWebUrl(await this.browser.url());
    if (url) this.approvedOrigins.add(url.origin);
  }

  async run(name: string, input: any): Promise<ToolOutput> {
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
        await this.browser.back();
        return this.afterAction("Went back.");
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
    this.approvedOrigins.add(url.origin);
    await this.browser.navigate(url.href);
    return this.afterAction("Navigated.");
  }

  /**
   * Clicks and key presses can leave the approved sites without going through navigate.
   * The request has already been sent by this point, so this limits further actions
   * on the new site. It cannot undo the navigation itself.
   */
  private async afterAction(done: string): Promise<ToolOutput> {
    const current = await this.browser.url();
    if (current === "about:blank") return { content: `${done} Current URL: ${current}` };
    const url = parseWebUrl(current);
    if (url && this.approvedOrigins.has(url.origin)) {
      return { content: `${done} Current URL: ${current}` };
    }
    if (url && (await this.confirm(`페이지가 새 사이트로 이동했습니다. 여기서 계속할까요?\n${current}`))) {
      this.approvedOrigins.add(url.origin);
      return { content: `${done} Current URL: ${current}` };
    }
    await this.browser.back().catch(() => {});
    return { content: `${done} The page moved to ${current}, which was not allowed, so the agent went back.` };
  }
}
