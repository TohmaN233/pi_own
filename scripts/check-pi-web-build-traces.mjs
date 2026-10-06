import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ROUTE_TRACE_FILES = 20_000;
const HOST_USER_PATH = /(?:^|[/\\])[A-Za-z]:[/\\]Users[/\\]/iu;
const HOST_TEMP_PATH = /(?:^|[/\\])AppData[/\\]Local[/\\]Temp[/\\]/iu;

async function tracePaths(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await tracePaths(path));
    else if (entry.isFile() && entry.name.endsWith(".nft.json")) paths.push(path);
  }
  return paths;
}

/** Reject accidental packaging of the build host's files, including cases
 * where Node file tracing statically evaluates a runtime-only directory. */
export async function checkPiWebBuildTraces(serverDirectory, maxFiles = MAX_ROUTE_TRACE_FILES) {
  const traces = await tracePaths(serverDirectory);
  if (traces.length === 0) throw new Error(`No Next server build traces found in ${serverDirectory}`);
  let largest = { path: "", count: 0 };
  for (const tracePath of traces) {
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    if (!Array.isArray(trace.files) || trace.files.some((file) => typeof file !== "string")) {
      throw new Error(`Invalid Next build trace: ${tracePath}`);
    }
    if (trace.files.length > largest.count) largest = { path: tracePath, count: trace.files.length };
    if (trace.files.length > maxFiles) {
      throw new Error(`Next build trace contains ${trace.files.length} files (limit ${maxFiles}): ${tracePath}`);
    }
    const leaked = trace.files.find((file) => HOST_USER_PATH.test(file) || HOST_TEMP_PATH.test(file));
    if (leaked) throw new Error(`Next build trace includes a build-host user file: ${tracePath} → ${leaked}`);
  }
  return {
    traces: traces.length,
    largest: { path: relative(serverDirectory, largest.path), files: largest.count },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/pi-web/.next/server");
  try {
    const result = await checkPiWebBuildTraces(serverDirectory);
    console.log(`Next build traces verified: ${result.traces} traces; largest ${result.largest.path} (${result.largest.files} files)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
