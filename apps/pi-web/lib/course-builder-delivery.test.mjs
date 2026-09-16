import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { CourseDeliveryLoop } = await createJiti(import.meta.url).import("./course-builder-delivery.ts");
function fixture() {
  let saved;
  const snapshot = { project:{projectId:"project",revision:1},materials:[],semesterPlan: null, lessonPlans: [], assignments: [], visuals: [], decks: [{ deckId: "deck", revision: 17, sourceHash: "old", source: "The R Workspace" }], compileReceipts: [], deckReviews: [] };
  const io = { snapshot: () => {const result=structuredClone(snapshot); for(const key of ["decks","lessonPlans","compileReceipts","deckReviews"]) result[key]=result[key].map(item=>({projectId:result.project.projectId,...item}));return result;}, load: () => structuredClone(saved), save: (task) => { saved = structuredClone(task); } };
  const loop = new CourseDeliveryLoop(io);
  loop.start("Restore all source sections including workspace AND getting help, not a partial patch.");
  const requirements = [{ id: "workspace", text: "Restore R Workspace", verification:"content" }, { id: "help", text: "Restore Getting Help", verification:"content" }];
  return { loop, io, snapshot, requirements, task: () => saved };
}

test("teacher notes bind to an existing old deck without new semester approval or deck edits", () => {
  const f=fixture();
  f.snapshot.lessonPlans.push({lessonPlanId:"lesson",revision:1,week:9,session:2});
  f.snapshot.decks[0].lessonPlanId="lesson";
  f.snapshot.semesterPlan={semesterPlanId:"semester",revision:2,sessions:[]};
  f.snapshot.teacherNotes=[];
  const originalDeck=structuredClone(f.snapshot.decks[0]);
  f.loop.start("Write the teacher lecture script for the old deck",{kind:"teacher-notes",deckId:"deck"});
  f.loop.route({kind:"teacher-notes",requirements:[{id:"spoken",text:"Explain the formula aloud",verification:"content"}]});
  const draft={deckRevision:17,title:"Teacher script",source:String.raw`Explain why $e^{i\pi}+1=0$ connects the constants.`};
  const command=f.loop.prepare({action:"save_teacher_notes",draft,expectedRevision:0});
  assert.equal(command.draft.deckId,"deck");
  assert.throws(()=>f.loop.prepare({action:"save_teacher_notes",draft:{...draft,deckId:"other"}}),/selected deck/);
  const notes={...command.draft,notesId:"host-notes",lessonPlanId:"lesson",revision:1,sourceHash:"notes-hash",deckSourceHash:"old"};
  f.snapshot.teacherNotes.push(notes);f.loop.observe(command,notes);
  assert.equal(f.loop.status().teacherNotesGate.ready,false,"saving script alone does not deliver its PDF");
  assert.throws(()=>f.loop.finish({checks:[{requirementId:"spoken",quote:draft.source}]}),/compile_teacher_notes/);
  f.snapshot.teacherNotesCompileReceipts=[{projectId:"project",receiptId:"notes-pdf",notesId:notes.notesId,notesRevision:notes.revision,sourceHash:notes.sourceHash,deckId:notes.deckId,deckRevision:notes.deckRevision,deckSourceHash:notes.deckSourceHash,succeeded:true}];
  assert.equal(new CourseDeliveryLoop(f.io).status().teacherNotesGate.ready,true);
  assert.equal(f.loop.finish({checks:[{requirementId:"spoken",quote:draft.source}]}).delivered.id,"host-notes");
  assert.deepEqual(f.snapshot.decks[0],originalDeck);
});

test("combined Beamer delivery cannot finish with missing or stale lecture notes", () => {
  const f=fixture();f.snapshot.teacherNotes=[];
  f.loop.start("Generate slides and a full teacher script",{kind:"deck",id:"deck",includeTeacherNotes:true});
  f.loop.route({kind:"deck",requirements:[{id:"spoken",text:"Teacher explanation",verification:"content"}]});
  assert.throws(()=>f.loop.route({kind:"deck",includeTeacherNotes:false,requirements:[{id:"spoken",text:"Teacher explanation",verification:"content"}]}),/product target/);
  f.snapshot.decks[0].revision=18;
  f.snapshot.compileReceipts.push({receiptId:"compile",deckId:"deck",deckRevision:18,sourceHash:"old",succeeded:true});
  f.snapshot.deckReviews.push({reviewId:"review",deckId:"deck",deckRevision:18,sourceHash:"old",compileReceiptId:"compile",status:"pass"});
  const checks=[{requirementId:"spoken",quote:"The R Workspace"}];
  assert.throws(()=>f.loop.finish({checks}),/Teacher notes delivery is unfinished/);
  f.snapshot.teacherNotes.push({notesId:"notes",deckId:"deck",revision:1,deckRevision:17,deckSourceHash:"old",sourceHash:"notes-hash",source:"Explain why the workspace retains variables between commands."});
  assert.throws(()=>f.loop.finish({checks}),/Teacher notes delivery is unfinished/);
  f.snapshot.teacherNotes[0].deckRevision=18;
  const script=f.snapshot.teacherNotes[0];
  const receipt={projectId:"project",receiptId:"notes-pdf",notesId:script.notesId,notesRevision:script.revision,sourceHash:script.sourceHash,deckId:script.deckId,deckRevision:script.deckRevision,deckSourceHash:script.deckSourceHash,succeeded:true};
  f.snapshot.teacherNotesCompileReceipts=[receipt,{...receipt,receiptId:"new-failed",succeeded:false,diagnostics:[{message:"Undefined control sequence"}]}];
  assert.throws(()=>f.loop.finish({checks}),/read_teacher_notes_compile_log.*new-failed/);
  f.snapshot.teacherNotesCompileReceipts.push({...receipt,receiptId:"recompiled"});
  const done=f.loop.finish({checks:[{requirementId:"spoken",quote:f.snapshot.teacherNotes[0].source}]});
  assert.deepEqual(done.delivered.additionalArtifacts,[{notesId:"notes",revision:1,sourceHash:"notes-hash"}]);
});

test("procedural verification uses Host receipts instead of unrelated slide quotations", () => {
  const f = fixture();
  f.snapshot.project={projectId:"project",revision:1};f.snapshot.materials=[];f.snapshot.decks[0].projectId="project";
  f.loop.route({kind:"deck",id:"deck",requirements:[{id:"verify",text:"Compile and pass review",verification:"compile-review"}]});
  f.snapshot.decks[0].revision=18;
  f.snapshot.compileReceipts.push({projectId:"project",receiptId:"compile",deckId:"deck",deckRevision:18,sourceHash:"old",succeeded:true});
  f.snapshot.deckReviews.push({projectId:"project",reviewId:"review",deckId:"deck",deckRevision:18,sourceHash:"old",compileReceiptId:"compile",status:"pass"});
  f.loop.observe({action:"delivery_finish"},null,"Previous stale quote error");
  assert.deepEqual(f.loop.status().finishTemplate,{checks:[]});
  assert.equal(f.loop.finish({checks:[]}).delivered.hostEvidence[0].requirementId,"verify");
  assert.equal(f.task().lastError,undefined);
});

test("status allocates stable requirement IDs and legacy active tasks must explicitly classify evidence", () => {
  const f=fixture();
  const req={text:"Restore the complete workspace explanation",verification:"content"};
  f.loop.route({kind:"deck",id:"deck",requirements:[req]});
  const id=f.task().requirements[0].id;
  assert.match(id,/^req-/);
  f.loop.route({kind:"deck",requirements:[req]});
  assert.equal(f.task().requirements.length,1);
  assert.deepEqual(f.loop.status().finishTemplate,{checks:[{requirementId:id,quote:""}]});
  f.io.save({...f.task(),requirements:[{id,text:req.text}]});
  assert.equal(f.loop.status().finishTemplate,null);
  f.loop.route({kind:"deck",requirements:[{id,...req}]});
  assert.equal(f.loop.status().finishTemplate.checks[0].requirementId,id);
  assert.throws(()=>f.loop.route({kind:"deck",requirements:[{id,...req,verification:"compile-review"}]}),/verification type/);
});

test("material body evidence is checked against the read-back window, never a filename or metadata", () => {
  const f=fixture();f.snapshot.project={projectId:"project",revision:1};f.snapshot.materials=[];
  f.loop.route({kind:"materials",requirements:[{id:"chapter",text:"Capture the chapter body",verification:"content"}]});
  f.snapshot.materials.push({materialId:"m",name:"A captured chapter.md",metadata:{}});
  f.loop.observe({action:"add_material"},{projectId:"project",materials:[{materialId:"m"}]});
  const checks=[{requirementId:"chapter",materialId:"m",offset:120,quote:"The likelihood defines our objective."}];
  assert.throws(()=>f.loop.finish({checks}),/read_material text window/);
  assert.throws(()=>f.loop.finish({checks:[{...checks[0],materialId:"other"}]}),/imported by this delivery/);
  const result=f.loop.finish({checks},{chapter:"## Optimization\nThe likelihood defines our objective."});
  assert.equal(result.status,"completed");assert.equal(result.delivered.checks[0].offset,120);
});

test("auxiliary material imports have Host evidence without changing a lesson delivery target", () => {
  const f=fixture();
  f.snapshot.lessonPlans.push({lessonPlanId:"lesson",revision:1,title:"Numerical optimization with the new reference"});
  f.loop.route({kind:"lesson",id:"lesson",requirements:[{id:"lesson-content",text:"Update the lesson",verification:"content"},{id:"reference",text:"Import the new reference during preparation",verification:"materials"}]});
  f.snapshot.materials.push({materialId:"reference",sourceHash:"sha256:reference",metadata:{materialScope:"course"}});
  f.loop.observe({action:"add_material"},{projectId:"project",materials:[{materialId:"reference"}]});
  assert.equal(f.task().target.kind,"lesson");assert.equal(f.task().target.id,"lesson");
  assert.deepEqual(f.loop.materialImportsToVerify(),["reference"]);
  assert.equal(f.loop.finish({checks:[{requirementId:"lesson-content",quote:"Numerical optimization with the new reference"}]}).delivered.hostEvidence[0].records[0].materialId,"reference");
});

test("a body quote cannot stand in for absent compile receipts and completion clears stale errors", () => {
  const f=fixture();
  f.snapshot.project={projectId:"project",revision:1};f.snapshot.materials=[];f.snapshot.decks[0].projectId="project";
  f.loop.route({kind:"deck",id:"deck",requirements:[{id:"verify",text:"Compile and pass review",verification:"compile-review"}]});
  f.snapshot.decks[0].revision=18;
  assert.throws(()=>f.loop.finish({checks:[{requirementId:"verify",quote:"The R Workspace"}]}),/content checks only/);
  assert.throws(()=>f.loop.finish({checks:[]}),/unfinished/);
  assert.equal(f.task().status,"active");
});

test("only an unbound direct-chat routing mistake can be corrected explicitly", () => {
  const f=fixture();f.snapshot.project={projectId:"project",revision:1};f.snapshot.materials=[];
  const requirements=[{text:"Capture the requested content",verification:"content"}];
  f.loop.route({kind:"visual",requirements});
  assert.throws(()=>f.loop.route({kind:"materials",requirements}),/product target/);
  f.loop.route({kind:"materials",requirements,correctRoutingReason:"This is source acquisition"});
  assert.equal(f.task().target.kind,"materials");assert.equal(f.task().requirements.length,1);
  assert.throws(()=>f.loop.route({kind:"visual",requirements,correctRoutingReason:"Change again"}),/saved or workspace-selected/);
});

test("supplemental files complete a materials delivery without pretending to be a visual", () => {
  const f = fixture();
  f.snapshot.project={projectId:"project",revision:1}; f.snapshot.materials=[];
  f.loop.route({kind:"materials",requirements:[{id:"source",text:"Import the user source", verification:"materials"}]});
  f.snapshot.materials.push({materialId:"source",name:"numerical-optimization.md",metadata:{storage:"local-link",sourceRoot:"/existing/library"}});
  f.snapshot.project.revision=2;
  f.loop.observe({action:"add_material"},{projectId:"project",revision:2,materials:[{materialId:"source"}]});
  assert.equal(f.loop.finish({checks:[]}).status,"completed");
});

test("a deck delivery binds the Host artifact for its lesson instead of locking a lesson ID as a deck ID", () => {
  const f = fixture();
  f.snapshot.lessonPlans.push({ lessonPlanId: "lesson", revision: 1 });
  f.snapshot.decks[0].lessonPlanId = "lesson";
  f.loop.route({ kind: "deck", id: "lesson", requirements: f.requirements });
  assert.equal(f.task().target.id, "deck");
});
test("an acknowledgement or a successful compile cannot end a delivery; every requirement needs new artifact evidence", () => {
  const f = fixture();
  assert.equal(f.loop.end("stop").continue, true, "no routing must continue");
  f.loop.route({ kind: "deck", id: "deck", requirements: f.requirements });
  assert.equal(f.loop.end("stop").continue, true, "a promise without an artifact must continue");
  f.snapshot.decks[0] = { deckId: "deck", revision: 18, sourceHash: "new", source: "The R Workspace\nGetting Help in R" };
  f.loop.observe({ action: "patch_deck" }, { deckId: "deck", revision: 18 });
  const checks = [{ requirementId: "workspace", quote: "The R Workspace" }, { requirementId: "help", quote: "Getting Help in R" }];
  assert.throws(() => f.loop.finish({ id: "deck", checks }), /compile/);
  f.snapshot.compileReceipts.push({ receiptId: "compile", deckId: "deck", deckRevision: 18, sourceHash: "new", succeeded: true });
  f.snapshot.deckReviews.push({ reviewId: "review", deckId: "deck", deckRevision: 18, sourceHash: "new", compileReceiptId: "compile", status: "pass" });
  assert.throws(() => f.loop.finish({ id: "deck", checks: checks.slice(0, 1) }), /Incomplete/);
  assert.throws(() => f.loop.finish({ checks: [checks[0], { requirementId: "renamed-by-model", quote: "Getting Help in R" }] }), /missing=\["help"\].*unknown=\["renamed-by-model"\]/);
  assert.throws(() => f.loop.finish({ id: "deck", checks: [checks[0], { requirementId: "help", quote: "Invented evidence" }] }), /no matching/);
  assert.equal(f.loop.end("stop").continue, true, "passing compile and review is insufficient until ALL checks complete");
  const restored = new CourseDeliveryLoop(f.io);
  assert.equal(restored.finish({ id: "deck", checks }).status, "completed");
  assert.equal(restored.end("stop"), null);
});

test("new deck IDs come from Host saves; stale parent-ID bindings recover without another deck revision", () => {
  const f = fixture();
  f.snapshot.semesterPlan = { semesterPlanId: "semester", revision: 1, sessions: [{ week: 2, session: 1 }] };
  f.snapshot.lessonPlans.push({ lessonPlanId: "lesson", revision: 1, week: 2, session: 1 });
  f.loop.route({ kind: "deck", week: 2, session: 1, requirements: f.requirements });
  assert.equal(f.task().target.id, undefined, "never allocate a deck ID from a model string");
  assert.equal(f.task().target.lessonPlanId, "lesson");
  const command = f.loop.prepare({ action: "save_deck", draft: { source: "The R Workspace\nGetting Help in R" }, expectedRevision: 0, parentRevision: 1 });
  assert.equal(command.draft.lessonPlanId, "lesson", "Host injects selected parent");
  const deck = { deckId: "host-deck", lessonPlanId: "lesson", revision: 1, sourceHash: "saved", source: command.draft.source };
  f.snapshot.decks.push(deck);
  f.loop.observe(command, deck);
  assert.equal(f.task().target.id, "host-deck");
  f.snapshot.compileReceipts.push({ receiptId: "compile", deckId: deck.deckId, deckRevision: 1, sourceHash: "saved", succeeded: true });
  f.snapshot.deckReviews.push({ reviewId: "review", deckId: deck.deckId, deckRevision: 1, sourceHash: "saved", compileReceiptId: "compile", status: "pass" });
  const originalBaseline = f.task().baseline;
  f.io.save({ ...f.task(), target: { kind: "deck", id: "lesson" }, status: "blocked", lastError: "Wrong delivery target" });
  const restored = new CourseDeliveryLoop(f.io);
  restored.restore();
  assert.deepEqual(f.task().baseline, originalBaseline);
  assert.equal(f.task().target.id, "host-deck");
  assert.equal(f.task().status, "blocked", "repair binding does not manufacture completion");
  assert.equal(f.task().bindingRepair.previous.id, "lesson");
  restored.start("Continue the saved work");
  restored.route({ kind: "deck", requirements: f.requirements });
  assert.equal(restored.finish({ checks: [{ requirementId: "workspace", quote: "The R Workspace" }, { requirementId: "help", quote: "Getting Help in R" }] }).delivered.id, "host-deck");
  assert.equal(f.snapshot.decks.at(-1).revision, 1, "no artificial save needed to fix binding");
});

test("invalid references and a different lesson cannot bind, write, or finish the selected delivery", () => {
  const f = fixture();
  f.snapshot.semesterPlan = { semesterPlanId: "semester", revision: 1, sessions: [{ week: 1, session: 1 }, { week: 2, session: 1 }] };
  f.snapshot.lessonPlans.push({ lessonPlanId: "lesson", revision: 1, week: 2, session: 1 }, { lessonPlanId: "other", revision: 1, week: 1, session: 1 });
  f.snapshot.decks[0].lessonPlanId = "other";
  const before = structuredClone(f.task());
  assert.throws(() => f.loop.route({ kind: "deck", id: "made-up-or-other-course", requirements: f.requirements }), /does not exist/);
  assert.deepEqual(f.task(), before, "bad references fail before changing durable state");
  f.loop.start("Generate the selected lesson slides", { kind: "deck", week: 2, session: 1 });
  assert.throws(() => f.loop.route({ kind: "question", reason: "Skip checklist" }), /route its requirements/);
  assert.throws(() => f.loop.route({ kind: "deck", id: "deck", requirements: f.requirements }), /product target/);
  f.loop.route({ kind: "deck", requirements: f.requirements });
  assert.throws(() => f.loop.prepare({ action: "save_deck", draft: { lessonPlanId: "other" } }), /product target/);
  assert.throws(() => f.loop.prepare({ action: "patch_deck", id: "deck" }), /product target/);
  assert.throws(() => f.loop.finish({ id: "deck", checks: [] }), /not saved\/bound/);
  assert.equal(f.task().target.lessonPlanId, "lesson");
});

test("an unbound direct-chat delivery cannot complete another conversation's saved artifact", () => {
  const f = fixture(); f.loop.route({ kind: "deck", requirements: f.requirements });
  f.snapshot.decks.push({ deckId: "concurrent", revision: 1, source: "The R Workspace" });
  assert.throws(() => f.loop.finish({ id: "concurrent", checks: [] }), /not saved\/bound/);
});

test("visual identity uses visualId, never its lessonPlanId", () => {
  const f = fixture();
  f.snapshot.lessonPlans.push({ lessonPlanId: "lesson", revision: 1 });
  f.loop.route({ kind: "visual", lessonPlanId: "lesson", requirements: f.requirements });
  const visual = { visualId: "host-visual", lessonPlanId: "lesson", learningPurpose: "The R Workspace and Getting Help in R" };
  f.snapshot.visuals.push(visual); f.loop.observe({ action: "visual" }, visual);
  assert.equal(f.task().target.id, "host-visual");
  assert.equal(f.loop.finish({ checks: [{ requirementId: "workspace", quote: "The R Workspace" }, { requirementId: "help", quote: "Getting Help in R" }] }).delivered.id, "host-visual");
});
test("follow-up instructions retain original requirements and baseline; a status question does not drop active work", () => {
  const f = fixture(); f.loop.route({ kind: "deck", id: "deck", requirements: f.requirements });
  f.loop.start("Finish before stopping");
  f.loop.route({ kind: "question", reason: "The user reiterates the instruction" });
  assert.equal(f.task().status, "active");
  assert.equal(f.task().baseline.deck, 17);
  assert.deepEqual(f.task().requirements, f.requirements);
  assert.throws(() => f.loop.route({ kind: "deck", id: "deck", requirements: [{ id: "help", text: "Only fix Workspace", verification:"content" }] }), /replace/);
});
test("questions need no production loop; errors and user abort are explicit unfinished states", () => {
  const f = fixture(); f.loop.route({ kind: "question", reason: "No artifact requested" });
  assert.equal(f.loop.end("stop"), null);
  assert.throws(() => f.loop.assertProductionAction("patch_deck"), /Route/);
  f.loop.start("Now edit the deck"); f.loop.route({ kind: "deck", id: "deck", requirements: f.requirements });
  assert.equal(f.loop.end("aborted").continue, false); assert.equal(f.task().status, "cancelled");
  f.loop.start("Resume"); assert.equal(f.loop.end("error"), null); assert.equal(f.task().status, "routing", "native provider retries retain the task");
  assert.match(f.loop.settled(), /原生重试已结束/); assert.equal(f.task().status, "blocked");
});
test("recoverable errors loop, repeated zero-progress cannot silently masquerade as delivery", () => {
  const f = fixture(); f.loop.route({ kind: "deck", id: "deck", requirements: f.requirements });
  f.loop.observe({ action: "compile" }, null, "TeX overflow, line 42");
  assert.equal(f.loop.end("stop").continue, true);
  assert.equal(f.loop.end("stop").continue, true);
  const stopped = f.loop.end("stop");
  assert.equal(stopped.continue, false); assert.match(stopped.message, /TeX overflow/);
  assert.equal(f.task().status, "blocked"); assert.equal(f.task().delivered, undefined);
});
