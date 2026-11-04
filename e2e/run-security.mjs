// Builds e2e/security.ts and runs it in real Electron with its sandbox on.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { build } from "esbuild";
import electronPath from "electron";

await build({
  entryPoints: { security: "e2e/security.ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  outdir: "dist-e2e",
  outExtension: { ".js": ".cjs" },
});

const needsDisplay = process.platform === "linux" && !process.env.DISPLAY;
function run(...flags) {
  const app = [electronPath, resolve("dist-e2e/security.cjs"), ...flags];
  const [command, ...args] = needsDisplay ? ["xvfb-run", "-a", ...app] : app;
  return spawnSync(command, args, { stdio: "inherit" }).status ?? 1;
}

const hardened = run();
const control = run("--control");
process.exit(hardened || control);
