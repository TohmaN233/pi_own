import JSZip, { type JSZipObject } from "jszip";
import { Readable } from "node:stream";
import {
	patchDocxDocumentXml,
	type ManuscriptDocxAdapter,
	type ManuscriptOperation,
} from "../../../packages/study-research-host/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { studyContext } from "./study-research-service";

const MAX_DOCX_ENTRIES = 512;
const MAX_DOCX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;
const configuredHarnesses = new WeakSet<object>();

type ZipEntryWithMetadata = JSZipObject & {
	_data?: { compressedSize?: unknown; uncompressedSize?: unknown; crc32?: unknown };
};

interface BoundedDocxArchive {
	zip: JSZip;
	names: string[];
	entries: Map<string, Uint8Array>;
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < table.length; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array, previous = 0): number {
	let value = previous ^ -1;
	for (const byte of bytes) value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff];
	return (value ^ -1) | 0;
}

function assertDocxCompressedBounds(bytes: Uint8Array): void {
	if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024 * 1024) {
		throw new Error("DOCX compressed package exceeds the 64 MiB manuscript input limit");
	}
}

function assertDocxDeclaredBounds(zip: JSZip): ZipEntryWithMetadata[] {
	const entries = Object.values(zip.files).filter((entry) => !entry.dir) as ZipEntryWithMetadata[];
	if (entries.length === 0 || entries.length > MAX_DOCX_ENTRIES) {
		throw new Error("DOCX package entry count is unsupported for manuscript patching");
	}
	let total = 0;
	for (const entry of entries) {
		const compressed = entry._data?.compressedSize;
		const size = entry._data?.uncompressedSize;
		const crc = entry._data?.crc32;
		if (typeof compressed !== "number" || !Number.isSafeInteger(compressed) || compressed < 0) {
			throw new Error("DOCX package entry " + entry.name + " has no safe declared compressed size");
		}
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || typeof crc !== "number" || !Number.isInteger(crc)) {
			throw new Error("DOCX package entry " + entry.name + " has no safe declared uncompressed size");
		}
		if (size > MAX_DOCX_ENTRY_UNCOMPRESSED_BYTES) {
			throw new Error("DOCX package entry " + entry.name + " exceeds the 16 MiB inflation limit");
		}
		total += size;
		if (!Number.isSafeInteger(total) || total > MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES) {
			throw new Error("DOCX package exceeds the 96 MiB total inflation limit");
		}
	}
	return entries;
}

async function readDocxEntryBounded(entry: ZipEntryWithMetadata, maximum: number): Promise<Uint8Array> {
	const expectedCrc = entry._data?.crc32;
	if (typeof expectedCrc !== "number") throw new Error(`DOCX package entry ${entry.name} has no declared CRC32`);
	const stream = entry.nodeStream("nodebuffer") as Readable;
	return new Promise((resolvePromise, reject) => {
		const chunks: Uint8Array[] = [];
		let total = 0;
		let checksum = 0;
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			stream.destroy();
			reject(error);
		};
		stream.on("data", (value: unknown) => {
			if (settled) return;
			if (!(value instanceof Uint8Array)) {
				fail(new Error(`DOCX package entry ${entry.name} emitted invalid decompressed data`));
				return;
			}
			if (total + value.byteLength > maximum) {
				fail(new Error(`DOCX package entry ${entry.name} exceeds the 16 MiB inflation limit`));
				return;
			}
			const piece = new Uint8Array(value.byteLength);
			piece.set(value);
			chunks.push(piece);
			total += piece.byteLength;
			checksum = crc32(piece, checksum);
		});
		stream.on("error", (error: Error) => fail(new Error(`DOCX package entry ${entry.name} failed bounded decompression: ${error.message}`)));
		stream.on("end", () => {
			if (settled) return;
			if ((checksum >>> 0) !== (expectedCrc >>> 0)) {
				fail(new Error(`DOCX package entry ${entry.name} failed CRC32 validation`));
				return;
			}
			settled = true;
			const output = new Uint8Array(total);
			let offset = 0;
			for (const piece of chunks) {
				output.set(piece, offset);
				offset += piece.byteLength;
			}
			resolvePromise(output);
		});
	});
}

async function loadBoundedDocx(bytes: Uint8Array): Promise<BoundedDocxArchive> {
	assertDocxCompressedBounds(bytes);
	const zip = await JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: false });
	const declared = assertDocxDeclaredBounds(zip);
	const entries = new Map<string, Uint8Array>();
	let total = 0;
	for (const entry of declared) {
		const content = await readDocxEntryBounded(entry, MAX_DOCX_ENTRY_UNCOMPRESSED_BYTES);
		total += content.byteLength;
		if (!Number.isSafeInteger(total) || total > MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES) {
			throw new Error("DOCX package exceeds the 96 MiB total inflation limit");
		}
		entries.set(entry.name, content);
	}
	return { zip, names: declared.map((entry) => entry.name), entries };
}

function requiredDocxDocument(zip: JSZip): JSZipObject {
	const document = zip.file("word/document.xml");
	if (!document) throw new Error("DOCX package has no word/document.xml");
	return document;
}

/**
 * The Host gives this adapter trusted, bounded bytes only. Rebuilds replace
 * word/document.xml alone and verify every unrelated ZIP entry's bytes.
 */
export const studyManuscriptDocxAdapter: ManuscriptDocxAdapter = async (bytes, operations, date) => {
	const source = await loadBoundedDocx(bytes);
	requiredDocxDocument(source.zip);
	const document = source.entries.get("word/document.xml");
	if (!document) throw new Error("DOCX package has no bounded word/document.xml entry");
	const xml = new TextDecoder("utf-8", { fatal: true }).decode(document);
	const { candidateXml, cleanXml } = patchDocxDocumentXml(xml, operations, date);
	const unrelated = new Map<string, Uint8Array>();
	for (const name of source.names) {
		if (name !== "word/document.xml") unrelated.set(name, source.entries.get(name)!);
	}
	const build = async (replacement: string) => {
		const target = await loadBoundedDocx(bytes);
		requiredDocxDocument(target.zip);
		target.zip.file("word/document.xml", replacement, { binary: false, compression: "DEFLATE" });
		const output = await target.zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
		const verified = await loadBoundedDocx(output);
		for (const [name, original] of unrelated) {
			const current = verified.entries.get(name);
			if (!current) throw new Error(`DOCX patch dropped unrelated package entry ${name}`);
			if (current.byteLength !== original.byteLength || current.some((byte, index) => byte !== original[index])) {
				throw new Error(`DOCX patch changed unrelated package entry ${name}`);
			}
		}
		return output;
	};
	return { candidate: await build(candidateXml), clean: await build(cleanXml) };
};

function manuscripts() {
	const harness = getLearningHarness();
	if (!configuredHarnesses.has(harness)) {
		harness.studyManuscripts.configureDocxAdapter(studyManuscriptDocxAdapter);
		configuredHarnesses.add(harness);
	}
	return harness.studyManuscripts;
}

export async function studyManuscriptState(sessionId: string) {
	const { scope, phase, host } = await studyContext(sessionId);
	await manuscripts().reconcile(scope);
	return {
		phase: phase.phase,
		phaseRevision: phase.revision,
		projectRevision: host.projectRevision(scope).revision,
		sources: host.listSources(scope).filter((source) => source.current && (source.kind === "tex" || source.kind === "docx")),
		patches: manuscripts().list(scope),
	};
}

export async function requestStudyManuscriptPatch(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	expectedProjectRevision: number;
	sourceId: string;
	sourceHash: string;
	requestText: string;
}) {
	const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	return manuscripts().requestFromUser(scope, input);
}

export async function draftStudyManuscriptPatch(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	patchId: string;
	expectedPatchRevision: number;
	operations: readonly ManuscriptOperation[];
}) {
	const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	return manuscripts().draft(scope, input);
}

export async function confirmStudyManuscriptPatch(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	patchId: string;
	expectedPatchRevision: number;
}) {
	const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	return manuscripts().confirmFromUser(scope, input);
}

export async function recoverStudyManuscriptPatch(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	patchId: string;
	expectedPatchRevision: number;
}) {
	const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	return manuscripts().recoverFromUser(scope, input);
}

export async function readStudyManuscriptCandidate(input: { sessionId: string; patchId: string }) {
	const { scope } = await studyContext(input.sessionId);
	return manuscripts().readCandidate(scope, input.patchId);
}
