import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import { recoverModePackBindingHistory, type ModePackEntryLike } from "../../../packages/mode-pack-host/src/index.ts";
import type { Scope, SourceVersionInput, StudyTask } from "../../../packages/study-research-host/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { resolveSessionPath } from "./session-reader";
import { assertStudyModeBoundary, studyModePhase } from "./study-mode-policy";
import { readStudySources, type StudySourceManifest } from "./study-source-reader";
import { preferredStudySources } from "./study-source-preference";
import { readStudySupplement } from "./study-supplement";

/** Reconcile only an explicit, committed Pi mode choice; never infer a phase from the prompt. */
export async function studyContext(sessionId: string, expectedPhaseRevision?: number) {
  const harness = getLearningHarness();
  const membership = harness.projectWorkspaces.members().find((member) => member.sessionId === sessionId);
  if (!membership) throw new Error("Study conversation must belong to a project");
  const project = harness.projectWorkspaces.get(membership.projectId);
  if (project.courseProjectId) throw new Error("Study uses an independent project without a course binding");
  const path = await resolveSessionPath(sessionId);
  if (!path) throw new Error("Pi conversation not found");
  const manager = SessionManager.open(path);
  if (manager.getSessionId() !== sessionId) throw new Error("Pi conversation identity mismatch");
  const recovery = recoverModePackBindingHistory(manager.getEntries() as unknown as ModePackEntryLike[], sessionId);
  const snapshot = recovery.current?.snapshot;
  const selectedPhase = snapshot ? studyModePhase(snapshot.profileId) : null;
  if (!snapshot || !selectedPhase) throw new Error("Select the Study or Research mode for this conversation first");
  assertStudyModeBoundary(snapshot);
  const host = harness.studyResearch;
  let phase = host.currentPhase(project.id, sessionId) ?? host.bindSession(project.id, sessionId, selectedPhase);
  if (phase.phase !== selectedPhase) {
    phase = host.setPhase({ projectId: project.id, sessionId, expectedPhaseRevision: phase.revision }, selectedPhase);
    console.info("[study-research] phase reconciled", { sessionId, phase: phase.phase, revision: phase.revision, snapshotId: snapshot.resourceSnapshotId });
  }
  if (expectedPhaseRevision !== undefined && phase.revision !== expectedPhaseRevision) {
    throw new Error("Study phase revision conflict; reload before saving");
  }
  const scope: Scope = { projectId: project.id, sessionId, expectedPhaseRevision: phase.revision };
  return { host, scope, project, phase, snapshot };
}

/** Public task metadata deliberately excludes trusted producer contexts and identities. */
export function studyTaskView(task: StudyTask) {
  return { taskId: task.taskId, projectId: task.projectId, dispatchKey: task.dispatchKey, kind: task.kind,
    status: task.status, revision: task.revision, manifest: task.manifest, createdAt: task.createdAt, updatedAt: task.updatedAt,
    authorization: { kind: task.authorization.kind, phase: task.authorization.phase, phaseRevision: task.authorization.phaseRevision },
    target: task.target ? { targetKind: task.target.targetKind, targetId: task.target.targetId, targetRevision: task.target.targetRevision, targetHash: task.target.targetHash } : null };
}
export type PublicStudyTask = ReturnType<typeof studyTaskView>;

export async function studyWorkspaceState(sessionId: string) {
  const { host, scope, project, phase, snapshot } = await studyContext(sessionId);
  const sources = preferredStudySources(host.listSources(scope).filter((source) => source.current));
  return {
    project: { id: project.id, title: project.title, cwd: project.cwd },
    phase,
    snapshotId: snapshot.resourceSnapshotId,
    revision: host.projectRevision(scope).revision,
    sources,
    knowledge: host.getKnowledge(scope),
    tasks: host.listTasks(scope).map(studyTaskView),
    visualizations: host.listVisualizations(scope),
    plans: host.listResearchPlans(scope),
    sourceUpdates: host.listSourceUpdates(scope),
    cells: getLearningHarness().studyCells.list(scope),
    checkpoints: sources.flatMap((source) => host.listReadCheckpoints(scope, source.sourceId)),
  };
}

/** Only the explicit local-folder UI action may choose a root. Agent tools never accept paths. */
export async function importStudyPaperFromUserSelection(input: {
  sessionId: string;
  rootPath: string;
  entryPath: string;
  expectedPhaseRevision: number;
  expectedProjectRevision: number;
}) {
  const context = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (context.host.projectRevision(context.scope).revision !== input.expectedProjectRevision) throw new Error("Study project revision conflict");
  const manifest = await readStudySources(input.rootPath, { entryPath: input.entryPath });
  // Extraction is asynchronous. Resolve membership and committed phase again before any write.
  const { host, scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (scope.projectId !== context.scope.projectId) throw new Error("Conversation project changed during source extraction");
  if (host.projectRevision(scope).revision !== input.expectedProjectRevision) throw new Error("Study project changed during source extraction");
  const current = host.listSources(scope).filter((source) => source.current);
  const sources = studyManifestInputs(manifest);
  for (const source of sources) {
    const previous = current.find((item) => item.sourceRoot === source.sourceRoot && item.relativePath === source.relativePath);
    if (previous && previous.contentHash !== source.contentHash) {
      throw new Error(`Source changed: ${source.relativePath}. Prepare and review its affected knowledge update before importing the replacement.`);
    }
  }
  host.registerSources(scope, sources, input.expectedProjectRevision);
  console.info("[study-research] source imported", { sessionId: input.sessionId, projectId: scope.projectId, documents: sources.length, entry: manifest.path, hash: manifest.hash });
  return studyWorkspaceState(input.sessionId);
}

export function studyManifestInputs(manifest: StudySourceManifest): SourceVersionInput[] {
  return manifest.documents.map((document) => ({
    sourceRoot: manifest.rootPath,
    relativePath: document.path,
    kind: document.kind,
    sourceRole: document.role,
    contentHash: `sha256:${document.hash}`,
    parser: `${document.provenance.parser}:v1`,
    diagnostics: document.diagnostics.map((diagnostic) => ({ ...diagnostic, locator: diagnostic.location ? JSON.stringify(diagnostic.location) : null })),
    chunks: document.chunks.map((chunk, index) => ({
      ordinal: index + 1,
      locator: JSON.stringify(chunk.location),
      text: chunk.sourceXml ? `${chunk.text}\n\n[Original Word paragraph XML, including OMML]\n${chunk.sourceXml}` : chunk.text,
    })),
  }));
}

export async function importStudySupplementFromUserSelection(input: { sessionId: string; rootPath: string; entryPath: string; expectedPhaseRevision: number; expectedProjectRevision: number }) {
  const context = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (context.host.projectRevision(context.scope).revision !== input.expectedProjectRevision) throw new Error("Study project revision conflict");
  const source = await readStudySupplement(input.rootPath, input.entryPath);
  const current = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (current.scope.projectId !== context.scope.projectId) throw new Error("Conversation project changed during input import");
  current.host.registerSource(current.scope, source, input.expectedProjectRevision);
  console.info("[study-research] supplemental input registered", { projectId: current.scope.projectId, kind: source.kind, hash: source.contentHash });
  return studyWorkspaceState(input.sessionId);
}

export async function readStudyChunks(sessionId: string, sourceId: string, sourceHash: string, offset = 0, limit = 3) {
  const { host, scope } = await studyContext(sessionId);
  return host.readChunks(scope, sourceId, sourceHash, offset, limit);
}

/** Literal project-scoped retrieval; bounded scanning reports its continuation rather than claiming exhaustive search. */
export async function searchStudySources(sessionId: string, query: string, cursor?: { sourceIndex: number; chunkOffset: number; searchHash: string }) {
  if (!query.trim() || query.length > 200) throw new Error("Search query must contain 1..200 characters");
  if (cursor && ![cursor.sourceIndex, cursor.chunkOffset].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid source search cursor");
  const { host, scope } = await studyContext(sessionId);
  const sources = host.listSources(scope).filter((source) => source.current);
  const searchHash = contentHash({ query, sources: sources.map((source) => [source.sourceId, source.contentHash]) });
  if (cursor && cursor.searchHash !== searchHash) throw new Error("Search sources or query changed; restart the search");
  const matches: Array<{ sourceId: string; sourceHash: string; path: string; chunkId: string; locator: string; excerpt: string }> = [];
  const needle = query.toLocaleLowerCase();
  let scannedChunks = 0;
  let sourceIndex = cursor?.sourceIndex ?? 0;
  let chunkOffset = cursor?.chunkOffset ?? 0;
  for (; sourceIndex < sources.length; sourceIndex++, chunkOffset = 0) {
    const source = sources[sourceIndex];
    do {
      const page = host.readChunks(scope, source.sourceId, source.contentHash, chunkOffset, 1);
      for (const chunk of page.chunks) {
        scannedChunks++;
        const position = chunk.text.toLocaleLowerCase().indexOf(needle);
        if (position >= 0) matches.push({ sourceId: source.sourceId, sourceHash: source.contentHash,
          path: source.relativePath, chunkId: chunk.chunkId, locator: chunk.locator,
          excerpt: chunk.text.slice(Math.max(0, position - 200), position + query.length + 500) });
      }
      const next = page.nextOffset === null ? { sourceIndex: sourceIndex + 1, chunkOffset: 0 } : { sourceIndex, chunkOffset: page.nextOffset };
      if (matches.length >= 10 || scannedChunks >= 256) return { matches, scannedChunks, nextCursor: next.sourceIndex < sources.length ? { ...next, searchHash } : null };
      if (page.nextOffset === null) break;
      chunkOffset = page.nextOffset;
    } while (true);
  }
  return { matches, scannedChunks, nextCursor: null };
}

export async function saveStudyNote(input: {
  sessionId: string;
  expectedPhaseRevision: number;
  expectedProjectRevision: number;
  sourceId: string;
  sourceHash: string;
  title: string;
  body: string;
  author: "user" | "agent";
}) {
  const { host, scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
  return host.commitKnowledgeChange(scope, {
    nodes: [{ localKey: "note", kind: "concept", title: input.title, statement: input.body, scope: input.sourceId,
      sourceId: input.sourceId, sourceHash: input.sourceHash, manuallyEdited: input.author === "user" }],
    notes: [{ author: input.author, body: input.body, sourceId: input.sourceId, sourceHash: input.sourceHash, nodeLocalKeys: ["note"] }],
    relations: [],
  }, input.expectedProjectRevision);
}
