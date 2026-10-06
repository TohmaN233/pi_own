import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validatePortableWorkflowPackage } from "pi-caw/lib/workbench-api.mjs";
import { bundledDomainWorkflowsDirectory } from "./mode-pack-paths";

interface BundleEntry { id: string; path: string; revisionHash: string; sha256: string }
interface VerifiedBundle extends BundleEntry { packagePath: string }
type Command = (operation: string, args: Record<string, unknown>) => Promise<unknown>;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const pin = /^[a-f0-9]{64}$/;
const idPattern = /^[a-z][a-z0-9-]{0,127}$/;

async function physicalFile(path: string, limit: number): Promise<Buffer> {
  // Refuse directory links as well as file links; lexical confinement alone is insufficient.
  let cursor = resolve(path);
  for (;;) {
    const entry = await lstat(cursor);
    if (entry.isSymbolicLink()) throw new Error(`Bundled Workflow path contains a symbolic link: ${cursor}`);
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit) throw new Error(`Bundled Workflow file is not a bounded physical file: ${path}`);
  const bytes = await readFile(path), after = await lstat(path);
  if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.isSymbolicLink()) throw new Error(`Bundled Workflow file changed while reading: ${path}`);
  return bytes;
}

/** Verify the complete manifest before dispatching any installation. No model or graph execution. */
export async function readBundledDomainWorkflows(directory = bundledDomainWorkflowsDirectory()): Promise<VerifiedBundle[]> {
  const root = resolve(directory), bytes = await physicalFile(join(root, "manifest.json"), 128 * 1024);
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest?.version !== 1 || !Array.isArray(manifest.workflows) || manifest.workflows.length < 1 || manifest.workflows.length > 64
    || Object.keys(manifest).some(key => !["version", "workflows"].includes(key))) throw new Error("Invalid bundled Workflow manifest");
  const ids = new Set<string>(), paths = new Set<string>();
  const entries: VerifiedBundle[] = [];
  for (const entry of manifest.workflows as BundleEntry[]) {
    if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => !["id", "path", "revisionHash", "sha256"].includes(key))
      || !idPattern.test(entry.id) || typeof entry.path !== "string" || entry.path !== `${entry.id}.workflow.json`
      || !pin.test(entry.revisionHash) || !pin.test(entry.sha256) || ids.has(entry.id) || paths.has(entry.path)) throw new Error("Invalid or duplicate bundled Workflow manifest entry");
    ids.add(entry.id); paths.add(entry.path);
    const packagePath = resolve(root, entry.path), local = relative(root, packagePath);
    if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error("Bundled Workflow package escapes its project directory");
    const source = await physicalFile(packagePath, 70 * 1024 * 1024);
    if (relative(await realpath(root), await realpath(packagePath)) !== local || hash(source) !== entry.sha256) throw new Error(`Bundled Workflow package hash or physical path differs: ${entry.id}`);
    const checked = validatePortableWorkflowPackage(JSON.parse(source.toString("utf8")));
    if (checked.package.id !== entry.id || checked.snapshot.workflow.id !== entry.id || checked.snapshot.revision_hash !== entry.revisionHash
      || checked.snapshot.workflow.status !== "ready") throw new Error(`Bundled Workflow package identity or Ready revision differs: ${entry.id}`);
    entries.push({ ...entry, packagePath });
  }
  return entries;
}

function catalog(value: unknown): Array<{ id: string; revision_hash: string }> {
  if (!Array.isArray(value) || value.some(row => !row || typeof row.id !== "string" || typeof row.revision_hash !== "string")
    || new Set(value.map(row => row.id)).size !== value.length) throw new Error("Invalid private Workflow catalog during bundled installation");
  return value;
}

export async function installMissingBundledDomainWorkflows(entries: readonly VerifiedBundle[], requiredIds: readonly string[], command: Command): Promise<{ installed: string[]; preserved: string[] }> {
  const selection = requiredIds.map(id => { const entry = entries.find(item => item.id === id); if (!entry) throw new Error(`Required bundled Workflow is missing: ${id}`); return entry; });
  if (new Set(requiredIds).size !== requiredIds.length) throw new Error("Duplicate required bundled Workflow IDs");
  const rows = catalog(await command("list", {})), installed: string[] = [], preserved: string[] = [];
  for (const entry of selection) {
    if (rows.some(row => row.id === entry.id)) { preserved.push(entry.id); continue; }
    try {
      const result = await command("install_workflow_package", { package_path: entry.packagePath, expected_sha256: entry.sha256 }) as { workflow?: { id: string }; revision_hash?: string };
      if (result?.workflow?.id !== entry.id || result.revision_hash !== entry.revisionHash) throw new Error(`Installed bundled Workflow identity differs: ${entry.id}`);
      installed.push(entry.id);
    } catch (error) {
      if ((error as { code?: string }).code !== "WORKFLOW_EXISTS") throw error;
      // The store's writer lock refused a concurrent creation. Preserve it, including a user edit.
      if (!catalog(await command("list", {})).some(row => row.id === entry.id)) throw new Error(`Concurrent bundled Workflow installation cannot be reconciled: ${entry.id}`, { cause: error });
      preserved.push(entry.id);
    }
  }
  return { installed, preserved };
}

/** Startup is order independent: readiness is queried synchronously or announced by Pi-CAW later. */
export function registerBundledDomainWorkflowInstaller(pi: Pick<ExtensionAPI, "events" | "sendMessage">, requiredIds: readonly string[], options: { directory?: string } = {}) {
  type State = { sessionId: string; verified: Promise<VerifiedBundle[]>; pending?: Promise<void>; error?: Error; available: boolean; reported: boolean };
  let state: State | undefined, disposed = false;
  const report = (current: State, error: Error) => {
    current.error = error;
    if (disposed || state !== current || current.reported) return;
    current.reported = true;
    console.error("[bundled-domain-workflows] unavailable", { sessionId: current.sessionId, workflowIds: requiredIds, error });
    pi.sendMessage({ customType: "bundled-domain-workflows-unavailable", content: `默认 Workflow 暂不可用：${error.message}`, display: true }, { triggerTurn: false });
  };
  const command = (current: State): Command => (operation, args) => new Promise((resolveResult, reject) => {
    if (disposed || state !== current) { reject(new Error("Bundled Workflow installer session changed")); return; }
    const timer = setTimeout(() => reject(new Error(`Bundled Workflow Host command timed out: ${operation}`)), 120000);
    try { pi.events.emit("pi-caw:host-command", { session_id: current.sessionId, operation, args,
      resolve: (result: unknown) => { clearTimeout(timer); resolveResult(result); }, reject: (error: unknown) => { clearTimeout(timer); reject(error); } }); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
  const begin = (current: State) => {
    if (disposed || current !== state || current.pending || current.error) return;
    current.pending = (async () => {
      const entries = await current.verified;
      const result = await installMissingBundledDomainWorkflows(entries, requiredIds, command(current));
      if (disposed || current !== state) return;
      current.available = true;
      console.info("[bundled-domain-workflows] reconciled", { sessionId: current.sessionId, ...result });
    })().catch(error => report(current, error instanceof Error ? error : new Error(String(error))));
  };
  const query = (current: State) => { const request = { session_id: current.sessionId, ready: false }; pi.events.emit("pi-caw:host-readiness", request); if (request.ready) begin(current); };
  const release = pi.events.on("pi-caw:host-ready", value => { const event = value as { session_id?: string }; if (state && event.session_id === state.sessionId) begin(state); });
  return {
    start(sessionId: string) {
      if (disposed) throw new Error("Bundled Workflow installer is disposed");
      const current: State = { sessionId, verified: readBundledDomainWorkflows(options.directory), available: false, reported: false };
      state = current;
      // Observe validation failures even when Pi-CAW has not initialized; keep the saved workspace open.
      void current.verified.catch(error => report(current, error instanceof Error ? error : new Error(String(error))));
      query(current);
    },
    async ensureAvailable(sessionId: string) {
      const current = state;
      if (disposed || !current || current.sessionId !== sessionId) throw new Error("Bundled Workflow installer requires its exact active session");
      await current.verified;
      if (!current.pending && !current.error) query(current);
      if (!current.pending && !current.error) report(current, new Error("Private pi-CAW Host bridge is unavailable; load the pi-CAW extension"));
      await current.pending;
      if (current.error) throw current.error;
      if (!current.available) throw new Error("Bundled Workflow installation did not complete");
    },
    dispose() { disposed = true; state = undefined; release(); },
  };
}
