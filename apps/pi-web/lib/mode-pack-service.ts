import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	BUILTIN_MODE_PACKS,
	canonicalModePackId,
	modePackHash,
	parseModePackDefinition,
	resolveModePack,
	type InstalledModeResources,
	type ModePackDefinition,
	type ResolvedModePack,
} from "../../../packages/profile-resource-host/src/mode-packs.ts";
import { ModePackRegistry } from "../../../packages/learning-harness/src/mode-pack-registry.ts";
import { EDUCATION_SKILLS } from "../../../packages/education-mode-host/src/index.ts";

const DEFAULT_DATA_DIRECTORY = ".learning-harness-data";
const GLOBAL_KEY = "__piOwnModePackRegistry";

interface GlobalModePackState {
	[GLOBAL_KEY]?: ModePackRegistry;
}

function dataDirectory(): string {
	const configured = process.env.PI_LEARNING_HARNESS_DIR?.trim();
	const directory = resolve(configured || join(process.cwd(), DEFAULT_DATA_DIRECTORY));
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return directory;
}

function registry(): ModePackRegistry {
	const globalState = globalThis as typeof globalThis & GlobalModePackState;
	if (!globalState[GLOBAL_KEY]) {
		globalState[GLOBAL_KEY] = new ModePackRegistry({
			databasePath: join(dataDirectory(), "mode-packs.sqlite"),
		});
	}
	return globalState[GLOBAL_KEY];
}

export interface ModePackCatalogEntry {
	definition: ModePackDefinition;
	contentHash: string;
	builtin: boolean;
}

export function listModePackCatalog(includeRetired = false): ModePackCatalogEntry[] {
	const builtins = Object.values(BUILTIN_MODE_PACKS).map((definition) => ({
		definition: structuredClone(definition),
		contentHash: modePackHash(definition),
		builtin: true,
	}));
	const custom = registry()
		.list(includeRetired)
		.map((definition) => ({ definition, contentHash: modePackHash(definition), builtin: false }));
	return [...builtins, ...custom].sort((left, right) => left.definition.id.localeCompare(right.definition.id));
}

export function findModePack(idOrAlias: string, revision?: number): ModePackDefinition {
	const canonical = canonicalModePackId(idOrAlias);
	const builtin = BUILTIN_MODE_PACKS[canonical];
	if (builtin) {
		if (revision !== undefined && revision !== builtin.revision) {
			throw new Error(`Built-in Mode Pack ${canonical} has only revision ${builtin.revision}`);
		}
		return structuredClone(builtin);
	}
	const custom = revision === undefined ? registry().latest(canonical, true) : registry().get(canonical, revision);
	if (!custom) throw new Error(`Mode Pack ${canonical} was not found`);
	return custom;
}

export function validateCustomModePack(value: unknown): {
	definition: ModePackDefinition;
	contentHash: string;
} {
	const definition = parseModePackDefinition(value);
	if (definition.provenance.source !== "user") {
		throw new Error("A custom Mode Pack must use provenance.source = user");
	}
	return { definition, contentHash: modePackHash(definition) };
}

export function publishCustomModePack(value: unknown): ModePackCatalogEntry {
	const definition = registry().publishCustom(value);
	return { definition, contentHash: modePackHash(definition), builtin: false };
}

export function retireCustomModePack(id: string): ModePackCatalogEntry {
	const definition = registry().retire(id);
	return { definition, contentHash: modePackHash(definition), builtin: false };
}

/**
 * This inventory is a source-tree declaration used only by the editor's preview.
 * Runtime activation must pass the resources Pi actually loaded to
 * `resolveModePackForRuntime`; a preview result is not an activation receipt.
 */
export function declaredModeResources(): InstalledModeResources {
	return {
		skills: new Set(Object.keys(EDUCATION_SKILLS)),
		plugins: new Set(),
		packages: new Set(["learning-harness", "assessment-host", "visual-host"]),
		tools: new Set(["submit-grounded-answer", "render-visual-activity", "read", "write", "bash"]),
		workflows: new Set([
			"tutor",
			"practice",
			"teach-back",
			"visual-lab",
			"coding",
			"creative",
		]),
	};
}

export function previewModePack(value: unknown): ResolvedModePack {
	return resolveModePack(value, declaredModeResources());
}

export function resolveModePackForRuntime(
	idOrAlias: string,
	revision: number | undefined,
	actualResources: InstalledModeResources,
): ResolvedModePack {
	return resolveModePack(findModePack(idOrAlias, revision), actualResources);
}

export function customModePackTemplate(parentId = "education-tutor", now = new Date().toISOString()): ModePackDefinition {
	const parent = findModePack(parentId);
	return {
		...parent,
		id: "my-custom-mode",
		revision: 1,
		title: "My custom mode",
		description: "A versioned custom Mode Pack.",
		aliases: [],
		provenance: {
			source: "user",
			createdAt: now,
		},
		retired: false,
	};
}
