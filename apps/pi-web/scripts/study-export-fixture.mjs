import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import JSZip from "jszip";

const directory = resolve(process.env.PI_STUDY_FIXTURE_DIR || "../../.artifacts/study-research/sr-diag");
const sessionId = process.env.PI_STUDY_EXPORT_SESSION || JSON.parse(await readFile(join(directory, "seed.json"), "utf8")).sessionId;
const base = "http://127.0.0.1:30185";
const endpoint = `${base}/api/study-research/export?sessionId=${encodeURIComponent(sessionId)}&format=project`;
const response = await fetch(endpoint);
assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
assert.match(response.headers.get("content-type"), /application\/zip/);
const bytes = new Uint8Array(await response.arrayBuffer());
await writeFile(join(directory, "project-export.zip"), bytes);
const zip = await JSZip.loadAsync(bytes);
const checksums = JSON.parse(await zip.file("checksums.json").async("string"));
const entries = Object.keys(zip.files).filter((path) => !zip.files[path].dir);
for (const path of entries) {
  assert.ok(!path.includes("\\") && !path.split("/").includes(".."), path);
  if (path !== "checksums.json") {
    const actual = createHash("sha256").update(await zip.file(path).async("nodebuffer")).digest("hex");
    assert.equal(checksums.files[path], `sha256:${actual}`, path);
  }
}
assert.equal(Object.keys(checksums.files).length, entries.length - 1);
assert.match(await zip.file("README.md").async("string"), /\[Learning notes\]\(notes.md\)/);
const records = await Promise.all(entries.filter((path) => /^experiments\/[^/]+\/record.json$/u.test(path)).map(async (path) => ({ folder: path.replace(/\/record.json$/u,""), record: JSON.parse(await zip.file(path).async("string")) })));
for (const language of (process.env.PI_STUDY_EXPORT_LANGUAGES || "r,python").split(",")) assert.ok(records.some(({record}) => record.language === language && record.status === "succeeded"));
for (const {folder,record} of records.filter(({record}) => ["succeeded","failed","cancelled","limit-reached"].includes(record.status))) {
  const language = record.language === "r" ? "R" : "py";
  assert.equal(await zip.file(`${folder}/source.${language}`).async("string"), record.cell.code);
  assert.deepEqual(JSON.parse(await zip.file(`${folder}/parameters.json`).async("string")),record.cell.parameters);
  assert.equal(await zip.file(`${folder}/stdout.log`).async("string"),record.result?.logs.stdout ?? "");
  assert.equal(await zip.file(`${folder}/stderr.log`).async("string"),record.result?.logs.stderr ?? "");
  for (const input of JSON.parse(await zip.file(`${folder}/input-manifest.json`).async("string"))) {
    const hash = createHash("sha256").update(await zip.file(`${folder}/${input.fileName}`).async("nodebuffer")).digest("hex");
    assert.equal(`sha256:${hash}`,input.sha256);
  }
  for (const output of JSON.parse(await zip.file(`${folder}/output-manifest.json`).async("string"))) {
    const body = await zip.file(`${folder}/outputs/${output.path}`).async("nodebuffer");
    assert.equal(`sha256:${createHash("sha256").update(body).digest("hex")}`,output.sha256);
    if (output.path.endsWith(".png")) assert.equal(body.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
  }
}
assert.ok(entries.some((path) => path.includes("/outputs/") && path.endsWith(".png")),"Actual R plot exported");
const selected=records.find(({record})=>record.language==="r"&&record.status==="succeeded");
const single=await fetch(`${endpoint}&queueJobId=${encodeURIComponent(selected.record.queueJobId)}`);
assert.equal(single.status,200);const singleZip=await JSZip.loadAsync(await single.arrayBuffer());
assert.equal(Object.keys(singleZip.files).filter((path)=>/^experiments\/[^/]+\/record.json$/u.test(path)).length,1);
const foreign=await fetch(`${endpoint}&queueJobId=queue-job-foreign-project`);assert.equal(foreign.status,400);assert.match((await foreign.json()).error,/not found/i);
const evidence={qualification:"Actual persisted native experiment export; no scientific reproduction claim.",sessionId,checkedAt:new Date().toISOString(),entryCount:entries.length,runCount:records.length,statuses:records.map(({record})=>record.status),sourceAndOutputBytesVerified:true,singleRunExport:true,foreignJobRejected:true,archive:join(directory,"project-export.zip")};
await writeFile(join(directory,"project-export-evidence.json"),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
