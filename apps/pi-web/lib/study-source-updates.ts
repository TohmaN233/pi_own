import type { KnowledgeChange } from "../../../packages/study-research-host/src/index.ts";
import { readStudySources } from "./study-source-reader";
import { readStudySupplement } from "./study-supplement";
import { studyContext, studyManifestInputs, studyWorkspaceState } from "./study-research-service";

/** A registered identity is the only input selector, never a model-provided path. */
async function changedSource(sessionId: string, sourceId: string, expectedHash: string, expectedPhaseRevision?: number) {
  const context = await studyContext(sessionId, expectedPhaseRevision);
  const source = context.host.listSources(context.scope).find((item) => item.sourceId === sourceId && item.current);
  if (!source || source.contentHash !== expectedHash) throw new Error("Source identity or version changed");
  const candidate = ["code", "text", "asset"].includes(source.kind)
    ? await readStudySupplement(source.sourceRoot, source.relativePath)
    : studyManifestInputs(await readStudySources(source.sourceRoot, { entryPath: source.relativePath })).find((item) => item.relativePath === source.relativePath);
  if (!candidate || candidate.sourceRoot !== source.sourceRoot || candidate.kind !== source.kind) throw new Error("Source identity changed during extraction");
  // A previously included file becomes the reader entry, but its registered role does not change.
  candidate.sourceRole = source.sourceRole;
  const current = await studyContext(sessionId, context.phase.revision);
  if (current.scope.projectId !== context.scope.projectId) throw new Error("Project changed during extraction");
  if (!current.host.listSources(current.scope).some((item) => item.sourceId === sourceId && item.current && item.contentHash === expectedHash)) throw new Error("Source changed during extraction");
  return { ...current, source, candidate };
}

export async function inspectStudySourceChange(input: { sessionId: string; sourceId: string; sourceHash: string; offset?: number; limit?: number }) {
  const { host, scope, source, candidate } = await changedSource(input.sessionId, input.sourceId, input.sourceHash);
  const offset = input.offset ?? 0, limit = input.limit ?? 3;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("Invalid candidate chunk page");
  const knowledge = host.getKnowledge(scope);
  return { sourceId: source.sourceId, path: source.relativePath, previousHash: source.contentHash, candidateHash: candidate.contentHash,
    changed: source.contentHash !== candidate.contentHash, phaseRevision: scope.expectedPhaseRevision, projectRevision: host.projectRevision(scope).revision,
    diagnostics: candidate.diagnostics, chunks: candidate.chunks.slice(offset, offset + limit),
    nextOffset: offset + limit < candidate.chunks.length ? offset + limit : null,
    affected: { notes: knowledge.notes.filter((item) => item.sourceId === source.sourceId && item.sourceHash === source.contentHash),
      nodes: knowledge.nodes.filter((item) => item.sourceId === source.sourceId && item.sourceHash === source.contentHash) } };
}

export async function prepareStudySourceUpdate(input: { sessionId: string; sourceId: string; sourceHash: string; candidateHash: string;
  expectedPhaseRevision: number; expectedProjectRevision: number; knowledge: KnowledgeChange; changeSummary: string }) {
  const { host, scope, candidate } = await changedSource(input.sessionId, input.sourceId, input.sourceHash, input.expectedPhaseRevision);
  if (candidate.contentHash !== input.candidateHash) throw new Error("Candidate source changed; regenerate the update against its actual bytes");
  const proposal = host.proposeSourceUpdate(scope, { sourceId: input.sourceId, candidate, knowledge: input.knowledge,
    changeSummary: input.changeSummary, expectedProjectRevision: input.expectedProjectRevision });
  console.info("[study-research] source update prepared", { projectId: scope.projectId, sourceId: input.sourceId, proposalId: proposal.proposalId, candidateHash: input.candidateHash });
  return host.getSourceUpdateDetails(scope, proposal.proposalId);
}

/** Explicit UI decision only; do not expose this operation as a Pi tool. */
export async function decideStudySourceUpdate(input: { sessionId: string; proposalId: string; candidateHash: string;
  expectedPhaseRevision: number; expectedProjectRevision: number; decision: "accept" | "reject" }) {
  let { host, scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
  const proposal = host.getSourceUpdate(scope, input.proposalId);
  if (proposal.status !== "pending" || proposal.candidateHash !== input.candidateHash) throw new Error("Source proposal changed; refresh before deciding");
  if (input.decision === "accept") {
    const checked = await changedSource(input.sessionId, proposal.sourceId, proposal.previousHash, input.expectedPhaseRevision);
    if (checked.candidate.contentHash !== input.candidateHash) throw new Error("Source changed again; candidate must be regenerated before acceptance");
    host = checked.host; scope = checked.scope;
    host.acceptSourceUpdate(scope, input.proposalId, input.expectedProjectRevision);
  } else if (input.decision === "reject") host.rejectSourceUpdate(scope, input.proposalId, input.expectedProjectRevision);
  else throw new Error("Invalid source update decision");
  console.info("[study-research] source update decided", { projectId: scope.projectId, proposalId: input.proposalId, decision: input.decision });
  return studyWorkspaceState(input.sessionId);
}
