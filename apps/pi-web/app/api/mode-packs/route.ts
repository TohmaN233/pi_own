import { NextResponse } from "next/server";
import { getGenericModePackStatus } from "@/lib/rpc-manager";
import { ModePackStore, definitionToDraft } from "@/lib/mode-pack-store";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readLatestPortableModePackageManifests, readPortableModePackage } from "@/lib/portable-mode-pack-registry";
import { bundledCodeModePackage } from "@/lib/bundled-code-mode-package";
import { composePortableModePackage } from "@/lib/portable-mode-pack-service";
import { portableModuleProfileIds, type PortableModePackage } from "../../../../../packages/mode-pack-host/src/index.ts";

export const dynamic = "force-dynamic";

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer`);
  return value as number;
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const sessionId = requiredString(params.get("sessionId"), "sessionId");
    const status = await getGenericModePackStatus(sessionId);
    const archives = new Map<string, PortableModePackage | null>();
    const packageResources = [...new Map([bundledCodeModePackage(), ...readLatestPortableModePackageManifests()]
      .map((archive) => [archive.packageContentHash, archive] as const)).values()]
      .flatMap((archive) => archive.resources.filter((resource) => resource.kind === "skill" || resource.kind === "extension")
        .map((resource) => ({
          kind: resource.kind,
          id: resource.id,
          title: resource.kind === "skill" ? resource.id : resource.source.type === "npm" ? resource.source.package : resource.id,
          packageContentHash: archive.packageContentHash,
          packageTitle: archive.definition.title,
          contentHash: resource.contentHash,
          delivery: resource.delivery,
        })));
    return NextResponse.json({
      sessionId,
      cwd: status.runtime.cwd,
      packs: status.packs.map((item) => ({
        ...(() => {
          const hash = item.definition.packageContentHash;
          if (!hash || item.packageError) return {};
          try {
            if (!archives.has(hash)) archives.set(hash, readPortableModePackage(hash));
            const archive = archives.get(hash);
            if (!archive && item.definition.modePackId.startsWith("custom."))
              throw new Error(`Portable module archive is unavailable: ${hash}`);
            const layout = archive ? portableModuleProfileIds(archive, item.definition.modePackId) : null;
            if (layout && layout.profileIds.some((id) => !status.packs.some((candidate) => candidate.definition.modePackId === id && candidate.definition.packageContentHash === hash)))
              throw new Error(`Portable module ${layout.moduleId} has missing or mismatched phase registrations`);
            return layout ? { moduleId: layout.moduleId, moduleProfileIds: layout.profileIds } : {};
          } catch (error) {
            return { packageMetadataError: error instanceof Error ? error.message : String(error) };
          }
        })(),
        definition: item.definition,
        draft: definitionToDraft(item.definition),
        builtin: item.builtin,
        selectable: item.selectable,
        missingRequiredResources: item.missingRequiredResources,
        missingOptionalResources: item.missingOptionalResources,
        identityMismatches: item.identityMismatches,
        ...(item.packageError ? { packageError: item.packageError } : {}),
      })),
      resources: status.resources,
      packageResources,
      diagnostics: status.diagnostics,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const raw = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a JSON object");
    const body = raw as Record<string, unknown>;
    const sessionId = requiredString(body.sessionId, "sessionId");
    const expectedRevision = nonNegativeInteger(body.expectedRevision, "expectedRevision");
    const status = await getGenericModePackStatus(sessionId);
    const resourceSources = body.resourceSources;
    if (resourceSources !== undefined && !Array.isArray(resourceSources)) throw new Error("resourceSources must be an array");
    const draftPackageHash = body.draft && typeof body.draft === "object" && !Array.isArray(body.draft)
      ? (body.draft as Record<string, unknown>).packageContentHash : undefined;
    const sourceArchive = typeof draftPackageHash === "string" ? readPortableModePackage(draftPackageHash) : null;
    const definition = (Array.isArray(resourceSources) && resourceSources.length > 0) || Boolean(sourceArchive?.profiles?.length)
      || body.sourceModePackId === "course-builder"
      || body.sourceModePackId === "study-research.study"
      || body.sourceModePackId === "study-research.research"
      ? await composePortableModePackage({
          draft: body.draft,
          cwd: status.runtime.cwd,
          expectedRevision,
          ...(typeof body.sourceModePackId === "string" ? { sourceModePackId: body.sourceModePackId } : {}),
          resourceSources: (Array.isArray(resourceSources) ? resourceSources : []).map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("resourceSources entries must be objects");
            const source = item as Record<string, unknown>;
            if ((source.kind !== "skill" && source.kind !== "extension") || typeof source.id !== "string" || typeof source.packageContentHash !== "string") throw new Error("Invalid resource source identity");
            return { kind: source.kind, id: source.id, packageContentHash: source.packageContentHash };
          }),
        })
      : await new ModePackStore().saveDraft(body.draft, status.runtime.cwd, expectedRevision);
    return NextResponse.json({ definition, draft: definitionToDraft(definition) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /revision conflict/iu.test(message) ? 409 : 400 });
  }
}

export async function DELETE(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const raw = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a JSON object");
    const body = raw as Record<string, unknown>;
    const modePackId = requiredString(body.modePackId, "modePackId");
    if (body.expectedRevisions !== undefined) {
      if (!body.expectedRevisions || typeof body.expectedRevisions !== "object" || Array.isArray(body.expectedRevisions))
        throw new Error("expectedRevisions must be an object");
      const revisions = Object.fromEntries(Object.entries(body.expectedRevisions).map(([id, revision]) => [id, nonNegativeInteger(revision, `expectedRevisions.${id}`)]));
      const deleted = await new ModePackStore().deleteCustomModule(modePackId, revisions);
      return NextResponse.json({ deleted: true, modePackId, deletedProfiles: deleted });
    }
    const expectedRevision = nonNegativeInteger(body.expectedRevision, "expectedRevision");
    await new ModePackStore().deleteCustom(modePackId, expectedRevision);
    return NextResponse.json({ deleted: true, modePackId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /revision conflict/iu.test(message) ? 409 : 400 });
  }
}
