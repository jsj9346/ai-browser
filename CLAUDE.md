# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A prototype AI-native browser for developers, built with Electron and TypeScript. Linux comes first, then macOS. The README, `docs/architecture.md` and all user-facing strings (panel UI, approval prompts) are in Korean; the system prompt and tool results sent to the model are in English.

`docs/architecture.md` holds the design and the remaining build steps. Only step 1 exists so far: one window, one task, no egress control, no login flow, no external agent connection.

## Commands

```bash
npm start           # Build to dist/ and run the app (needs a display)
npm run build       # Build to dist/
npm run typecheck   # tsc --noEmit (covers src/ and test/, not e2e/)
npm test            # Unit tests with vitest
npx vitest run test/policy.test.ts       # One test file
npx vitest run -t "part of a test name"  # Tests matching a name
npm run e2e         # Builds dist-e2e/ and drives the app in real Electron
```

`npm run e2e` re-runs itself under `xvfb-run` on Linux without a display. It writes a panel screenshot to `dist-e2e/panel.png` (override with `E2E_SHOT`).

On Ubuntu 24.04 Electron aborts unless `node_modules/electron/dist/chrome-sandbox` is owned by root with mode 4755, and `npm install` can reset this. Fix the helper's permissions; never run with `--no-sandbox`.

## Architecture

The agent runs in the main process. The window holds two `WebContentsView`s: the task page and the panel.

- `src/main/main.ts` creates the window and the panel, and owns IPC. Every handler checks that the sender is the panel. Approvals are answered only over this IPC.
- `src/main/task.ts` is one task: an in-memory session, the page view, the conversation, and a debugger attachment that lasts for one run.
- `src/main/settings.ts` holds the API key, which never goes to the panel.
- `src/panel/` is the panel UI, reached through `src/main/preload.ts`. Task pages have no preload script.
- `src/agent.ts` is the loop, capped at `MAX_STEPS`. It returns an `AgentOutcome` rather than throwing for expected endings, and reports progress through `onEvent`.
- `src/tools.ts` defines the model's tools and is where approvals happen. `ToolExecutor` combines `policy.ts` checks with the `Confirm` callback and tracks approved origins for the run.
- `src/policy.ts` holds the pure safety rules, enforced in code regardless of what the model decides.
- `src/browser.ts` defines the `Browser` interface and its CDP implementation. Unit tests use a fake `Browser`, so `agent.ts` and `tools.ts` do not touch Electron.
- `src/gated-cdp.ts` is the only path to CDP. `CdpBrowser` can only be built from a `GatedCdp`.
- `src/ax.ts` turns the CDP accessibility tree into the outline the model reads.

Refs given to the model are CDP `backendDOMNodeId`s. `CdpBrowser` only accepts refs from the latest `outline()`.

## Invariants

- **Safety checks belong in code, not the prompt.** A page can steer the model through prompt injection, so a new action that can have side effects needs its check in `policy.ts`/`ToolExecutor`.
- **Never expose raw CDP.** The spike read another session's HttpOnly cookies through `Target.*` and skipped request blocking with `Network.loadNetworkResource`. A new CDP command must be added to the list in `gated-cdp.ts`. `Runtime.evaluate` and `Runtime.callFunctionOn` only run the fixed code defined there.
- **Page text is untrusted.** In `readPage`, page content is wrapped in `<untrusted_page>`, and closing tags inside it are neutralized with a zero-width space, which is invisible in the source. In the panel, page-derived text must only be rendered with `textContent`.
- **Every `tool_use` needs a `tool_result`**, including skipped ones, or the conversation cannot continue. This is why `agent.ts` pushes "Not run" results after a stop or session end.
- **Response handling order in `agent.ts` matters.** `refusal` and `max_tokens` return before the response is added to `messages`, because their content is partial. Assistant content, including thinking blocks, is otherwise sent back unchanged.
- **`SessionEndedError` ends the task** (page closed, debugger detached); other tool errors go back to the model as `is_error` results.

## Build and E2E

`build.mjs` injects `__E2E_API_BASE__` at compile time. When `E2E_API_BASE` is set it outputs to `dist-e2e/` with a fake API base URL and a test data folder; release builds compile both out.

`e2e/run.mjs` fakes only the Anthropic API; tools run against the real fixture pages in `e2e/site/`, so it does not measure real model behavior. Its `script` array, the `answers` array of approval responses, and the checks that read `results[n]` by position are all order-dependent: adding a script step means updating the later indexes and possibly `answers`.

It drives the panel over `--remote-debugging-port`, not Playwright, whose Electron launcher adds `--no-sandbox` and hung on this app. Electron refuses `webContents.debugger` while another client is attached, so inspect the task page only while no task is running.
