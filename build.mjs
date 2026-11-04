import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

// E2E builds point at a local fake API and enable a tab override. Release builds compile both out.
const e2eApi = process.env.E2E_API_BASE ?? "";
const outdir = e2eApi ? "dist-e2e" : "dist";

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync("public", outdir, { recursive: true });

await build({
  entryPoints: ["src/background.ts", "src/sidepanel.ts"],
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir,
  define: { __E2E_API_BASE__: JSON.stringify(e2eApi) },
});
console.log(`built ${outdir}/`);
