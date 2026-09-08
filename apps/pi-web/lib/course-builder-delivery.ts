import { createHash, randomUUID } from "node:crypto";
import type { CourseBuilderHost } from "../../../packages/course-builder-host/src/index.ts";

type Snapshot = NonNullable<ReturnType<CourseBuilderHost["getSnapshotForSession"]>>;
export const DELIVERY_ENTRY = "pi-web:course-delivery";
type Kind = "semester" | "lesson" | "deck" | "assignment" | "visual";
export interface DeliveryTask {
  id: string;
  status: "routing" | "active" | "completed" | "question" | "blocked" | "cancelled";
  requests: string[];
  target?: { kind: Kind; id?: string };
  requirements: { id: string; text: string }[];
  baseline: Record<string, number>;
  operations: string[];
  lastProgress: number;
  idleRounds: number;
  rounds: number;
  lastError?: string;
  reason?: string;
  transportPending?: boolean;
  delivered?: { id: string; revision: number; checks: { requirementId: string; quote: string }[] };
}
interface IO {
  snapshot(): Snapshot;
  load(): DeliveryTask | undefined;
  save(task: DeliveryTask): void;
}
function artifacts(snapshot: Snapshot, kind: Kind) {
  switch (kind) {
    case "semester": return snapshot.semesterPlan ? [snapshot.semesterPlan] : [];
    case "lesson": return snapshot.lessonPlans;
    case "deck": return snapshot.decks;
    case "assignment": return snapshot.assignments;
    case "visual": return snapshot.visuals;
  }
}
function identity(value: unknown): string {
  const item = value as Record<string, unknown>;
  return String(item.deckId ?? item.lessonPlanId ?? item.semesterPlanId ?? item.assignmentId ?? item.visualId);
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

  start(prompt: string): string {
    const previous = this.io.load();
    const resume = previous && ["routing", "active", "blocked"].includes(previous.status);
    const baseline: Record<string, number> = {};
    for (const kind of ["semester", "lesson", "deck", "assignment", "visual"] as const) {
      for (const artifact of artifacts(this.io.snapshot(), kind)) baseline[identity(artifact)] = revision(artifact);
    }
    const task: DeliveryTask = resume ? { ...previous, status: "routing", requests: [...previous.requests, prompt], idleRounds: 0, rounds: 0, reason: undefined } : {
      id: randomUUID(), status: "routing", requests: [prompt], requirements: [], baseline, operations: [], lastProgress: 0, idleRounds: 0, rounds: 0,
    };
    this.io.save(task);
    return this.instruction(task);
  }

  private instruction(task: DeliveryTask): string {
    return [
      `Course delivery task ${task.id}. First call course_builder delivery_route using the structured spec object (not a JSON-encoded string). Use structured draft for save/patch operations to avoid double-escaping TeX.`,
      'For a pure information question use {kind:"question",reason:"..."}. For creating or revising a product use {kind:"deck|semester|lesson|assignment|visual",id:"existing target ID if known",requirements:[{id:"stable requirement ID",text:"one complete user requirement"}]}.',
      "Derive the full request from the conversation, not just its last sentence. Preserve all requested source sections, examples and exclusions. Enumerate each section when the user asks for a complete source-based restoration; never shrink the checklist to whatever you happened to finish. Existing task requirements remain binding.",
      `Current task: ${describe(task)}`,
      'After producing the artifact, call delivery_finish with spec:{id:"saved product ID",checks:[{requirementId:"...",quote:"exact substantive excerpt from that saved product proving this requirement"}]}. Every requirement must have actual evidence; do not use a token unrelated quote. For a deck the current revision must compile and pass review. A new save or a passing compiler alone is not delivery.',
      "Continue editing and checking until delivery_finish succeeds. Ordinary TeX errors, overflow, revision conflicts and accepted historical versions are repair steps, not requests for permission. Read current state after conflicts. Preserve unaffected content. Do not ask the teacher to unlock an accepted deck before saving the next draft. Never self-approve. If genuinely blocked, explain the exact missing resource/error; do not pretend partial work satisfies the request.",
    ].join("\n\n");
  }

  route(value: unknown): DeliveryTask {
    const task = this.io.load();
    if (!task || !["routing", "active", "question"].includes(task.status)) throw new Error("Delivery routing requires a current user request");
    const spec = record(value);
    if (spec.kind === "question") {
      text(spec.reason, "question reason");
      const next = { ...task, status: task.target ? "active" as const : "question" as const };
      this.io.save(next); return next;
    }
    if (!["semester", "lesson", "deck", "assignment", "visual"].includes(String(spec.kind))) throw new Error("Unknown delivery product kind");
    if (!Array.isArray(spec.requirements) || !spec.requirements.length || spec.requirements.length > 100) throw new Error("List every delivery requirement (1–100)");
    const requirements = spec.requirements.map((value) => { const item = record(value); return { id: text(item.id, "requirement ID"), text: text(item.text, "requirement text") }; });
    if (new Set(requirements.map((item) => item.id)).size !== requirements.length) throw new Error("Duplicate delivery requirement IDs");
    const merged = new Map(task.requirements.map((item) => [item.id, item]));
    for (const item of requirements) {
      if (merged.has(item.id) && merged.get(item.id)!.text !== item.text) throw new Error("Do not silently replace an unfinished requirement; retain it and add the user's amendment separately");
      merged.set(item.id, item);
    }
    const target = { kind: spec.kind as Kind, ...(spec.id ? { id: text(spec.id, "target ID") } : {}) };
    if (task.target && (task.target.kind !== target.kind || task.target.id && task.target.id !== target.id)) throw new Error("Finish the active delivery before changing its product target");
    const next: DeliveryTask = { ...task, target, requirements: [...merged.values()], status: "active" };
    this.io.save(next); return next;
  }

  observe(command: unknown, result: unknown, error?: string): void {
    const task = this.io.load();
    if (!task || !["routing", "active"].includes(task.status)) return;
    const fingerprint = createHash("sha256").update(JSON.stringify({ command, result })).digest("hex");
    this.io.save({ ...task, operations: error || task.operations.includes(fingerprint) ? task.operations : [...task.operations, fingerprint], lastError: error });
  }

  assertProductionAction(action: string): void {
    if (/^(?:save_|patch_|create_visual|render_visual)/u.test(action) && this.io.load()?.status !== "active") throw new Error("Route this production request with delivery_route and its full requirements before writing artifacts");
  }

  private nextStep(task: DeliveryTask): string {
    if (!task.target) return "Call delivery_route to declare the complete production task.";
    const snapshot = this.io.snapshot();
    const target = artifacts(snapshot, task.target.kind).find((item) => task.target?.id ? identity(item) === task.target.id : revision(item) > (task.baseline[identity(item)] ?? 0));
    if (!target || revision(target) <= (task.baseline[identity(target)] ?? 0)) return "Read the current source and target, implement ALL requested changes, and save the next draft now.";
    if (task.target.kind === "deck") {
      const deck = snapshot.decks.find((item) => item.deckId === identity(target))!;
      const receipt = snapshot.compileReceipts.filter((item) => item.deckId === deck.deckId && item.deckRevision === deck.revision && item.sourceHash === deck.sourceHash).at(-1);
      if (!receipt) return `Call compile for ${deck.deckId}, expectedRevision=${deck.revision}.`;
      if (!receipt.succeeded) return `Call read_compile_log for ${receipt.receiptId}, repair the reported errors with patch_deck, then compile the new revision. A compiler error does not require user permission.`;
      const review = snapshot.deckReviews.filter((item) => item.deckId === deck.deckId && item.deckRevision === deck.revision && item.sourceHash === deck.sourceHash && item.compileReceiptId === receipt.receiptId).at(-1);
      if (!review) return `Call review_deck for ${deck.deckId}.`;
      if (review.status !== "pass") return `Repair the current review issues: ${JSON.stringify(review.issues)}. Then compile and review the next revision.`;
    }
    return "Audit ALL user requirements against the saved artifact and the original source. Restore every missing section and remove requested duplicates. Call delivery_finish only with evidence for every requirement; compile success is not semantic completeness.";
  }

  finish(value: unknown): DeliveryTask {
    const task = this.io.load();
    if (!task || task.status !== "active" || !task.target) throw new Error("Route the delivery before completing it");
    const spec = record(value), id = text(spec.id, "artifact ID");
    if (task.target.id && task.target.id !== id) throw new Error("Wrong delivery target");
    const snapshot = this.io.snapshot();
    const artifact = artifacts(snapshot, task.target.kind).find((item) => identity(item) === id);
    if (!artifact || revision(artifact) <= (task.baseline[id] ?? 0)) throw new Error("Delivery requires a new saved revision of the requested product");
    if (!Array.isArray(spec.checks)) throw new Error("Every requirement needs saved artifact evidence");
    const checks = spec.checks.map((value) => { const item = record(value); return { requirementId: text(item.requirementId, "requirement ID"), quote: text(item.quote, "evidence quote") }; });
    if (checks.length !== task.requirements.length || new Set(checks.map((item) => item.requirementId)).size !== checks.length) throw new Error("Incomplete or duplicate requirement evidence; continue the delivery");
    const body = normalized(strings(artifact));
    for (const requirement of task.requirements) {
      const check = checks.find((item) => item.requirementId === requirement.id);
      if (!check || normalized(check.quote).length < 8 || !body.includes(normalized(check.quote))) throw new Error(`Requirement ${requirement.id} has no matching substantive evidence in the saved artifact; read back and finish it`);
    }
    if (task.target.kind === "deck") {
      const deck = snapshot.decks.find((item) => item.deckId === id)!;
      const receipt = snapshot.compileReceipts.filter((item) => item.deckId === id && item.deckRevision === deck.revision && item.sourceHash === deck.sourceHash).at(-1);
      const review = snapshot.deckReviews.filter((item) => item.deckId === id && item.deckRevision === deck.revision && item.sourceHash === deck.sourceHash && item.compileReceiptId === receipt?.receiptId).at(-1);
      if (!receipt?.succeeded || !review || review.status !== "pass") throw new Error("Delivery is unfinished: compile this revision successfully and pass its current review, repairing errors in a loop");
    }
    const next: DeliveryTask = { ...task, status: "completed", delivered: { id, revision: revision(artifact), checks } };
    this.io.save(next); return next;
  }

  end(stopReason?: string): { message: string; continue: boolean } | null {
    let task = this.io.load();
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
