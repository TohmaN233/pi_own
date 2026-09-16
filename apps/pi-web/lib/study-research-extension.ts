import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readStudyChunks, saveStudyNote, searchStudySources, studyContext, studyWorkspaceState } from "./study-research-service";
import { studyPdfPage } from "./study-pdf-page";
import { inspectStudySourceChange, prepareStudySourceUpdate } from "./study-source-updates";
import { saveStudyCodeCell } from "./study-code-cells";
import { runStudyCodeCell, studyExecutionState } from "./study-execution-service";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import { startStudyReading, studyReadingState } from "./study-reading-service";
import { searchExternalStudyReferences } from "./study-external-references";
import { readStudyResultField } from "./study-result-reading";

export default function studyResearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "study_paper",
    label: "论文学习",
    description: "Read project paper state, located source chunks and reading checkpoints, or save a note and graph node atomically. All source IDs and hashes must come from state. No filesystem paths, research grants, phase switching, approvals or manuscript writes are accepted here. Extracted text is not verified mathematics; heed source diagnostics and inspect the original PDF for uncertain equations.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("state"), Type.Literal("read"), Type.Literal("read_result"), Type.Literal("search"), Type.Literal("page_image"), Type.Literal("save_note"), Type.Literal("checkpoint"), Type.Literal("inspect_change"), Type.Literal("update_draft"), Type.Literal("read_update"), Type.Literal("save_cell"), Type.Literal("run_cell"), Type.Literal("execution_state"), Type.Literal("start_reading"), Type.Literal("reading_state")]),
      rPackages: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 })),
      queueJobId: Type.Optional(Type.String()),
      cellId: Type.Optional(Type.String()), expectedCellRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      cell: Type.Optional(Type.Object({ title: Type.String({ minLength: 1, maxLength: 1000 }), purpose: Type.String({ minLength: 1, maxLength: 6000 }),
        language: Type.Union([Type.Literal("r"), Type.Literal("python")]), code: Type.String({ minLength: 1, maxLength: 131072 }),
        parameters: Type.Record(Type.String(), Type.Unknown()), inputs: Type.Array(Type.Object({ name: Type.String(), sourceId: Type.String(), sourceHash: Type.String() }), { maxItems: 64 }) })),
      proposalId: Type.Optional(Type.String()), candidateHash: Type.Optional(Type.String()),
      candidateKnowledge: Type.Optional(Type.Object({
        nodes: Type.Array(Type.Object({ localKey: Type.String(), replaceNodeId: Type.Optional(Type.String()),
          kind: Type.Union([Type.Literal("concept"), Type.Literal("claim"), Type.Literal("proof"), Type.Literal("assumption"), Type.Literal("implementation"), Type.Literal("question")]),
          title: Type.String({ maxLength: 2000 }), statement: Type.String({ maxLength: 20000 }), scope: Type.String({ maxLength: 4000 }) }), { maxItems: 100 }),
        notes: Type.Array(Type.Object({ replaceNoteId: Type.Optional(Type.String()), body: Type.String({ maxLength: 20000 }), nodeLocalKeys: Type.Array(Type.String(), { maxItems: 100 }) }), { maxItems: 100 }),
        relations: Type.Array(Type.Object({ fromNodeLocalKey: Type.String(), toNodeLocalKey: Type.String(),
          kind: Type.Union([Type.Literal("prerequisite"), Type.Literal("supports"), Type.Literal("contradicts"), Type.Literal("refers-to"), Type.Literal("implements")]) }), { maxItems: 200 }),
      })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      externalQuery: Type.Optional(Type.String({ minLength: 2, maxLength: 160, description: "Optional supplemental learning lookup only with action search. Use minimal concept/title/DOI terms, never private full text or a verbatim paper passage. Returned Crossref metadata/abstracts are external and do not establish full-text reading or validation." })),
      cursor: Type.Optional(Type.Object({ sourceIndex: Type.Integer({ minimum: 0 }), chunkOffset: Type.Integer({ minimum: 0 }), searchHash: Type.String() })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })),
      sourceId: Type.Optional(Type.String()), sourceHash: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      resultId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      expectedResultRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      expectedTaskRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      field: Type.Optional(Type.Union([Type.Literal("code"), Type.Literal("parameters"), Type.Literal("plan"), Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("error"), Type.Literal("analysis")])),
      textOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })),
      fieldHash: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      expectedPhaseRevision: Type.Optional(Type.Integer({ minimum: 1 })), expectedProjectRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      title: Type.Optional(Type.String({ maxLength: 2000 })), body: Type.Optional(Type.String({ maxLength: 20000 })),
      locator: Type.Optional(Type.String({ maxLength: 4000 })),
    }),
    async execute(toolCallId, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Study operation cancelled");
      const sessionId = ctx.sessionManager.getSessionId();
      let result: unknown;
      if (params.action === "state") result = await studyWorkspaceState(sessionId);
      else if (params.action === "reading_state") {
        const reading = await studyReadingState(sessionId);
        result = { total: reading.tasks.length, completed: reading.tasks.filter((task) => task.status === "succeeded").length,
          maps: reading.maps.slice(params.offset ?? 0,(params.offset ?? 0)+Math.min(params.limit ?? 2,2)).map(({map,plan,reductions})=>({plan,paperMap:map?.paperMap??null,reductionStates:reductions.map(task=>({taskId:task.taskId,status:task.status}))})), totalMaps:reading.maps.length,
          tasks: reading.tasks.slice(-8), earlierReports: "Earlier source-grounded notes and checkpoints are available through state; this report view is bounded." };
      }
      else if (params.action === "start_reading") {
        if (!params.sourceId || !params.sourceHash || params.expectedPhaseRevision === undefined) throw new Error("Observed source identity and phase revision are required");
        const reading = await startStudyReading({ sessionId, sourceId: params.sourceId, sourceHash: params.sourceHash,
          expectedPhaseRevision: params.expectedPhaseRevision }, signal);
        result = { taskIds: reading.tasks.map((task) => task.taskId), chunks: reading.chunks, status: "Background reading admitted; continue the user's immediate question." };
      }
      else if (params.action === "execution_state") {
        const execution = await studyExecutionState(sessionId);
        result = { capacity: execution.capacity, capacityError: execution.capacityError,
          runs: execution.runs.filter((run) => (!params.cellId || run.cellId === params.cellId) && (!params.queueJobId || run.queueJobId === params.queueJobId)).slice(-5) };
      }
      else if (params.action === "run_cell") {
        if (!params.cellId || params.expectedCellRevision === undefined || params.expectedPhaseRevision === undefined) throw new Error("Observed cell ID, code revision and phase revision are required");
        const execution = await studyExecutionState(sessionId);
        if (!execution.capacity) throw new Error(execution.capacityError || "Local execution capacity is unavailable");
        if (signal?.aborted) throw new Error("Study calculation request cancelled before admission");
        // The actual Pi tool call fixes retry identity. This capability admits only a small learning run;
        // larger/custom limits remain an explicit frontend or Research scope action.
        result = await runStudyCodeCell({ sessionId, cellId: params.cellId, expectedCellRevision: params.expectedCellRevision,
          expectedPhaseRevision: params.expectedPhaseRevision, requestId: contentHash({ sessionId, toolCallId }).slice("sha256:".length),
          resources: execution.capacity.defaults, rPackages: params.rPackages ?? [] }, signal);
      }
      else if (params.action === "save_cell") {
        if (!params.cell || params.expectedPhaseRevision === undefined) throw new Error("Code draft and observed phase revision are required");
        result = await saveStudyCodeCell({ sessionId, expectedPhaseRevision: params.expectedPhaseRevision,
          cellId: params.cellId, expectedCellRevision: params.expectedCellRevision, draft: params.cell });
      }
      else if (params.action === "read_update") {
        if (!params.proposalId) throw new Error("Observed proposal ID is required");
        const { host, scope } = await studyContext(sessionId);
        result = host.getSourceUpdateDetails(scope, params.proposalId);
      }
      else if (params.action === "read_result") {
        if (!params.field) throw new Error("A result field is required");
        result = await readStudyResultField({
          sessionId,
          expectedPhaseRevision: params.expectedPhaseRevision,
          resultId: params.resultId,
          expectedResultRevision: params.expectedResultRevision,
          taskId: params.taskId,
          expectedTaskRevision: params.expectedTaskRevision,
          field: params.field,
          textOffset: params.textOffset,
          textLimit: params.textLimit,
          fieldHash: params.fieldHash,
        });
      }
      else if (params.action === "search") {
        if (params.externalQuery) {
          if (params.query || params.cursor || params.expectedPhaseRevision === undefined) throw new Error("External lookup requires an observed phase revision and a separate short query");
          result = await searchExternalStudyReferences({sessionId,expectedPhaseRevision:params.expectedPhaseRevision,query:params.externalQuery},signal);
        } else {
          if (!params.query) throw new Error("Search query is required");
          result = await searchStudySources(sessionId, params.query, params.cursor);
        }
      }
      else {
        if (!params.sourceId || !params.sourceHash) throw new Error("An observed source ID and hash are required");
        if (params.action === "inspect_change") {
          result = await inspectStudySourceChange({ sessionId, sourceId: params.sourceId, sourceHash: params.sourceHash, offset: params.offset, limit: params.limit });
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        }
        if (params.action === "update_draft") {
          if (params.expectedPhaseRevision === undefined || params.expectedProjectRevision === undefined || !params.candidateHash || !params.candidateKnowledge || !params.body) throw new Error("Observed revisions, candidate hash, candidate knowledge and change explanation are required");
          const sourceId = params.sourceId, sourceHash = params.candidateHash;
          result = await prepareStudySourceUpdate({ sessionId, sourceId, sourceHash: params.sourceHash, candidateHash: sourceHash,
            expectedPhaseRevision: params.expectedPhaseRevision, expectedProjectRevision: params.expectedProjectRevision, changeSummary: params.body,
            knowledge: { nodes: params.candidateKnowledge.nodes.map((node) => ({ ...node, sourceId, sourceHash, manuallyEdited: false })),
              notes: params.candidateKnowledge.notes.map((note) => ({ ...note, sourceId, sourceHash, author: "agent" as const })), relations: params.candidateKnowledge.relations } });
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        }
        if (params.action === "page_image") {
          if (params.page === undefined) throw new Error("PDF page number is required");
          const page = await studyPdfPage(sessionId, params.sourceId, params.sourceHash, params.page, signal);
          return { content: [
            { type: "text" as const, text: JSON.stringify({ sourceId: page.sourceId, sourceHash: page.sourceHash, page: page.page, meaning: "Original page image; viewing is not mathematical validation" }) },
            { type: "image" as const, data: page.data, mimeType: page.mimeType },
          ], details: {} };
        }
        if (params.action === "read") result = await readStudyChunks(sessionId, params.sourceId, params.sourceHash, params.offset, params.limit);
        else {
          if (params.expectedPhaseRevision === undefined || !params.body) throw new Error("Observed phase revision and content are required");
          if (params.action === "save_note") {
            if (params.expectedProjectRevision === undefined || !params.title) throw new Error("Observed project revision and note title are required");
            result = await saveStudyNote({ sessionId, sourceId: params.sourceId, sourceHash: params.sourceHash,
              expectedPhaseRevision: params.expectedPhaseRevision, expectedProjectRevision: params.expectedProjectRevision,
              title: params.title, body: params.body, author: "agent" });
          } else {
            if (!params.locator) throw new Error("Checkpoint source location is required");
            const { host, scope } = await studyContext(sessionId, params.expectedPhaseRevision);
            result = host.saveReadCheckpoint(scope, { sourceId: params.sourceId, sourceHash: params.sourceHash, kind: "read", locator: params.locator, note: params.body });
          }
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    },
  });
}
