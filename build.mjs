import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

// E2E builds point at a local fake API and read a test data folder. Release builds compile both out.
const e2eApi = process.env.E2E_API_BASE ?? "";
const outdir = e2eApi ? "dist-e2e" : "dist";
const define = { __E2E_API_BASE__: JSON.stringify(e2eApi) };

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync("public", outdir, { recursive: true });

await build({
  entryPoints: { main: "src/main/main.ts", preload: "src/main/preload.ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  outdir,
  outExtension: { ".js": ".cjs" },
  define,
});
await build({
  entryPoints: { panel: "src/panel/panel.ts" },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome130",
  outdir,
  define,
});
console.log(`built ${outdir}/`);
