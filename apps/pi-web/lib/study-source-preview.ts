import { studyContext } from "./study-research-service";
import { readExactStudySourceBytes } from "./study-source-bytes";

/** Registered source identity is the capability. No caller-controlled filesystem path is accepted. */
export async function readRegisteredStudyPdf(sessionId: string, sourceId: string, sourceHash: string): Promise<Uint8Array> {
  const context = await studyContext(sessionId);
  const source = context.host.listSources(context.scope).find((item) => item.sourceId === sourceId && item.contentHash === sourceHash);
  if (!source || source.kind !== "pdf") throw new Error("Registered project PDF version not found");
  const bytes = await readExactStudySourceBytes(source, 32 * 1024 * 1024);
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Registered file is not a PDF");
  const latest = await studyContext(sessionId, context.phase.revision);
  if (latest.scope.projectId !== context.scope.projectId) throw new Error("Conversation project changed during preview");
  return new Uint8Array(bytes);
}
