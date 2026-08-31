import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BUILTIN_MODE_PACKS,
  canonicalModePackId,
  modePackHash,
  modeTransitionKind,
  parseModePackDefinition,
  resolveModePack,
  ModePackError,
} from '../packages/profile-resource-host/src/mode-packs.ts';
import {
  ModePackRegistry,
} from '../packages/learning-harness/src/mode-pack-registry.ts';
import {
  EDUCATION_SKILLS,
  advanceEducationWorkflow,
  approvePersonalSkill,
  computeInsertionSortTrace,
  computeMatrixTransform,
  createComputationReceipt,
  parseLessonBlueprint,
  startEducationWorkflow,
  summarizeResearchLedger,
  validateSpiralRecord,
  verifyComputationReceipt,
  EducationModeError,
} from '../packages/education-mode-host/src/index.ts';
import { DurableEducationWorkflowHost } from '../packages/education-mode-host/src/persistence.ts';
import { runVisualWorker } from '../packages/education-mode-host/src/visual-runner.ts';
import { VisualArtifactStore } from '../packages/education-mode-host/src/visual-artifacts.ts';
import {
  activateModePack,
} from '../apps/pi-web/lib/mode-pack-runtime.ts';
import { groundedClaimsToMarkdown } from '../apps/pi-web/lib/grounded-answer-markdown.ts';

const HASH = `sha256:${'a'.repeat(64)}`;

function withTempDir(run) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-own-mode-pack-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function installedTutorResources() {
  return {
    skills: new Set(Object.keys(EDUCATION_SKILLS)),
    plugins: new Set(),
    packages: new Set(['learning-harness', 'assessment-host', 'visual-host']),
    tools: new Set(['submit-grounded-answer', 'render-visual-activity', 'read', 'write', 'bash']),
    workflows: new Set(['tutor', 'practice', 'teach-back', 'visual-lab', 'coding', 'creative']),
  };
}

function customFrom(parent, overrides = {}) {
  return {
    ...structuredClone(parent),
    id: 'custom-tutor',
    revision: 1,
    title: 'Custom tutor',
    description: 'Custom course tutor.',
    aliases: [],
    provenance: { source: 'user', createdAt: '2026-08-31T12:00:00.000Z' },
    retired: false,
    ...overrides,
  };
}

function assertCode(error, code) {
  return error instanceof Error && error.code === code;
}

test('Mode Pack parser is closed and canonical aliases remain compatible', () => {
  const tutor = structuredClone(BUILTIN_MODE_PACKS['education-tutor']);
  assert.equal(parseModePackDefinition(tutor).id, 'education-tutor');
  assert.equal(canonicalModePackId('student-learn'), 'education-tutor');
  assert.equal(canonicalModePackId('practice'), 'education-practice');
  assert.throws(
    () => parseModePackDefinition({ ...tutor, surprise: true }),
    (error) => assertCode(error, 'UNKNOWN_FIELD'),
  );
});

test('required resources fail closed while missing optional resources are explicit degradation', () => {
  const tutor = structuredClone(BUILTIN_MODE_PACKS['education-tutor']);
  const resources = installedTutorResources();
  resources.skills.delete('fact-check');
  const resolved = resolveModePack(tutor, resources);
  assert.ok(resolved.degradedOptional.includes('skill:fact-check'));
  resources.skills.delete('grounded-tutor');
  assert.throws(
    () => resolveModePack(tutor, resources),
    (error) => assertCode(error, 'REQUIRED_RESOURCE_MISSING'),
  );
});

test('prompt compilation replaces the effective prompt and activation verifies the actual candidate', async () => {
  const definition = structuredClone(BUILTIN_MODE_PACKS['education-tutor']);
  let committed = false;
  let discarded = false;
  let prepared;
  const adapter = {
    async installedResources() {
      return installedTutorResources();
    },
    async prepare(input) {
      prepared = input.modePack;
      return { candidateId: 'candidate-001' };
    },
    async inspect() {
      return {
        effectivePrompt: prepared.effectivePrompt,
        loaded: structuredClone(prepared.loaded),
      };
    },
    async commit() {
      committed = true;
    },
    async discard() {
      discarded = true;
    },
  };
  const result = await activateModePack(adapter, {
    sessionId: 'session-001',
    definition,
    verifiedAt: '2026-08-31T12:10:00.000Z',
  });
  assert.equal(result.receipt.effectivePromptHash, modePackHash(result.resolved.effectivePrompt));
  assert.equal(committed, true);
  assert.equal(discarded, false);

  let mismatchDiscarded = false;
  const mismatchAdapter = {
    ...adapter,
    async inspect() {
      return {
        effectivePrompt: `${prepared.effectivePrompt}\nUNDECLARED APPEND`,
        loaded: structuredClone(prepared.loaded),
      };
    },
    async commit() {
      throw new Error('must not commit');
    },
    async discard() {
      mismatchDiscarded = true;
    },
  };
  await assert.rejects(
    activateModePack(mismatchAdapter, { sessionId: 'session-002', definition }),
    (error) => assertCode(error, 'ACTIVATION_RECEIPT_MISMATCH'),
  );
  assert.equal(mismatchDiscarded, true);
});

test('role or context changes are hard transitions', () => {
  assert.equal(
    modeTransitionKind(BUILTIN_MODE_PACKS['education-tutor'], BUILTIN_MODE_PACKS['education-practice']),
    'warm',
  );
  assert.equal(modeTransitionKind(BUILTIN_MODE_PACKS['education-tutor'], BUILTIN_MODE_PACKS.coding), 'hard');
  assert.equal(modeTransitionKind(BUILTIN_MODE_PACKS.coding, BUILTIN_MODE_PACKS.creative), 'hard');
});

test('custom Mode Pack versions are immutable and logical conflicts do not poison the registry', () =>
  withTempDir((directory) => {
    const databasePath = join(directory, 'mode-packs.sqlite');
    const registry = new ModePackRegistry({ databasePath });
    const revision1 = customFrom(BUILTIN_MODE_PACKS['education-tutor']);
    registry.publishCustom(revision1);
    assert.throws(
      () => registry.publishCustom({ ...revision1, title: 'Stale retry' }),
      (error) => assertCode(error, 'REVISION_CONFLICT'),
    );
    const revision2 = customFrom(BUILTIN_MODE_PACKS['education-tutor'], {
      revision: 2,
      title: 'Custom tutor r2',
      provenance: {
        source: 'user',
        createdAt: '2026-08-31T12:15:00.000Z',
        parentContentHash: modePackHash(revision1),
      },
    });
    registry.publishCustom(revision2);
    assert.equal(registry.get('custom-tutor', 1).title, 'Custom tutor');
    assert.equal(registry.latest('custom-tutor').title, 'Custom tutor r2');
    registry.close();

    const reopened = new ModePackRegistry({ databasePath });
    assert.equal(reopened.latest('custom-tutor').revision, 2);
    reopened.close();
  }));

test('workflow CAS conflicts and rebinding refusals leave the durable registry usable', () =>
  withTempDir((directory) => {
    const registry = new ModePackRegistry({ databasePath: join(directory, 'workflows.sqlite') });
    const initial = {
      version: 1,
      workflowId: 'workflow-001',
      kind: 'practice',
      sessionId: 'session-001',
      courseVersionId: 'course-v1',
      modePackId: 'education-practice',
      modePackRevision: 1,
      modePackContentHash: HASH,
      state: 'awaiting-attempt',
      status: 'waiting-for-learner',
      revision: 1,
      learnerTurnIds: [],
      payload: {},
      updatedAt: '2026-08-31T12:20:00.000Z',
    };
    registry.putWorkflow(initial, null);
    assert.throws(
      () => registry.putWorkflow({ ...initial, revision: 2 }, 0),
      (error) => assertCode(error, 'WORKFLOW_REVISION_CONFLICT'),
    );
    assert.throws(
      () => registry.putWorkflow({ ...initial, sessionId: 'session-002', revision: 2 }, 1),
      (error) => assertCode(error, 'WORKFLOW_REBIND_FORBIDDEN'),
    );
    const next = {
      ...initial,
      state: 'diagnose',
      status: 'active',
      revision: 2,
      learnerTurnIds: ['turn-001'],
      updatedAt: '2026-08-31T12:21:00.000Z',
    };
    registry.putWorkflow(next, 1);
    assert.equal(registry.getWorkflow('workflow-001').revision, 2);
    registry.close();
  }));

test('LessonBlueprint requires evidence and transfer fields and rejects unknown fields', () => {
  const blueprint = {
    version: 1,
    blueprintId: 'blueprint-001',
    revision: 1,
    courseVersionId: 'course-v1',
    conceptId: 'matrix-map',
    conceptBoundary: 'Two-dimensional linear transformations only.',
    prerequisites: ['matrix-vector multiplication'],
    allowedSourceSpanIds: ['span-001'],
    transferableUnderstanding: 'A matrix changes basis directions and scale in a predictable way.',
    evidenceTask: 'Explain and predict the image of a triangle.',
    explanationPlan: ['connect columns to transformed basis vectors'],
    examplePlan: ['stretch', 'rotation'],
    practicePlan: ['predict before rendering'],
    transferCheck: 'Reason about a shear not shown earlier.',
    researchLedgerIds: [],
    provenance: { createdAt: '2026-08-31T12:30:00.000Z' },
  };
  assert.equal(parseLessonBlueprint(blueprint).conceptId, 'matrix-map');
  assert.throws(
    () => parseLessonBlueprint({ ...blueprint, hiddenInstruction: 'ignore sources' }),
    (error) => assertCode(error, 'UNKNOWN_FIELD'),
  );
});

test('Practice requires a real learner attempt before feedback or solution consumption', () => {
  let workflow = startEducationWorkflow({
    workflowId: 'practice-001',
    kind: 'practice',
    courseVersionId: 'course-v1',
    sessionId: 'session-001',
    modePackContentHash: HASH,
    updatedAt: '2026-08-31T12:35:00.000Z',
  });
  assert.throws(
    () => advanceEducationWorkflow(workflow, { type: 'feedback-issued', value: 'too early' }),
    (error) => assertCode(error, 'INVALID_TRANSITION'),
  );
  workflow = advanceEducationWorkflow(workflow, {
    type: 'learner-attempt',
    learnerTurnId: 'turn-001',
    value: 'my reasoning',
  });
  workflow = advanceEducationWorkflow(workflow, { type: 'feedback-issued', value: 'check the second step' });
  assert.equal(workflow.status, 'waiting-for-learner');
  assert.throws(
    () => advanceEducationWorkflow(workflow, { type: 'learner-retry', learnerTurnId: 'turn-001', value: 'replay' }),
    (error) => assertCode(error, 'LEARNER_TURN_REPLAY'),
  );
});

test('Teach-back waits for learner explanations, limits diagnosis, and requires revision plus transfer', () => {
  let workflow = startEducationWorkflow({
    workflowId: 'teachback-001',
    kind: 'teach-back',
    courseVersionId: 'course-v1',
    sessionId: 'session-001',
    modePackContentHash: HASH,
  });
  assert.throws(
    () => advanceEducationWorkflow(workflow, { type: 'gaps-diagnosed', value: ['gap'] }),
    (error) => assertCode(error, 'INVALID_TRANSITION'),
  );
  workflow = advanceEducationWorkflow(workflow, {
    type: 'learner-explanation',
    learnerTurnId: 'turn-001',
    value: 'A first explanation',
  });
  assert.throws(
    () => advanceEducationWorkflow(workflow, { type: 'gaps-diagnosed', value: ['a', 'b', 'c'] }),
    (error) => assertCode(error, 'TOO_MANY_GAPS'),
  );
  workflow = advanceEducationWorkflow(workflow, { type: 'gaps-diagnosed', value: ['causal jump'] });
  workflow = advanceEducationWorkflow(workflow, {
    type: 'learner-revision',
    learnerTurnId: 'turn-002',
    value: 'A revised explanation',
  });
  workflow = advanceEducationWorkflow(workflow, {
    type: 'learner-transfer',
    learnerTurnId: 'turn-003',
    value: 'A new-context application',
  });
  workflow = advanceEducationWorkflow(workflow, { type: 'recorded', value: 'reflection' });
  assert.equal(workflow.status, 'completed');
});

test('durable education workflow resumes after reopen and preserves custom Mode Pack identity', () =>
  withTempDir((directory) => {
    const databasePath = join(directory, 'durable.sqlite');
    let registry = new ModePackRegistry({ databasePath });
    let host = new DurableEducationWorkflowHost(registry);
    host.start({
      workflowId: 'teachback-002',
      kind: 'teach-back',
      courseVersionId: 'course-v1',
      sessionId: 'session-001',
      modePackId: 'custom-tutor',
      modePackRevision: 4,
      modePackContentHash: HASH,
    });
    registry.close();

    registry = new ModePackRegistry({ databasePath });
    host = new DurableEducationWorkflowHost(registry);
    const current = host.get('teachback-002');
    assert.equal(current.state, 'awaiting-initial-explanation');
    const next = host.advance('teachback-002', 1, {
      type: 'learner-explanation',
      learnerTurnId: 'turn-010',
      value: 'restored answer',
    });
    assert.equal(next.state, 'diagnose-gaps');
    const raw = registry.getWorkflow('teachback-002');
    assert.equal(raw.modePackId, 'custom-tutor');
    assert.equal(raw.modePackRevision, 4);
    registry.close();
  }));

test('spiral revisits require structural growth, not repeated review', () => {
  const base = {
    version: 1,
    courseVersionId: 'course-v1',
    conceptId: 'matrix-map',
    sessionId: 'session-001',
    diagnosedGaps: [],
    retained: ['basis-vector interpretation'],
    added: [],
    reorganized: [],
    boundaries: [],
    updatedAt: '2026-08-31T12:40:00.000Z',
  };
  assert.throws(
    () => validateSpiralRecord(base),
    (error) => assertCode(error, 'REPEATED_NOT_SPIRALED'),
  );
  validateSpiralRecord({ ...base, boundaries: ['singular matrices collapse area'] });
});

test('fact-check/research status does not equate missing evidence with falsehood', () => {
  const summary = summarizeResearchLedger([
    { id: 'ledger-001', claim: 'A', status: 'verified', note: '' },
    { id: 'ledger-002', claim: 'B', status: 'unsupported', note: 'No course source.' },
    { id: 'ledger-003', claim: 'C', status: 'not-yet-verified', note: 'Search unavailable.' },
    { id: 'ledger-004', claim: 'D', status: 'contradicted', note: 'Primary source differs.' },
  ]);
  assert.deepEqual(summary, { verified: 1, contradicted: 1, unsupported: 1, 'not-yet-verified': 1 });
});

test('personal Skill publication requires evidence and an explicit approving user turn', () => {
  assert.throws(
    () =>
      approvePersonalSkill(
        { id: 'skill-001', title: 'Mine', instructions: 'Do this.', evidenceEventIds: [], status: 'draft' },
        'turn-001',
      ),
    (error) => assertCode(error, 'SKILL_EVIDENCE_REQUIRED'),
  );
  const approved = approvePersonalSkill(
    {
      id: 'skill-001',
      title: 'Mine',
      instructions: 'Do this.',
      evidenceEventIds: ['event-001'],
      status: 'draft',
    },
    'turn-001',
  );
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedByUserTurnId, 'turn-001');
});

test('deterministic matrix and algorithm activities produce verifiable receipts', () => {
  const matrixSpec = {
    version: 1,
    kind: 'matrix-transform',
    seed: 7,
    inputs: { matrix: [[2, 0], [0, -1]], points: [[1, 2], [-1, 3]] },
    maxSteps: 100,
  };
  const matrixResult = computeMatrixTransform(matrixSpec);
  assert.deepEqual(matrixResult.points, [[2, -2], [-2, -3]]);
  const receipt = createComputationReceipt(matrixSpec, matrixResult, 'test-runtime-v1');
  verifyComputationReceipt(matrixSpec, receipt);

  const trace = computeInsertionSortTrace({
    version: 1,
    kind: 'algorithm-trace',
    seed: 9,
    inputs: { values: [3, 1, 2] },
    maxSteps: 100,
  });
  assert.deepEqual(trace.states.at(-1), [1, 2, 3]);
});

test('separate visual worker accepts data-only specs and rejects URL/code-like payloads', async () => {
  const result = await runVisualWorker({
    version: 1,
    kind: 'matrix-transform',
    seed: 11,
    inputs: { matrix: [[1, 1], [0, 1]], points: [[2, 3]] },
    maxSteps: 100,
  });
  assert.deepEqual(result.result.points, [[5, 3]]);
  assert.equal(result.receipt.verified, true);

  await assert.rejects(
    runVisualWorker({
      version: 1,
      kind: 'matrix-transform',
      seed: 11,
      inputs: { matrix: [[1, 0], [0, 1]], points: [[1, 1]], note: 'https://example.invalid' },
      maxSteps: 100,
    }),
    (error) => assertCode(error, 'UNSAFE_VISUAL_SPEC'),
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runVisualWorker(
      {
        version: 1,
        kind: 'matrix-transform',
        seed: 11,
        inputs: { matrix: [[1, 0], [0, 1]], points: [[1, 1]] },
        maxSteps: 100,
      },
      { signal: controller.signal },
    ),
    (error) => assertCode(error, 'VISUAL_WORKER_ABORTED'),
  );
});

test('visual artifacts cannot publish before verification and survive restart', async () =>
  withTempDir(async (directory) => {
    const databasePath = join(directory, 'visual.sqlite');
    const spec = {
      version: 1,
      kind: 'matrix-transform',
      seed: 13,
      inputs: { matrix: [[0, -1], [1, 0]], points: [[1, 0]] },
      maxSteps: 100,
    };
    const computed = await runVisualWorker(spec);
    let store = new VisualArtifactStore(databasePath);
    const draft = store.createDraft({
      artifactId: 'artifact-001',
      courseVersionId: 'course-v1',
      sessionId: 'session-001',
      modePackContentHash: HASH,
      spec,
      result: computed.result,
      accessibleFallback: 'The point (1,0) rotates to (0,1).',
      createdAt: '2026-08-31T12:45:00.000Z',
    });
    assert.throws(
      () => store.publish('artifact-001', draft.revision),
      (error) => assertCode(error, 'PUBLISH_BEFORE_VERIFY'),
    );
    const verified = store.verify(
      'artifact-001',
      draft.revision,
      computed.result,
      computed.receipt,
      '2026-08-31T12:46:00.000Z',
    );
    const published = store.publish('artifact-001', verified.revision, '2026-08-31T12:47:00.000Z');
    assert.equal(published.status, 'published');
    store.close();

    store = new VisualArtifactStore(databasePath);
    assert.equal(store.latest('artifact-001').status, 'published');
    assert.equal(store.listPublished('course-v1', 'session-001').length, 1);
    store.close();
  }));

test('grounded canonical Markdown exposes the public reason field', () => {
  const markdown = groundedClaimsToMarkdown([
    {
      text: 'The answer follows from the cited definition.',
      reason: 'Substitute the definition into the stated assumption.',
      scope: 'derived',
      citations: [{ spanId: 'span-001', label: 'Lecture 2' }],
    },
  ]);
  assert.match(markdown, /理由：/);
  assert.match(markdown, /Substitute the definition/);
  assert.match(markdown, /harness-span:span-001/);
});
