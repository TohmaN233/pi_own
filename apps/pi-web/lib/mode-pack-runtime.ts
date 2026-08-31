import {
	modePackHash,
	modeTransitionKind,
	resolveModePack,
	verifyModeActivation,
	type InstalledModeResources,
	type ModeActivationReceipt,
	type ModePackDefinition,
	type ResolvedModePack,
} from '../../../packages/profile-resource-host/src/mode-packs.ts';

export interface PreparedModeRuntime {
  candidateId: string;
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

/**
 * Pi owns the agent loop and transcript. A concrete adapter may replace its
 * prompt, Skills, plugin/package set, tools, and workflows, but must stage the
 * candidate without mutating the live runtime until `commit` succeeds.
 */
export interface ModeRuntimeAdapter {
  installedResources(): Promise<InstalledModeResources>;
  prepare(input: {
    sessionId: string;
    modePack: ResolvedModePack;
    expectedCurrentModeHash?: string;
  }): Promise<PreparedModeRuntime>;
  inspect(candidate: PreparedModeRuntime): Promise<ModeRuntimeInspection>;
  commit(candidate: PreparedModeRuntime): Promise<void>;
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
  transition: 'warm' | 'hard';
  resolved: ResolvedModePack;
  receipt: ModeActivationReceipt;
}

function normalizedLoaded(inspection: ModeRuntimeInspection): ModeRuntimeInspection['loaded'] {
  const uniqueSorted = (values: readonly string[], kind: string): string[] => {
    if (values.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error(`Runtime reported an invalid ${kind} identifier.`);
    }
    const unique = [...new Set(values)];
    if (unique.length !== values.length) throw new Error(`Runtime reported duplicate ${kind} identifiers.`);
    return unique.sort();
  };
  return {
    skills: uniqueSorted(inspection.loaded.skills, 'Skill'),
    plugins: uniqueSorted(inspection.loaded.plugins, 'plugin'),
    packages: uniqueSorted(inspection.loaded.packages, 'package'),
    tools: uniqueSorted(inspection.loaded.tools, 'tool'),
    workflows: uniqueSorted(inspection.loaded.workflows, 'workflow'),
  };
}

function normalizeResolvedLoaded(resolved: ResolvedModePack): ResolvedModePack['loaded'] {
  return {
    skills: [...resolved.loaded.skills].sort(),
    plugins: [...resolved.loaded.plugins].sort(),
    packages: [...resolved.loaded.packages].sort(),
    tools: [...resolved.loaded.tools].sort(),
    workflows: [...resolved.loaded.workflows].sort(),
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
  const installed = await adapter.installedResources();
  const resolved = resolveModePack(options.definition, installed);
  const transition = options.currentDefinition
    ? modeTransitionKind(options.currentDefinition, resolved.definition)
    : 'hard';
  if (transition === 'hard' && options.currentDefinition) {
    throw Object.assign(
      new Error('This Mode Pack changes role or context kind and requires a new Pi session or explicit fork.'),
      { code: 'HARD_MODE_TRANSITION_REQUIRED' },
    );
  }

  const candidate = await adapter.prepare({
    sessionId: options.sessionId,
    modePack: resolved,
    expectedCurrentModeHash: options.expectedCurrentModeHash,
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
    await adapter.commit(candidate);
    committed = true;
    return { transition, resolved, receipt };
  } finally {
    if (!committed) await adapter.discard(candidate);
  }
}
