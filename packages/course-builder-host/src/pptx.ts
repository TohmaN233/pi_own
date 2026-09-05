import { posix } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { JsonValue } from "../../harness-contracts/src/index.ts";

const MAX_XML = 4 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
function fail(message: string): never {
	throw new Error(`INVALID_PPTX: ${message}`);
}
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const b of bytes) {
		crc ^= b;
		for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function decode(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/giu, (_match, entity: string) => {
		if (entity.startsWith("#")) {
			const n = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
			if (n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) fail("invalid XML character");
			return String.fromCodePoint(n);
		}
		return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[entity] ?? entity;
	});
}
function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/gu)) {
		const key = match[1];
		if (Object.hasOwn(out, key)) fail("duplicate XML attribute");
		out[key] = decode(match[3]);
	}
	return out;
}
interface Entry {
	name: string;
	method: number;
	crc: number;
	packed: number;
	size: number;
	offset: number;
}
function archive(bytes: Uint8Array): (name: string) => string {
	const b = Buffer.from(bytes);
	if (b.length < 22 || b.length > 64 * 1024 * 1024) fail("archive size");
	let end = -1;
	for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
		if (b.readUInt32LE(i) === 0x06054b50 && i + 22 + b.readUInt16LE(i + 20) === b.length) {
			end = i;
			break;
		}
	}
	if (end < 0) fail("missing ZIP directory");
	const count = b.readUInt16LE(end + 10),
		directory = b.readUInt32LE(end + 16),
		length = b.readUInt32LE(end + 12);
	if (
		b.readUInt16LE(end + 4) ||
		b.readUInt16LE(end + 6) ||
		count !== b.readUInt16LE(end + 8) ||
		count > 2000 ||
		directory + length !== end
	)
		fail("unsupported ZIP directory");
	const entries = new Map<string, Entry>();
	let cursor = directory;
	for (let i = 0; i < count; i++) {
		if (cursor + 46 > end || b.readUInt32LE(cursor) !== 0x02014b50) fail("corrupt directory entry");
		const flags = b.readUInt16LE(cursor + 8),
			method = b.readUInt16LE(cursor + 10),
			nameLength = b.readUInt16LE(cursor + 28),
			extra = b.readUInt16LE(cursor + 30),
			comment = b.readUInt16LE(cursor + 32);
		if (cursor + 46 + nameLength + extra + comment > end || flags & 1 || ![0, 8].includes(method))
			fail("unsupported ZIP entry");
		const name = b.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		if (entries.has(name) || name.includes("\\") || name.startsWith("/") || name.split("/").includes(".."))
			fail("duplicate or unsafe entry path");
		entries.set(name, {
			name,
			method,
			crc: b.readUInt32LE(cursor + 16),
			packed: b.readUInt32LE(cursor + 20),
			size: b.readUInt32LE(cursor + 24),
			offset: b.readUInt32LE(cursor + 42),
		});
		cursor += 46 + nameLength + extra + comment;
	}
	if (cursor !== end) fail("invalid directory length");
	let total = 0;
	const cache = new Map<string, string>();
	return (name: string): string => {
		if (cache.has(name)) return cache.get(name) as string;
		const e = entries.get(name);
		if (!e) fail(`missing ${name}`);
		if (e.size > MAX_XML || e.offset + 30 > directory || b.readUInt32LE(e.offset) !== 0x04034b50)
			fail("XML entry budget/header");
		if (b.readUInt16LE(e.offset + 6) & 1 || b.readUInt16LE(e.offset + 8) !== e.method) fail("local header mismatch");
		const n = b.readUInt16LE(e.offset + 26),
			start = e.offset + 30 + n + b.readUInt16LE(e.offset + 28);
		if (b.subarray(e.offset + 30, e.offset + 30 + n).toString("utf8") !== name || start + e.packed > directory)
			fail("entry bounds");
		const compressed = b.subarray(start, start + e.packed);
		const raw = e.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_XML });
		if (raw.length !== e.size || crc32(raw) !== e.crc) fail("entry integrity");
		total += raw.length;
		if (total > MAX_TOTAL) fail("XML aggregate budget");
		const xml = raw.toString("utf8");
		if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) fail("DTD/entity declarations are not allowed");
		cache.set(name, xml);
		return xml;
	};
}
function relationships(xml: string, base: string): Map<string, { path: string; type: string }> {
	const result = new Map<string, { path: string; type: string }>();
	for (const m of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/gu)) {
		const a = attrs(m[0]);
		if (a.TargetMode === "External") continue;
		if (!a.Id || !a.Target || !a.Type || result.has(a.Id)) fail("invalid relationship");
		const path = posix.normalize(posix.join(base, a.Target));
		if (a.Target.startsWith("/") || a.Target.includes("\\") || path.startsWith("../") || !path.startsWith("ppt/"))
			fail("relationship escapes presentation");
		result.set(a.Id, { path, type: a.Type });
	}
	return result;
}
function text(xml: string): string {
	return [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gu)]
		.map((p) => [...p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gu)].map((t) => decode(t[1])).join(""))
		.filter(Boolean)
		.join("\n");
}
/** Text/notes only. No master, images, animation or layout fidelity claim. */
export function extractPptx(bytes: Uint8Array): { text: string; metadata: Record<string, JsonValue> } {
	const read = archive(bytes),
		presentation = read("ppt/presentation.xml");
	const rels = relationships(read("ppt/_rels/presentation.xml.rels"), "ppt");
	const slides: { number: number; path: string; text: string; notes: string }[] = [];
	const seen = new Set<string>();
	for (const m of presentation.matchAll(/<p:sldId\b[^>]*\/?\s*>/gu)) {
		const id = attrs(m[0])["r:id"],
			rel = rels.get(id);
		if (!rel || !rel.type.endsWith("/slide") || seen.has(rel.path)) fail("invalid slide order");
		seen.add(rel.path);
		if (slides.length >= 500) fail("slide count budget");
		const xml = read(rel.path);
		let notes = "";
		const relPath = posix.join(posix.dirname(rel.path), "_rels", `${posix.basename(rel.path)}.rels`);
		let slideRels = "";
		try {
			slideRels = read(relPath);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== `INVALID_PPTX: missing ${relPath}`) throw error;
		}
		if (slideRels) {
			for (const r of relationships(slideRels, posix.dirname(rel.path)).values())
				if (r.type.endsWith("/notesSlide")) notes = text(read(r.path));
		}
		slides.push({ number: slides.length + 1, path: rel.path, text: text(xml), notes });
	}
	if (!slides.length) fail("no slides");
	return {
		text: slides
			.map((s) => `## Slide ${s.number}\n${s.text}\n${s.notes ? `Speaker notes:\n${s.notes}` : ""}`)
			.join("\n\n"),
		metadata: { slideCount: slides.length, slides, extraction: "semantic-text-and-notes" },
	};
}
