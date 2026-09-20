import type { CourseBuilderHost, CourseBuilderCommand } from "../../../packages/course-builder-host/src/index.ts";

export type DeliverySnapshot = NonNullable<ReturnType<CourseBuilderHost["getSnapshotForSession"]>>;
export type DeliveryKind = "semester" | "lesson" | "deck" | "assignment" | "visual" | "materials" | "teacher-notes";
export interface DeliveryTarget {
  kind: DeliveryKind;
  id?: string;
  lessonPlanId?: string;
  deckId?: string;
  includeTeacherNotes?: boolean;
  week?: number;
  session?: number;
}

export function deliveryArtifacts(snapshot: DeliverySnapshot, kind: DeliveryKind) {
  switch (kind) {
    case "teacher-notes": return snapshot.teacherNotes ?? [];
    case "materials": return snapshot.project ? [{...snapshot.project,materials:snapshot.materials.filter(m=>m.metadata.materialScope!=="assignment")}] : [];
    case "semester": return snapshot.semesterPlan ? [snapshot.semesterPlan] : [];
    case "lesson": return snapshot.lessonPlans;
    case "deck": return snapshot.decks;
    case "assignment": return snapshot.assignments;
    case "visual": return snapshot.visuals;
  }
}

// Never infer identity by field order: decks and visuals also contain lessonPlanId.
export function deliveryIdentity(kind: DeliveryKind, value: unknown): string {
  const field = { semester: "semesterPlanId", lesson: "lessonPlanId", deck: "deckId", assignment: "assignmentId", visual: "visualId", materials:"projectId", "teacher-notes":"notesId" }[kind];
  const id = (value as Record<string, unknown>)[field];
  if (typeof id !== "string" || !id) throw new Error(`Saved ${kind} has no ${field}`);
  return id;
}

/** Resolve references against the bound course, never against ID prefixes or titles.
 * A new lesson/deck retains its parent/slot until the Host save allocates its ID. */
export function resolveDeliveryTarget(snapshot: DeliverySnapshot, input: DeliveryTarget): DeliveryTarget {
  if (!["semester", "lesson", "deck", "assignment", "visual", "materials", "teacher-notes"].includes(input.kind)) throw new Error("Unknown delivery product kind");
  const target: DeliveryTarget = { kind: input.kind };
  if (input.includeTeacherNotes !== undefined) {
    if(input.kind!=="deck" || typeof input.includeTeacherNotes!=="boolean")throw new Error("includeTeacherNotes belongs to a deck delivery and must be boolean");
    target.includeTeacherNotes=input.includeTeacherNotes;
  }
  let lessonId = input.lessonPlanId;
  let notesDeckId=input.deckId;
  const items = deliveryArtifacts(snapshot, input.kind);
  if (input.id !== undefined) {
    const item = items.find((item) => deliveryIdentity(input.kind, item) === input.id);
    if (item) {
      target.id = deliveryIdentity(input.kind, item);
      if (input.kind === "teacher-notes" && "deckId" in item) {
        if(notesDeckId && notesDeckId!==item.deckId)throw new Error("Teacher notes and selected deck disagree");
        notesDeckId=item.deckId;
      }
      if ("lessonPlanId" in item) {
        if (lessonId && lessonId !== item.lessonPlanId) throw new Error("Delivery target and lesson disagree");
        lessonId = item.lessonPlanId;
      }
    } else if(input.kind === "teacher-notes" && snapshot.decks.some(deck=>deck.deckId===input.id)) {
      if(notesDeckId && notesDeckId!==input.id)throw new Error("Teacher notes and selected deck disagree");
      notesDeckId=input.id;
    } else if ((input.kind === "deck" || input.kind === "visual") && snapshot.lessonPlans.some((item) => item.lessonPlanId === input.id)) {
      // Explicit repair of the old untyped target contract, including persisted tasks.
      if (lessonId && lessonId !== input.id) throw new Error("Delivery target and lesson disagree");
      lessonId = input.id;
    } else throw new Error(`Delivery ${input.kind} reference does not exist in this course: ${input.id}`);
  }
  if (notesDeckId) {
    if(input.kind!=="teacher-notes")throw new Error("deckId selector is for teacher-notes; deck deliveries use id or lesson selectors");
    const deck=snapshot.decks.find(deck=>deck.deckId===notesDeckId);
    if(!deck || lessonId && lessonId!==deck.lessonPlanId)throw new Error("Teacher notes deck is unavailable or belongs to another lesson");
    lessonId=deck.lessonPlanId;
  }
  if (lessonId && !["lesson", "deck", "visual", "teacher-notes"].includes(input.kind)) throw new Error("This delivery kind has no lesson parent");
  let lesson = lessonId ? snapshot.lessonPlans.find((item) => item.lessonPlanId === lessonId) : undefined;
  if (lessonId && !lesson) throw new Error("Delivery lesson does not exist in this course");
  if (input.week !== undefined || input.session !== undefined) {
    if (!["lesson", "deck", "visual", "teacher-notes"].includes(input.kind) || !Number.isSafeInteger(input.week) || !Number.isSafeInteger(input.session) || !snapshot.semesterPlan?.sessions.some((item) => item.week === input.week && item.session === input.session)) throw new Error("Delivery requires a real semester week/session pair");
    if (lesson && (lesson.week !== input.week || lesson.session !== input.session)) throw new Error("Delivery target and selected course slot disagree");
    target.week = input.week; target.session = input.session;
    lesson ??= snapshot.lessonPlans.find((item) => item.week === input.week && item.session === input.session);
  }
  if (input.kind === "teacher-notes") {
    const deck=notesDeckId ? snapshot.decks.find(deck=>deck.deckId===notesDeckId) : snapshot.decks.find(deck=>deck.lessonPlanId===lesson?.lessonPlanId);
    if(!deck)throw new Error("Save or select an existing Beamer before generating its teacher notes");
    target.deckId=deck.deckId;
    target.id=(snapshot.teacherNotes ?? []).find(notes=>notes.deckId===deck.deckId)?.notesId;
  }
  if (lesson) {
    target.lessonPlanId = lesson.lessonPlanId;
    // Existing lecture scripts belong to the selected saved deck, even when its
    // old slot has subsequently been removed from the semester schedule.
    if(input.kind!=="teacher-notes") { target.week = lesson.week; target.session = lesson.session; }
    if (input.kind === "lesson") target.id = lesson.lessonPlanId;
    if (input.kind === "deck" && !target.id) {
      const matches = snapshot.decks.filter((item) => item.lessonPlanId === lesson.lessonPlanId);
      if (matches.length > 1) throw new Error("Ambiguous deck ownership in this course");
      target.id = matches[0]?.deckId;
    }
  }
  if (input.kind === "semester") target.id = snapshot.semesterPlan?.semesterPlanId;
  if (input.kind === "materials") target.id = snapshot.project.projectId;
  return target;
}

export function mergeDeliveryTarget(current: DeliveryTarget | undefined, next: DeliveryTarget): DeliveryTarget {
  if (!current) return next;
  for (const field of ["kind", "id", "lessonPlanId", "deckId", "includeTeacherNotes", "week", "session"] as const) {
    if (current[field] !== undefined && next[field] !== undefined && current[field] !== next[field]) throw new Error(`Finish the active delivery before changing its product target (${field})`);
  }
  return { ...current, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) };
}

export function deliveryWriteKind(action: string): DeliveryKind | undefined {
  return ({ save_semester: "semester", save_lesson: "lesson", save_deck: "deck", patch_deck: "deck", save_assignment: "assignment", visual: "visual", interactive_visual:"visual", add_material:"materials",save_teacher_notes:"teacher-notes",patch_teacher_notes:"teacher-notes" } as Record<string, DeliveryKind>)[action];
}

/** Validate/inject identity before a write. Revision guards remain caller-observed. */
export function prepareDeliveryCommand(snapshot: DeliverySnapshot, target: DeliveryTarget, command: CourseBuilderCommand): { target: DeliveryTarget; command: CourseBuilderCommand } {
  if(command.action==="compile_teacher_notes" && (target.kind==="teacher-notes" || target.kind==="deck")) {
    const deckId=target.kind==="teacher-notes" ? target.deckId : target.id;
    const notes=(snapshot.teacherNotes ?? []).find(item=>command.id ? item.notesId===command.id : item.deckId===deckId);
    if(!notes || notes.deckId!==deckId)throw new Error("Compile the teacher script bound to the selected delivery deck");
    return {target,command:{...command,id:notes.notesId}};
  }
  if (["save_teacher_notes","patch_teacher_notes"].includes(command.action)) {
    const deckId=target.kind === "teacher-notes" ? target.deckId : target.kind === "deck" ? target.id : undefined;
    const draft=command.draft && typeof command.draft === "object" && !Array.isArray(command.draft) ? command.draft as Record<string,unknown> : undefined;
    if (!deckId) throw new Error("Route the teacher-notes delivery or select the deck before saving a teacher script");
    if(command.action==="save_teacher_notes") {
      if(draft?.deckId!==undefined && draft.deckId!==deckId)throw new Error("Teacher script cannot change the selected deck");
      return {target,command:{...command,draft:{...draft,deckId}}};
    }
    const notes=(snapshot.teacherNotes ?? []).find(item=>item.notesId===(command.id ?? (target.kind === "teacher-notes" ? target.id : undefined)));
    if(!notes || notes.deckId!==deckId)throw new Error("Teacher script is not bound to the selected deck");
    return {target,command:{...command,id:notes.notesId}};
  }
  if (target.kind === "deck" && ["compile", "review_deck", "read_deck"].includes(command.action)) {
    if (command.id !== undefined && command.action !== "read_deck") mergeDeliveryTarget(target, resolveDeliveryTarget(snapshot, { kind: "deck", id: command.id }));
    return { target, command: { ...command, id: command.id ?? target.id } };
  }
  const kind = deliveryWriteKind(command.action);
  if (kind !== target.kind) return { target, command };
  const draft = command.draft && typeof command.draft === "object" && !Array.isArray(command.draft) ? { ...command.draft as Record<string, unknown> } : undefined;
  let selector: DeliveryTarget = { kind };
  if (command.action === "save_lesson" && draft) {
    selector = { kind, week: draft.week as number | undefined ?? target.week, session: draft.session as number | undefined ?? target.session };
  } else if (command.action === "save_deck" && draft) {
    selector = { kind, lessonPlanId: draft.lessonPlanId as string | undefined ?? target.lessonPlanId };
  } else if (command.action === "visual" || command.action === "interactive_visual") {
    selector = { kind, lessonPlanId: command.id ?? target.lessonPlanId };
  } else if (command.action === "save_assignment") {
    selector = { kind, id: command.assignmentId ?? target.id };
  } else if (command.action === "patch_deck") {
    selector = { kind, id: command.id ?? target.id };
  }
  const resolved = mergeDeliveryTarget(target, resolveDeliveryTarget(snapshot, selector));
  const next = { ...command };
  if (command.action === "save_lesson" && draft) next.draft = { ...draft, week: resolved.week, session: resolved.session };
  if (command.action === "save_deck" && draft) next.draft = { ...draft, lessonPlanId: resolved.lessonPlanId };
  if (command.action === "patch_deck") next.id = resolved.id;
  if (command.action === "save_assignment") next.assignmentId = resolved.id;
  if (command.action === "visual" || command.action === "interactive_visual") next.id = resolved.lessonPlanId;
  return { target: resolved, command: next };
}
