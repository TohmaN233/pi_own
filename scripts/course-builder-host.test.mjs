// PR #7 regression: exercise the real Host, approval boundaries and SQLite restore.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CourseBuilderHost, compileBeamer, reviewBeamer, assertSafeBeamerSource, assertBeamerAssets } from '../packages/course-builder-host/src/index.ts';
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

test('PR #7: draft, approval, deck and original source survive fresh Host construction', () => {
  const f = planned();
  const recovered = new CourseBuilderHost(f.db);
  assert.deepEqual(recovered.getSnapshotForSession('teacher'), f.host.getSnapshotForSession('teacher'));
  assert.equal(Buffer.from(recovered.getMaterialBytes('teacher', f.material.materialId)).toString(), 'Linearity');
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

test('PR #7: revision conflicts and concurrent instances do not clobber state', () => {
  const f = planned();
  const second = new CourseBuilderHost(f.db);
  f.host.updateProject(f.project.projectId, { ...projectInput, title: 'Changed title' }, 2);
  assert.throws(() => second.updateProject(f.project.projectId, projectInput, 2), /Expected/);
  assert.equal(second.getProject(f.project.projectId).title, 'Changed title');
  assert.throws(() => second.getDeckForCompile('teacher', f.deck.deckId), /current approved Semester/);
  f.db.close();
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
  } finally { f.db.close(); }
});

test('PR #7: model command surface cannot approve, accept or smuggle private source in state', async () => {
 const {runCourseBuilderCommand}=await import('../packages/course-builder-host/src/index.ts');
 const f=planned();
 for(const action of ['approve','accept','review_semester','review_lesson']) await assert.rejects(runCourseBuilderCommand(f.host,'teacher',{action}),/not available/);
 const state=await runCourseBuilderCommand(f.host,'teacher',{action:'state'});
 assert.equal('source' in state.decks[0],false);
 assert.equal('extractedText' in state.materials[0],false);
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
