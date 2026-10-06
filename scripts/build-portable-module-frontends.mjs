import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(repository, "apps", "pi-web");
const destination = join(web, "runtime", "module-frontends");
const shims = join(web, "lib", "portable-frontend");
const definitions = [
  {
    id: "course-builder",
    pages: {
      "course-builder": "app/course-builder/page.tsx",
      lesson: "app/course-builder/lesson/page.tsx",
      "study-assets": "app/course-builder/study-assets/page.tsx",
    },
  },
  { id: "study-research", pages: { study: "app/study/page.tsx" } },
];

function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function slash(path) { return path.split(sep).join("/"); }
function replaceExactlyOnce(source, before, after, name) {
  if (source.split(before).length !== 2) throw new Error(`Portable PDF viewer source changed: ${name}`);
  return source.replace(before, after);
}
function addPortablePdfViewer(staging) {
  const publicRoot = join(web, "public");
  const html = replaceExactlyOnce(readFileSync(join(publicRoot, "pdf-viewer.html"), "utf8"), 'src="/pdf-viewer.mjs"', 'src="./pdf-viewer.mjs"', "script URL");
  writeFileSync(join(staging, "pdf-viewer.html"), html);
  let script = readFileSync(join(publicRoot, "pdf-viewer.mjs"), "utf8");
  script = replaceExactlyOnce(script, 'from "/api/pdfjs/build/pdf.min.mjs"', 'from "./pdfjs/build/pdf.min.mjs"', "PDF.js import");
  script = replaceExactlyOnce(script, 'GlobalWorkerOptions.workerSrc = "/api/pdfjs/build/pdf.worker.min.mjs";', 'GlobalWorkerOptions.workerSrc = new URL("./pdfjs/build/pdf.worker.min.mjs", import.meta.url).href;', "PDF.js worker");
  script = replaceExactlyOnce(script,
    'const response = await fetch(`/api/pdf-content?file=${encodeURIComponent(url.pathname + url.search)}`, { cache: "no-store" });\n  if (!response.ok) throw new Error(`读取 PDF 失败 (HTTP ${response.status})：${(await response.text()).slice(0, 500)}`);\n  const payload = await response.json();',
    'const payload = await portablePdfContent(file);', "PDF content bridge");
  for (const [name, path] of [["cmaps", "cmaps"], ["standard_fonts", "standard_fonts"], ["wasm", "wasm"], ["iccs", "iccs"]]) {
    script = replaceExactlyOnce(script, `/${"api/pdfjs"}/${path}/`, `./pdfjs/${name}/`, `${name} URL`);
  }
  script = `function portablePdfContent(file) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("Portable PDF content timed out")); }, 30000);
    function receive(event) {
      if (event.source !== parent || event.origin !== "null" || event.data?.type !== "pi-pdf-content-response" || event.data.file !== file || event.data.requestId !== requestId) return;
      clearTimeout(timeout); window.removeEventListener("message", receive);
      if (typeof event.data.error === "string") reject(new Error(event.data.error));
      else resolve(event.data.payload);
    }
    window.addEventListener("message", receive);
    parent.postMessage({ type: "pi-pdf-content-request", file, requestId }, "*");
  });
}
${script}`;
  writeFileSync(join(staging, "pdf-viewer.mjs"), script);
  const files = ["pdf-viewer.html", "pdf-viewer.mjs"];
  const sourceRoot = join(web, "node_modules", "pdfjs-dist");
  const addTree = (relativePath) => {
    const source = join(sourceRoot, relativePath);
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const next = join(relativePath, entry.name);
      if (entry.isDirectory()) addTree(next);
      else if (entry.isFile()) {
        const target = slash(join("pdfjs", next));
        mkdirSync(dirname(join(staging, target)), { recursive: true });
        writeFileSync(join(staging, target), readFileSync(join(sourceRoot, next)));
        files.push(target);
      } else throw new Error(`Portable PDF asset is not a regular file: ${next}`);
    }
  };
  for (const path of ["cmaps", "standard_fonts", "wasm", "iccs"]) addTree(path);
  for (const name of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
    const path = `pdfjs/build/${name}`;
    mkdirSync(dirname(join(staging, path)), { recursive: true });
    writeFileSync(join(staging, path), readFileSync(join(sourceRoot, "build", name)));
    files.push(path);
  }
  return files;
}
function assertGeneratedDirectory(path) {
  const resolved = resolve(path);
  if (!resolved.startsWith(`${resolve(destination)}${sep}`)) throw new Error(`Generated frontend path escaped its output root: ${resolved}`);
  return resolved;
}

async function buildModule(definition) {
  const target = assertGeneratedDirectory(join(destination, definition.id));
  const staging = assertGeneratedDirectory(`${target}.${process.pid}.building`);
  if (existsSync(staging)) throw new Error(`Stale frontend staging directory: ${staging}`);
  mkdirSync(staging, { recursive: true });
  try {
    const pages = new Map(Object.entries(definition.pages));
    const result = await build({
      absWorkingDir: web,
      entryPoints: [{ in: "portable-page:bundle", out: "module" }],
      entryNames: "assets/[name]-[hash]",
      chunkNames: "assets/chunk-[hash]",
      assetNames: "assets/resource-[hash]",
      outdir: staging,
      bundle: true,
      // Avoid hundreds of tiny syntax-highlighter and Mermaid chunks. Besides
      // slowing cold loads, each chunk would become a separate verified file
      // during cross-install, which is disastrous on cloud-backed filesystems.
      splitting: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      minify: true,
      metafile: true,
      logLevel: "warning",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "next/navigation": join(shims, "navigation.ts"),
        "next/link": join(shims, "link.tsx"),
        "next/image": join(shims, "image.tsx"),
        "@/components/mode-packs/ModePackOverlay": join(shims, "mode-overlay.tsx"),
        "@/components/PdfPreview": join(shims, "pdf-preview.tsx"),
      },
      plugins: [{
        name: "portable-module-pages",
        setup(plugin) {
          plugin.onResolve({ filter: /^portable-page:/ }, ({ path }) => ({ path, namespace: "portable-page" }));
          plugin.onLoad({ filter: /.*/, namespace: "portable-page" }, ({ path }) => {
            if (path !== "portable-page:bundle") throw new Error(`Unknown portable page bundle: ${path}`);
            const imports = [...pages].map(([name, page], index) => `import Page${index} from "${slash(join(web, page))}";`).join("\n");
            const pageMap = [...pages.keys()].map((name, index) => `${JSON.stringify(name)}:Page${index}`).join(",");
            return {
              loader: "tsx",
              resolveDir: web,
              contents: `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport { installPortableFrontendBridge } from "${slash(join(shims, "bridge.ts"))}";\nimport "${slash(join(shims, "base.css"))}";\n${imports}\nawait installPortableFrontendBridge();\nconst pages = {${pageMap}};\nconst page = document.documentElement.dataset.portablePage;\nconst Page = pages[page];\nif (!Page) throw new Error("Portable module page is unknown: " + page);\nconst root = document.getElementById("root");\nif (!root) throw new Error("Portable module root is missing");\ncreateRoot(root).render(React.createElement(Page));\n`,
            };
          });
        },
      }, {
        name: "portable-pdf-preview",
        setup(plugin) {
          plugin.onResolve({ filter: /^\.\/PdfPreview$/ }, ({ importer }) => {
            if (slash(importer).endsWith("/components/FileViewer.tsx")) return { path: join(shims, "pdf-preview.tsx") };
            return undefined;
          });
        },
      }],
    });
    const outputs = Object.entries(result.metafile.outputs);
    const entries = {};
    const output = outputs.find(([, meta]) => meta.entryPoint === "portable-page:portable-page:bundle" && meta.exports);
    if (!output) throw new Error(`Portable frontend entry was not generated: ${definition.id}`);
    const [js, meta] = output;
    const script = slash(relative(staging, resolve(web, js)));
    const css = meta.cssBundle ? slash(relative(staging, resolve(web, meta.cssBundle))) : null;
    for (const [name] of pages) {
      const html = `<!doctype html><html lang="zh-CN" data-portable-page="${name}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css ? `<link rel="stylesheet" href="./${css}">` : ""}<script type="module" src="./${script}"></script></head><body><div id="root"></div></body></html>\n`;
      writeFileSync(join(staging, `${name}.html`), html);
      entries[name] = `${name}.html`;
    }
    for (const [path, meta] of outputs) {
      for (const item of meta.imports ?? []) if (item.external) throw new Error(`Portable frontend has an external module import: ${path} -> ${item.path}`);
    }
    const assets = [];
    const emitted = new Set([...outputs.map(([path]) => slash(relative(staging, resolve(web, path)))), ...Object.values(entries), ...addPortablePdfViewer(staging)]);
    for (const path of [...emitted].sort()) {
      if (path.startsWith("../") || path.startsWith("/") || path.includes("\\")) throw new Error(`Frontend output escaped staging: ${path}`);
      const compression = path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".css") ? "gzip" : null;
      const bytes = compression ? gzipSync(readFileSync(join(staging, path)), { level: 9, mtime: 0 }) : readFileSync(join(staging, path));
      if (compression) writeFileSync(join(staging, path), bytes);
      assets.push({ path, contentHash: digest(bytes), bytes: bytes.byteLength, ...(compression ? { contentEncoding: compression } : {}) });
    }
    const manifest = { format: "pi-own-portable-frontend/v1", moduleId: definition.id, entries, assets };
    writeFileSync(join(staging, "frontend-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(target)) rmSync(assertGeneratedDirectory(target), { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    // The runtime output is a reproducible build artifact and is never edited in place.
    renameSync(staging, target);
    return manifest;
  } catch (error) {
    if (existsSync(staging)) rmSync(assertGeneratedDirectory(staging), { recursive: true, force: true });
    throw error;
  }
}

for (const definition of definitions) {
  const manifest = await buildModule(definition);
  process.stdout.write(`${definition.id}: ${manifest.assets.length} assets, ${manifest.assets.reduce((total, asset) => total + asset.bytes, 0)} bytes\n`);
}
