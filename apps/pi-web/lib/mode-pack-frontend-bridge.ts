export const MODE_PACK_FRONTEND_CHANNEL = "pi-own-mode-pack";

export interface ModePackFrontendContext {
  sessionId: string;
  snapshotId: string;
  packageContentHash: string;
  nonce: string;
  entry: string;
  parentOrigin: string;
  runtimeId?: string;
}

export interface SpecKitFrontendStatus {
  state: "ready" | "uninitialized" | "partial";
  initialized: boolean;
  missingCommands: string[];
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}

function entryPath(entry: string): string {
  const segments = required(entry, "frontend entry").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes(":"))) {
    throw new Error("frontend entry must be a canonical relative slash path");
  }
  return segments.map(encodeURIComponent).join("/");
}

export function frontendContextKey(context: ModePackFrontendContext): string {
  return `${context.sessionId}\0${context.packageContentHash}\0${context.snapshotId}\0${context.nonce}\0${context.entry}\0${context.parentOrigin}\0${context.runtimeId ?? ""}`;
}

/** The entry gets context as a query string; all relative assets retain their
 * original paths and bytes beneath the same route. */
export function modePackFrontendUrl(context: ModePackFrontendContext): string {
  const params = new URLSearchParams({
    sessionId: required(context.sessionId, "sessionId"),
    snapshotId: required(context.snapshotId, "snapshotId"),
    nonce: required(context.nonce, "nonce"),
    parentOrigin: required(context.parentOrigin, "parentOrigin"),
  });
  if (context.runtimeId) params.set("runtimeId", context.runtimeId);
  return `/api/mode-packs/frontend/${encodeURIComponent(context.sessionId)}/${encodeURIComponent(context.snapshotId)}/${encodeURIComponent(context.nonce)}/${entryPath(context.entry)}?${params.toString()}`;
}

export function isOpaqueModePackMessage(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  source: Window | null,
  context: Pick<ModePackFrontendContext, "sessionId" | "snapshotId" | "nonce">,
): event is MessageEvent<Record<string, unknown>> {
  if (event.origin !== "null" || event.source !== source || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) return false;
  const data = event.data as Record<string, unknown>;
  return data.channel === MODE_PACK_FRONTEND_CHANNEL
    && data.sessionId === context.sessionId
    && data.snapshotId === context.snapshotId
    && data.nonce === context.nonce
    && typeof data.type === "string";
}

export function specKitFrontendPresentation(status: SpecKitFrontendStatus): { message: string; canInitialize: boolean } {
  if (status.state === "ready" || status.initialized) return { message: "Spec Kit is ready", canInitialize: false };
  if (status.state === "partial") return {
    message: `Spec Kit setup is partial${status.missingCommands.length ? ` (${status.missingCommands.length} templates missing)` : ""}; repair existing files before initialization.`,
    canInitialize: false,
  };
  return { message: "Spec Kit is not initialized", canInitialize: true };
}
