import type { SessionManager, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
	type EducationWorkflowInstance,
	type EducationWorkflowKind,
} from "../../../packages/education-mode-host/src/index.ts";
import { DurableEducationWorkflowHost } from "../../../packages/education-mode-host/src/persistence.ts";
import { getModePackRegistry } from "./mode-pack-service";

const WORKFLOW_ID_LIMIT = 128;

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object" || Array.isArray(message)) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				Boolean(block) &&
				typeof block === "object" &&
				!Array.isArray(block) &&
				(block as { type?: unknown }).type === "text" &&
				(typeof (block as { text?: unknown }).text === "string"),
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function workflowId(sessionId: string, bindingRevision: number, kind: EducationWorkflowKind): string {
	const value = `mode-workflow:${sessionId}:${bindingRevision}:${kind}`;
	if (value.length > WORKFLOW_ID_LIMIT) {
		throw Object.assign(new Error("Mode workflow identity exceeds the contract limit."), {
			code: "MODE_WORKFLOW_ID_TOO_LONG",
		});
	}
	return value;
}

function learnerEventFor(state: string): string | null {
	switch (state) {
		case "awaiting-initial-explanation":
			return "learner-explanation";
		case "awaiting-revised-explanation":
			return "learner-revision";
		case "awaiting-transfer":
			return "learner-transfer";
		case "awaiting-prediction":
			return "learner-prediction";
		case "awaiting-observation":
			return "learner-observation";
		case "awaiting-retry-or-reveal":
			return "learner-retry";
		default:
			return null;
	}
}

function stateInstruction(instance: EducationWorkflowInstance): string {
	const common = `Active education workflow ${instance.workflowId} is in state ${instance.state} (${instance.status}), revision ${instance.revision}. The Host, not the model, owns transitions. Never invent a learner turn or claim that a required learner action happened.`;
	if (instance.kind === "teach-back") {
		switch (instance.state) {
			case "awaiting-initial-explanation":
				return `${common} Ask the learner to explain first. Do not reveal the standard explanation.`;
			case "diagnose-gaps":
				return `${common} Diagnose at most two load-bearing gaps and ask focused questions. The Host records this response as the diagnosis.`;
			case "awaiting-revised-explanation":
				return `${common} Wait for the learner's revised explanation; give only the smallest useful scaffold.`;
			case "awaiting-transfer":
				return `${common} Present a genuinely new transfer situation and wait for the learner's answer.`;
			case "reflection":
				return `${common} Summarize the learner's change, remaining gap, and next target. The Host records this response and completes the cycle.`;
			case "completed":
				return `${common} This cycle is complete. Do not silently restart it; the learner can reactivate the Mode Pack for a new cycle.`;
		}
	}
	if (instance.kind === "visual-lab" || instance.kind === "learn-by-doing") {
		switch (instance.state) {
			case "awaiting-prediction":
				return `${common} Ask for a concrete prediction before running a visualization.`;
			case "compute-and-verify":
				return `${common} Use the verified visual tool. Do not substitute an unverified hand-written result.`;
			case "awaiting-observation":
				return `${common} Ask what the learner observes; do not state the intended conclusion first.`;
			case "awaiting-transfer":
				return `${common} Ask the learner to explain or transfer the observed mechanism to a new case.`;
			case "completed":
				return `${common} The prediction-observation-explanation cycle is complete.`;
		}
	}
	return common;
}

export interface ModeWorkflowRuntimeOptions {
	sessionId: string;
	courseVersionId: string;
	modePackContentHash: string;
	bindingRevision: number;
	kind: "teach-back" | "visual-lab";
	manager: SessionManager;
}

export class ModeWorkflowRuntime {
	readonly extension: InlineExtension;
	readonly workflowId: string;
	private readonly host: DurableEducationWorkflowHost;
	private readonly options: ModeWorkflowRuntimeOptions;

	constructor(options: ModeWorkflowRuntimeOptions) {
		this.options = options;
		this.workflowId = workflowId(options.sessionId, options.bindingRevision, options.kind);
		this.host = new DurableEducationWorkflowHost(getModePackRegistry());
		this.extension = {
			name: `pi-own-${options.kind}-workflow`,
			hidden: true,
			factory: (pi) => {
				pi.on("before_agent_start", (event) => {
					const current = this.ensureWorkflow();
					let next = current.instance;
					if (!current.created && next.status === "waiting-for-learner") {
						const eventType = learnerEventFor(next.state);
						const learnerTurnId = this.options.manager.getLeafId();
						if (eventType && learnerTurnId) {
							next = this.host.advance(next.workflowId, next.revision, {
								type: eventType,
								learnerTurnId,
								value: event.prompt,
							});
						}
					}
					return {
						systemPrompt: `${event.systemPrompt}\n\n${stateInstruction(next)}`,
					};
				});

				pi.on("message_end", (event) => {
					const text = assistantText(event.message);
					if (!text) return;
					const current = this.host.get(this.workflowId);
					if (!current || current.status !== "active") return;
					if (current.kind === "teach-back" && current.state === "diagnose-gaps") {
						this.host.advance(current.workflowId, current.revision, {
							type: "gaps-diagnosed",
							value: [text],
						});
					} else if (current.kind === "teach-back" && current.state === "reflection") {
						this.host.advance(current.workflowId, current.revision, {
							type: "recorded",
							value: text,
						});
					}
				});
			},
		};
	}

	current(): EducationWorkflowInstance {
		return this.ensureWorkflow().instance;
	}

	recordVerifiedVisual(value: unknown): EducationWorkflowInstance {
		const current = this.current();
		if (
			(current.kind !== "visual-lab" && current.kind !== "learn-by-doing") ||
			current.state !== "compute-and-verify"
		) {
			throw Object.assign(new Error("The visual workflow is not ready to accept an artifact."), {
				code: "VISUAL_WORKFLOW_STATE_MISMATCH",
			});
		}
		return this.host.advance(current.workflowId, current.revision, {
			type: "verified-observation-requested",
			value,
		});
	}

	private ensureWorkflow(): { instance: EducationWorkflowInstance; created: boolean } {
		const existing = this.host.get(this.workflowId);
		if (existing) {
			if (
				existing.sessionId !== this.options.sessionId ||
				existing.courseVersionId !== this.options.courseVersionId ||
				existing.modePackContentHash !== this.options.modePackContentHash ||
				existing.kind !== this.options.kind
			) {
				throw Object.assign(new Error("Persisted education workflow identity does not match the active Mode Pack."), {
					code: "MODE_WORKFLOW_IDENTITY_MISMATCH",
				});
			}
			return { instance: existing, created: false };
		}
		return {
			instance: this.host.start({
				workflowId: this.workflowId,
				kind: this.options.kind,
				courseVersionId: this.options.courseVersionId,
				sessionId: this.options.sessionId,
				modePackContentHash: this.options.modePackContentHash,
			}),
			created: true,
		};
	}
}
