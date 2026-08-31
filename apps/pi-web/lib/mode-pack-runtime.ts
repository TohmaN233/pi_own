import {
	modePackHash,
	modeTransitionKind,
	resolveModePack,
	verifyModeActivation,
	type InstalledModeResources,
	type ModeActivationReceipt,
	type ModePackDefinition,
	type ResolvedModePack,
} from "../../../packages/profile-resource-host/src/mode-packs.ts";

export interface PreparedModeRuntime {
	candidateId: string;
	/** A hard transition creates a fresh Pi session. Warm transitions retain the source id. */
	targetSessionId?: string;
}

export interface ModeRuntimeInspection {
	effectivePrompt: string;
	loaded: {
		skills: string[];
		plugins: string[];
		packages: string[];
		tools: string[];
		workflows: string[];
	};
}

export interface ModeRuntimeCommitResult {
	sessionId: string;
	bindingRevision?: number;
}

/**
 * Pi owns the agent loop and transcript. A concrete adapter may replace its
 * prompt, Skills, plugin/package set, tools, and workflows, but must stage the
 * candidate without mutating the live runtime until `commit` succeeds.
 */
export interface ModeRuntimeAdapter {
	installedResources(definition: ModePackDefinition): Promise<InstalledModeResources>;
	/**
	 * Materialize files and context into the exact prompt that the candidate
	 * runtime will use. The definition, content hash, resolved resource set, and
	 * degradation list must remain unchanged.
	 */
	materialize?(modePack: ResolvedModePack): Promise<ResolvedModePack>;
	prepare(input: {
		sessionId: string;
		modePack: ResolvedModePack;
		expectedCurrentModeHash?: string;
		transition: "warm" | "hard";
	}): Promise<PreparedModeRuntime>;
	inspect(candidate: PreparedModeRuntime): Promise<ModeRuntimeInspection>;
	commit(
		candidate: PreparedModeRuntime,
		receipt: ModeActivationReceipt,
	): Promise<ModeRuntimeCommitResult | void>;
	discard(candidate: PreparedModeRuntime): Promise<void>;
}

export interface ActivateModePackOptions {
	sessionId: string;
	definition: ModePackDefinition;
	currentDefinition?: ModePackDefinition;
	expectedCurrentModeHash?: string;
	verifiedAt?: string;
}

export interface ActivatedModePack {
	transition: "warm" | "hard";
	targetSessionId: string;
	bindingRevision?: number;
	resolved: ResolvedModePack;
	receipt: ModeActivationReceipt;
}

function normalizedLoaded(inspection: ModeRuntimeInspection): ModeRuntimeInspection["loaded"] {
	const uniqueSorted = (values: readonly string[], kind: string): string[] => {
		if (values.some((value) => typeof value !== "string" || !value.trim())) {
			throw new Error(`Runtime reported an invalid ${kind} identifier.`);
		}
		const unique = [...new Set(values)];
		if (unique.length !== values.length) throw new Error(`Runtime reported duplicate ${kind} identifiers.`);
		return unique.sort();
	};
	return {
		skills: uniqueSorted(inspection.loaded.skills, "Skill"),
		plugins: uniqueSorted(inspection.loaded.plugins, "plugin"),
		packages: uniqueSorted(inspection.loaded.packages, "package"),
		tools: uniqueSorted(inspection.loaded.tools, "tool"),
		workflows: uniqueSorted(inspection.loaded.workflows, "workflow"),
	};
}

function normalizeResolvedLoaded(resolved: ResolvedModePack): ResolvedModePack["loaded"] {
	return {
		skills: [...resolved.loaded.skills].sort(),
		plugins: [...resolved.loaded.plugins].sort(),
		packages: [...resolved.loaded.packages].sort(),
		tools: [...resolved.loaded.tools].sort(),
		workflows: [...resolved.loaded.workflows].sort(),
	};
}

function materializedModePack(base: ResolvedModePack, value: ResolvedModePack): ResolvedModePack {
	const invariantBase = {
		definition: base.definition,
		contentHash: base.contentHash,
		loaded: normalizeResolvedLoaded(base),
		degradedOptional: [...base.degradedOptional].sort(),
		verified: base.verified,
	};
	const invariantValue = {
		definition: value.definition,
		contentHash: value.contentHash,
		loaded: normalizeResolvedLoaded(value),
		degradedOptional: [...value.degradedOptional].sort(),
		verified: value.verified,
	};
	if (JSON.stringify(invariantBase) !== JSON.stringify(invariantValue)) {
		throw Object.assign(
			new Error("A Mode Runtime adapter may materialize the prompt, but cannot change the resolved Mode Pack identity or resources."),
			{ code: "MODE_PACK_MATERIALIZATION_MISMATCH" },
		);
	}
	if (!value.effectivePrompt.trim() || modePackHash(value.effectivePrompt) !== value.effectivePromptHash) {
		throw Object.assign(new Error("The materialized Mode Pack prompt hash is invalid."), {
			code: "MODE_PACK_MATERIALIZATION_HASH_MISMATCH",
		});
	}
	return {
		...value,
		loaded: normalizeResolvedLoaded(value),
		degradedOptional: [...value.degradedOptional].sort(),
	};
}

/**
 * Candidate-based Mode Pack activation.
 *
 * A Mode Pack is not active because its definition parsed or because the UI
 * selected it. It becomes active only after a staged Pi runtime reports the
 * exact effective prompt and resource set and the candidate is committed.
 */
export async function activateModePack(
	adapter: ModeRuntimeAdapter,
	options: ActivateModePackOptions,
): Promise<ActivatedModePack> {
	const installed = await adapter.installedResources(options.definition);
	const resolvedBase = resolveModePack(options.definition, installed);
	const resolved = adapter.materialize
		? materializedModePack(resolvedBase, await adapter.materialize(resolvedBase))
		: resolvedBase;
	const transition = options.currentDefinition
		? modeTransitionKind(options.currentDefinition, resolved.definition)
		: "hard";

	const candidate = await adapter.prepare({
		sessionId: options.sessionId,
		modePack: resolved,
		expectedCurrentModeHash: options.expectedCurrentModeHash,
		transition,
	});
	let committed = false;
	try {
		const inspection = await adapter.inspect(candidate);
		const loaded = normalizedLoaded(inspection);
		const receipt: ModeActivationReceipt = {
			modePackId: resolved.definition.id,
			revision: resolved.definition.revision,
			contentHash: resolved.contentHash,
			effectivePromptHash: modePackHash(inspection.effectivePrompt),
			loaded,
			verifiedAt: options.verifiedAt ?? new Date().toISOString(),
		};
		const expected = { ...resolved, loaded: normalizeResolvedLoaded(resolved) };
		verifyModeActivation(expected, receipt);
		const committedRuntime = await adapter.commit(candidate, receipt);
		committed = true;
		return {
			transition,
			targetSessionId: committedRuntime?.sessionId ?? candidate.targetSessionId ?? options.sessionId,
			...(committedRuntime?.bindingRevision !== undefined
				? { bindingRevision: committedRuntime.bindingRevision }
				: {}),
			resolved,
			receipt,
		};
	} finally {
		if (!committed) await adapter.discard(candidate);
	}
}
