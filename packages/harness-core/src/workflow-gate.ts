import type { ValidatorResult, WorkflowRun } from "../../harness-contracts/src/index.ts";

export class WorkflowGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowGateError";
	}
}

export class WorkflowGate {
	private readonly workflows = new Map<string, WorkflowRun>();
	private readonly validators = new Map<string, ValidatorResult>();

	recordWorkflow(run: WorkflowRun): void {
		const previous = this.workflows.get(run.runId);
		if (previous && run.revision <= previous.revision)
			throw new WorkflowGateError(`Stale workflow revision ${run.runId}`);
		this.workflows.set(run.runId, run);
	}

	recordValidator(result: ValidatorResult): void {
		const key = `${result.validatorId}\0${result.subject.kind}\0${result.subject.id}`;
		const previous = this.validators.get(key);
		if (previous && result.subject.revision < previous.subject.revision) {
			throw new WorkflowGateError(`Stale validator result for ${result.subject.kind}/${result.subject.id}`);
		}
		this.validators.set(key, result);
	}

	assertPublishable(
		subject: { kind: string; id: string; revision: number },
		requiredValidatorIds: readonly string[],
	): void {
		for (const validatorId of requiredValidatorIds) {
			const key = `${validatorId}\0${subject.kind}\0${subject.id}`;
			const result = this.validators.get(key);
			if (!result) throw new WorkflowGateError(`Missing validator ${validatorId}`);
			if (result.subject.revision !== subject.revision)
				throw new WorkflowGateError(`Validator ${validatorId} is stale`);
			if (result.status !== "pass") throw new WorkflowGateError(`Validator ${validatorId} failed`);
		}
	}

	getWorkflow(runId: string): WorkflowRun | undefined {
		return this.workflows.get(runId);
	}
}
