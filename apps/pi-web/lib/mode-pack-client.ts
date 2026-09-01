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
  packs: ModePackStatusItem[];
  resources: unknown[];
  diagnostics: Array<{ severity: "warning" | "error"; source: string | null; message: string }>;
}

export interface ModePackLibraryItem {
  definition: Record<string, unknown>;
  draft: Record<string, unknown>;
  builtin: boolean;
  selectable: boolean;
  missingRequiredResources: string[];
  missingOptionalResources: string[];
  identityMismatches: string[];
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
  return requestJson("/api/mode-packs/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

export function getModePackLibrary(sessionId: string): Promise<{
  sessionId: string;
  cwd: string;
  packs: ModePackLibraryItem[];
  resources: Array<Record<string, unknown>>;
  diagnostics: ModePackStatusResponse["diagnostics"];
}> {
  return requestJson(`/api/mode-packs?sessionId=${encodeURIComponent(sessionId)}`);
}

export function saveModePack(options: {
  sessionId: string;
  draft: unknown;
  expectedRevision: number;
}): Promise<{ definition: Record<string, unknown>; draft: Record<string, unknown> }> {
  return requestJson("/api/mode-packs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

export function deleteModePack(options: {
  modePackId: string;
  expectedRevision: number;
}): Promise<{ deleted: true; modePackId: string }> {
  return requestJson("/api/mode-packs", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}
