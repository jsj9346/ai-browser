// Chromium resolves DNS for dns-prefetch and for requests that webRequest later blocks, which e2e/security.ts
// measured. This applies to the whole process, so Chromium's own network stack (Electron's `net`,
// session.fetch) cannot resolve names here. The proxy resolves allowed hosts in Node, and the Anthropic SDK
// uses Node's fetch.
import { app } from "electron";

/** Must run before the app is ready. `extraRules` lets security tests map fixture hosts first. */
export function applyEgressSwitches(extraRules = ""): void {
  app.commandLine.appendSwitch("host-resolver-rules", `${extraRules}MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost`);
}
