// PR #7 regression: exercise the real Host, approval boundaries and SQLite restore.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CourseBuilderHost, compileBeamer, reviewBeamer, assertSafeBeamerSource, assertBeamerAssets, runCourseBuilderCommand } from '../packages/course-builder-host/src/index.ts';
import { contentHash, sha256Hex } from '../packages/harness-core/src/index.ts';

export const projectInput = {
  courseId: 'linear-algebra', title: 'Linear algebra', weeks: 2, sessionsPerWeek: 1,
  minutesPerSession: 50, audience: 'Undergraduate', language: 'English', goals: ['Explain linearity'],
  beamerProfile: { aspectRatio: '169', fontSize: 11, theme: 'default', author: 'Teacher', institute: 'Department', language: 'English', overlayPolicy: 'allow', referencesPolicy: 'optional', backupSlides: 0, speakerNotes: false, preamble: null },
};
const source = String.raw`\documentclass[aspectratio=169,11pt]{beamer}
\title{Linearity}\author{Teacher}\institute{Department}
\begin{document}
\begin{frame}{Learning goal}
A linear transformation preserves sums and scalar multiplication.
\[ T(ax+by)=aT(x)+bT(y). \]
Predict the image of a sum before computing it. Check the result against the definition.
\end{frame}
\begin{frame}{Worked example}
\[ A=\begin{pmatrix}2&0\\0&1\end{pmatrix},\quad Ax=\begin{pmatrix}2x_1\\x_2\end{pmatrix}. \]
Doubling the horizontal component preserves vector addition. Try two different vectors and verify the identity independently.
\end{frame}
\end{document}`;
const semesterDraft = (materialId) => ({ title: 'Semester', rationale: 'Examples before abstraction', sessions: [1,2].map(week => ({ week, session: 1, title: `Week ${week}`, objectives: ['Explain linearity'], prerequisites: [], topics: ['Linearity'], materialIds: [materialId], activities: ['Predict and check'], understandingEvidence: ['Explain a counterexample'], assessment: null, homework: null, courseGoalsCovered: ['Explain linearity'], revisits: [], visualOpportunities: ['Matrix transform'] })) });
const lessonDraft = (materialId) => ({ week: 1, session: 1, title: 'Linearity', objectives: ['Explain linearity'], prerequisites: [], misconceptions: [], segments: [{ minutes: 45, title: 'Experiment', teacherAction: 'Demonstrate', learnerAction: 'Predict then explain', checkForUnderstanding: 'Find a counterexample' }], examples: ['Diagonal matrix'], exercises: ['Transform a vector'], materialIds: [materialId], visualRequests: [], notes: [] });
function setup() {
  const db = new DatabaseSync(':memory:');
  const host = new CourseBuilderHost(db);
  const project = host.createProject(projectInput);
  host.bindSession('teacher', project.projectId);
  const [material] = host.importMaterials('teacher', [{ name: 'notes.md', kind: 'markdown', sourceBytes: Buffer.from('Linearity'), extractedText: 'Linearity' }], 1);
  return { db, host, project, material };
}
function planned() {
  const f = setup();
  const plan = f.host.saveSemesterPlan('teacher', semesterDraft(f.material.materialId), 0);
  f.host.reviewSemesterPlan('teacher', plan.semesterPlanId, 1, 'approve', 'Approved');
  const lesson = f.host.saveLessonPlan('teacher', lessonDraft(f.material.materialId), 0, 1);
  f.host.reviewLessonPlan('teacher', lesson.lessonPlanId, 1, 'approve', 'Approved');
  const deck = f.host.saveBeamerDeck('teacher', { lessonPlanId: lesson.lessonPlanId, title: 'Linearity', source, frameOutline: ['Goal', 'Example'], assetMaterialIds: [] }, 0, 1);
  return { ...f, plan, lesson, deck };
}

test('Host rejects leaked formatting commands but permits valid monospace and literal TeX examples', () => {
  const f = planned();
  try {
    const draft = { lessonPlanId: f.lesson.lessonPlanId, title: 'Linearity', frameOutline: ['Goal'], assetMaterialIds: [] };
    const replace = (fragment) => source.replace('A linear transformation', fragment + ' A linear transformation');
    assert.throws(() => f.host.saveBeamerDeck('teacher', { ...draft, source: replace(String.raw`\\texttt{x[5]}`) }, 1, 1), /TEX_COMMAND_LEAK.*line/);
    assert.equal(f.host.getSnapshotForSession('teacher').decks[0].revision, 1);
    const legacyReview = reviewBeamer({ project: f.project, deck: { ...f.deck, source: replace(String.raw`\\texttt{x[5]}`) } });
    assert.ok(legacyReview.issues.some((issue) => issue.code === 'TEX_COMMAND_LEAK' && issue.severity === 'critical' && /line/.test(issue.location)));
    const valid = f.host.saveBeamerDeck('teacher', { ...draft, source: replace(String.raw`\\\texttt{x[5]} \verb|\\texttt{x}|`) }, 1, 1);
    assert.equal(valid.revision, 2);
  } finally { f.db.close(); }
});

test('failed compilation exposes the actual TeX error and paginated logs to the Agent', { skip: process.env.PI_TEST_XELATEX !== '1' }, async () => {
  const f = planned();
  try {
    const broken = String.raw`\documentclass[aspectratio=169,11pt]{beamer}
\begin{document}
\begin{frame}[fragile]{Broken}Text\end{frame}
\end{document}`;
    const deck = f.host.saveBeamerDeck('teacher', { lessonPlanId: f.lesson.lessonPlanId, title: 'Broken', source: broken, frameOutline: ['Broken'], assetMaterialIds: [] }, 1, 1);
    const result = await runCourseBuilderCommand(f.host, 'teacher', { action: 'compile', id: deck.deckId, expectedRevision: deck.revision }, { trustedTex: true });
    assert.equal(result.succeeded, false);
    assert.match(result.diagnostics.map(d => d.message).join('\n'), /File ended while scanning use/);
    assert.match(result.logExcerpt.text, /File ended while scanning use/);
    let fullLog = '', offset = 0;
    do {
      const part = await runCourseBuilderCommand(f.host, 'teacher', { action: 'read_compile_log', id: result.receiptId, offset, limit: 2000 });
      assert.equal(part.logHash, result.logHash);
      assert.equal(part.deckRevision, deck.revision);
      fullLog += part.text; offset = part.nextOffset;
    } while (offset !== null);
    assert.equal(fullLog, f.host.getCompileLog('teacher', result.receiptId));
    const other = f.host.createProject({ ...projectInput, courseId: 'other' });
    f.host.bindSession('other-teacher', other.projectId);
    await assert.rejects(runCourseBuilderCommand(f.host, 'other-teacher', { action: 'read_compile_log', id: result.receiptId }), /unavailable/);
  } finally { f.db.close(); }
});

test('patch_deck preserves unrelated source and rejects ambiguous or stale edits atomically', async () => {
  const f = planned();
  try {
    const patch = { action: 'patch_deck', id: f.deck.deckId, expectedRevision: 1, parentRevision: 1, draft: { edits: [{oldText:'Learning goal',newText:'Our learning goal'}] } };
    await assert.rejects(runCourseBuilderCommand(f.host,'teacher',{...patch,draft:{edits:[{oldText:'Learning goal',newText:'Changed'},{oldText:'not present',newText:'bad'}]}}),/exactly once/);
    assert.equal(f.host.getSnapshotForSession('teacher').decks[0].source, f.deck.source);
    await assert.rejects(runCourseBuilderCommand(f.host,'teacher',{...patch,draft:{edits:[{oldText:'frame',newText:'bad'}]}}),/exactly once/);
    const saved=await runCourseBuilderCommand(f.host,'teacher',patch);
    assert.equal(saved.deckId,f.deck.deckId);
    assert.equal(saved.revision,2);
    assert.equal(f.host.getSnapshotForSession('teacher').decks[0].source,f.deck.source.replace('Learning goal','Our learning goal'));
    await assert.rejects(runCourseBuilderCommand(f.host,'teacher',patch),/current deck/);
  } finally {f.db.close();}
});

test('PR #7: draft, approval, deck and original source survive fresh Host construction', () => {
  const f = planned();
  const recovered = new CourseBuilderHost(f.db);
  assert.deepEqual(recovered.getSnapshotForSession('teacher'), f.host.getSnapshotForSession('teacher'));
  assert.equal(Buffer.from(recovered.getMaterialBytes('teacher', f.material.materialId)).toString(), 'Linearity');
  f.db.close();
});

test('Course Builder restores version 1 databases created before Assignment workflows', () => {
  const f = setup();
  const row = f.db.prepare('SELECT value FROM course_builder_state').get();
  const state = JSON.parse(row.value);
  delete state.assignments;
  delete state.bindings[0].agentAssignmentId;
  f.db.prepare('UPDATE course_builder_state SET value=?').run(JSON.stringify(state));
  const recovered = new CourseBuilderHost(f.db);
  assert.deepEqual(recovered.getSnapshotForSession('teacher').assignments, []);
  f.db.close();
});

test('PR #7: agent cannot forge approvals or skip teacher review', () => {
  const { db, host, material } = setup();
  assert.throws(() => host.saveSemesterPlan('teacher', { ...semesterDraft(material.materialId), approved: true }, 0), /controlled by the teacher/);
  assert.throws(() => host.saveLessonPlan('teacher', lessonDraft(material.materialId), 0, 1), /Approve/);
  const plan = host.saveSemesterPlan('teacher', semesterDraft(material.materialId), 0);
  assert.throws(() => host.reviewSemesterPlan('teacher', plan.semesterPlanId, 0, 'approve', ''), /Expected/);
  db.close();
});

test('PR #7: revision conflicts still protect writes while cosmetic edits preserve approved planning', () => {
  const f = planned();
  const second = new CourseBuilderHost(f.db);
  f.host.updateProject(f.project.projectId, { ...projectInput, title: 'Changed title' }, 2);
  assert.throws(() => second.updateProject(f.project.projectId, projectInput, 2), /Expected/);
  assert.equal(second.getProject(f.project.projectId).title, 'Changed title');
  assert.equal(second.getDeckForCompile('teacher', f.deck.deckId).deck.deckId, f.deck.deckId);
  f.db.close();
});

test('reference imports preserve semester approval and downstream work; planning changes invalidate it', () => {
  const f = planned();
  try {
    const approved = f.host.getSnapshotForSession('teacher').semesterPlan;
    f.host.importMaterials('teacher', [{ name: 'extra-questions.md', kind: 'markdown', sourceBytes: Buffer.from('Extra practice'), extractedText: 'Extra practice' }], 2);
    const restored = new CourseBuilderHost(f.db);
    assert.deepEqual(restored.getSnapshotForSession('teacher').semesterPlan, approved);
    assert.equal(restored.getDeckForCompile('teacher', f.deck.deckId).deck.deckId, f.deck.deckId);
    const lesson = restored.saveLessonPlan('teacher', lessonDraft(f.material.materialId), 1, 1);
    assert.equal(lesson.revision, 2);
    restored.updateProject(f.project.projectId, { ...projectInput, goals: ['Explain determinants'] }, 3);
    assert.throws(() => restored.saveLessonPlan('teacher', lessonDraft(f.material.materialId), 2, 1), /Semester Plan changed/);
  } finally { f.db.close(); }
});

test('legacy approved plans remain usable after material-only revisions without rewriting review history', () => {
  const f = planned();
  try {
    f.host.importMaterials('teacher', [{ name: 'extra.md', kind: 'markdown', sourceBytes: Buffer.from('Practice'), extractedText: 'Practice' }], 2);
    const state = JSON.parse(f.db.prepare('SELECT value FROM course_builder_state').get().value);
    for (const project of state.projects) { delete project.planningRevision; const { contentHash: _, ...payload } = project; project.contentHash = contentHash(payload); }
    for (const plan of state.semesterPlans) { delete plan.projectPlanningRevision; const { contentHash: _, ...payload } = plan; plan.contentHash = contentHash(payload); }
    f.db.prepare('UPDATE course_builder_state SET value=?').run(JSON.stringify(state));
    const restored = new CourseBuilderHost(f.db);
    assert.deepEqual(restored.getSnapshotForSession('teacher').semesterPlan, state.semesterPlans[0]);
    assert.equal(restored.getDeckForCompile('teacher', f.deck.deckId).deck.deckId, f.deck.deckId);
    restored.updateProject(f.project.projectId, { ...projectInput, minutesPerSession: 40 }, 3);
    assert.throws(() => restored.getDeckForCompile('teacher', f.deck.deckId), /current approved Semester/);
  } finally { f.db.close(); }
});

test('PR #7: changing parent Semester Plan invalidates approved lessons and decks', () => {
  const f = planned();
  f.host.saveSemesterPlan('teacher', semesterDraft(f.material.materialId), 1);
  assert.throws(() => f.host.getDeckForCompile('teacher', f.deck.deckId), /current approved Semester/);
  assert.throws(() => f.host.saveLessonPlan('teacher', lessonDraft(f.material.materialId), 1, 1), /Approve/);
  f.db.close();
});

test('PR #7: entire import batch rolls back and cross-project sources are rejected', () => {
  const f = setup();
  const input = { name: 'more.md', kind: 'markdown', sourceBytes: Buffer.from('more'), extractedText: 'more' };
  assert.throws(() => f.host.importMaterials('teacher', [input, input], 2), /already exists/);
  assert.equal(f.host.getSnapshotForSession('teacher').materials.length, 1);
  const other = f.host.createProject({ ...projectInput, courseId: 'other' });
  f.host.bindSession('other-session', other.projectId);
  assert.throws(() => f.host.getMaterialBytes('other-session', f.material.materialId), /not available/);
  assert.throws(() => f.host.bindSession('teacher', other.projectId), /silently rebound/);
  f.db.close();
});

test('PR #7: successful receipt requires matching PDF and log bytes', () => {
  const f = planned();
  const payload = { receiptId: 'test-receipt', projectId: f.project.projectId, deckId: f.deck.deckId, deckRevision: 1, sourceHash: f.deck.sourceHash, compiler: 'test', arguments: [], succeeded: true, exitCode: 0, pageCount: 2, pdfHash: null, logHash: `sha256:${sha256Hex('ok')}`, diagnostics: [], createdAt: new Date().toISOString() };
  assert.throws(() => f.host.recordCompile('teacher', { ...payload, contentHash: contentHash(payload) }, null, 'ok'), /actual PDF/);
  f.db.close();
});

test('PR #7: TeX direct reads, encoded primitives and graphic path escape are blocked', () => {
  for (const fragment of [String.raw`\input{/etc/passwd}`, String.raw`\write18{touch x}`, String.raw`^^5cinput{x}`, String.raw`\csname input\endcsname{x}`]) assert.throws(() => assertSafeBeamerSource(source.replace('\\end{document}', `${fragment}\n\\end{document}`)), /primitive/);
  assert.throws(() => assertBeamerAssets(source + String.raw`\includegraphics{../../secret.pdf}`, []), /Unknown published/);
});

test('PR #7: corrupt persistent content fails closed', () => {
  const f = planned();
  const row = f.db.prepare('SELECT value FROM course_builder_state').get();
  const state = JSON.parse(row.value); state.projects[0].title = 'tampered';
  f.db.prepare('UPDATE course_builder_state SET value=?').run(JSON.stringify(state));
  assert.throws(() => new CourseBuilderHost(f.db), /invalid content hash/);
  f.db.close();
});

// This is a real compiler test, not a fake success marker. Enable explicitly in CI.
test('PR #7: real XeLaTeX -> PDF -> review -> teacher acceptance -> restart', { skip: process.env.PI_TEST_XELATEX !== '1' }, async () => {
  const f = planned();
  try {
    const result = await compileBeamer(f.host.getDeckForCompile('teacher', f.deck.deckId));
    assert.equal(result.receipt.succeeded, true, result.log);
    assert.equal(result.receipt.pageCount, 2);
    f.host.recordCompile('teacher', result.receipt, result.artifact, result.log);
    const review = reviewBeamer({ project: f.project, deck: f.deck, compileReceipt: result.receipt });
    assert.equal(review.status, 'pass', JSON.stringify(review.issues));
    f.host.recordDeckReview('teacher', review);
    f.host.acceptDeck('teacher', f.deck.deckId, 1, result.receipt.receiptId, review.reviewId);
    const reopened = new CourseBuilderHost(f.db);
    assert.equal(reopened.getSnapshotForSession('teacher').decks[0].status, 'accepted');
    assert.equal(sha256Hex(reopened.getCompiledPdf('teacher', result.receipt.receiptId)), result.receipt.pdfHash.slice(7));
    assert.equal(reopened.getCompileLog('teacher', result.receipt.receiptId), result.log);
    assert.throws(() => reopened.revokeDeckAcceptance('teacher', f.deck.deckId, 2), /changed/);
    reopened.revokeDeckAcceptance('teacher', f.deck.deckId, 1);
    const cancelled = new CourseBuilderHost(f.db);
    assert.equal(cancelled.getSnapshotForSession('teacher').decks[0].acceptedAt, null);
    assert.equal(cancelled.getSnapshotForSession('teacher').decks[0].source, source);
    cancelled.acceptDeck('teacher', f.deck.deckId, 1, result.receipt.receiptId, review.reviewId);
    const next = cancelled.saveBeamerDeck('teacher', { lessonPlanId: f.lesson.lessonPlanId, title: f.deck.title, source: source.replace('Try two different', 'Try three different'), frameOutline: f.deck.frameOutline, assetMaterialIds: [] }, 1, 1);
    assert.equal(next.revision, 2);
    assert.equal(next.status, 'draft');
    const history = JSON.parse(f.db.prepare('SELECT value FROM course_builder_state').get().value).decks;
    assert.equal(history.find((deck) => deck.revision === 1).status, 'accepted');
    assert.equal(history.find((deck) => deck.revision === 1).source, source);
  } finally { f.db.close(); }
});

test('PR #7: model command surface cannot approve, accept or smuggle private source in state', async () => {
 const {runCourseBuilderCommand}=await import('../packages/course-builder-host/src/index.ts');
 const f=planned();
 for(const action of ['approve','accept','review_semester','review_lesson']) await assert.rejects(runCourseBuilderCommand(f.host,'teacher',{action}),/not available/);
 const state=await runCourseBuilderCommand(f.host,'teacher',{action:'state'});
 assert.equal('source' in state.decks[0],false);
 assert.equal('extractedText' in state.materials[0],false);
 const templates=await runCourseBuilderCommand(f.host,'teacher',{action:'visual_templates'});
 assert.equal(templates.contract.courseVersionId,f.project.projectId);
 assert.deepEqual(templates.kinds.map(item=>item.kind),['function-plot','matrix-transform','algorithm-trace','graph-trace','state-machine']);
 const visual=await runCourseBuilderCommand(f.host,'teacher',{action:'visual',id:f.lesson.lessonPlanId,purpose:'Predict and compare a shear transformation',spec:{...templates.kinds[1].example,specId:'lesson-shear'}});
 assert.equal(visual.projectId,f.project.projectId);
 assert.match(visual.artifact.html,/Content-Security-Policy/);
 await assert.rejects(runCourseBuilderCommand(f.host,'teacher',{action:'compile',id:f.deck.deckId,expectedRevision:1}),/disabled/);
 f.db.close();
});

test('PR #7: real composition root owns one shared SQLite connection and restores builder', async()=>{
 const {LearningHarness}=await import('../packages/learning-harness/src/index.ts');
 const harness=new LearningHarness({databasePath:':memory:'});
 const p=harness.courseBuilder.createProject(projectInput);harness.courseBuilder.bindSession('teacher',p.projectId);
 assert.equal(harness.courseBuilder.getSnapshotForSession('teacher').project.projectId,p.projectId);
 harness.close();
});

test('PR #7: asynchronous runtime admission completes before a draft can be written', async () => {
  const { runCourseBuilderCommand } = await import('../packages/course-builder-host/src/index.ts');
  const f = setup();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const draft = { topicChains: ['Linearity'], prerequisiteGaps: [], duplicates: [], sequenceGaps: [], terminologyConflicts: [], practiceOpportunities: [], visualOpportunities: [] };
  const pending = runCourseBuilderCommand(f.host, 'teacher', { action: 'save_analysis', draft }, { assertActive: () => gate });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.host.getSnapshotForSession('teacher').materialAnalysis, null, 'A pending admission must not publish a draft');
  } finally {
    release();
    await pending;
    f.db.close();
  }
});

test('PR #7: asynchronous post-compile runtime verification completes before receipt persistence', { skip: process.env.PI_TEST_XELATEX !== '1' }, async () => {
  const { runCourseBuilderCommand } = await import('../packages/course-builder-host/src/index.ts');
  const f = planned();
  let checks = 0, entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pending = runCourseBuilderCommand(f.host, 'teacher', { action: 'compile', id: f.deck.deckId, expectedRevision: 1 }, {
    trustedTex: true,
    assertActive: () => { if (++checks === 2) { entered(); return gate; } },
  });
  try {
    await Promise.race([reached, pending.then(() => { throw new Error('Post-compile runtime check was skipped'); })]);
    assert.equal(f.host.getSnapshotForSession('teacher').compileReceipts.length, 0, 'Do not persist while runtime verification is pending');
  } finally {
    release();
    await pending;
    f.db.close();
  }
});
