import { createHash } from "node:crypto";
import {
	type ModePackDefinition,
	type ModePackResourceDelivery,
	parseModePackDefinition,
	type ResourceKind,
} from "../../harness-contracts/src/index.ts";
import { contentHash, stableStringify } from "../../harness-core/src/index.ts";

export const PORTABLE_MODE_PACKAGE_VERSION = 1 as const;

export interface PortableModePackageAsset {
	path: string;
	contentHash: string;
	bytes: number;
	contentEncoding?: "gzip";
}
export interface PortableModePackageNpmDependency {
	package: string;
	version: string;
	integrity: string;
	entries: string[];
}
export interface PortableModePackageExternalDependency {
	kind: "executable";
	name: string;
}
export interface PortableModePackageResource {
	kind: ResourceKind;
	id: string;
	delivery: ModePackResourceDelivery;
	contentHash: string;
	source: { type: "bundled"; path: string } | ({ type: "npm" } & PortableModePackageNpmDependency);
	/** Private executables or peers selected with this resource, never Pi resources. */
	runtimeDependencies?: PortableModePackageNpmDependency[];
}
export interface PortableModePackageFile {
	path: string;
	contentHash: string;
	bytes: number;
	/** Present in transfer archives; omitted from the verified on-disk manifest. */
	base64?: string;
}
export interface PortableModePackageOfflineRuntime {
	archivePath: string;
	dependencies: PortableModePackageNpmDependency[];
	nodeModulesHash: string;
}
export interface PortableModePackageRuntimeAsset {
	kind: "harness" | "route-validation";
	id: string;
	version: string;
	entry: string;
	contentHash: string;
	/** All private local modules/data used by this asset, including entry. */
	files: string[];
	/** Exact private npm tree used by this package-owned runtime asset. */
	runtimeDependencies?: PortableModePackageNpmDependency[];
}
/** An explicitly shared Pi resource. Ordinary same-named resources remain
 * package-private. A consumer accepts only its own exact version unless it
 * lists another exact version here. */
export interface PortableModePackageSharedResource {
	logicalId: string;
	kind: Exclude<ResourceKind, "tool">;
	id: string;
	/** Explicit local dependency closure for this reusable implementation. */
	files: string[];
	compatibleVersions: string[];
}
export interface PortableModeDependencyGraph {
	format: "pi-own-portable-dependencies/v1";
	nodes: Array<{ id: string; kind: string; version: string | null; contentHash: string | null }>;
	edges: Array<{ from: string; to: string }>;
}
export interface PortableModePackage {
	version: typeof PORTABLE_MODE_PACKAGE_VERSION;
	/** One user-facing module may expose multiple internal profiles/phases. */
	moduleId?: string;
	definition: ModePackDefinition;
	profiles?: ModePackDefinition[];
	resources: PortableModePackageResource[];
	frontend: {
		entry: string;
		assets: PortableModePackageAsset[];
		phaseEntries?: Record<string, string>;
		presentation?: "panel" | "workspace";
	} | null;
	projectCapabilities: string[];
	/** Optional only for reading packages created before target metadata existed.
	 * New imports require it during mechanical preflight. */
	targetPlatform?: { os: string; arch: string };
	/** Explicit host-provided prerequisites. Absence is retained only while
	 * reading historical archives; new exports record an explicit array. */
	externalDependencies?: PortableModePackageExternalDependency[];
	/** A complete, platform-specific npm tree carried as verified local bytes. */
	offlineRuntime?: PortableModePackageOfflineRuntime;
	/** Package-owned runtime code, separate from ordinary Pi resources. */
	runtimeAssets?: PortableModePackageRuntimeAsset[];
	sharedResources?: PortableModePackageSharedResource[];
	/** Canonical, exhaustive local/host dependency edges, derived from the
	 * verified manifest and included in the package identity. */
	dependencyGraph?: PortableModeDependencyGraph;
	files: PortableModePackageFile[];
	packageContentHash: string;
}

export type PortableModePackageContent = Pick<
	PortableModePackage,
	| "resources"
	| "files"
	| "frontend"
	| "projectCapabilities"
	| "targetPlatform"
	| "externalDependencies"
	| "offlineRuntime"
	| "runtimeAssets"
	| "sharedResources"
	| "dependencyGraph"
	| "moduleId"
>;

function deriveDependencyGraph(
	payload: PortableModePackageContent,
	definitions: ModePackDefinition[],
): PortableModeDependencyGraph {
	const nodes = new Map<string, PortableModeDependencyGraph["nodes"][number]>();
	const edges = new Set<string>();
	const add = (id: string, kind: string, version: string | null, contentHash: string | null) => {
		const node = { id, kind, version, contentHash };
		const prior = nodes.get(id);
		if (prior && JSON.stringify(prior) !== JSON.stringify(node))
			throw new Error(`Portable dependency graph has incompatible node ${id}`);
		nodes.set(id, node);
	};
	const edge = (from: string, to: string) => edges.add(`${from}\0${to}`);
	add("module", "module", "1", null);
	for (const [index, definition] of definitions.entries()) {
		const profile = `profile:${index}`;
		add(profile, "profile", String(definition.version), null);
		edge("module", profile);
		for (const component of definition.components) {
			const kind =
				component.type === "plugin" ? "extension" : component.type === "workflow" ? "prompt" : component.type;
			const id = component.type === "workflow" ? `workflow:${component.id}` : component.id;
			const resource = `resource:${kind}:${id}`;
			add(resource, "resource", component.version, component.contentHash);
			edge(profile, resource);
		}
	}
	for (const file of payload.files) {
		const id = `file:${file.path}`;
		add(id, "file", null, file.contentHash);
		edge("module", id);
	}
	const npm = (dependency: PortableModePackageNpmDependency, owner: string) => {
		const id = `npm:${dependency.package}`;
		add(id, "npm", dependency.version, dependency.integrity);
		edge(owner, id);
	};
	for (const item of payload.resources) {
		const owner = `resource:${item.kind}:${item.id}`;
		if (!nodes.has(owner)) {
			add(owner, "resource", null, item.contentHash);
			edge("module", owner);
		}
		if (item.source.type === "bundled") edge(owner, `file:${item.source.path}`);
		else npm(item.source, owner);
		for (const dependency of item.runtimeDependencies ?? []) npm(dependency, owner);
	}
	for (const shared of payload.sharedResources ?? []) {
		const id = `shared:${shared.logicalId}`;
		add(id, "shared-resource", null, null);
		edge("module", id);
		edge(id, `resource:${shared.kind}:${shared.id}`);
		for (const path of shared.files) edge(id, `file:${path}`);
	}
	if (payload.frontend) {
		add(
			"frontend",
			"frontend",
			"1",
			payload.files.find((file) => file.path === payload.frontend!.entry)?.contentHash ?? null,
		);
		edge("module", "frontend");
		for (const asset of payload.frontend.assets) edge("frontend", `file:${asset.path}`);
	}
	for (const asset of payload.runtimeAssets ?? []) {
		const owner = `runtime:${asset.kind}:${asset.id}`;
		add(owner, "runtime-asset", asset.version, asset.contentHash);
		edge("module", owner);
		for (const path of asset.files) edge(owner, `file:${path}`);
		for (const dependency of asset.runtimeDependencies ?? []) npm(dependency, owner);
	}
	if (payload.offlineRuntime) {
		add("offline-npm", "offline-runtime", "1", payload.offlineRuntime.nodeModulesHash);
		edge("module", "offline-npm");
		edge("offline-npm", `file:${payload.offlineRuntime.archivePath}`);
		for (const dependency of payload.offlineRuntime.dependencies) npm(dependency, "offline-npm");
	}
	for (const capability of payload.projectCapabilities) {
		const id = `host:${capability}`;
		add(id, "host-capability", capability, null);
		edge("module", id);
	}
	for (const dependency of payload.externalDependencies ?? []) {
		const id = `executable:${dependency.name}`;
		add(id, "external-executable", null, null);
		edge("module", id);
	}
	return {
		format: "pi-own-portable-dependencies/v1",
		nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
		edges: [...edges]
			.map((key) => {
				const [from, to] = key.split("\0");
				return { from: from!, to: to! };
			})
			.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
	};
}

/** The manifest identity excludes base64 and install-specific module names.
 * Phase suffixes preserve the internal module layout across renamed installs. */
export function portableModePackageContentHash(payload: PortableModePackageContent, profileIds: string[] = []): string {
	const moduleId = payload.moduleId;
	if (moduleId && profileIds.length === 0) throw new Error("Module content identity requires every profile id");
	const phaseSuffixes = moduleId
		? profileIds.map((id) => {
				if (id === moduleId) return "";
				if (!id.startsWith(`${moduleId}.`)) throw new Error(`Profile ${id} does not belong to module ${moduleId}`);
				return id.slice(moduleId.length);
			})
		: [];
	return contentHash({
		resources: payload.resources,
		files: payload.files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })),
		frontend: payload.frontend,
		projectCapabilities: [...payload.projectCapabilities].sort(),
		...(payload.targetPlatform ? { targetPlatform: payload.targetPlatform } : {}),
		...(payload.externalDependencies ? { externalDependencies: payload.externalDependencies } : {}),
		...(payload.offlineRuntime ? { offlineRuntime: payload.offlineRuntime } : {}),
		...(payload.runtimeAssets ? { runtimeAssets: payload.runtimeAssets } : {}),
		...(payload.sharedResources ? { sharedResources: payload.sharedResources } : {}),
		...(payload.dependencyGraph ? { dependencyGraph: payload.dependencyGraph } : {}),
		...(payload.moduleId ? { phaseSuffixes } : {}),
	});
}

/** Author a package through the same strict parser used at import. The caller
 * supplies complete component pins and bytes; this function owns both hashes. */
export function createPortableModePackage(
	payload: PortableModePackageContent & {
		definition: Omit<ModePackDefinition, "contentHash">;
		profiles?: Array<Omit<ModePackDefinition, "contentHash">>;
	},
): PortableModePackage {
	if (!payload.targetPlatform || !payload.externalDependencies) {
		throw new Error("New portable Mode Packages require targetPlatform and externalDependencies");
	}
	const complete = {
		...payload,
		dependencyGraph: deriveDependencyGraph(payload, [
			payload.definition as ModePackDefinition,
			...((payload.profiles ?? []) as ModePackDefinition[]),
		]),
	};
	const packageContentHash = portableModePackageContentHash(complete, [
		payload.definition.modePackId,
		...(payload.profiles?.map((item) => item.modePackId) ?? []),
	]);
	const { contentHash: _oldContentHash, ...definitionBody } = payload.definition as ModePackDefinition;
	const rawDefinition = { ...definitionBody, packageContentHash };
	return parsePortableModePackage({
		version: PORTABLE_MODE_PACKAGE_VERSION,
		...complete,
		definition: { ...rawDefinition, contentHash: contentHash(rawDefinition) },
		...(payload.profiles
			? {
					profiles: payload.profiles.map((profile) => {
						const { contentHash: _oldHash, ...body } = profile as ModePackDefinition;
						const normalized = { ...body, packageContentHash };
						return { ...normalized, contentHash: contentHash(normalized) };
					}),
				}
			: {}),
		packageContentHash,
	});
}

/** Construct a file-backed package without materializing large local payloads
 * as base64. The same metadata parser and identity rules apply. */
export function createStoredPortableModePackage(
	payload: PortableModePackageContent & {
		definition: Omit<ModePackDefinition, "contentHash">;
		profiles?: Array<Omit<ModePackDefinition, "contentHash">>;
	},
): PortableModePackage {
	if (!payload.targetPlatform || !payload.externalDependencies) {
		throw new Error("New portable Mode Packages require targetPlatform and externalDependencies");
	}
	const complete = {
		...payload,
		dependencyGraph: deriveDependencyGraph(payload, [
			payload.definition as ModePackDefinition,
			...((payload.profiles ?? []) as ModePackDefinition[]),
		]),
	};
	const packageContentHash = portableModePackageContentHash(complete, [
		payload.definition.modePackId,
		...(payload.profiles?.map((item) => item.modePackId) ?? []),
	]);
	const { contentHash: _oldContentHash, ...definitionBody } = payload.definition as ModePackDefinition;
	const rawDefinition = { ...definitionBody, packageContentHash };
	return parsePortableModePackage(
		{
			version: PORTABLE_MODE_PACKAGE_VERSION,
			...complete,
			definition: { ...rawDefinition, contentHash: contentHash(rawDefinition) },
			...(payload.profiles
				? {
						profiles: payload.profiles.map((profile) => {
							const { contentHash: _oldHash, ...body } = profile as ModePackDefinition;
							const normalized = { ...body, packageContentHash };
							return { ...normalized, contentHash: contentHash(normalized) };
						}),
					}
				: {}),
			files: payload.files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })),
			packageContentHash,
		},
		{ storedManifest: true },
	);
}

/** This identity is used as a directory name. Keep it deliberately narrower
 * than generic resource hashes so a malicious definition can never influence
 * a filesystem path. */
export function isPortableModePackageContentHash(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function assertPortableModePackageContentHash(value: unknown, path = "packageContentHash"): string {
	if (!isPortableModePackageContentHash(value))
		throw new Error(`${path}: expected sha256:<64 lowercase hex characters>`);
	return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected object`);
	return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[], path: string): void {
	for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${path}.${key}: unknown field`);
	for (const key of keys) if (!(key in value)) throw new Error(`${path}.${key}: missing required field`);
}
function exactWithOptional(value: Record<string, unknown>, keys: string[], optional: string[], path: string): void {
	for (const key of Object.keys(value))
		if (!keys.includes(key) && !optional.includes(key)) throw new Error(`${path}.${key}: unknown field`);
	for (const key of keys) if (!(key in value)) throw new Error(`${path}.${key}: missing required field`);
}
function text(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path}: expected non-empty string`);
	return value;
}
function packagePath(value: unknown, path: string): string {
	const result = text(value, path);
	const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
	const segments = result.split("/");
	if (
		result.includes("\\") ||
		result.includes(":") ||
		result.startsWith("/") ||
		result.startsWith("//") ||
		result.endsWith("/") ||
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				/[. ]$/u.test(segment) ||
				/[\0-\x1f<>"|?*]/u.test(segment) ||
				reserved.test(segment.split(".", 1)[0]!),
		)
	)
		throw new Error(
			`${path}: expected a canonical relative slash path without traversal, Windows aliases, drive, URL, controls, or reserved characters`,
		);
	return result;
}

function canonicalBase64(value: string): boolean {
	if (value.length % 4 !== 0) return false;
	let padding = 0;
	if (value.endsWith("==")) padding = 2;
	else if (value.endsWith("=")) padding = 1;
	const length = value.length - padding;
	for (let index = 0; index < length; index += 1) {
		const code = value.charCodeAt(index);
		if (
			!(
				(code >= 65 && code <= 90) ||
				(code >= 97 && code <= 122) ||
				(code >= 48 && code <= 57) ||
				code === 43 ||
				code === 47
			)
		)
			return false;
	}
	if (padding === 2) {
		const code = value.charCodeAt(length - 1);
		const sextet =
			code >= 65 && code <= 90
				? code - 65
				: code >= 97 && code <= 122
					? code - 71
					: code >= 48 && code <= 57
						? code + 4
						: code === 43
							? 62
							: 63;
		if ((sextet & 0b1111) !== 0) return false;
	} else if (padding === 1) {
		const code = value.charCodeAt(length - 1);
		const sextet =
			code >= 65 && code <= 90
				? code - 65
				: code >= 97 && code <= 122
					? code - 71
					: code >= 48 && code <= 57
						? code + 4
						: code === 43
							? 62
							: 63;
		if ((sextet & 0b11) !== 0) return false;
	}
	return true;
}

function assertCanonicalPayloadPaths(paths: readonly string[]): void {
	const canonical = new Map<string, string>();
	for (const path of paths) {
		const key = path.toLocaleLowerCase("en-US");
		const prior = canonical.get(key);
		if (prior && prior !== path)
			throw new Error(`portableModePackage.files: Windows case collision: ${prior} and ${path}`);
		canonical.set(key, path);
		const first = key.split("/", 1)[0]!;
		if (first === "manifest.json" || first === "runtime")
			throw new Error(`portableModePackage.files: reserved host namespace: ${path}`);
	}
	const sorted = [...canonical.keys()].sort();
	for (let index = 1; index < sorted.length; index += 1) {
		if (sorted[index]!.startsWith(`${sorted[index - 1]!}/`))
			throw new Error(
				`portableModePackage.files: file/directory prefix collision: ${canonical.get(sorted[index - 1]!)} and ${canonical.get(sorted[index]!)}`,
			);
	}
}
function hash(value: unknown, path: string): string {
	const result = text(value, path);
	if (!/^sha(?:256|512):[A-Za-z0-9+/=_-]+$/u.test(result)) throw new Error(`${path}: expected a SHA hash`);
	return result;
}
function integrity(value: unknown, path: string): string {
	const result = text(value, path);
	if (!/^sha(?:256|512)-[A-Za-z0-9+/]+={0,2}$/u.test(result))
		throw new Error(`${path}: expected an immutable SRI hash`);
	return result;
}
function npmPackage(value: unknown, path: string): string {
	const result = text(value, path);
	if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(result))
		throw new Error(`${path}: expected an npm registry package name`);
	return result;
}
function exactVersion(value: unknown, path: string): string {
	const result = text(value, path);
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(result))
		throw new Error(`${path}: expected an exact semver version`);
	return result;
}
function npmDependency(value: unknown, path: string): PortableModePackageNpmDependency {
	const item = object(value, path);
	exactWithOptional(item, ["package", "version", "integrity", "entries"], ["type"], path);
	if (!Array.isArray(item.entries)) throw new Error(`${path}.entries: expected array`);
	const entries = item.entries.map((entry, index) => packagePath(entry, `${path}.entries[${index}]`));
	if (new Set(entries).size !== entries.length) throw new Error(`${path}.entries: duplicate entry`);
	return {
		package: npmPackage(item.package, `${path}.package`),
		version: exactVersion(item.version, `${path}.version`),
		integrity: integrity(item.integrity, `${path}.integrity`),
		entries,
	};
}

/** Strict, path-safe import/export format. Host-specific installers consume the
 * source pin; neither an exported package nor its frontend can carry a local path. */
export function parsePortableModePackage(
	value: unknown,
	options: { storedManifest?: boolean } = {},
): PortableModePackage {
	const root = object(value, "portableModePackage");
	exactWithOptional(
		root,
		["version", "definition", "resources", "frontend", "projectCapabilities", "files", "packageContentHash"],
		[
			"targetPlatform",
			"externalDependencies",
			"offlineRuntime",
			"runtimeAssets",
			"sharedResources",
			"dependencyGraph",
			"moduleId",
			"profiles",
		],
		"portableModePackage",
	);
	if (root.version !== PORTABLE_MODE_PACKAGE_VERSION)
		throw new Error("portableModePackage.version: unsupported version");
	if (!Array.isArray(root.resources)) throw new Error("portableModePackage.resources: expected array");
	const definition = parseModePackDefinition(root.definition);
	const moduleId = root.moduleId === undefined ? undefined : text(root.moduleId, "portableModePackage.moduleId");
	if (moduleId && !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(moduleId))
		throw new Error("portableModePackage.moduleId: invalid module identity");
	if (root.profiles !== undefined && !moduleId) throw new Error("portableModePackage.profiles: moduleId is required");
	if (root.profiles !== undefined && (!Array.isArray(root.profiles) || root.profiles.length === 0))
		throw new Error("portableModePackage.profiles: expected non-empty array");
	const profiles =
		root.profiles === undefined ? undefined : root.profiles.map((item) => parseModePackDefinition(item));
	const definitions = [definition, ...(profiles ?? [])];
	if (new Set(definitions.map((item) => item.modePackId)).size !== definitions.length)
		throw new Error("portableModePackage.profiles: duplicate profile id");
	if (
		moduleId &&
		definitions.some((item) => item.modePackId !== moduleId && !item.modePackId.startsWith(`${moduleId}.`))
	)
		throw new Error("portableModePackage.profiles: profile id must belong to moduleId");
	if (profiles && definition.modePackId === moduleId)
		throw new Error("portableModePackage.definition: multi-profile module requires a phase-specific id");
	if (!Array.isArray(root.files)) throw new Error("portableModePackage.files: expected array");
	if (
		!Array.isArray(root.projectCapabilities) ||
		root.projectCapabilities.some((item) => typeof item !== "string" || !item.trim())
	)
		throw new Error("portableModePackage.projectCapabilities: expected non-empty strings");
	const files = root.files.map((raw, index) => {
		const file = object(raw, `portableModePackage.files[${index}]`);
		if (options.storedManifest) exact(file, ["path", "contentHash", "bytes"], `portableModePackage.files[${index}]`);
		else exact(file, ["path", "contentHash", "bytes", "base64"], `portableModePackage.files[${index}]`);
		const path = packagePath(file.path, `portableModePackage.files[${index}].path`);
		const contentHash = hash(file.contentHash, `portableModePackage.files[${index}].contentHash`);
		if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0)
			throw new Error(`portableModePackage.files[${index}]: invalid bytes`);
		if (options.storedManifest) return { path, contentHash, bytes: file.bytes as number };
		if (typeof file.base64 !== "string")
			throw new Error(`portableModePackage.files[${index}].base64: expected string`);
		if (!canonicalBase64(file.base64))
			throw new Error(`portableModePackage.files[${index}].base64: expected canonical base64`);
		const bytes = Buffer.from(file.base64, "base64");
		if (bytes.byteLength !== file.bytes || portableModePackageAssetHash(bytes) !== contentHash)
			throw new Error(`portableModePackage.files[${index}]: byte/hash mismatch`);
		return { path, contentHash, bytes: file.bytes as number, base64: file.base64 };
	});
	if (new Set(files.map((file) => file.path)).size !== files.length)
		throw new Error("portableModePackage.files: duplicate file path");
	assertCanonicalPayloadPaths(files.map((file) => file.path));
	if (new Set(root.projectCapabilities).size !== root.projectCapabilities.length)
		throw new Error("portableModePackage.projectCapabilities: duplicate capability");
	const targetPlatform =
		root.targetPlatform === undefined
			? undefined
			: (() => {
					const target = object(root.targetPlatform, "portableModePackage.targetPlatform");
					exact(target, ["os", "arch"], "portableModePackage.targetPlatform");
					return {
						os: text(target.os, "portableModePackage.targetPlatform.os"),
						arch: text(target.arch, "portableModePackage.targetPlatform.arch"),
					};
				})();
	const externalDependencies =
		root.externalDependencies === undefined
			? undefined
			: (() => {
					if (!Array.isArray(root.externalDependencies)) {
						throw new Error("portableModePackage.externalDependencies: expected array");
					}
					const entries = root.externalDependencies.map((raw, index) => {
						const path = `portableModePackage.externalDependencies[${index}]`;
						const item = object(raw, path);
						exact(item, ["kind", "name"], path);
						if (item.kind !== "executable") throw new Error(`${path}.kind: expected executable`);
						const name = text(item.name, `${path}.name`);
						if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name)) {
							throw new Error(`${path}.name: expected a bare executable name without a path`);
						}
						return { kind: "executable" as const, name };
					});
					if (new Set(entries.map((item) => `${item.kind}:${item.name.toLowerCase()}`)).size !== entries.length) {
						throw new Error("portableModePackage.externalDependencies: duplicate requirement");
					}
					return entries;
				})();
	const resources = root.resources.map((raw, index) => {
		const item = object(raw, `portableModePackage.resources[${index}]`);
		exactWithOptional(
			item,
			["kind", "id", "delivery", "contentHash", "source"],
			["runtimeDependencies"],
			`portableModePackage.resources[${index}]`,
		);
		if (
			!["tool", "extension", "skill", "prompt", "theme"].includes(
				text(item.kind, `portableModePackage.resources[${index}].kind`),
			)
		)
			throw new Error(`portableModePackage.resources[${index}].kind: invalid kind`);
		const delivery = text(
			item.delivery,
			`portableModePackage.resources[${index}].delivery`,
		) as ModePackResourceDelivery;
		if (!["system-instruction", "native-skill", "native-prompt-template"].includes(delivery))
			throw new Error(`portableModePackage.resources[${index}].delivery: invalid delivery`);
		if (delivery === "native-skill" && item.kind !== "skill")
			throw new Error(`portableModePackage.resources[${index}].delivery: native-skill requires kind=skill`);
		if (delivery === "native-prompt-template" && item.kind !== "prompt")
			throw new Error(
				`portableModePackage.resources[${index}].delivery: native-prompt-template requires kind=prompt`,
			);
		const source = object(item.source, `portableModePackage.resources[${index}].source`);
		const runtimeDependencies =
			item.runtimeDependencies === undefined
				? undefined
				: (() => {
						if (!Array.isArray(item.runtimeDependencies))
							throw new Error(`portableModePackage.resources[${index}].runtimeDependencies: expected array`);
						const dependencies = item.runtimeDependencies.map((entry, dependencyIndex) =>
							npmDependency(
								entry,
								`portableModePackage.resources[${index}].runtimeDependencies[${dependencyIndex}]`,
							),
						);
						if (new Set(dependencies.map((entry) => entry.package)).size !== dependencies.length)
							throw new Error(`portableModePackage.resources[${index}].runtimeDependencies: duplicate package`);
						return dependencies;
					})();
		if (source.type === "bundled") {
			exact(source, ["type", "path"], `portableModePackage.resources[${index}].source`);
			return {
				kind: item.kind as ResourceKind,
				id: text(item.id, `portableModePackage.resources[${index}].id`),
				delivery,
				contentHash: hash(item.contentHash, `portableModePackage.resources[${index}].contentHash`),
				source: {
					type: "bundled" as const,
					path: packagePath(source.path, `portableModePackage.resources[${index}].source.path`),
				},
				...(runtimeDependencies?.length ? { runtimeDependencies } : {}),
			};
		}
		if (source.type === "npm") {
			exact(
				source,
				["type", "package", "version", "integrity", "entries"],
				`portableModePackage.resources[${index}].source`,
			);
			const dependency = npmDependency(source, `portableModePackage.resources[${index}].source`);
			return {
				kind: item.kind as ResourceKind,
				id: text(item.id, `portableModePackage.resources[${index}].id`),
				delivery,
				contentHash: hash(item.contentHash, `portableModePackage.resources[${index}].contentHash`),
				source: { type: "npm" as const, ...dependency },
				...(runtimeDependencies?.length ? { runtimeDependencies } : {}),
			};
		}
		throw new Error(`portableModePackage.resources[${index}].source.type: expected bundled or npm`);
	});
	if (new Set(resources.map((resource) => `${resource.kind}:${resource.id}`)).size !== resources.length)
		throw new Error("portableModePackage.resources: duplicate resource identity");
	const packagePins = new Map<string, string>();
	for (const resource of resources) {
		for (const dependency of [
			...(resource.source.type === "npm" ? [resource.source] : []),
			...(resource.runtimeDependencies ?? []),
		]) {
			const pin = `${dependency.version}\0${dependency.integrity}\0${dependency.entries.join("\0")}`;
			const previous = packagePins.get(dependency.package);
			if (previous && previous !== pin)
				throw new Error(`portableModePackage.resources: conflicting npm pin for ${dependency.package}`);
			packagePins.set(dependency.package, pin);
		}
	}
	const offlineRuntime =
		root.offlineRuntime === undefined
			? undefined
			: (() => {
					const value = object(root.offlineRuntime, "portableModePackage.offlineRuntime");
					exact(value, ["archivePath", "dependencies", "nodeModulesHash"], "portableModePackage.offlineRuntime");
					const archivePath = packagePath(value.archivePath, "portableModePackage.offlineRuntime.archivePath");
					if (!Array.isArray(value.dependencies))
						throw new Error("portableModePackage.offlineRuntime.dependencies: expected array");
					const dependencies = value.dependencies.map((entry, index) =>
						npmDependency(entry, `portableModePackage.offlineRuntime.dependencies[${index}]`),
					);
					if (new Set(dependencies.map((item) => item.package)).size !== dependencies.length) {
						throw new Error("portableModePackage.offlineRuntime.dependencies: duplicate package");
					}
					for (const [name, pin] of packagePins) {
						const dependency = dependencies.find((item) => item.package === name);
						if (
							!dependency ||
							`${dependency.version}\0${dependency.integrity}\0${dependency.entries.join("\0")}` !== pin
						) {
							throw new Error(`portableModePackage.offlineRuntime.dependencies: missing exact pin for ${name}`);
						}
					}
					if (typeof value.nodeModulesHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.nodeModulesHash)) {
						throw new Error(
							"portableModePackage.offlineRuntime.nodeModulesHash: expected sha256:<64 lowercase hex characters>",
						);
					}
					return { archivePath, dependencies, nodeModulesHash: value.nodeModulesHash };
				})();
	const references = new Set(resources.map((resource) => `${resource.kind}:${resource.id}`));
	for (const component of definitions.flatMap((item) => item.components)) {
		const kind =
			component.type === "plugin" ? "extension" : component.type === "workflow" ? "prompt" : component.type;
		const id = component.type === "workflow" ? `workflow:${component.id}` : component.id;
		if (!references.has(`${kind}:${id}`))
			throw new Error(`portableModePackage.resources: missing source for ${kind}:${id}`);
		const resource = resources.find((candidate) => candidate.kind === kind && candidate.id === id)!;
		if (resource.contentHash !== component.contentHash)
			throw new Error(`portableModePackage.resources: content hash does not match selectable ${kind}:${id}`);
		if (resource.source.type === "npm" && resource.source.version !== component.version)
			throw new Error(`portableModePackage.resources: npm version does not match selectable ${kind}:${id}`);
	}
	const sharedResources =
		root.sharedResources === undefined
			? undefined
			: (() => {
					if (!Array.isArray(root.sharedResources))
						throw new Error("portableModePackage.sharedResources: expected array");
					const shared = root.sharedResources.map((raw, index) => {
						const path = `portableModePackage.sharedResources[${index}]`;
						const item = object(raw, path);
						exact(item, ["logicalId", "kind", "id", "files", "compatibleVersions"], path);
						const logicalId = text(item.logicalId, `${path}.logicalId`);
						if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(logicalId))
							throw new Error(`${path}.logicalId: invalid shared identity`);
						if (!["extension", "skill", "prompt", "theme"].includes(item.kind as string))
							throw new Error(`${path}.kind: unsupported shared resource kind`);
						const kind = item.kind as PortableModePackageSharedResource["kind"];
						const id = text(item.id, `${path}.id`);
						const resource = resources.find((entry) => entry.kind === kind && entry.id === id);
						if (!resource || resource.source.type !== "bundled")
							throw new Error(`${path}: shared resource must have a complete bundled source`);
						if (!Array.isArray(item.files) || item.files.length === 0)
							throw new Error(`${path}.files: expected non-empty dependency closure`);
						const sharedFiles = item.files.map((entry, fileIndex) =>
							packagePath(entry, `${path}.files[${fileIndex}]`),
						);
						if (new Set(sharedFiles).size !== sharedFiles.length)
							throw new Error(`${path}.files: duplicate path`);
						if (!sharedFiles.includes(resource.source.path))
							throw new Error(`${path}.files: missing resource entry ${resource.source.path}`);
						if (sharedFiles.some((entry) => !files.some((file) => file.path === entry)))
							throw new Error(`${path}.files: dependency path is absent from package`);
						const ownDirectory = resource.source.path.slice(0, resource.source.path.lastIndexOf("/") + 1);
						if (files.some((file) => file.path.startsWith(ownDirectory) && !sharedFiles.includes(file.path)))
							throw new Error(`${path}.files: missing same-directory dependency`);
						const pins = definitions
							.flatMap((definition) => definition.components)
							.filter((component) =>
								kind === "extension"
									? component.type === "plugin" && component.id === id
									: kind === "prompt"
										? (component.type === "prompt" && component.id === id) ||
											(component.type === "workflow" && `workflow:${component.id}` === id)
										: component.type === kind && component.id === id,
							);
						if (!pins.length || new Set(pins.map((pin) => `${pin.version}\0${pin.contentHash}`)).size !== 1)
							throw new Error(`${path}: shared resource needs one exact selected component pin across profiles`);
						const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
						if (!Array.isArray(item.compatibleVersions))
							throw new Error(`${path}.compatibleVersions: expected array`);
						const compatibleVersions = item.compatibleVersions.map((version, versionIndex) =>
							exactVersion(version, `${path}.compatibleVersions[${versionIndex}]`),
						);
						if (compatibleVersions.some((version) => !stableVersion.test(version)))
							throw new Error(`${path}.compatibleVersions: only stable semver is supported`);
						if (compatibleVersions.length && !stableVersion.test(pins[0]!.version))
							throw new Error(`${path}.compatibleVersions: upgrades need a stable-semver current version`);
						if (new Set(compatibleVersions).size !== compatibleVersions.length)
							throw new Error(`${path}.compatibleVersions: duplicate version`);
						return { logicalId, kind, id, files: sharedFiles, compatibleVersions };
					});
					if (new Set(shared.map((item) => item.logicalId)).size !== shared.length)
						throw new Error("portableModePackage.sharedResources: duplicate logical identity");
					if (new Set(shared.map((item) => `${item.kind}:${item.id}`)).size !== shared.length)
						throw new Error("portableModePackage.sharedResources: resource has multiple shared identities");
					return shared;
				})();
	let frontend: PortableModePackage["frontend"] = null;
	if (root.frontend !== null) {
		const value = object(root.frontend, "portableModePackage.frontend");
		exactWithOptional(value, ["entry", "assets"], ["phaseEntries", "presentation"], "portableModePackage.frontend");
		if (value.presentation !== undefined && value.presentation !== "panel" && value.presentation !== "workspace")
			throw new Error("portableModePackage.frontend.presentation: unsupported presentation");
		if (!Array.isArray(value.assets)) throw new Error("portableModePackage.frontend.assets: expected array");
		const assets = value.assets.map((raw, index) => {
			const asset = object(raw, `portableModePackage.frontend.assets[${index}]`);
			exactWithOptional(
				asset,
				["path", "contentHash", "bytes"],
				["contentEncoding"],
				`portableModePackage.frontend.assets[${index}]`,
			);
			if (!Number.isSafeInteger(asset.bytes) || (asset.bytes as number) < 0)
				throw new Error(`portableModePackage.frontend.assets[${index}].bytes: expected non-negative safe integer`);
			if (asset.contentEncoding !== undefined && asset.contentEncoding !== "gzip")
				throw new Error(`portableModePackage.frontend.assets[${index}].contentEncoding: unsupported encoding`);
			return {
				path: packagePath(asset.path, `portableModePackage.frontend.assets[${index}].path`),
				contentHash: hash(asset.contentHash, `portableModePackage.frontend.assets[${index}].contentHash`),
				bytes: asset.bytes as number,
				...(asset.contentEncoding ? { contentEncoding: asset.contentEncoding as "gzip" } : {}),
			};
		});
		if (new Set(assets.map((asset) => asset.path)).size !== assets.length)
			throw new Error("portableModePackage.frontend.assets: duplicate asset path");
		const entry = packagePath(value.entry, "portableModePackage.frontend.entry");
		if (!assets.some((asset) => asset.path === entry))
			throw new Error("portableModePackage.frontend.entry: must be an asset");
		let phaseEntries: Record<string, string> | undefined;
		if (value.phaseEntries !== undefined) {
			if (!moduleId) throw new Error("portableModePackage.frontend.phaseEntries: moduleId is required");
			const entries = object(value.phaseEntries, "portableModePackage.frontend.phaseEntries");
			const knownSuffixes = new Set(definitions.map((item) => item.modePackId.slice(moduleId.length)));
			phaseEntries = {};
			for (const [suffix, rawPath] of Object.entries(entries)) {
				if (!knownSuffixes.has(suffix))
					throw new Error(`portableModePackage.frontend.phaseEntries: unknown phase ${suffix}`);
				const path = packagePath(rawPath, `portableModePackage.frontend.phaseEntries.${suffix}`);
				if (!assets.some((asset) => asset.path === path))
					throw new Error(`portableModePackage.frontend.phaseEntries: ${path} is not an asset`);
				phaseEntries[suffix] = path;
			}
		}
		frontend = {
			entry,
			assets,
			...(phaseEntries ? { phaseEntries } : {}),
			...(value.presentation ? { presentation: value.presentation as "panel" | "workspace" } : {}),
		};
	}
	const bundledFiles = new Map(files.map((file) => [file.path, file]));
	const runtimeAssets =
		root.runtimeAssets === undefined
			? undefined
			: (() => {
					if (!Array.isArray(root.runtimeAssets))
						throw new Error("portableModePackage.runtimeAssets: expected array");
					const assets: PortableModePackageRuntimeAsset[] = root.runtimeAssets.map((raw, index) => {
						const path = `portableModePackage.runtimeAssets[${index}]`;
						const item = object(raw, path);
						exactWithOptional(
							item,
							["kind", "id", "version", "entry", "contentHash", "files"],
							["runtimeDependencies"],
							path,
						);
						if (item.kind !== "harness" && item.kind !== "route-validation")
							throw new Error(`${path}.kind: unsupported runtime asset`);
						if (!Array.isArray(item.files) || item.files.length === 0)
							throw new Error(`${path}.files: expected non-empty array`);
						const paths = item.files.map((value, fileIndex) => packagePath(value, `${path}.files[${fileIndex}]`));
						if (new Set(paths).size !== paths.length) throw new Error(`${path}.files: duplicate file`);
						const entry = packagePath(item.entry, `${path}.entry`);
						if (!paths.includes(entry)) throw new Error(`${path}.entry: must be declared in files`);
						for (const name of paths)
							if (!bundledFiles.has(name)) throw new Error(`${path}.files: missing package file ${name}`);
						const entryHash = hash(item.contentHash, `${path}.contentHash`);
						if (bundledFiles.get(entry)!.contentHash !== entryHash)
							throw new Error(`${path}.contentHash: does not match entry bytes`);
						const runtimeDependencies =
							item.runtimeDependencies === undefined
								? undefined
								: (() => {
										if (!Array.isArray(item.runtimeDependencies))
											throw new Error(`${path}.runtimeDependencies: expected array`);
										const dependencies = item.runtimeDependencies.map((value, index) =>
											npmDependency(value, `${path}.runtimeDependencies[${index}]`),
										);
										if (
											new Set(dependencies.map((dependency) => dependency.package)).size !==
											dependencies.length
										)
											throw new Error(`${path}.runtimeDependencies: duplicate package`);
										return dependencies;
									})();
						return {
							kind: item.kind as PortableModePackageRuntimeAsset["kind"],
							id: text(item.id, `${path}.id`),
							version: text(item.version, `${path}.version`),
							entry,
							contentHash: entryHash,
							files: paths,
							...(runtimeDependencies ? { runtimeDependencies } : {}),
						};
					});
					if (new Set(assets.map((asset) => `${asset.kind}:${asset.id}`)).size !== assets.length)
						throw new Error("portableModePackage.runtimeAssets: duplicate runtime asset identity");
					return assets;
				})();
	for (const asset of runtimeAssets ?? [])
		for (const dependency of asset.runtimeDependencies ?? []) {
			const pin = `${dependency.version}\0${dependency.integrity}\0${dependency.entries.join("\0")}`;
			const prior = packagePins.get(dependency.package);
			if (prior && prior !== pin)
				throw new Error(`portableModePackage.runtimeAssets: conflicting npm pin for ${dependency.package}`);
			packagePins.set(dependency.package, pin);
			const installed = offlineRuntime?.dependencies.find((item) => item.package === dependency.package);
			if (
				offlineRuntime &&
				(!installed || `${installed.version}\0${installed.integrity}\0${installed.entries.join("\0")}` !== pin)
			)
				throw new Error(
					`portableModePackage.offlineRuntime.dependencies: missing exact pin for runtime asset ${dependency.package}`,
				);
		}
	const dependencyGraph =
		root.dependencyGraph === undefined
			? undefined
			: (() => {
					const expected = deriveDependencyGraph(
						{
							resources,
							files,
							frontend,
							projectCapabilities: root.projectCapabilities as string[],
							...(targetPlatform ? { targetPlatform } : {}),
							...(externalDependencies ? { externalDependencies } : {}),
							...(offlineRuntime ? { offlineRuntime } : {}),
							...(runtimeAssets ? { runtimeAssets } : {}),
							...(sharedResources ? { sharedResources } : {}),
						},
						definitions,
					);
					if (stableStringify(root.dependencyGraph) !== stableStringify(expected)) {
						throw new Error(
							"portableModePackage.dependencyGraph: does not match the verified package dependency closure",
						);
					}
					return expected;
				})();
	const packageContentHash = assertPortableModePackageContentHash(
		root.packageContentHash,
		"portableModePackage.packageContentHash",
	);
	const expectedPackageContentHash = portableModePackageContentHash(
		{
			resources,
			files,
			frontend,
			projectCapabilities: root.projectCapabilities as string[],
			...(targetPlatform ? { targetPlatform } : {}),
			...(externalDependencies ? { externalDependencies } : {}),
			...(offlineRuntime ? { offlineRuntime } : {}),
			...(runtimeAssets ? { runtimeAssets } : {}),
			...(sharedResources ? { sharedResources } : {}),
			...(dependencyGraph ? { dependencyGraph } : {}),
			...(moduleId ? { moduleId } : {}),
		},
		definitions.map((item) => item.modePackId),
	);
	if (packageContentHash !== expectedPackageContentHash)
		throw new Error("portableModePackage.packageContentHash: invalid package payload identity");
	for (const item of definitions)
		if (item.packageContentHash !== packageContentHash)
			throw new Error(`portableModePackage.profile ${item.modePackId}: package identity does not match archive`);
	const bundledPaths = new Set(bundledFiles.keys());
	if (offlineRuntime && !bundledPaths.has(offlineRuntime.archivePath)) {
		throw new Error(`portableModePackage.files: missing offline npm archive ${offlineRuntime.archivePath}`);
	}
	for (const resource of resources)
		if (resource.source.type === "bundled" && !bundledPaths.has(resource.source.path))
			throw new Error(`portableModePackage.files: missing bundled resource ${resource.source.path}`);
	if (frontend)
		for (const asset of frontend.assets) {
			const file = bundledFiles.get(asset.path);
			if (!file) throw new Error(`portableModePackage.files: missing frontend asset ${asset.path}`);
			if (file.contentHash !== asset.contentHash || file.bytes !== asset.bytes)
				throw new Error(`portableModePackage.frontend.assets: metadata does not match bundled file ${asset.path}`);
		}
	return {
		version: PORTABLE_MODE_PACKAGE_VERSION,
		...(moduleId ? { moduleId } : {}),
		definition,
		...(profiles ? { profiles } : {}),
		resources,
		frontend,
		projectCapabilities: [...root.projectCapabilities].sort(),
		...(targetPlatform ? { targetPlatform } : {}),
		...(externalDependencies ? { externalDependencies } : {}),
		...(offlineRuntime ? { offlineRuntime } : {}),
		...(runtimeAssets ? { runtimeAssets } : {}),
		...(sharedResources ? { sharedResources } : {}),
		...(dependencyGraph ? { dependencyGraph } : {}),
		files,
		packageContentHash,
	};
}

export function portableModePackageAssetHash(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Resolve a stored module's phase layout against a renamed installation.
 * The content-addressed archive may have been cached by another installation. */
export function portableModuleProfileIds(
	archive: PortableModePackage,
	selectedId: string,
): { moduleId: string; profileIds: string[] } | null {
	if (!archive.moduleId) return null;
	const suffixes = [archive.definition, ...(archive.profiles ?? [])].map((item) =>
		item.modePackId.slice(archive.moduleId!.length),
	);
	const matching = [...suffixes]
		.sort((left, right) => right.length - left.length)
		.find((suffix) => selectedId.endsWith(suffix));
	if (matching === undefined)
		throw new Error(`Profile ${selectedId} is not part of portable module ${archive.moduleId}`);
	const moduleId = matching ? selectedId.slice(0, -matching.length) : selectedId;
	if (!moduleId || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(moduleId))
		throw new Error(`Cannot derive portable module id from ${selectedId}`);
	return { moduleId, profileIds: suffixes.map((suffix) => `${moduleId}${suffix}`) };
}

export function portableModuleFrontendEntry(archive: PortableModePackage, selectedId: string): string | null {
	if (!archive.frontend) return null;
	const layout = portableModuleProfileIds(archive, selectedId);
	if (!layout) return archive.frontend.entry;
	const suffix = selectedId.slice(layout.moduleId.length);
	return archive.frontend.phaseEntries?.[suffix] ?? archive.frontend.entry;
}
