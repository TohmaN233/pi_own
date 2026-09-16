import { isApiRequestAllowed } from "@/lib/request-security";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import { importStudyPaperFromUserSelection, importStudySupplementFromUserSelection, readStudyChunks, saveStudyNote, studyWorkspaceState } from "@/lib/study-research-service";
import { isStudyBrowserMutation } from "@/lib/study-user-action";
import { studyContext } from "@/lib/study-research-service";
import { decideStudySourceUpdate, inspectStudySourceChange } from "@/lib/study-source-updates";
import { saveStudyCodeCell } from "@/lib/study-code-cells";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const query = new URL(request.url).searchParams;
    const sessionId = studyText(query.get("sessionId"), "sessionId");
    const action = query.get("action") ?? "state";
    if (action === "source-change") return Response.json(await inspectStudySourceChange({ sessionId,
      sourceId: studyText(query.get("sourceId"), "sourceId"), sourceHash: studyText(query.get("sourceHash"), "sourceHash"),
      offset: studyInteger(Number(query.get("offset") ?? "0"), "offset"), limit: studyInteger(Number(query.get("limit") ?? "3"), "limit", 1, 10) }), { headers: { "cache-control": "no-store" } });
    if (action === "source-update") {
      const { host, scope } = await studyContext(sessionId);
      return Response.json(host.getSourceUpdateDetails(scope, studyText(query.get("proposalId"), "proposalId")), { headers: { "cache-control": "no-store" } });
    }
    const value = action === "state" ? await studyWorkspaceState(sessionId) : action === "read" ? await readStudyChunks(
      sessionId, studyText(query.get("sourceId"), "sourceId"), studyText(query.get("sourceHash"), "sourceHash"),
      studyInteger(Number(query.get("offset") ?? "0"), "offset"), studyInteger(Number(query.get("limit") ?? "3"), "limit", 1, 10),
    ) : null;
    if (!value) throw new Error("Unknown Study read action");
    return Response.json(value, { headers: { "cache-control": "no-store" } });
  } catch (error) { return studyApiError(error); }
}

/** User workspace actions only. Pi tools call scoped services and cannot dispatch this action map. */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const input = await readStudyRequest(request);
    const action = studyText(input.action, "action");
    const shared = {
      sessionId: studyText(input.sessionId, "sessionId"),
      expectedPhaseRevision: studyInteger(input.expectedPhaseRevision, "expectedPhaseRevision", 1),
      expectedProjectRevision: studyInteger(input.expectedProjectRevision, "expectedProjectRevision"),
    };
    if (action === "import") {
      return Response.json(await importStudyPaperFromUserSelection({ ...shared,
        rootPath: studyText(input.rootPath, "rootPath", 4096), entryPath: studyText(input.entryPath, "entryPath", 4096),
      }));
    }
    if (action === "import-supplement") {
      if (!isStudyBrowserMutation(request)) return Response.json({ error: "需要同一页面的文件登记操作。" }, { status: 403 });
      return Response.json(await importStudySupplementFromUserSelection({ ...shared, rootPath: studyText(input.rootPath, "rootPath", 4096), entryPath: studyText(input.entryPath, "entryPath", 4096) }));
    }
    if (action === "note") {
      await saveStudyNote({ ...shared, sourceId: studyText(input.sourceId, "sourceId"), sourceHash: studyText(input.sourceHash, "sourceHash"),
        title: studyText(input.title, "title", 2000), body: studyText(input.body, "body", 20000), author: "user" });
      return Response.json(await studyWorkspaceState(shared.sessionId));
    }
    if (action === "save-cell") {
      if (input.language !== "r" && input.language !== "python") throw new Error("Only R and Python cells are supported");
      if (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters)) throw new Error("Cell parameters must be an object");
      if (!Array.isArray(input.inputs)) throw new Error("Cell inputs must be an array");
      const inputs = input.inputs.map((value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cell input binding");
        const item = value as Record<string, unknown>;
        return { name: studyText(item.name, "input name", 128), sourceId: studyText(item.sourceId, "sourceId"), sourceHash: studyText(item.sourceHash, "sourceHash") };
      });
      return Response.json(await saveStudyCodeCell({ ...shared,
        cellId: input.cellId === undefined ? undefined : studyText(input.cellId, "cellId"),
        expectedCellRevision: input.expectedCellRevision === undefined ? undefined : studyInteger(input.expectedCellRevision, "expectedCellRevision", 1),
        draft: { title: studyText(input.title, "cell title", 1000), purpose: studyText(input.purpose, "cell purpose", 6000), language: input.language,
          code: studyText(input.code, "cell code", 131072), parameters: input.parameters as Record<string, unknown>, inputs },
      }));
    }
    if (action === "source-update-decision") {
      if (input.decision !== "accept" && input.decision !== "reject") throw new Error("Invalid source update decision");
      return Response.json(await decideStudySourceUpdate({ ...shared, proposalId: studyText(input.proposalId, "proposalId"),
        candidateHash: studyText(input.candidateHash, "candidateHash"), decision: input.decision }));
    }
    throw new Error("Unknown Study workspace action");
  } catch (error) { return studyApiError(error); }
}
