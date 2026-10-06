import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(repository, "apps", "pi-web");
const outfile = join(web, "runtime", "portable-registration-probe.mjs");
mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: [join(web, "lib", "portable-registration-probe.ts")],
  outfile,
  absWorkingDir: web,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  banner: { js: 'import { createRequire as __portableCreateRequire } from "node:module"; const require = __portableCreateRequire(import.meta.url);' },
});
process.stdout.write(`Built portable registration probe: ${outfile}\n`);
