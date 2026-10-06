import { notifySessionConfiguration } from "./session-configuration-events";

export interface ModePackStatusItem {
  modePackId: string;
  title: string;
  description: string;
  category: string;
  builtin: boolean;
  revision: number | null;
  selectable: boolean;
  missingRequiredResources: string[];
  missingOptionalResources: string[];
  identityMismatches: string[];
  packageError?: string;
}

export interface ModePackStatusResponse {
  kind: "learning" | "generic";
  sessionId: string;
  cwd: string | null;
  currentModePackId: string | null;
  currentSnapshotId: string | null;
  live: boolean;
  busy: boolean;
  verified: boolean;
  activeTools: string[];
  expectedTools: string[];
  diagnostic: string | null;
  packageContentHash?: string | null;
  frontend?: { entry: string; presentation: "panel" | "workspace" } | null;
  frontendEntry?: string | null;
  runtimeId?: string | null;
  projectCapabilities?: string[];
  packs: ModePackStatusItem[];
  resources: unknown[];
  diagnostics: Array<{ severity: "warning" | "error"; source: string | null; message: string }>;
}

export interface ModePackLibraryItem {
  moduleId?: string;
  moduleProfileIds?: string[];
  packageMetadataError?: string;
  definition: Record<string, unknown>;
  draft: Record<string, unknown>;
  builtin: boolean;
  selectable: boolean;
  missingRequiredResources: string[];
  missingOptionalResources: string[];
  identityMismatches: string[];
  packageError?: string;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Mode Pack request failed: HTTP ${response.status}`);
  return body;
}

export function getModePackStatus(sessionId: string): Promise<ModePackStatusResponse> {
  return requestJson(`/api/mode-packs/status?sessionId=${encodeURIComponent(sessionId)}`);
}

/** Restore a persisted ordinary Pi session without sending a model prompt. */
export function resumePiSession(sessionId: string): Promise<{ success: true; data: unknown }> {
  return requestJson(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "get_state" }),
  });
}

export function activateModePack(options: {
  sessionId: string;
  modePackId: string;
  expectedSnapshotId: string | null;
  idempotencyKey: string;
  modePackDraft?: unknown;
}): Promise<{
  kind: "learning" | "generic";
  sessionId: string;
  modePackId: string;
  resourceSnapshotId: string;
  bindingRevision: number;
  replay: boolean;
  verified?: boolean;
}> {
  return requestJson<Awaited<ReturnType<typeof activateModePack>>>("/api/mode-packs/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  }).then((result) => { notifySessionConfiguration(options.sessionId); return result; });
}

export function getModePackLibrary(sessionId: string): Promise<{
  sessionId: string;
  cwd: string;
  packs: ModePackLibraryItem[];
  resources: Array<Record<string, unknown>>;
  packageResources: Array<{ kind: "skill" | "extension"; id: string; title: string; packageContentHash: string; packageTitle: string; contentHash: string; delivery: string }>;
  diagnostics: ModePackStatusResponse["diagnostics"];
}> {
  return requestJson(`/api/mode-packs?sessionId=${encodeURIComponent(sessionId)}`);
}

export function saveModePack(options: {
  sessionId: string;
  draft: unknown;
  expectedRevision: number;
  sourceModePackId?: string;
  resourceSources?: Array<{ kind: "skill" | "extension"; id: string; packageContentHash: string }>;
}): Promise<{ definition: Record<string, unknown>; draft: Record<string, unknown> }> {
  return requestJson("/api/mode-packs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

export function deleteModePack(options: {
  modePackId: string;
  expectedRevision?: number;
  expectedRevisions?: Record<string, number>;
}): Promise<{ deleted: true; modePackId: string }> {
  return requestJson("/api/mode-packs", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

export class PortableModePackImportError extends Error {
  constructor(
    message: string,
    readonly details: {
      code?: string;
      agentPrompt?: string;
      agentDelivery?: "accepted" | "failed";
      agentDeliveryError?: string;
    },
  ) {
    super(message);
    this.name = "PortableModePackImportError";
  }
}

export async function importModePackArchive(options: {
  sessionId: string;
  archive: unknown;
  newModePackId: string;
  expectedRevision?: number;
}): Promise<{ definition: Record<string, unknown> }> {
  const response = await fetch("/api/mode-packs/portable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...options, expectedRevision: options.expectedRevision ?? 0 }),
  });
  const body = await response.json() as {
    definition?: Record<string, unknown>;
    error?: string;
    code?: string;
    agentPrompt?: string;
    agentDelivery?: "accepted" | "failed";
    agentDeliveryError?: string;
  };
  if (!response.ok || !body.definition) {
    throw new PortableModePackImportError(body.error ?? "Import failed", {
      code: body.code,
      agentPrompt: body.agentPrompt,
      agentDelivery: body.agentDelivery,
      agentDeliveryError: body.agentDeliveryError,
    });
  }
  notifySessionConfiguration(options.sessionId);
  return { definition: body.definition };
}

export async function importModePackBundle(options: {
  sessionId: string;
  file: File;
  newModePackId: string;
  expectedRevision?: number;
}): Promise<{ definition: Record<string, unknown> }> {
  const parameters = new URLSearchParams({ sessionId: options.sessionId, newModePackId: options.newModePackId, expectedRevision: String(options.expectedRevision ?? 0) });
  const response = await fetch(`/api/mode-packs/portable?${parameters}`, {
    method: "POST",
    headers: { "Content-Type": "application/vnd.pi-own.mode-pack+tar" },
    body: options.file,
  });
  const body = await response.json() as {
    definition?: Record<string, unknown>; error?: string; code?: string; agentPrompt?: string;
    agentDelivery?: "accepted" | "failed"; agentDeliveryError?: string;
  };
  if (!response.ok || !body.definition) throw new PortableModePackImportError(body.error ?? "Import failed", {
    code: body.code, agentPrompt: body.agentPrompt, agentDelivery: body.agentDelivery, agentDeliveryError: body.agentDeliveryError,
  });
  notifySessionConfiguration(options.sessionId);
  return { definition: body.definition };
}

export async function sendPortableImportPrompt(sessionId: string, message: string): Promise<void> {
  await requestJson(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", message, streamingBehavior: "followUp" }),
  });
}


/** Convert the server's immutable definition back to the strict editable
 * draft shape. Definitions deliberately carry content/version identities that
 * `parseModePackDraft` rejects, so imported packages must never be placed in
 * the editor verbatim. */
export function modePackDefinitionToDraft(definition: Record<string, unknown>): Record<string, unknown> {
  const components = definition.components;
  if (!Array.isArray(components)) throw new Error("Imported Mode Pack definition has invalid components");
  const componentDrafts = components.map((component, index) => {
    if (!component || typeof component !== "object" || Array.isArray(component)) throw new Error(`Imported Mode Pack component ${index} is invalid`);
    const value = component as Record<string, unknown>;
    const draft: Record<string, unknown> = {
      type: value.type,
      id: value.id,
      required: value.required,
      enabled: value.enabled,
    };
    if (value.delivery !== undefined) draft.delivery = value.delivery;
    return draft;
  });
  const draft: Record<string, unknown> = {
    version: definition.version,
    modePackId: definition.modePackId,
    revision: definition.revision,
    title: definition.title,
    description: definition.description,
    category: definition.category,
    role: definition.role,
    runtimeMode: definition.runtimeMode,
    provider: definition.provider,
    model: definition.model,
    thinkingLevel: definition.thinkingLevel,
    externalKnowledgePolicy: definition.externalKnowledgePolicy,
    courseRequired: definition.courseRequired,
    tools: definition.tools,
    components: componentDrafts,
    systemPrompt: definition.systemPrompt,
    ...(definition.systemPromptMode ? { systemPromptMode: definition.systemPromptMode } : {}),
    instructions: definition.instructions,
  };
  if (definition.packageContentHash !== undefined) draft.packageContentHash = definition.packageContentHash;
  return draft;
}
