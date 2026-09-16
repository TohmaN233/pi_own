import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { contentHash, sha256Hex } from "../../../packages/harness-core/src/index.ts";
import { studyContext } from "./study-research-service";

export interface ExternalReference {
  doi: string; url: string; title: string; authors: string[]; year: number | null;
  abstract: string | null; abstractTruncated: boolean;
}

export function externalStudyQuery(value: string): string {
  if (typeof value !== "string" || value.trim().length < 2 || value.length > 160 || /[\r\n\0]/u.test(value)
    || value.trim().split(/\s+/u).length > 20) throw new Error("Use a short concept, title or DOI query (2–160 characters, at most 20 terms); never send private full text");
  return value.trim();
}

/** A fixed bibliographic endpoint, with no cookies, credentials, arbitrary URLs or source-text parameters. */
export async function fetchExternalStudyReferences(query: string, signal?: AbortSignal): Promise<ExternalReference[]> {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", externalStudyQuery(query)); url.searchParams.set("rows", "5");
  const response = await fetch(url, { headers: { accept: "application/json" }, credentials: "omit", redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Crossref metadata retrieval failed (HTTP ${response.status}); retry later`);
  if (!response.body) throw new Error("Crossref returned an empty response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
    if (length > 2 * 1024 * 1024) throw new Error("Crossref response exceeded its metadata size limit"); chunks.push(part.value); }
  } finally { await reader.cancel(); }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!data || typeof data !== "object" || !("message" in data) || !data.message || typeof data.message !== "object"
    || !("items" in data.message) || !Array.isArray(data.message.items)) throw new Error("Crossref returned malformed metadata");
  return data.message.items.slice(0, 5).map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Crossref result is malformed");
    const item = raw as Record<string, unknown>;
    const doi = typeof item.DOI === "string" ? item.DOI.trim() : "";
    if (!/^10\.\d{4,9}\/[^\s\0]{1,1000}$/u.test(doi)) throw new Error("Crossref result has no valid DOI");
    const titles = item.title;
    if (!Array.isArray(titles) || typeof titles[0] !== "string" || !titles[0].trim()) throw new Error("Crossref result has no title");
    const authors = Array.isArray(item.author) ? item.author.slice(0, 100).map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error("Crossref author is malformed");
      const author = entry as Record<string, unknown>;
      return [author.given, author.family, author.name].filter((part) => typeof part === "string").join(" ").slice(0, 500);
    }) : [];
    const published = item.published as { "date-parts"?: unknown } | undefined;
    const dates = published?.["date-parts"];
    const year = Array.isArray(dates) && Array.isArray(dates[0]) && Number.isInteger(dates[0][0]) ? dates[0][0] as number : null;
    const abstract = typeof item.abstract === "string" ? item.abstract : null;
    return { doi, url: `https://doi.org/${encodeURIComponent(doi)}`, title: titles[0].slice(0, 4000), authors, year,
      abstract: abstract?.slice(0, 20000) ?? null, abstractTruncated: abstract !== null && abstract.length > 20000 };
  });
}

/** Capture external provenance as a separately identified read-only reference source in the existing Host. */
export async function searchExternalStudyReferences(input: {sessionId: string; expectedPhaseRevision: number; query: string}, signal?: AbortSignal) {
  const query = externalStudyQuery(input.query);
  const initial = await studyContext(input.sessionId, input.expectedPhaseRevision);
  const references = await fetchExternalStudyReferences(query, signal);
  signal?.throwIfAborted();
  const current = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (current.scope.projectId !== initial.scope.projectId || current.snapshot.resourceSnapshotId !== initial.snapshot.resourceSnapshotId) throw new Error("Study context changed during external retrieval");
  const capture = { origin: "external-crossref-metadata", retrievedAt: new Date().toISOString(), query, references,
    interpretation: "External bibliographic metadata and deposited abstracts only; full texts have not been read or verified. This is supplemental learning material, not a research direction or scientific validation." };
  const text = JSON.stringify(capture, null, 2) + "\n";
  const dataDirectory = resolve(process.env.PI_LEARNING_HARNESS_DIR || join(getAgentDir(), "learning-harness"));
  const sourceRoot = join(dataDirectory, "study-external-references", sha256Hex(current.scope.projectId));
  await mkdir(sourceRoot, { recursive: true });
  if ((await realpath(sourceRoot)).toLowerCase() !== sourceRoot.toLowerCase()) throw new Error("External reference storage must not redirect through a link");
  const relativePath = `crossref-${sha256Hex(text)}.json`;
  const handle = await open(join(sourceRoot, relativePath), "wx");
  try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
  if (await readFile(join(sourceRoot, relativePath), "utf8") !== text) throw new Error("External reference capture failed byte verification");
  const final = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (final.scope.projectId !== current.scope.projectId || final.snapshot.resourceSnapshotId !== current.snapshot.resourceSnapshotId) throw new Error("Study context changed before external reference registration; captured file retained for diagnostics");
  const source = final.host.registerSource(final.scope, { sourceRoot, relativePath, contentHash: `sha256:${sha256Hex(text)}`,
    kind: "text", sourceRole: "reference", parser: "crossref-metadata-v1",
    diagnostics: [{ code: "EXTERNAL_METADATA_ONLY", severity: "info", message: capture.interpretation, path: null, locator: null, requiresPdfInspection: false }],
    chunks: [{ ordinal: 1, locator: JSON.stringify({kind:"external-metadata",provider:"Crossref",retrievedAt:capture.retrievedAt,queryHash:contentHash(query)}), text }],
  }, final.host.projectRevision(final.scope).revision);
  return { ...capture, sourceId: source.sourceId, sourceHash: source.contentHash };
}
