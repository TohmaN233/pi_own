import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Build the immutable built-in Code Mode payload during packaging. Runtime code
 * imports this asset directly and never reaches back into a source checkout. */
export async function buildPortableCodeModeArchive(outputRoot = resolve(repository, "apps", "pi-web", "runtime")) {
  const runtime = resolve(outputRoot);
  const outputName = basename(runtime);
  if (outputName !== "runtime" && !outputName.startsWith(".study-runtime-build-")) {
    throw new Error("Portable Code archive output must be an owned runtime directory");
  }
  const output = resolve(runtime, "mode-packs", "coding.archive.json");
  if (!output.startsWith(`${runtime}\\`) && !output.startsWith(`${runtime}/`)) throw new Error("Portable Code archive output escapes runtime directory");
  const source = await createJiti(import.meta.url, { tsconfigPaths: true }).import(resolve(repository, "apps", "pi-web", "lib", "bundled-code-mode-package-source.ts"));
  if (!source || typeof source !== "object" || typeof source.bundledCodeModePackage !== "function") throw new Error("Portable Code archive source builder is unavailable");
  const archive = source.bundledCodeModePackage();
  const serialized = `${JSON.stringify(archive)}\n`;
  await mkdir(dirname(output), { recursive: true });
  const current = await readFile(output, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (current === serialized) return { output, packageContentHash: archive.packageContentHash, changed: false };
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, serialized, { flag: "wx" });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return { output, packageContentHash: archive.packageContentHash, changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildPortableCodeModeArchive(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.info(`Portable Code archive built: ${result.output} (${result.packageContentHash})`);
}
