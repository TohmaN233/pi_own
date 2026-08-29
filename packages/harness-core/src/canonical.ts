import { createHash } from "node:crypto";
import type { JsonValue } from "../../harness-contracts/src/index.ts";

function canonicalizeInternal(value: unknown, path: string, seen: Set<object>): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`${path}: number must be finite`);
		return Object.is(value, -0) ? 0 : value;
	}
	if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || value === undefined) {
		throw new TypeError(`${path}: value is not JSON serializable`);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new TypeError(`${path}: cyclic value`);
		seen.add(value);
		const result = value.map((item, index) => canonicalizeInternal(item, `${path}[${index}]`, seen));
		seen.delete(value);
		return result;
	}
	if (typeof value === "object") {
		if (seen.has(value)) throw new TypeError(`${path}: cyclic value`);
		seen.add(value);
		const result: Record<string, JsonValue> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child === undefined) throw new TypeError(`${path}.${key}: undefined is not allowed`);
			result[key] = canonicalizeInternal(child, `${path}.${key}`, seen);
		}
		seen.delete(value);
		return result;
	}
	throw new TypeError(`${path}: unsupported value`);
}

export function canonicalize(value: unknown): JsonValue {
	return canonicalizeInternal(value, "$", new Set<object>());
}

export function stableStringify(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function contentHash(value: unknown): string {
	return `sha256:${sha256Hex(stableStringify(value))}`;
}

export function deterministicId(prefix: string, value: unknown, length = 24): string {
	if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw new TypeError("prefix must be lowercase kebab-case");
	if (!Number.isSafeInteger(length) || length < 8 || length > 64) throw new TypeError("length must be 8..64");
	return `${prefix}_${sha256Hex(stableStringify(value)).slice(0, length)}`;
}

export function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && ArrayBuffer.isView(value)) return value;
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}
