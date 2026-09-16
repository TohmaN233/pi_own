import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A relocatable ordinary-Node worker; it does not need tsx or any source-tree packages at runtime. */
export async function buildStudyWorker(outputRoot = join(repository, "apps", "pi-web", "runtime")) {
  outputRoot = resolve(outputRoot);
  if (basename(outputRoot) !== "runtime") throw new Error("Study worker output must be an owned runtime directory");
  await mkdir(dirname(outputRoot), { recursive: true });
  const parent = await realpath(dirname(outputRoot));
  outputRoot = join(parent, "runtime");
  const existing = await lstat(outputRoot).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Study worker runtime must be a real directory");
  const staging = await mkdtemp(join(parent, ".study-runtime-build-"));
  try {
  const directory = join(staging, "packages", "study-execution-host", "src");
  await mkdir(directory, { recursive: true });
  const output = join(directory, "study-execution-coordinator.mjs");
  const result = await build({ entryPoints: [join(repository, "scripts", "study-execution-coordinator.mjs")],
    outfile: output, bundle: true, platform: "node", target: "node22.19", format: "esm", metafile: true, logLevel: "warning" });
  for (const entry of Object.values(result.metafile.outputs)) for (const dependency of entry.imports) {
    if (dependency.external && !isBuiltin(dependency.path)) throw new Error(`Study worker retained an unpackaged runtime dependency: ${dependency.path}`);
  }
  for (const asset of ["windows-runner.cs", "r-appcontainer-launcher.c", "environment-package-supervisor.cs"])
    await copyFile(join(repository, "packages", "study-execution-host", "src", asset), join(directory, asset));
  const environmentDirectory = join(staging, "packages", "study-environment", "src");
  await mkdir(environmentDirectory, { recursive: true });
  await copyFile(join(repository, "packages", "study-execution-host", "src", "environment-package-supervisor.cs"), join(environmentDirectory, "environment-package-supervisor.cs"));
  const environmentResult = await build({ entryPoints: [join(repository, "scripts", "study-environment-worker.mjs")],
    outfile: join(environmentDirectory, "study-environment-worker.mjs"), bundle: true, platform: "node", target: "node22.19", format: "esm", metafile: true, logLevel: "warning" });
  for (const entry of Object.values(environmentResult.metafile.outputs)) for (const dependency of entry.imports) {
    if (dependency.external && !isBuiltin(dependency.path)) throw new Error(`Environment worker retained an unpackaged dependency: ${dependency.path}`);
  }
  const agentDirectory = join(staging, "packages", "study-agent", "src");
  await mkdir(agentDirectory, { recursive: true });
  const agentOutput = join(agentDirectory, "study-agent-worker.mjs");
  const agentResult = await build({ entryPoints: [join(repository, "scripts", "study-agent-worker.mjs")], outfile: agentOutput,
    bundle: true, platform: "node", target: "node22.19", format: "esm", metafile: true, logLevel: "warning",
    external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "typebox", "typebox/*"] });
  const packagedDependencies = new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "typebox"]);
  const appManifest = JSON.parse(await readFile(join(repository, "apps", "pi-web", "package.json"), "utf8"));
  for (const entry of Object.values(agentResult.metafile.outputs)) for (const dependency of entry.imports) {
    const packageName = dependency.path.startsWith("typebox/") ? "typebox" : dependency.path;
    if (dependency.external && !isBuiltin(dependency.path) && (!packagedDependencies.has(packageName) || !appManifest.dependencies[packageName]))
      throw new Error(`Study agent worker retained an undeclared installed dependency: ${dependency.path}`);
  }
  // Bundled import.meta.url stays three levels below runtime/skills, matching the existing Skill resolver.
  await cp(join(repository, "skills"), join(staging, "skills"), { recursive: true, dereference: false });
  await writeFile(join(staging, "study-worker-build.json"), JSON.stringify({ version: 1, entry: "packages/study-execution-host/src/study-execution-coordinator.mjs",
    node: ">=22.19.0", externalDependencies: "node builtins only", sourceFiles: Object.keys(result.metafile.inputs).sort(),
    agentEntry: "packages/study-agent/src/study-agent-worker.mjs", agentDependencies: [...packagedDependencies],
    environmentEntry: "packages/study-environment/src/study-environment-worker.mjs",
    environmentSourceFiles: Object.keys(environmentResult.metafile.inputs).sort(),
    agentSourceFiles: Object.keys(agentResult.metafile.inputs).sort() }, null, 2));
  if (!(await readFile(output, "utf8")).trim()) throw new Error("Study worker bundle is empty");
  // Only the verified runtime child is replaced, after a complete successful build.
  await rm(outputRoot, { recursive: true, force: true });
  await rename(staging, outputRoot);
  return { outputRoot, output: join(outputRoot, "packages", "study-execution-host", "src", "study-execution-coordinator.mjs") };
  } finally {
    if (dirname(staging) !== parent || !basename(staging).startsWith(".study-runtime-build-")) throw new Error("Invalid build cleanup path");
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const built = await buildStudyWorker(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.info(`Study worker bundled: ${built.output}`);
}
