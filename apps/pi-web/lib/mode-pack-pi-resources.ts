import { createHash } from "node:crypto";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import {
	DefaultPackageManager,
	SettingsManager,
	loadProjectContextFiles,
	loadSkills,
	type ResolvedResource,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { EDUCATION_SKILLS } from "../../../packages/education-mode-host/src/index.ts";
import { loadEducationSkill } from "../../../packages/education-mode-host/src/skills.ts";
import {
	modePackHash,
	type InstalledModeResources,
	type ModePackDefinition,
	type ResolvedModePack,
} from "../../../packages/profile-resource-host/src/mode-packs.ts";
import { getProjectTrustStatus } from "./project-trust";

const MAX_MATERIALIZED_PROMPT_CHARS = 192_000;
const INTERNAL_PACKAGES = ["learning-harness", "assessment-host", "visual-host"] as const;
const INTERNAL_WORKFLOWS = [
	"tutor",
	"practice",
	"teach-back",
	"visual-lab",
	"coding",
	"creative",
] as const;
const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"] as const;
const VIRTUAL_TOOLS = ["submit-grounded-answer", "render-visual-activity"] as const;

export class ModePackResourceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ModePackResourceError";
		this.code = code;
	}
}

interface PackageResourcePaths {
	extensionPaths: string[];
	skillPaths: string[];
}

export interface ModePackResourceInventory {
	installed: InstalledModeResources;
	skillFiles: ReadonlyMap<string, string>;
	pluginPaths: ReadonlyMap<string, string>;
	packagePaths: ReadonlyMap<string, PackageResourcePaths>;
	projectTrusted: boolean;
}

export interface SelectedModeResourcePaths {
	extensionPaths: string[];
	skillPaths: string[];
}

function inside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

function normalizedId(value: string, fallback: string): string {
	const normalized = value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/^@/, "")
		.replace(/\.git$/u, "")
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.replace(/-{2,}/gu, "-")
		.slice(0, 120);
	if (!normalized) return fallback;
	return /^[a-z]/u.test(normalized) ? normalized : `${fallback}-${normalized}`.slice(0, 128);
}

function packageSourceId(source: string): string {
	const stripped = source.split("#", 1)[0] ?? source;
	if (/^@[^/]+\/[^@]+(?:@.+)?$/u.test(stripped)) {
		const withoutVersion = stripped.replace(/(@[^/]+\/[^@]+)@.+$/u, "$1");
		return normalizedId(withoutVersion, "package");
	}
	if (/^[^/@]+@[^/]+$/u.test(stripped)) {
		return normalizedId(stripped.replace(/@[^@]+$/u, ""), "package");
	}
	try {
		const url = new URL(stripped.replace(/^git\+/u, ""));
		return normalizedId(url.pathname, "package");
	} catch {
		return normalizedId(stripped, "package");
	}
}

function extensionId(path: string): string {
	const filename = basename(path, extname(path));
	return normalizedId(filename === "index" ? basename(dirname(path)) : filename, "plugin");
}

function addUniquePath(
	target: Map<string, string>,
	ambiguous: Set<string>,
	id: string,
	path: string,
): void {
	if (ambiguous.has(id)) return;
	const previous = target.get(id);
	if (!previous) {
		target.set(id, path);
		return;
	}
	if (realpathSync(previous) === realpathSync(path)) return;
	target.delete(id);
	ambiguous.add(id);
}

function enabledTrusted(
	resource: ResolvedResource,
	projectTrusted: boolean,
): boolean {
	return resource.enabled && (resource.metadata.scope !== "project" || projectTrusted);
}

function stableUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function skillSource(path: string): { body: string; contentHash: string } {
	const normalized = readFileSync(path, "utf8").replace(/\r\n?/gu, "\n");
	const body = normalized.startsWith("---\n")
		? normalized.slice(normalized.indexOf("\n---\n", 4) + 5).trim()
		: normalized.trim();
	if (!body || (normalized.startsWith("---\n") && normalized.indexOf("\n---\n", 4) < 0)) {
		throw new ModePackResourceError("INVALID_SKILL_BODY", `Skill ${path} has no readable body`);
	}
	return {
		body,
		contentHash: `sha256:${createHash("sha256").update(normalized).digest("hex")}`,
	};
}

function selectedIds(definition: ModePackDefinition): {
	skills: string[];
	plugins: string[];
	packages: string[];
} {
	return {
		skills: stableUnique([...definition.skills.required, ...definition.skills.optional]),
		plugins: stableUnique([...definition.plugins.required, ...definition.plugins.optional]),
		packages: stableUnique([...definition.packages.required, ...definition.packages.optional]),
	};
}

export async function buildModePackResourceInventory(
	cwd: string,
	agentDir: string,
	definition?: ModePackDefinition,
): Promise<ModePackResourceInventory> {
	const trust = getProjectTrustStatus(cwd, agentDir);
	const settings = SettingsManager.create(cwd, agentDir);
	settings.setProjectTrusted(trust.trusted);
	await settings.reload();
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
	const resolved = await manager.resolve(async () => "skip");
	const skillFiles = new Map<string, string>();
	const pluginPaths = new Map<string, string>();
	const ambiguousSkills = new Set<string>();
	const ambiguousPlugins = new Set<string>();

	for (const skillId of Object.keys(EDUCATION_SKILLS)) {
		const loaded = loadEducationSkill(skillId);
		skillFiles.set(skillId, loaded.filePath);
	}

	const trustedSkillPaths = resolved.skills
		.filter((resource) => enabledTrusted(resource, trust.trusted))
		.map((resource) => resource.path);
	const loadedSkills = loadSkills({
		cwd,
		agentDir,
		skillPaths: trustedSkillPaths,
		includeDefaults: false,
	});
	for (const diagnostic of loadedSkills.diagnostics) {
		if (diagnostic.type === "error") {
			throw new ModePackResourceError(
				"SKILL_INVENTORY_FAILED",
				`${diagnostic.path ?? "Skill"}: ${diagnostic.message}`,
			);
		}
	}
	for (const skill of loadedSkills.skills) {
		if (skill.name in EDUCATION_SKILLS) {
			const reserved = skillFiles.get(skill.name);
			if (reserved && realpathSync(reserved) !== realpathSync(skill.filePath)) {
				throw new ModePackResourceError(
					"RESERVED_SKILL_COLLISION",
					`Installed Skill ${skill.name} attempts to replace a built-in education Skill`,
				);
			}
			continue;
		}
		addUniquePath(skillFiles, ambiguousSkills, skill.name, skill.filePath);
	}

	for (const resource of resolved.extensions.filter((item) => enabledTrusted(item, trust.trusted))) {
		addUniquePath(pluginPaths, ambiguousPlugins, extensionId(resource.path), resource.path);
	}

	const packagePaths = new Map<string, PackageResourcePaths>();
	for (const configured of manager.listConfiguredPackages()) {
		if (configured.scope === "project" && !trust.trusted) continue;
		if (!configured.installedPath) continue;
		const root = realpathSync(configured.installedPath);
		const id = packageSourceId(configured.source);
		if (packagePaths.has(id)) {
			throw new ModePackResourceError(
				"PACKAGE_ID_COLLISION",
				`Configured packages collide on Mode Pack id ${id}`,
			);
		}
		packagePaths.set(id, {
			extensionPaths: stableUnique(
				resolved.extensions
					.filter((resource) => enabledTrusted(resource, trust.trusted) && inside(realpathSync(resource.path), root))
					.map((resource) => resource.path),
			),
			skillPaths: stableUnique(
				resolved.skills
					.filter((resource) => enabledTrusted(resource, trust.trusted) && inside(realpathSync(resource.path), root))
					.map((resource) => resource.path),
			),
		});
	}

	const skills = new Set(skillFiles.keys());
	const plugins = new Set(pluginPaths.keys());
	const packages = new Set<string>([...INTERNAL_PACKAGES, ...packagePaths.keys()]);
	const tools = new Set<string>([...BUILTIN_TOOLS, ...VIRTUAL_TOOLS]);
	// A selected extension/package may provide custom tools. They remain
	// provisional here and must be observed in the staged candidate before an
	// activation receipt can pass.
	if (definition) {
		const selection = selectedIds(definition);
		if (
			selection.plugins.some((id) => plugins.has(id)) ||
			selection.packages.some((id) => packagePaths.has(id))
		) {
			for (const tool of definition.allowedTools) tools.add(tool);
		}
	}
	return {
		installed: {
			skills,
			plugins,
			packages,
			tools,
			workflows: new Set(INTERNAL_WORKFLOWS),
		},
		skillFiles,
		pluginPaths,
		packagePaths,
		projectTrusted: trust.trusted,
	};
}

export function selectedModeResourcePaths(
	definition: ModePackDefinition,
	inventory: ModePackResourceInventory,
): SelectedModeResourcePaths {
	const selection = selectedIds(definition);
	const extensionPaths: string[] = [];
	const skillPaths: string[] = [];
	for (const id of selection.plugins) {
		const path = inventory.pluginPaths.get(id);
		if (path) extensionPaths.push(path);
	}
	for (const id of selection.skills) {
		const path = inventory.skillFiles.get(id);
		if (path) skillPaths.push(path);
	}
	for (const id of selection.packages) {
		const paths = inventory.packagePaths.get(id);
		if (!paths) continue;
		if (paths.extensionPaths.length === 0 && paths.skillPaths.length === 0) {
			throw new ModePackResourceError(
				"MODE_PACKAGE_HAS_NO_LOADABLE_RESOURCES",
				`Mode Pack package ${id} does not expose a Skill or extension that this runtime can load`,
			);
		}
		extensionPaths.push(...paths.extensionPaths);
		skillPaths.push(...paths.skillPaths);
	}
	return {
		extensionPaths: stableUnique(extensionPaths),
		skillPaths: stableUnique(skillPaths),
	};
}

export function materializeModePackPrompt(
	resolved: ResolvedModePack,
	inventory: ModePackResourceInventory,
	input: {
		cwd: string;
		agentDir: string;
		contextBinding: string | null;
	},
): ResolvedModePack {
	const skillBlocks: string[] = [];
	for (const skillId of resolved.loaded.skills) {
		const filePath = inventory.skillFiles.get(skillId);
		if (!filePath) {
			throw new ModePackResourceError("SKILL_MATERIALIZATION_MISSING", skillId);
		}
		if (skillId in EDUCATION_SKILLS) {
			const skill = loadEducationSkill(skillId);
			skillBlocks.push(
				`## Loaded Skill: ${skill.id}\n\n${skill.body}\n\n[Skill content hash: ${skill.contentHash}]`,
			);
		} else {
			const source = skillSource(filePath);
			skillBlocks.push(
				`## Loaded Skill: ${skillId}\n\n${source.body}\n\n[Skill content hash: ${source.contentHash}]`,
			);
		}
	}
	const contextFiles =
		resolved.definition.contextPolicy.kind === "workspace" ||
		resolved.definition.contextPolicy.kind === "creative-project"
			? loadProjectContextFiles({ cwd: input.cwd, agentDir: input.agentDir })
			: [];
	const sections = [
		resolved.effectivePrompt,
		`## Active Mode Context\n\nKind: ${resolved.definition.contextPolicy.kind}\nBinding: ${input.contextBinding ?? "none"}`,
		...skillBlocks,
		...contextFiles.map(
			(file) => `## Workspace instruction file: ${file.path}\n\n${file.content}`,
		),
	];
	const effectivePrompt = sections.filter(Boolean).join("\n\n---\n\n");
	if (effectivePrompt.length > MAX_MATERIALIZED_PROMPT_CHARS) {
		throw new ModePackResourceError(
			"MATERIALIZED_PROMPT_BUDGET_EXCEEDED",
			`Mode Pack prompt is ${effectivePrompt.length} characters; limit is ${MAX_MATERIALIZED_PROMPT_CHARS}`,
		);
	}
	return {
		...resolved,
		effectivePrompt,
		effectivePromptHash: modePackHash(effectivePrompt),
	};
}

export function actualToolName(
	logicalId: string,
	registered: ReadonlySet<string>,
): string {
	const candidates = stableUnique([logicalId, logicalId.replace(/-/gu, "_")]).filter((name) =>
		registered.has(name),
	);
	if (candidates.length !== 1) {
		throw new ModePackResourceError(
			candidates.length === 0 ? "MODE_TOOL_MISSING" : "MODE_TOOL_AMBIGUOUS",
			`Mode Pack tool ${logicalId} resolved to ${candidates.length} registered Pi tools`,
		);
	}
	return candidates[0] as string;
}

export function loadedSkillIds(skills: readonly Skill[]): string[] {
	return stableUnique(skills.map((skill) => skill.name));
}
