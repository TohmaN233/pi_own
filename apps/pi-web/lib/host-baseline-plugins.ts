import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import * as tui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import { createJiti } from "jiti/static";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory, InlineExtension, LoadExtensionsResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { assertHostPluginInstalled, hostPluginDirectory, isHostPluginEnabled, type HostPluginId } from "./host-plugin-settings";
import { createHostSubagentFactory } from "./mode-extension-loader";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import type { ResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";
import { studyModePhaseForSnapshot } from "./study-mode-policy";
import { hasModeWorkflowScope, modeWorkflowScope, writeModeWorkflowSettings, type WorkflowCatalogEntry } from "./mode-workflow-settings";

const LEGACY_LEARNER_PROFILES = new Set(["student-learn", "practice", "teach-back", "visual-lab"]);
export function learningWorkflowScope(snapshot?: ResourceSnapshot): boolean {
  return Boolean(snapshot && (studyModePhaseForSnapshot(snapshot)
    || (!snapshot.packageContentHash && snapshot.role === "student" && LEGACY_LEARNER_PROFILES.has(snapshot.profileId))));
}

export const HOST_SUBAGENT_EXTENSION_PATH = "<inline:pi-web-subagents>";
export const HOST_BASELINE_EXTENSION_PATHS = [HOST_SUBAGENT_EXTENSION_PATH, "<inline:pi-web-ask>", "<inline:pi-web-context>", "<inline:pi-web-caw>"];
export const LEGACY_SUBAGENT_TOOL_NAMES = new Set(["Agent", "get_subagent_result", "steer_subagent"]);

export function hostBaselineToolNames(session: {
  getActiveToolNames(): string[];
  resourceLoader: { getExtensions(): { extensions: Array<{ path?: string; tools?: ReadonlyMap<string, unknown> }> } };
}): string[] {
  const active = new Set(session.getActiveToolNames());
  return registeredHostBaselineToolNames(session)
    .filter(name => (name !== "subagent" && name !== "subagents_enable") || active.has(name));
}

/** Registered capabilities include native tools that activate lazily. A tool
 * being dormant must not prevent its own loader from enabling it later. */
export function registeredHostBaselineToolNames(session: {
  resourceLoader: { getExtensions(): { extensions: Array<{ path?: string; tools?: ReadonlyMap<string, unknown> }> } };
}): string[] {
  return session.resourceLoader.getExtensions().extensions
    .filter(extension => HOST_BASELINE_EXTENSION_PATHS.includes(extension.path ?? ""))
    .flatMap(extension => [...(extension.tools?.keys() ?? [])]);
}

/** Pi Web supplies the same interactive UI contract through its existing custom panel. */
export function webInteractiveExtensionApi(pi: ExtensionAPI, id?: HostPluginId): ExtensionAPI {
  const assertEnabled = () => {
    if (id && !isHostPluginEnabled(id)) throw new Error(`Host plugin was disabled or deleted: ${id}. Reload this conversation.`);
  };
  return {
    ...pi,
    registerTool: <T extends TSchema, D, S>(tool: ToolDefinition<T, D, S>) => pi.registerTool({
      ...tool,
      ...(tool.name === "ask_user" ? { promptGuidelines: [
        "Ask only when missing information materially changes the result. Use existing answers and instructions first.",
        "Do not ask again for already authorized actions or routine reversible implementation choices.",
        "Use 1-3 concise questions. A cancelled question is not approval or an answer.",
      ] } : {}),
      execute: (callId, params, signal, update, ctx) => {
        assertEnabled();
        return tool.execute(callId, params, signal, update, { ...ctx, mode: "tui" });
      },
    }),
    registerCommand: (name, command) => pi.registerCommand(name, {
      ...command,
      handler: (args, ctx) => { assertEnabled(); return command.handler(args, { ...ctx, mode: "tui" }); },
    }),
  };
}

async function interactiveFactory(id: Exclude<HostPluginId, "pi-subagents" | "@ff-labs/pi-fff">, learningScope = false, snapshot?: ResourceSnapshot): Promise<ExtensionFactory> {
  assertHostPluginInstalled(id);
  const loader = createJiti(import.meta.url, {
    moduleCache: false, fsCache: false, tryNative: false,
    virtualModules: { "@earendil-works/pi-coding-agent": codingAgent, "@earendil-works/pi-ai": ai, "@earendil-works/pi-tui": tui, typebox },
  });
  const entry = id === "pi-caw" ? ["extensions", "pi-caw.ts"] : ["src", "index.ts"];
  const factory = await loader.import(join(hostPluginDirectory(id), ...entry), { default: true });
  if (typeof factory !== "function") throw new Error(`Invalid Host plugin factory: ${id}`);
  return (pi) => {
    if (id === "pi-caw" && hasModeWorkflowScope(snapshot)) {
      let sessionId: string | undefined;
      let catalog: WorkflowCatalogEntry[] = [];
      pi.on("session_start", (_event, ctx) => { sessionId = ctx.sessionManager.getSessionId(); });
      const scope = () => {
        if (!snapshot || !sessionId) throw new Error("Workflow mode binding is unavailable");
        const current = modeWorkflowScope(sessionId, snapshot, catalog);
        if (!current) throw new Error("Scoped Workflow mode adapter is unavailable");
        return current;
      };
      const releaseScope = pi.events.on("pi-caw:workflow-scope", (value: unknown) => {
        const request = value as { session_id: string; catalog?: WorkflowCatalogEntry[]; scope?: ReturnType<typeof modeWorkflowScope> };
        if (sessionId && request.session_id === sessionId) { catalog = request.catalog ?? []; request.scope = scope(); }
      });
      const releaseSetting = pi.events.on("pi-caw:workflow-setting", (value: unknown) => {
        const request = value as { session_id: string; mode_pack_id: string; workflow_id: string; enabled: boolean;
          expected_revision: number; expected_origin?: string; expected_snapshot_id?: string; resolve: (scope: ReturnType<typeof modeWorkflowScope>) => void; reject: (error: unknown) => void };
        if (!sessionId || request.session_id !== sessionId) return;
        void (async () => {
          const { getLiveModePackSnapshot } = await import("./rpc-manager");
          const { getLearningHarness } = await import("./harness-server");
          const current = getLearningHarness().findCurrentSession(sessionId!)?.snapshot ?? getLiveModePackSnapshot(sessionId!);
          if (!current || !snapshot || current.resourceSnapshotId !== snapshot.resourceSnapshotId || current.profileId !== snapshot.profileId
            || current.packageContentHash !== snapshot.packageContentHash) throw new Error("Workflow mode binding changed; reload Workbench");
          catalog = (request as typeof request & { catalog?: WorkflowCatalogEntry[] }).catalog ?? [];
          const currentScope = scope();
          if (request.mode_pack_id !== currentScope.mode_pack_id || request.expected_origin !== currentScope.origin
            || request.expected_snapshot_id !== currentScope.snapshot_id) throw new Error("Workflow mode identity conflict; reload Workbench");
          writeModeWorkflowSettings(sessionId!, snapshot, [{ id: request.workflow_id, enabled: request.enabled }], request.expected_revision, catalog);
          return scope();
        })().then(request.resolve, request.reject);
      });
      const releaseAdmission = pi.events.on("pi-caw:execution-admission", (value: unknown) => {
        const request = value as { session_id: string; operation: string; args: Record<string, unknown>; required?: boolean;
          workflow_id?: string; revision_hash?: string; workflow?: unknown; host_tool_contracts?: unknown;
          authorize?: Promise<{ authorized: true; session_id: string; operation: string }>; error?: Error };
        if (!sessionId || request.session_id !== sessionId) return;
        request.required = true;
        request.authorize = (async () => {
          if (!isHostPluginEnabled("pi-caw")) throw new Error("Host plugin was disabled: pi-caw");
          if (request.operation === "run") {
            if (!scope().enabled_workflow_ids.includes(request.workflow_id ?? "")) throw new Error(`Workflow is disabled in the current conversation: ${request.workflow_id}`);
            if (request.workflow_id === "study-explanation") {
              const { assertStudyWorkflowRunScope } = await import("./study-workflow-tasks");
              await assertStudyWorkflowRunScope(sessionId!, { ...request.args, workflow_id: request.workflow_id,
                revision_hash: request.revision_hash, workflow: request.workflow, host_tool_contracts: request.host_tool_contracts });
            } else if (request.workflow_id === "course-production") {
              const { assertCourseProductionRunScope } = await import("./course-workflow-tasks");
              await assertCourseProductionRunScope(sessionId!, { ...request.args, workflow_id: request.workflow_id, revision_hash: request.revision_hash });
            }
          }
          return { authorized: true as const, session_id: sessionId!, operation: request.operation };
        })();
      });
      const releaseRegistryRequirement = pi.events.on("pi-caw:host-tools", (value: unknown) => {
        const request = value as { session_id: string; execution_admission_required?: boolean };
        if (sessionId && request.session_id === sessionId) request.execution_admission_required = true;
      });
      pi.on("session_shutdown", () => { releaseAdmission(); releaseRegistryRequirement(); releaseScope(); releaseSetting(); });
    }
    if (id === "pi-caw") {
      // Keep the native /caw command usable in the web chat without opening Chrome.
      const unsubscribe = pi.events.on("pi-caw:open-workbench", (data: unknown) => {
        const url = (data as { url?: unknown })?.url;
        if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/#(?:[a-f0-9]{64})$/u.test(url)) throw new Error("Invalid pi-CAW Workbench URL");
        pi.sendMessage({ customType: "pi-caw:workbench", content: `[打开 pi-CAW Workbench](${url})`, display: true }, { triggerTurn: false });
      });
      pi.on("session_shutdown", () => { unsubscribe(); });
    }
    const api = webInteractiveExtensionApi(pi, id);
    const scopedApi: ExtensionAPI = { ...api, registerTool: tool => api.registerTool({ ...tool,
      ...(tool.name === "caw" && learningScope ? { description: "Workflow control plane: route enabled Ready candidates, execute selected Workflows, manage Runs and open Workbench. Mode defaults are editable preferences; all installed Workflows remain selectable. For study-explanation use study_workflow prepare/start to bind the selected sources and question. Each domain tool enforces its own task, source and answer contract." } : {}),
      execute: (callId, params, signal, update, ctx) => {
        if (tool.name === "caw") {
          const action = (params as { action: string }).action;
          if (["set_mode_workflow_enabled", "set_workflow_enabled"].includes(action)) throw new Error("Workflow combination changes require the human Mode Settings or Workbench control");
        }
        return tool.execute(callId, params, signal, update, ctx);
      },
    }) };
    return factory(id === "pi-caw" ? scopedApi : api);
  };
}

export async function createHostBaselineExtensions(options: {
  tools: boolean;
  modeScope?: string;
  permissionEntry?: string;
  snapshot?: ResourceSnapshot;
  modePackOwnsCeiling?: boolean;
}): Promise<InlineExtension[]> {
  const extensions: InlineExtension[] = [];
  const learningScope = learningWorkflowScope(options.snapshot);
  // The SDK retains these factories across reloads. Read current switches when
  // each factory runs so the settings UI can both enable and disable a plugin.
  if (options.tools && !learningScope) {
    extensions.push({ name: "pi-web-subagents", hidden: true, factory: async pi => {
      if (!isBuiltInSubagentsEnabled() || !isHostPluginEnabled("pi-subagents")) return;
      const factory = await createHostSubagentFactory(options.permissionEntry, options.modeScope, options.modePackOwnsCeiling);
      return factory(webInteractiveExtensionApi(pi, "pi-subagents"));
    } });
  }
  for (const [id, name, eligible] of [
    ["@eko24ive/pi-ask", "pi-web-ask", options.tools],
    ["pi-context-usage", "pi-web-context", true],
    ["pi-caw", "pi-web-caw", options.tools && Boolean(options.snapshot)],
  ] as const) {
    if (!eligible) continue;
    extensions.push({ name, hidden: true, factory: async pi => {
      if (!isHostPluginEnabled(id)) return;
      return (await interactiveFactory(id, learningScope, options.snapshot))(pi);
    } });
  }
  return extensions;
}

/** Identity-based ownership, independent of tool spelling. Never run two schedulers. */
export function preferHostBaselinePlugins(base: LoadExtensionsResult): LoadExtensionsResult {
  const owners = new Map<HostPluginId, string>([
    ["pi-subagents", HOST_SUBAGENT_EXTENSION_PATH], ["@eko24ive/pi-ask", "<inline:pi-web-ask>"], ["pi-context-usage", "<inline:pi-web-context>"], ["pi-caw", "<inline:pi-web-caw>"],
  ]);
  const removed = new Set<string>();
  for (const extension of base.extensions) {
    const normalized = extension.path.replaceAll("\\", "/");
    for (const [id, owner] of owners) {
      if (extension.path === owner || !base.extensions.some((candidate) => candidate.path === owner)) continue;
      if (normalized.includes(`/node_modules/${id}/`) || normalized.endsWith(`/node_modules/${id}`)
        || extension.sourceInfo?.source?.replace(/^npm:/u, "").startsWith(`${id}@`)) removed.add(extension.path);
    }
  }
  const oldOwners = base.extensions.filter((extension) => extension.path !== HOST_SUBAGENT_EXTENSION_PATH
    && [...LEGACY_SUBAGENT_TOOL_NAMES].some((name) => extension.tools.has(name)));
  if (oldOwners.length) throw new Error(`Obsolete subagent implementation is still loaded: ${oldOwners.map((extension) => extension.path).join(", ")}`);
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !removed.has(extension.path)),
    errors: base.errors.filter((error) => ![...removed].some((path) => error.error.endsWith(`conflicts with ${path}`))),
  };
}
