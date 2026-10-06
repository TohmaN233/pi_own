import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createJiti } from "jiti";
import "./build-course-workflow-domain-identity.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(repository, "apps", "pi-web");
const destination = join(web, "runtime", "module-runtimes");
const hostCapabilities = [
  "file-access", "harness-server", "mode-pack-inventory", "mode-pack-store",
  "portable-mode-pack-registry", "portable-mode-pack-service", "request-security",
  "rpc-manager", "session-reader", "bundled-domain-workflows",
];
const hostCapabilitySet = new Set(hostCapabilities);

async function copyDomainWorkflowBundles() {
  const source = join(repository, "mode-packs", "domain-workflows");
  const runtimeRoot = resolve(web, "runtime"), target = resolve(runtimeRoot, "domain-workflows");
  const checkedOutput = (path) => {
    const absolute = resolve(path), local = relative(runtimeRoot, absolute);
    if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`) || resolve(runtimeRoot, local) !== absolute) throw new Error(`Unsafe bundled Workflow output path: ${path}`);
    let cursor = absolute;
    for (;;) {
      try { if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Linked bundled Workflow output path: ${cursor}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    return absolute;
  };
  if (!existsSync(join(source, "manifest.json"))) {
    // Generated assets cannot retain a stale bundle when the canonical source is unavailable.
    if (existsSync(target)) rmSync(checkedOutput(target), { recursive: true, force: true });
    process.stderr.write("Bundled domain Workflows unavailable: source manifest has not been exported; no defaults were manufactured.\n");
    return;
  }
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { readBundledDomainWorkflows } = await jiti.import(join(web, "lib", "bundled-domain-workflows.ts"));
  const entries = await readBundledDomainWorkflows(source);
  mkdirSync(runtimeRoot, { recursive: true });
  const stage = checkedOutput(mkdtempSync(join(runtimeRoot, ".domain-workflows-")));
  try {
    const manifest = readFileSync(join(source, "manifest.json"));
    for (const entry of entries) {
      const bytes = readFileSync(entry.packagePath);
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Bundled Workflow changed during packaging: ${entry.id}`);
      writeFileSync(join(stage, entry.path), bytes);
    }
    writeFileSync(join(stage, "manifest.json"), manifest);
    const staged = await readBundledDomainWorkflows(stage);
    if (JSON.stringify(staged.map(({ packagePath, ...entry }) => entry)) !== JSON.stringify(entries.map(({ packagePath, ...entry }) => entry))) throw new Error("Bundled Workflow manifest changed during packaging");
    if (existsSync(target)) rmSync(checkedOutput(target), { recursive: true, force: true });
    renameSync(stage, checkedOutput(target));
    process.stdout.write(`Bundled domain Workflows: ${entries.length} verified packages copied to Host runtime assets\n`);
  } catch (error) {
    if (existsSync(stage)) rmSync(checkedOutput(stage), { recursive: true, force: true });
    throw error;
  }
}
const modules = [
  { id: "course-builder", extensions: { "course-builder": "course-builder-extension.ts" } },
  { id: "study-research", extensions: {
    "study-research": "study-research-extension.ts",
    "study-visualization": "study-visualization-extension.ts",
    "research-execution": "research-execution-extension.ts",
    "study-results": "study-results-extension.ts",
    "study-manuscript": "study-manuscript-extension.ts",
    "study-assignment": "study-assignment-extension.ts",
  } },
];
function hash(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function slash(path) { return path.replaceAll("\\", "/"); }
function assertOutput(path) {
  const resolved = resolve(path);
  if (!resolved.startsWith(`${resolve(destination)}${sep}`)) throw new Error(`Module runtime path escaped its output root: ${resolved}`);
  return resolved;
}
function routesFor(moduleId) {
  const root = join(web, "app", "api", moduleId);
  const routes = [];
  function walk(directory, names = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(directory, entry.name), [...names, entry.name]);
      else if (entry.name === "route.ts") routes.push({ route: names.join("/"), source: join(directory, entry.name) });
    }
  }
  walk(root);
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}
function entrySource(module, routes) {
  const lines = [];
  for (const [index, item] of routes.entries()) lines.push(`import * as route${index} from ${JSON.stringify(slash(item.source))};`);
  const extensions = Object.entries(module.extensions);
  for (const [index, [, filename]] of extensions.entries()) lines.push(`import extension${index} from ${JSON.stringify(slash(join(web, "lib", filename)))};`);
  lines.push(`export const routes = {${routes.map((item, index) => `${JSON.stringify(item.route)}:route${index}`).join(",")}};`);
  lines.push(`export const extensions = {${extensions.map(([id], index) => `${JSON.stringify(id)}:extension${index}`).join(",")}};`);
  return `${lines.join("\n")}\n`;
}

async function buildModule(module) {
  const target = assertOutput(join(destination, module.id));
  const stage = assertOutput(`${target}.${process.pid}.building`);
  if (existsSync(stage)) throw new Error(`Stale module runtime staging directory: ${stage}`);
  mkdirSync(stage, { recursive: true });
  try {
    const routes = routesFor(module.id);
    const result = await build({
      absWorkingDir: web,
      stdin: { contents: entrySource(module, routes), loader: "ts", resolveDir: web },
      outfile: join(stage, "module.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "warning",
      metafile: true,
      banner: { js: 'import { createRequire as __portableCreateRequire } from "node:module"; const require = __portableCreateRequire(import.meta.url);' },
      external: ["@earendil-works/*", "@mariozechner/*"],
      plugins: [{
        name: "portable-host-capability-boundary",
        setup(plugin) {
          plugin.onResolve({ filter: /(?:^@\/lib\/|^\.\.?\/).*/ }, ({ path }) => {
            const basename = path.split("/").at(-1).replace(/\.[cm]?[jt]sx?$/u, "");
            if (hostCapabilitySet.has(basename)) return { path: `pi-own-host:${basename}`, external: true };
            return null;
          });
        },
      }],
    });
    const output = Object.values(result.metafile.outputs)[0];
    if (!output) throw new Error(`No runtime output for ${module.id}`);
    const externals = [...new Set(output.imports.filter((item) => item.external).map((item) => item.path))].sort();
    for (const item of externals) {
      if (item.startsWith("node:") || hostCapabilities.some((name) => item === `pi-own-host:${name}`)
        || /^@(?:earendil-works|mariozechner)\/pi-[a-z-]+(?:\/.*)?$/u.test(item)
        || /^[a-z][a-z_]*(?:\/[a-z_]+)?$/u.test(item)) continue;
      throw new Error(`Portable ${module.id} runtime has undeclared external module: ${item}`);
    }
    const extensionEntries = {};
    for (const id of Object.keys(module.extensions)) {
      const name = `extension-${id}.mjs`;
      writeFileSync(join(stage, name), `import { extensions } from "./module.mjs";\nconst factory = extensions[${JSON.stringify(id)}];\nif (typeof factory !== "function") throw new Error("Portable extension factory is missing: ${id}");\nexport default factory;\n`);
      extensionEntries[id] = name;
    }
    const names = ["module.mjs", ...Object.values(extensionEntries)];
    const files = names.map((path) => {
      const bytes = readFileSync(join(stage, path));
      return { path, contentHash: hash(bytes), bytes: bytes.byteLength };
    });
    const manifest = { format: "pi-own-portable-runtime/v1", moduleId: module.id,
      entry: "module.mjs", routes: routes.map((item) => item.route), extensionEntries,
      hostCapabilities: externals.filter((item) => item.startsWith("pi-own-host:")).map((item) => item.slice("pi-own-host:".length)),
      platformImports: externals.filter((item) => !item.startsWith("pi-own-host:")), files };
    writeFileSync(join(stage, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(target)) rmSync(assertOutput(target), { recursive: true, force: true });
    renameSync(stage, target);
    return manifest;
  } catch (error) {
    if (existsSync(stage)) rmSync(assertOutput(stage), { recursive: true, force: true });
    throw error;
  }
}

await copyDomainWorkflowBundles();
for (const module of modules) {
  const manifest = await buildModule(module);
  process.stdout.write(`${module.id}: ${manifest.routes.length} routes, ${Object.keys(manifest.extensionEntries).length} extensions, ${manifest.files.reduce((total, file) => total + file.bytes, 0)} bytes\n`);
}
