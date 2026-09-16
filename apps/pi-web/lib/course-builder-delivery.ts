import { createHash, randomUUID } from "node:crypto";
import type { CourseBuilderCommand, CourseBuilderHost } from "../../../packages/course-builder-host/src/index.ts";
import { resolveOperationalEvidence, type RequirementVerification } from "./course-builder-delivery-evidence";
import { deliveryArtifacts as artifacts, deliveryIdentity as identity, deliveryWriteKind, mergeDeliveryTarget, prepareDeliveryCommand, resolveDeliveryTarget, type DeliverySnapshot as Snapshot, type DeliveryTarget } from "./course-builder-delivery-target";

export const DELIVERY_ENTRY = "pi-web:course-delivery";
export const DELIVERY_REQUEST_ENTRY = "pi-web:course-delivery-request";
export function deliveryRequest(prompt: string, target: DeliveryTarget) {
  return { promptHash: createHash("sha256").update(prompt).digest("hex"), target };
}
export interface DeliveryTask {
  id: string;
  status: "routing" | "active" | "completed" | "question" | "blocked" | "cancelled";
  requests: string[];
  target?: DeliveryTarget;
  workspaceSelected?: boolean;
  bindingRepair?: { previous: DeliveryTarget; resolved: DeliveryTarget };
  requirements: { id: string; text: string; verification?: RequirementVerification }[];
  baseline: Record<string, number>;
  operations: string[];
  lastProgress: number;
  idleRounds: number;
  rounds: number;
  lastError?: string;
  reason?: string;
  transportPending?: boolean;
  importedMaterialIds?: string[];
  delivered?: { teacherNotesCompileReceiptId?: string; id: string; revision: number; checks: DeliveryCheck[]; hostEvidence?: { requirementId: string; records: Record<string, string | number>[] }[]; additionalArtifacts?: {notesId:string;revision:number;sourceHash:string}[] };
}
export interface DeliveryCheck { requirementId: string; quote: string; materialId?: string; offset?: number }
interface IO {
  snapshot(): Snapshot;
  checkpoints?(): ReturnType<CourseBuilderHost["listCoverageCheckpoints"]>;
  load(): DeliveryTask | undefined;
  save(task: DeliveryTask): void;
}
function revision(value: unknown): number { return Number((value as { revision?: number }).revision ?? 1); }
function strings(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.map(strings).join("\n") : value && typeof value === "object" ? Object.values(value).map(strings).join("\n") : "";
}
const normalized = (value: string) => value.replace(/\s+/gu, " ").trim();
const describe = (task: DeliveryTask) => JSON.stringify({ id: task.id, requests: task.requests, target: task.target, requirements: task.requirements, lastError: task.lastError });
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Delivery specification must be an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 20000) throw new Error(`Invalid delivery ${name}`);
  return value.trim();
}

/** The model chooses the product and semantic requirements; Host owns continuation
 * and verifies durable artifacts, every requirement's evidence, and compile/review. */
export class CourseDeliveryLoop {
  constructor(private readonly io: IO) {}

  restore(): DeliveryTask | undefined {
    const task = this.io.load();
    if (!task?.target || ["completed", "question", "cancelled"].includes(task.status)) return task;
    const target = resolveDeliveryTarget(this.io.snapshot(), task.target);
    const changedId = task.target.id !== undefined && task.target.id !== target.id;
    const repairedBlock = task.status === "blocked" && (changedId || task.bindingRepair && task.reason?.includes("Wrong delivery target"));
    if (JSON.stringify(target) === JSON.stringify(task.target) && !repairedBlock) return task;
    const next = { ...task, target, ...(changedId ? { bindingRepair: { previous: task.target, resolved: target }, lastError: undefined,
    } : {}), ...(repairedBlock ? { reason: "Host 已修复交付目标绑定；可继续检查已保存产物，无需为修复 ID 重新生成课件。" } : {}) };
    this.io.save(next);
    return next;
  }

  start(prompt: string, selected?: DeliveryTarget): string {
    const previous = this.restore();
    const resume = previous && ["routing", "active", "blocked"].includes(previous.status);
    const baseline: Record<string, number> = {};
    for (const kind of ["semester", "lesson", "deck", "assignment", "visual", "materials", "teacher-notes"] as const) {
      for (const artifact of artifacts(this.io.snapshot(), kind)) baseline[identity(kind, artifact)] = revision(artifact);
    }
    const task: DeliveryTask = resume ? { ...previous, status: "routing", requests: [...previous.requests, prompt], idleRounds: 0, rounds: 0, reason: undefined } : {
      id: randomUUID(), status: "routing", requests: [prompt], requirements: [], baseline, operations: [], lastProgress: 0, idleRounds: 0, rounds: 0,
    };
    if (selected) { task.target = mergeDeliveryTarget(task.target, resolveDeliveryTarget(this.io.snapshot(), selected)); task.workspaceSelected = true; }
    this.io.save(task);
    return this.instruction(task);
  }

  private instruction(task: DeliveryTask): string {
    return [
      'Teacher lecture scripts are independent TeX products: delivery_route {kind:"teacher-notes",deckId:"observed existing deck ID",requirements:[{text:"teacher speaking script",verification:"content"}]}. Read the deck, save_teacher_notes or patch_teacher_notes, then read_teacher_notes and compile_teacher_notes. On failure use read_teacher_notes_compile_log, repair and recompile. Only then finish with the current successful PDF receipt. For a deck task with includeTeacherNotes=true, retain the deck target and also save teacher notes for its final revision; Host will not complete until both outputs exist. Teacher notes do not require rewriting or reapproving an existing Beamer.',
      'Supplemental files or website acquisition alone use delivery_route {kind:"materials",requirements:[...]}, not visual. add_material imports into the existing material library and binds this delivery to the Host-owned project ID. Several files may be added to this same delivery. While preparing a lesson/deck, add_material is auxiliary: retain that lesson/deck target and continue using the returned material IDs. Do not change product kind just to fetch a reference. Use verification=materials for registration and verification=content for captured content. Material content checks use read_material text with materialId and offset, never filenames as content proof.',
      `Course delivery task ${task.id}. First call course_builder delivery_route using the structured spec object (not a JSON-encoded string). Use structured draft for save/patch operations to avoid double-escaping TeX.`,
      'For a pure information question use {kind:"question",reason:"..."}. For a product use {kind:"deck|semester|lesson|assignment|visual|materials|teacher-notes",requirements:[{text:"one complete user requirement",verification:"content|compile-review|checkpoint|materials"}]}. The Host allocates product and requirement IDs; retain IDs returned in delivery_status when amending existing requirements. The workspace-selected target is already bound; omit IDs. In direct chat select a lesson by week/session or lessonPlanId; an existing artifact id is only a validated reference, never an ID to allocate. New IDs come from successful Host saves.',
      'For combined deck-and-script deliveries, content quotes may come from the saved deck or its accompanying teacher script. Read the appropriate exact source. The Host binds the accompanying script to the final deck revision/hash; never use notes from another deck as evidence.',
      "Derive the full request from the conversation, not just its last sentence. Preserve all requested source sections, examples and exclusions. Enumerate each section when the user asks for a complete source-based restoration; never shrink the checklist to whatever you happened to finish. Existing task requirements remain binding.",
      `Current task: ${describe(task)}`,
      'After producing the artifact, call delivery_status and fill its exact finishTemplate. content requirements need exact source quotes. compile-review and checkpoint requirements are verified from Host records, materials from import records; do not submit quotes for these operational requirements. Do not supply a product ID: the Host binds the saved artifact. Every requirement must have actual evidence; do not use a token unrelated quote. For a deck the current revision must compile and pass review. A new save or a passing compiler alone is not delivery.',
      "Continue editing and checking until delivery_finish succeeds. Ordinary TeX errors, overflow, revision conflicts and accepted historical versions are repair steps, not requests for permission. Read current state after conflicts. Preserve unaffected content. Do not ask the teacher to unlock an accepted deck before saving the next draft. Never self-approve. If genuinely blocked, explain the exact missing resource/error; do not pretend partial work satisfies the request.",
    ].join("\n\n");
  }

  route(value: unknown): DeliveryTask {
    const task = this.restore();
    if (!task || !["routing", "active", "question"].includes(task.status)) throw new Error("Delivery routing requires a current user request");
    const spec = record(value);
    if (spec.kind === "question") {
      text(spec.reason, "question reason");
      if (task.target && !task.requirements.length) throw new Error("The workspace selected a production task; route its requirements before writing or completing it");
      const next = { ...task, status: task.target ? "active" as const : "question" as const };
      this.io.save(next); return next;
    }
    if (!["semester", "lesson", "deck", "assignment", "visual", "materials", "teacher-notes"].includes(String(spec.kind))) throw new Error("Unknown delivery product kind");
    if (!Array.isArray(spec.requirements) || !spec.requirements.length || spec.requirements.length > 100) throw new Error("List every delivery requirement (1–100)");
    const requirements = spec.requirements.map((value) => {
      const item = record(value), requirementText = text(item.text, "requirement text");
      if (!["content", "compile-review", "checkpoint", "materials"].includes(String(item.verification))) throw new Error("Each requirement needs verification: content (exact source quote), compile-review (Host receipts), checkpoint (Host coverage record), or materials (Host import records). Call delivery_status for the saved contract.");
      const verification = item.verification as RequirementVerification;
      const id = item.id === undefined ? `req-${createHash("sha256").update(`${task.id}:${requirementText}:${verification}`).digest("hex").slice(0, 12)}` : text(item.id, "requirement ID");
      return { id, text: requirementText, verification };
    });
    if (new Set(requirements.map((item) => item.id)).size !== requirements.length) throw new Error("Duplicate delivery requirement IDs");
    const merged = new Map(task.requirements.map((item) => [item.id, item]));
    for (const item of requirements) {
      if (merged.has(item.id) && merged.get(item.id)!.text !== item.text) throw new Error("Do not silently replace an unfinished requirement; retain it and add the user's amendment separately");
      if (merged.get(item.id)?.verification && merged.get(item.id)!.verification !== item.verification) throw new Error("Do not change an existing requirement's verification type to bypass evidence");
      merged.set(item.id, item);
    }
    const correctingKind = task.target && task.target.kind !== spec.kind && spec.correctRoutingReason !== undefined;
    if (correctingKind) {
      text(spec.correctRoutingReason,"routing correction reason");
      if (task.target?.id || task.workspaceSelected) throw new Error("Cannot reclassify a saved or workspace-selected product. Continue its delivery; reference imports remain auxiliary.");
    }
    const target = mergeDeliveryTarget(correctingKind ? undefined : task.target, resolveDeliveryTarget(this.io.snapshot(), {
      kind: spec.kind as DeliveryTarget["kind"],
      ...(spec.kind==="teacher-notes" && task.target?.kind==="teacher-notes" && spec.id===undefined && spec.deckId===undefined && spec.lessonPlanId===undefined && spec.week===undefined && spec.session===undefined ? {deckId:task.target.deckId} : {}),
      ...(spec.id !== undefined ? { id: text(spec.id, "target reference") } : {}),
      ...(spec.lessonPlanId !== undefined ? { lessonPlanId: text(spec.lessonPlanId, "lesson reference") } : {}),
      ...(spec.deckId !== undefined ? {deckId:text(spec.deckId,"deck reference")} : {}),
      ...(spec.includeTeacherNotes !== undefined ? {includeTeacherNotes:spec.includeTeacherNotes as boolean} : {}),
      ...(spec.week !== undefined || spec.session !== undefined ? { week: spec.week as number, session: spec.session as number } : {}),
    }));
    for (const item of merged.values()) {
      if (item.verification === "compile-review" && target.kind !== "deck" || item.verification === "checkpoint" && !["deck", "lesson"].includes(target.kind)) throw new Error(`Verification ${item.verification} is incompatible with ${target.kind}; content checks prove product content. Keep imports auxiliary to lesson/deck work.`);
    }
    const next: DeliveryTask = { ...task, target, requirements: [...merged.values()], status: "active" };
    this.io.save(next); return next;
  }

  observe(command: unknown, result: unknown, error?: string): void {
    const task = this.restore();
    if (!task || !["routing", "active"].includes(task.status)) return;
    const kind = deliveryWriteKind(record(command).action as string);
    if (!error && result && task.target && kind === task.target.kind) {
      task.target = mergeDeliveryTarget(task.target, resolveDeliveryTarget(this.io.snapshot(), { kind, id: identity(kind, result) }));
    }
    if (!error && result && kind === "materials") {
      const materialIds=(result as {materials:{materialId:string}[]}).materials.map(m=>m.materialId);
      task.importedMaterialIds=[...new Set([...(task.importedMaterialIds??[]),...materialIds])];
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ command, result })).digest("hex");
    this.io.save({ ...task, operations: error || task.operations.includes(fingerprint) ? task.operations : [...task.operations, fingerprint], lastError: error });
  }

  assertProductionAction(action: string): void {
    if (/^(?:save_|patch_|visual$|create_visual|render_visual)/u.test(action) && this.io.load()?.status !== "active") throw new Error("Route this production request with delivery_route and its full requirements before writing artifacts");
  }

  materialImportsToVerify(): string[] {
    const task=this.restore();
    return task?.importedMaterialIds ?? [];
  }

  status() {
    const task = this.restore();
    if (!task) throw new Error("No current delivery request");
    const snapshot = this.io.snapshot();
    const checkpoints = this.io.checkpoints?.() ?? [];
    const lesson = snapshot.lessonPlans.find(item=>item.lessonPlanId === task.target?.lessonPlanId);
    const deck = task.target?.kind === "deck" ? snapshot.decks.find(item=>item.deckId === task.target?.id) : undefined;
    const checkpoint = lesson ? checkpoints.filter(item=>item.lessonPlanId === lesson.lessonPlanId).at(-1) : undefined;
    const artifact = task.target ? artifacts(snapshot,task.target.kind).find(item=>identity(task.target!.kind,item) === task.target?.id) : undefined;
    const saved = !!artifact && (task.target?.kind === "materials" ? !!task.importedMaterialIds?.length : revision(artifact) > (task.baseline[task.target!.id!] ?? 0));
    const productGate = !saved ? {ready:false,nextAction:"Save the requested product's new revision, or import the requested materials through add_material."}
      : task.target?.kind === "deck" ? resolveOperationalEvidence({snapshot,target:task.target,verification:"compile-review"})
      : {ready:true,nextAction:null};
    const notesDeck=task.target?.kind === "teacher-notes" ? snapshot.decks.find(item=>item.deckId===task.target?.deckId) : task.target?.includeTeacherNotes ? deck : undefined;
    const notes=(snapshot.teacherNotes ?? []).find(item=>item.deckId===notesDeck?.deckId);
    const notesReceipt=notes ? (snapshot.teacherNotesCompileReceipts ?? []).filter(receipt=>receipt.projectId===snapshot.project.projectId && receipt.notesId===notes.notesId && receipt.notesRevision===notes.revision && receipt.sourceHash===notes.sourceHash && receipt.deckId===notes.deckId && receipt.deckRevision===notes.deckRevision && receipt.deckSourceHash===notes.deckSourceHash).at(-1) : undefined;
    const notesCurrent=!!notes && !!notesDeck && notes.deckRevision===notesDeck.revision && notes.deckSourceHash===notesDeck.sourceHash;
    const teacherNotesGate=task.target?.kind === "teacher-notes" || task.target?.includeTeacherNotes ? {
      ready:notesCurrent && notesReceipt?.succeeded===true,
      notesId:notes?.notesId,revision:notes?.revision,sourceHash:notes?.sourceHash,
      compileReceipt:notesReceipt ?? null,
      saveTemplate:{action:"save_teacher_notes",expectedRevision:notes?.revision ?? 0,draft:{deckId:notesDeck?.deckId ?? "",deckRevision:notesDeck?.revision ?? 0,title:"",source:""}},
      nextAction:!notesCurrent ? "Read the selected deck and save/patch its independent teacher lecture-script TeX for the final deck revision. Do not rewrite the deck to produce notes; query state.teacherNotes/read_teacher_notes first." : !notesReceipt ? `Call compile_teacher_notes with id=${notes!.notesId}, expectedRevision=${notes!.revision}; a saved TeX source alone is not delivery.` : !notesReceipt.succeeded ? `Call read_teacher_notes_compile_log with id=${notesReceipt.receiptId}; repair the current script with patch_teacher_notes, then compile_teacher_notes for its new revision. Diagnostics: ${JSON.stringify(notesReceipt.diagnostics)}` : "The current lecture-script revision has a verified compiled PDF.",
    } : null;
    const requirements = task.requirements.map((item) => ({ ...item,
      evidence: !item.verification ? { ready: false, nextAction: "Reissue delivery_route with this exact id/text and an explicit verification type; old tasks did not record evidence types." }
        : item.verification === "content" ? { ready: false, nextAction: task.target?.kind === "materials" ? "Use read_material on an imported material; supply materialId, offset and an exact quote from that returned text window (limit 20000). Filenames do not prove document contents." : "Read the saved product and quote exact substantive source, preserving TeX/HTML markup. A matching quote checks provenance, not semantic completeness; audit the full requirement." }
        : task.target ? resolveOperationalEvidence({snapshot,target:task.target,verification:item.verification,checkpoints,importedMaterialIds:task.importedMaterialIds ?? []}) : {ready:false,nextAction:"Route the delivery first."},
    }));
    const missingTypes = requirements.filter(item=>!item.verification).map(item=>item.id);
    return { taskId: task.id, status: task.status, target: task.target, requirements, productGate, teacherNotesGate,
      canCorrectUnboundKind: !task.workspaceSelected && !!task.target && !task.target.id,
      importedMaterialIds: task.importedMaterialIds ?? [],
      checkpoint: lesson ? {current:checkpoint ?? null,saveTemplate:{action:"save_checkpoint",expectedRevision:checkpoint?.revision ?? 0,draft:{lessonPlanId:lesson.lessonPlanId,lessonRevision:lesson.revision,deckId:deck?.deckId ?? null,deckRevision:deck?.revision ?? null,coverage:checkpoint?.coverage ?? [],completed:[],remaining:[],nextLesson:""}},instruction:"Fill actual coverage and handoff. expectedRevision belongs to this lesson's checkpoint record, NOT the deck, lesson, or another lesson's checkpoint. Refresh delivery_status after content saves or conflicts."} : null,
      finishTemplate: missingTypes.length ? null : { checks: requirements.filter(item=>item.verification === "content").map(item=>({requirementId:item.id, ...(task.target?.kind === "materials" ? {materialId:"",offset:0} : {}),quote:""})) },
      nextAction: missingTypes.length ? `Classify legacy requirements before finishing: ${missingTypes.join(", ")}` : "Fill only the content quotes in finishTemplate. Host obtains operational evidence itself; never submit receipt claims as quotes.",
    };
  }

  materialChecks(value: unknown): DeliveryCheck[] {
    const task = this.restore(), spec = record(value);
    if (task?.target?.kind !== "materials") return [];
    if (!Array.isArray(spec.checks)) throw new Error("Use the checks array from delivery_status.finishTemplate");
    return spec.checks.map(value=>{
      const item=record(value), materialId=text(item.materialId,"material ID"), offset=item.offset ?? 0;
      if (!task.importedMaterialIds?.includes(materialId)) throw new Error("Content evidence must reference a material imported by this delivery; call delivery_status for IDs");
      if (!Number.isSafeInteger(offset) || (offset as number)<0) throw new Error("Material evidence offset must be a non-negative character offset from read_material");
      return {requirementId:text(item.requirementId,"requirement ID"),quote:text(item.quote,"evidence quote"),materialId,offset:offset as number};
    });
  }

  prepare(command: CourseBuilderCommand): CourseBuilderCommand {
    this.assertProductionAction(command.action);
    const task = this.restore();
    if (!task?.target) return command;
    const prepared = prepareDeliveryCommand(this.io.snapshot(), task.target, command);
    if (JSON.stringify(task.target) !== JSON.stringify(prepared.target)) this.io.save({ ...task, target: prepared.target });
    return prepared.command;
  }

  private nextStep(task: DeliveryTask): string {
    if (!task.target) return "Call delivery_route to declare the complete production task.";
    const snapshot = this.io.snapshot();
    const kind = task.target.kind;
    const target = artifacts(snapshot, kind).find((item) => identity(kind, item) === task.target?.id);
    if (!target || (kind === "materials" ? !task.importedMaterialIds?.length : revision(target) <= (task.baseline[identity(kind, target)] ?? 0))) return "Read the current source and target, implement ALL requested changes, and save the next draft now.";
    if (task.target.kind === "deck") {
      const deck = snapshot.decks.find((item) => item.deckId === identity(kind, target))!;
      const receipt = snapshot.compileReceipts.filter((item) => item.deckId === deck.deckId && item.deckRevision === deck.revision && item.sourceHash === deck.sourceHash).at(-1);
      if (!receipt) return `Call compile for ${deck.deckId}, expectedRevision=${deck.revision}.`;
      if (!receipt.succeeded) return `Call read_compile_log for ${receipt.receiptId}, repair the reported errors with patch_deck, then compile the new revision. A compiler error does not require user permission.`;
      const review = snapshot.deckReviews.filter((item) => item.deckId === deck.deckId && item.deckRevision === deck.revision && item.sourceHash === deck.sourceHash && item.compileReceiptId === receipt.receiptId).at(-1);
      if (!review) return `Call review_deck for ${deck.deckId}.`;
      if (review.status !== "pass") return `Repair the current review issues: ${JSON.stringify(review.issues)}. Then compile and review the next revision.`;
    }
    return `Call delivery_status and follow its Host evidence actions and exact finishTemplate. Do not invent requirement IDs or rewrite correct content to satisfy quote formatting. Contract: ${JSON.stringify(this.status())}`;
  }

  finish(value: unknown, materialText: Record<string, string> = {}): DeliveryTask {
    const task = this.restore();
    if (!task || task.status !== "active" || !task.target) throw new Error("Route the delivery before completing it");
    const spec = record(value), id = task.target.id;
    if (!id) throw new Error("Delivery target is not saved/bound yet; save the selected product through the Host first");
    if (spec.id !== undefined && spec.id !== id) throw new Error(`Delivery target is Host-bound to ${id}; omit id from delivery_finish`);
    const snapshot = this.io.snapshot();
    const artifact = artifacts(snapshot, task.target.kind).find((item) => identity(task.target!.kind, item) === id);
    if (!artifact || (task.target.kind === "materials" ? !task.importedMaterialIds?.length : revision(artifact) <= (task.baseline[id] ?? 0))) throw new Error("Delivery requires a new saved revision of the requested product or a verified material import");
    const contract = this.status();
    if (!contract.finishTemplate) throw new Error(contract.nextAction);
    const contentRequirements = task.requirements.filter(item=>item.verification === "content");
    if (!Array.isArray(spec.checks)) throw new Error("Use the checks array from delivery_status.finishTemplate");
    const checks = spec.checks.map((value) => { const item = record(value); return { requirementId: text(item.requirementId, "requirement ID"), quote: text(item.quote, "evidence quote") }; });
    const missing = contentRequirements.filter((item) => !checks.some((check) => check.requirementId === item.id)).map((item) => item.id);
    const unknown = checks.filter((check) => !contentRequirements.some((item) => item.id === check.requirementId)).map((item) => item.requirementId);
    if (missing.length || unknown.length || new Set(checks.map(item=>item.requirementId)).size !== checks.length) throw new Error(`Incomplete requirement evidence mapping: missing=${JSON.stringify(missing)}, unknown=${JSON.stringify(unknown)}. Submit content checks only. Exact finishTemplate=${JSON.stringify(contract.finishTemplate)}; correct the checks, not the artifact.`);
    const materialChecks = this.materialChecks(spec);
    const accompanyingNotes=task.target.includeTeacherNotes ? (snapshot.teacherNotes ?? []).find(notes=>notes.deckId===id) : undefined;
    const body = normalized(strings(artifact)+(accompanyingNotes ? `\n${accompanyingNotes.source}` : ""));
    for (const requirement of contentRequirements) {
      const check = checks.find((item) => item.requirementId === requirement.id);
      const evidenceBody = task.target.kind === "materials" ? normalized(materialText[requirement.id] ?? "") : body;
      if (!check || normalized(check.quote).length < 8 || !evidenceBody.includes(normalized(check.quote))) throw new Error(`Requirement ${requirement.id} has no matching substantive evidence in ${task.target.kind === "materials" ? "the read_material text window (not registration metadata)" : "the saved product source"}. Read exact source including markup, then fill delivery_status.finishTemplate. Do not rewrite correct content to fix a quote.`);
    }
    const hostEvidence = contract.requirements.filter(item=>item.verification && item.verification !== "content").map(item=>{
      if (!item.evidence.ready || !("records" in item.evidence)) throw new Error(`Requirement ${item.id} (${item.verification}) is unfinished: ${item.evidence.nextAction}. Host verifies records; a body quote cannot satisfy this requirement.`);
      return {requirementId:item.id,records:item.evidence.records};
    });
    if (!contract.productGate.ready) throw new Error(`Delivery is unfinished: compile this revision successfully and pass its current review. ${contract.productGate.nextAction}`);
    if(contract.teacherNotesGate && !contract.teacherNotesGate.ready)throw new Error(`Teacher notes delivery is unfinished: ${contract.teacherNotesGate.nextAction}`);
    const additionalArtifacts=task.target.includeTeacherNotes && contract.teacherNotesGate?.notesId ? [{notesId:contract.teacherNotesGate.notesId,revision:contract.teacherNotesGate.revision!,sourceHash:contract.teacherNotesGate.sourceHash!}] : [];
    const next: DeliveryTask = { ...task, status: "completed", lastError:undefined, delivered: { ...(contract.teacherNotesGate?.compileReceipt?.succeeded ? {teacherNotesCompileReceiptId:contract.teacherNotesGate.compileReceipt.receiptId} : {}), id, revision: revision(artifact), checks:task.target.kind === "materials" ? materialChecks : checks, hostEvidence,additionalArtifacts } };
    this.io.save(next); return next;
  }

  end(stopReason?: string): { message: string; continue: boolean } | null {
    let task = this.restore();
    if (!task || !["routing", "active"].includes(task.status)) return null;
    // Native Pi owns provider retries. Do not disable production tools while a
    // transient provider error is about to be retried by that same prompt.
    if (stopReason === "error") { this.io.save({ ...task, transportPending: true }); return null; }
    task = { ...task, transportPending: false };
    if (stopReason === "aborted") {
      const reason = "用户或运行时中止了任务；交付仍未完成。";
      this.io.save({ ...task, status: "cancelled", reason });
      return { message: reason, continue: false };
    }
    const idleRounds = task.operations.length > task.lastProgress ? 0 : task.idleRounds + 1;
    const rounds = task.rounds + 1;
    if (idleRounds >= 3 || rounds >= 50) {
      const reason = `交付未完成：${idleRounds >= 3 ? "连续三轮没有新的工具证据" : "达到 50 轮自动续跑预算"}。${task.lastError ?? "Agent 未提交完整交付证据。"} 未将部分产物标记为完成。`;
      this.io.save({ ...task, status: "blocked", idleRounds, rounds, reason });
      return { message: reason, continue: false };
    }
    const next = { ...task, idleRounds, rounds, lastProgress: task.operations.length };
    this.io.save(next);
    return { message: `交付任务尚未完成，自动继续（${rounds}）。\n${task.status === "routing" ? this.instruction(next) : `Host next step: ${this.nextStep(next)}\nDo the remaining work now; do not merely acknowledge or promise. Task: ${describe(next)}. Latest tool error: ${task.lastError ?? "none"}.`}`, continue: true };
  }

  settled(): string | null {
    const task = this.io.load();
    if (!task?.transportPending || !["routing", "active"].includes(task.status)) return null;
    const reason = "模型请求失败且原生重试已结束，交付仍未完成；恢复连接后可继续。";
    this.io.save({ ...task, status: "blocked", reason });
    return reason;
  }
}
