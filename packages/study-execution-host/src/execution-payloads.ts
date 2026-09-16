import { sha256Hex, stableStringify } from "../../harness-core/src/index.ts";
import type { RunManifest } from "../../study-research-host/src/index.ts";

const MAX_PROGRAM_BYTES = 2 * 1024 * 1024;
const MAX_PARAMETER_BYTES = 512 * 1024;
export const MAX_EXECUTION_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_EXECUTION_TOTAL_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_INPUTS = 128;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export const FROZEN_EXECUTION_PAYLOAD_VERSION = 1 as const;
export const MAX_EXECUTION_OUTPUT_BYTES = 64 * 1024 * 1024;

export type FrozenExecutionLanguage = "node" | "python" | "rscript";

export interface FrozenExecutionInput {
	name: string;
	/** Canonical base64 of the already-authorized source bytes, never a live source path. */
	bytesBase64: string;
	sha256: string;
}

export interface FrozenEnvironmentFile {
	absolutePath: string;
	sha256: string;
}

/**
 * The descriptor is hash-addressed as part of the Host run manifest. An adapter must
 * prove these exact local bytes before it prepares a run; an environment label alone
 * is insufficient authorization to execute.
 */
export interface FrozenExecutionEnvironment {
	adapterKind: string;
	executablePath: string;
	files: readonly FrozenEnvironmentFile[];
	descriptorHash: string;
}

export interface FrozenExecutionPayload {
	version: typeof FROZEN_EXECUTION_PAYLOAD_VERSION;
	taskId: string;
	projectId: string;
	sessionId: string;
	manifest: RunManifest;
	language: FrozenExecutionLanguage;
	/** Original approved cell source. This exact UTF-8 text is bound to manifest.codeHash. */
	program: {
		fileName: string;
		content: string;
		sha256: string;
	};
	/** Canonical JSON sent to any deterministic language wrapper. */
	parameters: {
		canonicalJson: string;
		sha256: string;
	};
	/** Immutable source bytes which the adapter materializes into its private staging area. */
	inputs: readonly FrozenExecutionInput[];
	environment: FrozenExecutionEnvironment;
	outputLimitBytes: number;
}

export interface FrozenExecutionPayloadIdentity {
	taskId: string;
	projectId: string;
	sessionId: string;
	manifest: RunManifest;
}

export class FrozenExecutionPayloadError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "FrozenExecutionPayloadError";
		this.code = code;
	}
}

export function executionSha256(value: string | Uint8Array): string {
	return `sha256:${sha256Hex(value)}`;
}

export function frozenEnvironmentDescriptorHash(
	environment: Omit<FrozenExecutionEnvironment, "descriptorHash">,
): string {
	const files = environment.files
		.map((file) => ({ absolutePath: file.absolutePath, sha256: file.sha256 }))
		.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
	return executionSha256(
		stableStringify({
			adapterKind: environment.adapterKind,
			executablePath: environment.executablePath,
			files,
		}),
	);
}

export function validateFrozenExecutionPayload(value: unknown): FrozenExecutionPayload {
	if (!isRecord(value)) fail("PAYLOAD_INVALID", "frozen execution payload must be an object");
	if (value.version !== FROZEN_EXECUTION_PAYLOAD_VERSION) {
		fail("PAYLOAD_VERSION_UNSUPPORTED", "frozen execution payload version is unsupported");
	}
	const identity = {
		taskId: text(value.taskId, "taskId", 128),
		projectId: text(value.projectId, "projectId", 128),
		sessionId: text(value.sessionId, "sessionId", 128),
		manifest: manifest(value.manifest),
	};
	const language = languageValue(value.language);
	if (!isRecord(value.program)) fail("PAYLOAD_INVALID", "frozen program must be an object");
	const program = {
		fileName: fileName(value.program.fileName, "program.fileName"),
		content: text(value.program.content, "program.content", MAX_PROGRAM_BYTES),
		sha256: hash(value.program.sha256, "program.sha256"),
	};
	if (executionSha256(program.content) !== program.sha256 || program.sha256 !== identity.manifest.codeHash) {
		fail("PAYLOAD_CODE_HASH_MISMATCH", "frozen program bytes do not match the approved code hash");
	}
	if (!isRecord(value.parameters)) fail("PAYLOAD_INVALID", "frozen parameters must be an object");
	const parameters = {
		canonicalJson: text(value.parameters.canonicalJson, "parameters.canonicalJson", MAX_PARAMETER_BYTES),
		sha256: hash(value.parameters.sha256, "parameters.sha256"),
	};
	let parsedParameters: unknown;
	try {
		parsedParameters = JSON.parse(parameters.canonicalJson);
	} catch {
		fail("PAYLOAD_PARAMETERS_INVALID", "frozen parameters are not valid JSON");
	}
	if (!isRecord(parsedParameters)) fail("PAYLOAD_PARAMETERS_INVALID", "frozen parameters must be a JSON object");
	if (stableStringify(parsedParameters) !== parameters.canonicalJson) {
		fail("PAYLOAD_PARAMETERS_INVALID", "frozen parameters are not canonical JSON");
	}
	if (
		executionSha256(parameters.canonicalJson) !== parameters.sha256 ||
		parameters.sha256 !== identity.manifest.parameterHash
	) {
		fail("PAYLOAD_PARAMETER_HASH_MISMATCH", "frozen parameters do not match the approved parameter hash");
	}
	if (!Array.isArray(value.inputs) || value.inputs.length > MAX_INPUTS) {
		fail("PAYLOAD_INPUTS_INVALID", "frozen inputs must be a bounded array");
	}
	const names = new Set<string>();
	let totalInputBytes = 0;
	const inputs = value.inputs.map((item, index) => {
		if (!isRecord(item)) fail("PAYLOAD_INPUTS_INVALID", `frozen input ${index} must be an object`);
		const input = {
			name: fileName(item.name, `inputs[${index}].name`),
			bytesBase64: base64Text(item.bytesBase64, `inputs[${index}].bytesBase64`, MAX_EXECUTION_INPUT_BYTES * 2),
			sha256: hash(item.sha256, `inputs[${index}].sha256`),
		};
		if (names.has(input.name)) fail("PAYLOAD_INPUTS_INVALID", `frozen input name ${input.name} is duplicated`);
		names.add(input.name);
		const bytes = decodeBase64(input.bytesBase64, `inputs[${index}].bytesBase64`);
		totalInputBytes += bytes.byteLength;
		if (bytes.byteLength > MAX_EXECUTION_INPUT_BYTES || totalInputBytes > MAX_EXECUTION_TOTAL_INPUT_BYTES)
			fail("PAYLOAD_INPUTS_INVALID", `frozen input ${input.name} exceeds its byte limit`);
		if (executionSha256(bytes) !== input.sha256 || identity.manifest.inputHashes[input.name] !== input.sha256) {
			fail("PAYLOAD_INPUT_HASH_MISMATCH", `frozen input ${input.name} does not match the approved input hash`);
		}
		return input;
	});
	if (
		Object.keys(identity.manifest.inputHashes).length !== inputs.length ||
		Object.keys(identity.manifest.inputHashes).some((name) => !names.has(name))
	) {
		fail("PAYLOAD_INPUT_HASH_MISMATCH", "frozen inputs do not exactly match the approved input manifest");
	}
	if (!isRecord(value.environment)) fail("PAYLOAD_ENVIRONMENT_INVALID", "frozen environment must be an object");
	if (
		!Array.isArray(value.environment.files) ||
		value.environment.files.length < 1 ||
		value.environment.files.length > 10_000
	) {
		fail("PAYLOAD_ENVIRONMENT_INVALID", "frozen environment must list bounded verified files");
	}
	const environmentFiles = value.environment.files.map((item, index) => {
		if (!isRecord(item)) fail("PAYLOAD_ENVIRONMENT_INVALID", `environment file ${index} must be an object`);
		return {
			absolutePath: absolutePath(item.absolutePath, `environment.files[${index}].absolutePath`),
			sha256: hash(item.sha256, `environment.files[${index}].sha256`),
		};
	});
	if (new Set(environmentFiles.map((file) => file.absolutePath)).size !== environmentFiles.length) {
		fail("PAYLOAD_ENVIRONMENT_INVALID", "frozen environment lists an absolute path more than once");
	}
	const environment: FrozenExecutionEnvironment = {
		adapterKind: text(value.environment.adapterKind, "environment.adapterKind", 128),
		executablePath: absolutePath(value.environment.executablePath, "environment.executablePath"),
		files: environmentFiles,
		descriptorHash: hash(value.environment.descriptorHash, "environment.descriptorHash"),
	};
	if (!environment.files.some((file) => file.absolutePath === environment.executablePath)) {
		fail("PAYLOAD_ENVIRONMENT_INVALID", "frozen environment does not bind its executable bytes");
	}
	if (
		frozenEnvironmentDescriptorHash(environment) !== environment.descriptorHash ||
		environment.descriptorHash !== identity.manifest.environmentHash
	) {
		fail("PAYLOAD_ENVIRONMENT_HASH_MISMATCH", "frozen environment does not match the approved environment hash");
	}
	const outputLimitBytes = boundedInteger(
		value.outputLimitBytes,
		"outputLimitBytes",
		1_024,
		MAX_EXECUTION_OUTPUT_BYTES,
	);
	return {
		version: FROZEN_EXECUTION_PAYLOAD_VERSION,
		...identity,
		language,
		program,
		parameters,
		inputs,
		environment,
		outputLimitBytes,
	};
}

export function assertFrozenPayloadIdentity(
	payload: FrozenExecutionPayload,
	identity: FrozenExecutionPayloadIdentity,
): void {
	if (
		payload.taskId !== identity.taskId ||
		payload.projectId !== identity.projectId ||
		payload.sessionId !== identity.sessionId ||
		stableStringify(payload.manifest) !== stableStringify(identity.manifest)
	) {
		fail("PAYLOAD_TASK_MISMATCH", "frozen execution payload belongs to a different Host task");
	}
}

export function frozenPayloadHash(payload: FrozenExecutionPayload): string {
	return executionSha256(stableStringify(payload));
}

export function decodeFrozenInput(input: FrozenExecutionInput): Uint8Array {
	return decodeBase64(input.bytesBase64, `input ${input.name}`);
}

function manifest(value: unknown): RunManifest {
	if (!isRecord(value)) fail("PAYLOAD_INVALID", "run manifest must be an object");
	if (!isRecord(value.inputHashes)) fail("PAYLOAD_INVALID", "run manifest inputHashes must be an object");
	const inputHashes: Record<string, string> = {};
	for (const [name, valueHash] of Object.entries(value.inputHashes)) {
		fileName(name, "manifest input name");
		inputHashes[name] = hash(valueHash, `manifest input hash ${name}`);
	}
	return {
		codeHash: hash(value.codeHash, "manifest.codeHash"),
		parameterHash: hash(value.parameterHash, "manifest.parameterHash"),
		inputHashes,
		environmentHash: hash(value.environmentHash, "manifest.environmentHash"),
	};
}

function languageValue(value: unknown): FrozenExecutionLanguage {
	if (value === "node" || value === "python" || value === "rscript") return value;
	fail("PAYLOAD_LANGUAGE_INVALID", "frozen execution language must be node, python, or rscript");
}

function decodeBase64(value: string, label: string): Uint8Array {
	if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(value)) {
		fail("PAYLOAD_INPUTS_INVALID", `${label} is not canonical base64`);
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) fail("PAYLOAD_INPUTS_INVALID", `${label} is not canonical base64`);
	return new Uint8Array(bytes);
}

function text(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum) {
		fail("PAYLOAD_INVALID", `${label} must be nonempty UTF-8 text within its bound`);
	}
	return value;
}

/** Empty files have canonical base64 ""; absence is still rejected because the value must be a string. */
function base64Text(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum) {
		fail("PAYLOAD_INPUTS_INVALID", `${label} must be canonical base64 within its bound`);
	}
	return value;
}

function fileName(value: unknown, label: string): string {
	const result = text(value, label, 256);
	if (result === "." || result === ".." || /[\\/]/u.test(result) || /[\u0000-\u001f]/u.test(result)) {
		fail("PAYLOAD_INVALID", `${label} must be a single safe file name`);
	}
	return result;
}

function absolutePath(value: unknown, label: string): string {
	const result = text(value, label, 32_768);
	if (!/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(result))
		fail("PAYLOAD_ENVIRONMENT_INVALID", `${label} must be an absolute Windows path`);
	return result;
}

function hash(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256.test(value)) fail("PAYLOAD_INVALID", `${label} must be a sha256 hash`);
	return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		fail("PAYLOAD_INVALID", `${label} must be an integer within its bound`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string): never {
	throw new FrozenExecutionPayloadError(code, message);
}
