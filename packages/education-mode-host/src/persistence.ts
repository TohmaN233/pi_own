import {
  ModePackRegistry,
  type StoredModeWorkflow,
} from '../../learning-harness/src/mode-pack-registry.ts';
import {
  advanceEducationWorkflow,
  startEducationWorkflow,
  type EducationWorkflowInstance,
  type EducationWorkflowKind,
} from './index.ts';

function toStored(instance: EducationWorkflowInstance): StoredModeWorkflow {
  return {
    version: 1,
    workflowId: instance.workflowId,
    kind: instance.kind,
    sessionId: instance.sessionId,
    courseVersionId: instance.courseVersionId,
    modePackId: modePackIdForWorkflow(instance.kind),
    modePackRevision: 1,
    modePackContentHash: instance.modePackContentHash,
    state: instance.state,
    status: instance.status,
    revision: instance.revision,
    learnerTurnIds: [...instance.learnerTurnIds],
    payload: structuredClone(instance.payload),
    updatedAt: instance.updatedAt,
  };
}

function fromStored(stored: StoredModeWorkflow): EducationWorkflowInstance {
  return {
    version: 1,
    workflowId: stored.workflowId,
    kind: stored.kind as EducationWorkflowKind,
    sessionId: stored.sessionId,
    courseVersionId: stored.courseVersionId ?? '',
    modePackContentHash: stored.modePackContentHash,
    state: stored.state,
    status: stored.status,
    revision: stored.revision,
    learnerTurnIds: [...stored.learnerTurnIds],
    payload: structuredClone(stored.payload),
    updatedAt: stored.updatedAt,
  };
}

function modePackIdForWorkflow(kind: EducationWorkflowKind): string {
  switch (kind) {
    case 'practice':
      return 'education-practice';
    case 'teach-back':
      return 'education-teach-back';
    case 'visual-lab':
    case 'learn-by-doing':
      return 'education-visual-lab';
    default:
      return 'education-tutor';
  }
}

export interface StartDurableEducationWorkflowInput {
  workflowId: string;
  kind: EducationWorkflowKind;
  courseVersionId: string;
  sessionId: string;
  modePackContentHash: string;
  updatedAt?: string;
}

export class DurableEducationWorkflowHost {
  constructor(private readonly registry: ModePackRegistry) {}

  start(input: StartDurableEducationWorkflowInput): EducationWorkflowInstance {
    const instance = startEducationWorkflow(input);
    this.registry.putWorkflow(toStored(instance), null);
    return instance;
  }

  get(workflowId: string): EducationWorkflowInstance | null {
    const stored = this.registry.getWorkflow(workflowId);
    return stored ? fromStored(stored) : null;
  }

  list(sessionId: string): EducationWorkflowInstance[] {
    return this.registry.listWorkflows(sessionId).map(fromStored);
  }

  advance(
    workflowId: string,
    expectedRevision: number,
    event: { type: string; learnerTurnId?: string; value?: unknown; updatedAt?: string },
  ): EducationWorkflowInstance {
    const current = this.get(workflowId);
    if (!current) throw Object.assign(new Error(`Workflow ${workflowId} was not found.`), { code: 'WORKFLOW_NOT_FOUND' });
    if (current.revision !== expectedRevision) {
      throw Object.assign(new Error(`Workflow ${workflowId} revision changed.`), {
        code: 'WORKFLOW_REVISION_CONFLICT',
      });
    }
    const next = advanceEducationWorkflow(current, event);
    this.registry.putWorkflow(toStored(next), current.revision);
    return next;
  }
}
