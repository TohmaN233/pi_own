import { DatabaseSync } from "node:sqlite";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	modePackHash,
	type ModeActivationReceipt,
	type ModeContextKind,
	type ModePackDefinition,
	type ModeRole,
} from "../../../packages/profile-resource-host/src/mode-packs.ts";

export const MODE_PACK_BINDING_CUSTOM_TYPE = "pi-own:mode-pack-binding/v1";
const CONTRACT_VERSION = 1 as const;
const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class ModePackSessionStoreError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ModePackSessionStoreError";
		this.code = code;
	}
}

export interface ModePackSessionBinding {
	version: typeof CONTRACT_VERSION;
	bindingId: string;
	sessionId: string;
	revision: number;
	parentSessionId: string | null;
	modePackId: string;
	modePackRevision: number;
	modePackContentHash: string;
	role: ModeRole;
	contextKind: ModeContextKind;
	contextBinding: string | null;
	receipt: ModeActivationReceipt;
	createdAt: string;
	activatedAt: string;
}

export interface CreateModePackSessionBindingInput {
	sessionId: string;
	parentSessionId?: string | null;
	current?: ModePackSessionBinding | null;
	definition: ModePackDefinition;
	contextBinding: string | null;
	receipt: ModeActivationReceipt;
	activatedAt?: string;
}

export interface ModePackSessionManager {
	getSessionId(): string;
	getEntries(): Array<{ type: string; id: string; customType?: string; data?: unknown }>;
	appendCustomEntry(customType: string, data?: unknown): string;
}

interface BindingRow {
	payloadJson: string;
	payloadHash: string;
	status: string;
}

function fail(code: string, message: string): never {
	throw new ModePackSessionStoreError(code, message);
}

function record(value: unknown, where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_BINDING", `${where} must be an object`);
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], where: string): void {
	for (const key of Object.keys(value)) if (!fields.includes(key)) fail("UNKNOWN_BINDING_FIELD", `${where}.${key}`);
	for (const field of fields) if (!(field in value)) fail("MISSING_BINDING_FIELD", `${where}.${field}`);
}

function id(value: unknown, where: string): string {
	if (typeof value !== "string" || !ID.test(value)) fail("INVALID_BINDING_IDENTITY", where);
	return value;
}

function timestamp(value: unknown, where: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("INVALID_BINDING_TIMESTAMP", where);
	return value;
}

function positive(value: unknown, where: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) fail("INVALID_BINDING_REVISION", where);
	return Number(value);
}

function nullableText(value: unknown, where: string): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 8_192) {
		fail("INVALID_CONTEXT_BINDING", where);
	}
	return value;
}

function stringList(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || value.length > 128) fail("INVALID_RECEIPT", where);
	const result = value.map((item, index) => id(item, `${where}[${index}]`));
	if (new Set(result).size !== result.length) fail("INVALID_RECEIPT", `${where} contains duplicates`);
	return result;
}

function parseReceipt(value: unknown): ModeActivationReceipt {
	const item = record(value, "binding.receipt");
	exact(
		item,
		["modePackId", "revision", "contentHash", "effectivePromptHash", "loaded", "verifiedAt"],
		"binding.receipt",
	);
	const loaded = record(item.loaded, "binding.receipt.loaded");
	exact(loaded, ["skills", "plugins", "packages", "tools", "workflows"], "binding.receipt.loaded");
	const contentHash = item.contentHash;
	const effectivePromptHash = item.effectivePromptHash;
	if (typeof contentHash !== "string" || !HASH.test(contentHash)) fail("INVALID_RECEIPT", "contentHash");
	if (typeof effectivePromptHash !== "string" || !HASH.test(effectivePromptHash)) {
		fail("INVALID_RECEIPT", "effectivePromptHash");
	}
	return {
		modePackId: id(item.modePackId, "binding.receipt.modePackId"),
		revision: positive(item.revision, "binding.receipt.revision"),
		contentHash,
		effectivePromptHash,
		loaded: {
			skills: stringList(loaded.skills, "binding.receipt.loaded.skills"),
			plugins: stringList(loaded.plugins, "binding.receipt.loaded.plugins"),
			packages: stringList(loaded.packages, "binding.receipt.loaded.packages"),
			tools: stringList(loaded.tools, "binding.receipt.loaded.tools"),
			workflows: stringList(loaded.workflows, "binding.receipt.loaded.workflows"),
		},
		verifiedAt: timestamp(item.verifiedAt, "binding.receipt.verifiedAt"),
	};
}

export function parseModePackSessionBinding(value: unknown): ModePackSessionBinding {
	const item = record(value, "binding");
	const fields = [
		"version",
		"bindingId",
		"sessionId",
		"revision",
		"parentSessionId",
		"modePackId",
		"modePackRevision",
		"modePackContentHash",
		"role",
		"contextKind",
		"contextBinding",
		"receipt",
		"createdAt",
		"activatedAt",
	] as const;
	exact(item, fields, "binding");
	if (item.version !== CONTRACT_VERSION) fail("UNSUPPORTED_BINDING_VERSION", "binding.version");
	const roles: ModeRole[] = ["student", "teacher", "developer", "general"];
	const contextKinds: ModeContextKind[] = ["course", "workspace", "creative-project", "none"];
	if (!roles.includes(item.role as ModeRole)) fail("INVALID_BINDING_ROLE", "binding.role");
	if (!contextKinds.includes(item.contextKind as ModeContextKind)) {
		fail("INVALID_CONTEXT_BINDING", "binding.contextKind");
	}
	const modePackContentHash = item.modePackContentHash;
	if (typeof modePackContentHash !== "string" || !HASH.test(modePackContentHash)) {
		fail("INVALID_BINDING_HASH", "binding.modePackContentHash");
	}
	const receipt = parseReceipt(item.receipt);
	const binding: ModePackSessionBinding = {
		version: CONTRACT_VERSION,
		bindingId: id(item.bindingId, "binding.bindingId"),
		sessionId: id(item.sessionId, "binding.sessionId"),
		revision: positive(item.revision, "binding.revision"),
		parentSessionId: item.parentSessionId === null ? null : id(item.parentSessionId, "binding.parentSessionId"),
		modePackId: id(item.modePackId, "binding.modePackId"),
		modePackRevision: positive(item.modePackRevision, "binding.modePackRevision"),
		modePackContentHash,
		role: item.role as ModeRole,
		contextKind: item.contextKind as ModeContextKind,
		contextBinding: nullableText(item.contextBinding, "binding.contextBinding"),
		receipt,
		createdAt: timestamp(item.createdAt, "binding.createdAt"),
		activatedAt: timestamp(item.activatedAt, "binding.activatedAt"),
	};
	if (
		receipt.modePackId !== binding.modePackId ||
		receipt.revision !== binding.modePackRevision ||
		receipt.contentHash !== binding.modePackContentHash
	) {
		fail("BINDING_RECEIPT_MISMATCH", "The binding and activation receipt identify different Mode Packs");
	}
	if (binding.contextKind === "none" && binding.contextBinding !== null) {
		fail("INVALID_CONTEXT_BINDING", "A none context cannot carry a binding");
	}
	if (binding.contextKind !== "none" && binding.contextBinding === null) {
		fail("INVALID_CONTEXT_BINDING", `${binding.contextKind} requires a binding value`);
	}
	return binding;
}

function bindingPayloadHash(binding: ModePackSessionBinding): string {
	return modePackHash(binding);
}

function assertWarmSuccessor(previous: ModePackSessionBinding, next: ModePackSessionBinding): void {
	if (next.sessionId !== previous.sessionId) fail("BINDING_SESSION_CHANGED", "Warm binding changed session");
	if (next.bindingId !== previous.bindingId) fail("BINDING_ID_CHANGED", "Warm binding changed bindingId");
	if (next.revision !== previous.revision + 1) fail("BINDING_REVISION_GAP", "Binding revision must advance once");
	if (next.parentSessionId !== previous.parentSessionId) fail("BINDING_PARENT_CHANGED", "Warm binding changed parent");
	if (next.createdAt !== previous.createdAt) fail("BINDING_CREATED_AT_CHANGED", "Warm binding changed createdAt");
	if (next.role !== previous.role || next.contextKind !== previous.contextKind) {
		fail("HARD_TRANSITION_IN_PLACE", "Role or context kind changed inside one Pi session");
	}
	if (next.contextBinding !== previous.contextBinding) {
		fail("CONTEXT_REBIND_FORBIDDEN", "A Pi session cannot change its context binding in place");
	}
}

export function createModePackSessionBinding(
	input: CreateModePackSessionBindingInput,
): ModePackSessionBinding {
	const activatedAt = timestamp(input.activatedAt ?? new Date().toISOString(), "activatedAt");
	const current = input.current ? parseModePackSessionBinding(input.current) : null;
	const bindingId =
		current?.bindingId ??
		`mode-binding:${modePackHash({
			sessionId: input.sessionId,
			parentSessionId: input.parentSessionId ?? null,
			createdAt: activatedAt,
		}).slice("sha256:".length, "sha256:".length + 32)}`;
	const value: ModePackSessionBinding = {
		version: CONTRACT_VERSION,
		bindingId,
		sessionId: id(input.sessionId, "sessionId"),
		revision: current ? current.revision + 1 : 1,
		parentSessionId: current?.parentSessionId ?? input.parentSessionId ?? null,
		modePackId: input.definition.id,
		modePackRevision: input.definition.revision,
		modePackContentHash: input.receipt.contentHash,
		role: input.definition.role,
		contextKind: input.definition.contextPolicy.kind,
		contextBinding: input.contextBinding,
		receipt: structuredClone(input.receipt),
		createdAt: current?.createdAt ?? activatedAt,
		activatedAt,
	};
	const parsed = parseModePackSessionBinding(value);
	if (current) assertWarmSuccessor(current, parsed);
	return parsed;
}

export function readModePackBindingLineage(manager: Pick<ModePackSessionManager, "getEntries">): ModePackSessionBinding[] {
	const values: ModePackSessionBinding[] = [];
	const bySession = new Map<string, ModePackSessionBinding>();
	let last: ModePackSessionBinding | null = null;
	for (const entry of manager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== MODE_PACK_BINDING_CUSTOM_TYPE) continue;
		let binding: ModePackSessionBinding;
		try {
			binding = parseModePackSessionBinding(entry.data);
		} catch (error) {
			throw new ModePackSessionStoreError(
				"MODE_BINDING_JOURNAL_CORRUPT",
				`Mode Pack binding at Pi entry ${entry.id} is invalid: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const previousForSession = bySession.get(binding.sessionId);
		if (previousForSession) {
			assertWarmSuccessor(previousForSession, binding);
		} else if (binding.revision !== 1) {
			fail("MODE_BINDING_JOURNAL_CORRUPT", `Session ${binding.sessionId} does not start at revision 1`);
		} else if (last && binding.parentSessionId !== last.sessionId) {
			fail("MODE_BINDING_JOURNAL_CORRUPT", `Session ${binding.sessionId} does not name its inherited parent`);
		}
		bySession.set(binding.sessionId, binding);
		values.push(binding);
		last = binding;
	}
	return values;
}

export function activeModePackBinding(
	manager: Pick<ModePackSessionManager, "getEntries" | "getSessionId">,
): ModePackSessionBinding | null {
	const sessionId = manager.getSessionId();
	const values = readModePackBindingLineage(manager).filter((binding) => binding.sessionId === sessionId);
	return values.at(-1) ?? null;
}

export function appendModePackBinding(
	manager: ModePackSessionManager,
	value: unknown,
): string {
	const binding = parseModePackSessionBinding(value);
	if (binding.sessionId !== manager.getSessionId()) {
		fail("BINDING_SESSION_MISMATCH", "Binding targets another Pi session");
	}
	const current = activeModePackBinding(manager);
	if (current) assertWarmSuccessor(current, binding);
	else if (binding.revision !== 1) fail("BINDING_REVISION_GAP", "Initial binding must have revision 1");
	const entryId = manager.appendCustomEntry(MODE_PACK_BINDING_CUSTOM_TYPE, binding);
	const recovered = activeModePackBinding(manager);
	if (!recovered || bindingPayloadHash(recovered) !== bindingPayloadHash(binding)) {
		fail("BINDING_APPEND_FAILED", "Pi did not expose the appended Mode Pack binding");
	}
	return entryId;
}

export class ModePackSessionStore {
	private readonly database: DatabaseSync;

	constructor(databasePath: string) {
		this.database = new DatabaseSync(databasePath);
		this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS mode_pack_session_binding (
				session_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('staged', 'committed')),
				payload_hash TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				PRIMARY KEY (session_id, revision)
			);
		`);
	}

	close(): void {
		this.database.close();
	}

	latest(sessionId: string, includeStaged = false): ModePackSessionBinding | null {
		const row = this.database
			.prepare(
				`SELECT payload_json AS payloadJson, payload_hash AS payloadHash, status
				 FROM mode_pack_session_binding
				 WHERE session_id = ? ${includeStaged ? "" : "AND status = 'committed'"}
				 ORDER BY revision DESC LIMIT 1`,
			)
			.get(sessionId) as BindingRow | undefined;
		if (!row) return null;
		const binding = parseModePackSessionBinding(JSON.parse(row.payloadJson));
		if (row.payloadHash !== bindingPayloadHash(binding)) {
			fail("MODE_BINDING_STORE_CORRUPT", `Stored binding ${sessionId}:${binding.revision} failed its hash`);
		}
		return binding;
	}

	history(sessionId: string): ModePackSessionBinding[] {
		const rows = this.database
			.prepare(
				`SELECT payload_json AS payloadJson, payload_hash AS payloadHash, status
				 FROM mode_pack_session_binding
				 WHERE session_id = ? AND status = 'committed'
				 ORDER BY revision`,
			)
			.all(sessionId) as unknown as BindingRow[];
		const result = rows.map((row) => {
			const binding = parseModePackSessionBinding(JSON.parse(row.payloadJson));
			if (row.payloadHash !== bindingPayloadHash(binding)) {
				fail("MODE_BINDING_STORE_CORRUPT", `Stored binding ${sessionId}:${binding.revision} failed its hash`);
			}
			return binding;
		});
		for (let index = 1; index < result.length; index++) {
			assertWarmSuccessor(result[index - 1] as ModePackSessionBinding, result[index] as ModePackSessionBinding);
		}
		return result;
	}

	stage(bindingValue: unknown, expectedRevision: number | null): ModePackSessionBinding {
		const binding = parseModePackSessionBinding(bindingValue);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.latest(binding.sessionId);
			if ((current?.revision ?? null) !== expectedRevision) {
				fail("MODE_BINDING_REVISION_CONFLICT", `Expected binding revision ${expectedRevision ?? "none"}`);
			}
			if (current) assertWarmSuccessor(current, binding);
			else if (binding.revision !== 1) fail("BINDING_REVISION_GAP", "Initial binding must have revision 1");
			const payloadJson = JSON.stringify(binding);
			const payloadHash = bindingPayloadHash(binding);
			const existing = this.database
				.prepare(
					"SELECT payload_json AS payloadJson, payload_hash AS payloadHash, status FROM mode_pack_session_binding WHERE session_id = ? AND revision = ?",
				)
				.get(binding.sessionId, binding.revision) as BindingRow | undefined;
			if (existing) {
				if (existing.payloadHash !== payloadHash || existing.payloadJson !== payloadJson) {
					fail("MODE_BINDING_REVISION_CONFLICT", `Binding ${binding.sessionId}:${binding.revision} was redefined`);
				}
			} else {
				this.database
					.prepare(
						"INSERT INTO mode_pack_session_binding (session_id, revision, status, payload_hash, payload_json) VALUES (?, ?, 'staged', ?, ?)",
					)
					.run(binding.sessionId, binding.revision, payloadHash, payloadJson);
			}
			this.database.exec("COMMIT");
			return binding;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	commitStaged(sessionId: string, revision: number): ModePackSessionBinding {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.database
				.prepare(
					"SELECT payload_json AS payloadJson, payload_hash AS payloadHash, status FROM mode_pack_session_binding WHERE session_id = ? AND revision = ?",
				)
				.get(sessionId, revision) as BindingRow | undefined;
			if (!row) fail("STAGED_BINDING_MISSING", `Binding ${sessionId}:${revision} was not staged`);
			this.database
				.prepare(
					"UPDATE mode_pack_session_binding SET status = 'committed' WHERE session_id = ? AND revision = ?",
				)
				.run(sessionId, revision);
			this.database.exec("COMMIT");
			const binding = parseModePackSessionBinding(JSON.parse(row.payloadJson));
			if (bindingPayloadHash(binding) !== row.payloadHash) {
				fail("MODE_BINDING_STORE_CORRUPT", `Binding ${sessionId}:${revision} failed its hash`);
			}
			return binding;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	rollbackStaged(sessionId: string, revision: number): void {
		this.database
			.prepare(
				"DELETE FROM mode_pack_session_binding WHERE session_id = ? AND revision = ? AND status = 'staged'",
			)
			.run(sessionId, revision);
	}

	deleteSession(sessionId: string): void {
		this.database
			.prepare("DELETE FROM mode_pack_session_binding WHERE session_id = ?")
			.run(sessionId);
	}

	reconcile(manager: ModePackSessionManager): ModePackSessionBinding | null {
		const sessionId = manager.getSessionId();
		const journal = readModePackBindingLineage(manager).filter((binding) => binding.sessionId === sessionId);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const journalByRevision = new Map(journal.map((binding) => [binding.revision, binding]));
			const rows = this.database
				.prepare(
					"SELECT payload_json AS payloadJson, payload_hash AS payloadHash, status FROM mode_pack_session_binding WHERE session_id = ? ORDER BY revision",
				)
				.all(sessionId) as unknown as BindingRow[];
			for (const row of rows) {
				const stored = parseModePackSessionBinding(JSON.parse(row.payloadJson));
				const authoritative = journalByRevision.get(stored.revision);
				if (!authoritative) {
					this.database
						.prepare("DELETE FROM mode_pack_session_binding WHERE session_id = ? AND revision = ?")
						.run(sessionId, stored.revision);
					continue;
				}
				if (
					row.payloadHash !== bindingPayloadHash(stored) ||
					bindingPayloadHash(stored) !== bindingPayloadHash(authoritative)
				) {
					fail("MODE_BINDING_STORE_CORRUPT", `SQLite and Pi JSONL disagree at ${sessionId}:${stored.revision}`);
				}
				if (row.status !== "committed") {
					this.database
						.prepare(
							"UPDATE mode_pack_session_binding SET status = 'committed' WHERE session_id = ? AND revision = ?",
						)
						.run(sessionId, stored.revision);
				}
				journalByRevision.delete(stored.revision);
			}
			for (const binding of journalByRevision.values()) {
				this.database
					.prepare(
						"INSERT INTO mode_pack_session_binding (session_id, revision, status, payload_hash, payload_json) VALUES (?, ?, 'committed', ?, ?)",
					)
					.run(sessionId, binding.revision, bindingPayloadHash(binding), JSON.stringify(binding));
			}
			this.database.exec("COMMIT");
			return journal.at(-1) ?? null;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}
}

export type PiSessionManager = SessionManager;
