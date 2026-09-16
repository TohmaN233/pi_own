import type { studyWorkspaceState } from "./study-research-service";

export type StudyExportState = Awaited<ReturnType<typeof studyWorkspaceState>>;

/** Portable exports retain readable labels, exact source identities and uncertainty. */
export function exportStudyNotes(state: StudyExportState): string {
  const sourceById = new Map(state.sources.map((source) => [source.sourceId, source]));
  const lines = [
    `# ${state.project.title.replace(/[\r\n]/g, " ")} — 学习笔记`, "",
    `项目版本：${state.revision}；当前阶段：${state.phase.phase}。`, "",
    "这些笔记保留作者、来源和待核查状态；阅读记录不等于已验证证明。", "",
  ];
  for (const note of state.knowledge.notes) {
    const source = note.sourceId ? sourceById.get(note.sourceId) : undefined;
    const node = state.knowledge.nodes.find((item) => note.nodeIds.includes(item.nodeId));
    lines.push(`## ${(node?.title ?? "笔记").replace(/[\r\n]/g, " ")}`, "",
      `作者：${note.author === "user" ? "用户" : "Agent"}；版本：${note.revision}；状态：${note.stale ? "与新版来源有差异，待更新" : "学习记录，未自动认定为研究结论"}。`, "",
      note.body, "", `来源：${source?.relativePath ?? "未绑定来源"}；hash：${note.sourceHash ?? "无"}；笔记 ID：${note.noteId}。`, "");
  }
  lines.push("## 来源与读取提示", "");
  for (const source of state.sources) {
    lines.push(`- ${source.relativePath}（${source.kind} / ${source.sourceRole}），${source.contentHash}`);
    for (const diagnostic of source.diagnostics) lines.push(`  - ${diagnostic.code}：${diagnostic.message}${diagnostic.requiresPdfInspection ? "（需对照 PDF 原页）" : ""}`);
  }
  lines.push("", "## 阅读位置", "");
  for (const checkpoint of state.checkpoints) {
    lines.push(`- ${sourceById.get(checkpoint.sourceId)?.relativePath ?? checkpoint.sourceId}：${checkpoint.locator}；${checkpoint.kind}；${checkpoint.note}；来源 ${checkpoint.sourceHash}`);
  }
  if (!state.knowledge.notes.length) lines.push("", "尚无已保存笔记。");
  return `${lines.join("\n")}\n`;
}

export function exportStudyGraph(state: StudyExportState) {
  return {
    format: "pi-study-graph", version: 1,
    project: { title: state.project.title, id: state.project.id, revision: state.revision },
    interpretation: "Source-grounded learning records. Agent claims and draft notes are not confirmed research conclusions.",
    sources: state.sources.map((source) => ({ sourceId: source.sourceId, relativePath: source.relativePath,
      kind: source.kind, sourceRole: source.sourceRole, contentHash: source.contentHash, parser: source.parser,
      version: source.version, diagnostics: source.diagnostics, createdAt: source.createdAt })),
    nodes: state.knowledge.nodes,
    relations: state.knowledge.relations,
    notes: state.knowledge.notes,
    checkpoints: state.checkpoints,
  };
}
