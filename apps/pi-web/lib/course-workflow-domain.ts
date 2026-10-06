import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compileBeamerDeck, compileLatexDocument, runBoundedProcess, semesterPlanningIssue, type CourseBuilderHost, type CourseBuilderMaterial } from "../../../packages/course-builder-host/src/index.ts";
import { describeCourseBuilderLocalFile, readLinkedCourseBuilderMaterial, readLinkedCourseBuilderMaterialBytes } from "./course-builder-local-materials.ts";
import { validateLinkedInteractiveVisual, validateStandaloneInteractiveVisual } from "./course-builder-interactive-visual.ts";
import { COURSE_WORKFLOW_IMPLEMENTATION_SHA256 } from "./course-workflow-domain-identity.ts";
import { courseProductionRoute, COURSE_PRODUCTION_ROUTE_SCHEMA, COURSE_PRODUCT_DEFINITIONS, type CourseWorkflowProductAction, type CourseProductionOperation } from "./course-production-policy.ts";

import { canonical, parseRecord, record as jsonRecord, isRecord, errorCode, errorMessage, type JsonRecord as Data } from "./workflow-domain-data.ts";
interface SemanticDraft extends Data { materialIndexes?: unknown; segments?: Data[]; sessions?: SemanticSession[]; coverage?: Data[] }
interface SemanticSession extends Data { goalIndexes?: number[]; materialIndexes?: unknown }
interface ArtifactFile extends Data { format?: string; path?: string; source?: FileRef; role?: string; documentKind?: "beamer"|"teacher-notes"|"assignment"; outputMode?: string; expectedPages?: number }
interface DomainInput extends ArtifactFile { kind?: CourseWorkflowKind; requestId?: string; bindingSha256?: string; round?: number; draft?: SemanticDraft; lessonDraft?: SemanticDraft; files?: ArtifactFile[]; title?: string; purpose?: string; frameOutline?: unknown }
type CommittedFile = ArtifactFile & { source: FileRef };
interface CourseOutput extends Data { context?: Data & {currentArtifact?: {deckId:string} | null} }
interface CommitReceipt extends Data { files: (CommittedFile & {format:"tex"|"rmd"|"html";role?:"student"|"solution";source:FileRef & {bytes:number}})[]; lesson?: {contentHash:string;revision:number} | null; product?: Data & {contentHash?:string;revision?:number;materialId?:string} }
type BrokerResult = { exit_code: 0; output: CourseOutput; effects: Effects } | { exit_code: 1; output: null; diagnostic: string; effects: Effects };
function fileInput(value: unknown): ArtifactFile {
  const file = jsonRecord(value);
  for (const key of ["format","path","role","documentKind","outputMode"] as const) requireThat(file[key] === undefined || typeof file[key] === "string", "ARTIFACT_FORMAT_REQUIRED", `Artifact ${key} must be text`);
  requireThat(file.documentKind === undefined || ["beamer","teacher-notes","assignment"].includes(String(file.documentKind)), "ARTIFACT_FORMAT_REQUIRED", "Unknown document kind");
  requireThat(file.expectedPages === undefined || typeof file.expectedPages === "number", "ARTIFACT_FORMAT_REQUIRED", "Expected pages must be numeric");
  if (file.source !== undefined) { const ref = jsonRecord(file.source); requireThat(typeof ref.path === "string" && typeof ref.sha256 === "string" && (ref.bytes === undefined || typeof ref.bytes === "number"), "SOURCE_REF_REQUIRED", "Supply the exact Host source file and SHA256"); }
  // The predicates above establish the fields consumed locally; Host validators retain semantic authority.
  return file as ArtifactFile;
}
function semanticDraft(value: unknown): SemanticDraft {
  const draft = jsonRecord(value);
  for (const key of ["segments","sessions","coverage"] as const) if (draft[key] !== undefined) {
    requireThat(Array.isArray(draft[key]) && draft[key].every(isRecord), "SEMANTIC_DRAFT_REQUIRED", `${key} must contain semantic objects`);
  }
  if (Array.isArray(draft.sessions)) for (const value of draft.sessions) { const slot = jsonRecord(value); requireThat(slot.goalIndexes === undefined || Array.isArray(slot.goalIndexes) && slot.goalIndexes.every(index => typeof index === "number"), "HOST_OWNED_FIELDS", "Course goal indexes must be numbers"); }
  return draft as SemanticDraft;
}
function domainInput(value: Data): DomainInput {
  const input = fileInput(value);
  for (const key of ["requestId","bindingSha256","title","purpose"] as const) requireThat(input[key] === undefined || typeof input[key] === "string", "TASK_INPUT_REQUIRED", `${key} must be text`);
  requireThat(input.round === undefined || typeof input.round === "number", "REQUEST_ROUND_INVALID", "Repair round must be numeric");
  requireThat(input.kind === undefined || typeof input.kind === "string" && ["analysis","checkpoint","semester","lesson","deck","teacher-notes","assignment-plan","assignment-artifacts","assignment","rmd","html","bundle","experiment"].includes(input.kind ?? ""), "COMMIT_KIND_REQUIRED", "Unknown artifact commit kind");
  if (input.draft !== undefined) semanticDraft(input.draft);
  if (input.lessonDraft !== undefined) semanticDraft(input.lessonDraft);
  if (input.files !== undefined) requireThat(Array.isArray(input.files) && input.files.every(file => { fileInput(file); return true; }), "ARTIFACT_FILES_REQUIRED", "Artifact files must be an array");
  return input as DomainInput;
}
const projectSettingNames = ["title","audience","language","weeks","sessionsPerWeek","minutesPerSession","goals","beamerProfile"] as const;
const lessonFieldNames = ["title","objectives","prerequisites","misconceptions","segments","examples","exercises","visualRequests","notes"] as const;
const analysisFieldNames = ["topicChains","prerequisiteGaps","duplicates","sequenceGaps","terminologyConflicts","practiceOpportunities","visualOpportunities"] as const;

type FileRef = { path: string; sha256: string; bytes?: number };
type Effects = { observed: true; changed_paths: string[]; outside_paths: string[]; artifacts: { id: string; sha256: string; bytes: number }[] };
type Invocation = { input: Data & {taskId: string}; context: { run_id: string; node_id: string; attempt_id: string; workspace?: string }; signal?: AbortSignal; authorize?: () => void | Promise<void>; permissions?: { write_paths: string[] } };
type ToolIdentity = { name: string; version: string; sha256: string };
export interface CourseWorkflowBroker {
  identity: ToolIdentity;
  execute: (invocation: Invocation) => Promise<BrokerResult>;
  cancel: (invocation: { context: Invocation["context"]; reason?: unknown }) => Promise<{ termination_confirmed: true; evidence: { kind: string; sha256: string }[]; effects: Effects }>;
  attestation: { qualified: true; cancellable: true; effect_observation: true; tool_identity: ToolIdentity; broker_id: string; evidence_sha256: string };
}
export interface CourseWorkflowToolContract {
  id: string; identity: ToolIdentity; argv: string[]; input_schema: Data; output_schema: Data; env_allow: string[];
  permissions: { network: false; read_paths: string[]; write_paths: string[] };
  output_cap_bytes: number; deadline_ms: number; idempotency: { mode: "safe" | "reconcile_required" };
}
export type CourseWorkflowKind = "analysis" | "checkpoint" | "semester" | "lesson" | "deck" | "teacher-notes" | "assignment-plan" | "assignment-artifacts" | "assignment" | "rmd" | "html" | "bundle" | "experiment";
export type CourseWorkflowTarget = { lessonId: string } | { week: number; session: number } | { course: true } | { assignmentId: string };
export interface CourseWorkflowDomain {
  registry: Record<string, CourseWorkflowBroker>;
  contracts: CourseWorkflowToolContract[];
  binding: { taskId: string; projectId: string; week: number | null; session: number | null; taskDirectory: string };
  contextBinding: () => Data & {sha256:string};
  committedReceipt: (requestId: string) => Promise<CommitReceipt>;
}
export interface CourseWorkflowDomainOptions {
  sessionId: string;
  cwd: string;
  taskId: string;
  target: CourseWorkflowTarget;
  kind?: CourseWorkflowKind;
  production?: { action: CourseWorkflowProductAction; operation: CourseProductionOperation; bindingSha256?: string; discardBaseline?: boolean };
  /** Exact private Host-owned destinations, never model-chosen directories. */
  outputDirectory?: string;
  materialRoot?: string;
  baselineFiles?: { path: string; format: "tex" | "rmd" | "html"; role?: "student" | "solution" }[];
  /** Frozen previous-task sources are references, never publication destinations. */
  repairBaselineFiles?: CourseWorkflowDomainOptions["baselineFiles"];
  attachmentIds?: string[];
  attachmentSources?: {id:string;name:string;sourceHash:string;textSha256:string}[];
  readAttachment?: (id:string) => Promise<{id:string;name:string;sourceHash:string;text:string}>;
  materialIds: string[];
  taskDirectory: string;
  /** Host control records stay outside the child's writable artifact workspace. */
  journalDirectory?: string;
  /** Exact authoritative database and WAL/SHM paths, including paths outside cwd. */
  storagePaths?: string[];
  /** Only fixtures may use this; production writes require observed storage paths. */
  inMemoryFixture?: boolean;
  getHost: () => CourseBuilderHost;
  readMaterial?: (material: CourseBuilderMaterial) => Promise<string>;
  compiler?: string;
  rscript?: string;
  trustedExecution?: boolean;
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function requireThat(test: unknown, code: string, message: string): asserts test { if (!test) throw Object.assign(new Error(message), { code }); }
const inside = (root: string, candidate: string) => { const rel = relative(root, candidate); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const portable = (value: string) => value.split(sep).join("/");
const emptyEffects = (): Effects => ({ observed: true, changed_paths: [], outside_paths: [], artifacts: [] });
const stringSchema = { type: "string", minLength: 1, maxLength: 4096 };
const refSchema = { type: "object", additionalProperties: false, required: ["path", "sha256"], properties: { path: stringSchema, sha256: { type: "string", pattern: "^[a-f0-9]+$", minLength: 64, maxLength: 64 }, bytes: { type: "integer", minimum: 0, maximum: 2097152 } } };
const fileSchema = { type: "object", additionalProperties: false, required: ["format", "source"], properties: { format: { enum: ["tex", "rmd", "html"] }, source: refSchema, role: { enum: ["student", "solution"] }, documentKind: { enum: ["beamer", "teacher-notes", "assignment"] }, outputMode: { enum: ["knit", "render"] }, expectedPages: { type: "integer", minimum: 1, maximum: 1000 } } };
const newArtifactPathSchema = { ...stringSchema, description: "Author-chosen new artifact filename beneath sources/, relative to the task workspace; no absolute path, traversal, or context-resource path. Host captures its SHA256/bytes; supply exactly one of path or legacy source." };
const commitFileSchema = { ...fileSchema, required: ["format"], description: "Supply exactly one of path or source. For a new artifact, the author chooses a new relative sources/ filename; Host computes its byte identity. Do not copy a context path or write_workspace hash into semantic output.", properties: { ...fileSchema.properties, path: newArtifactPathSchema } };
const materialIndexesSchema = {type:"array",maxItems:100,uniqueItems:true,items:{type:"integer",minimum:0,maximum:511}};
const listSchema = { type: "array", maxItems: 500, items: stringSchema };
/** Shared bound for the author result and its direct commit projection. */
export const COURSE_FRAME_OUTLINE_SCHEMA = { type: "array", maxItems: 100, items: stringSchema };
const nullableTextSchema = { type: "string", maxLength: 10000, description:"Use an empty string when absent; Host normalizes absence." };
interface ObjectSchema extends Data { properties: Record<string, Data>; required: string[] }
const closed = (properties: Record<string, Data>): ObjectSchema => ({ type: "object", additionalProperties: false, required: [], properties });
/** Closed author-only schemas: identities and reference hashes are always assigned by Host. */
export function courseWorkflowSemanticSchema(kind: CourseWorkflowKind): ObjectSchema {
  const lesson = closed({materialIndexes:materialIndexesSchema,title:stringSchema,objectives:listSchema,prerequisites:listSchema,misconceptions:listSchema,segments:{type:"array",minItems:1,maxItems:100,items:closed({minutes:{type:"integer",minimum:1,maximum:360},title:stringSchema,teacherAction:stringSchema,learnerAction:stringSchema,checkForUnderstanding:nullableTextSchema})},examples:listSchema,exercises:listSchema,visualRequests:listSchema,notes:listSchema});
  if (kind === "lesson" || kind === "bundle") return lesson;
  if (kind === "semester") return closed({title:stringSchema,rationale:stringSchema,sessions:{type:"array",minItems:1,maxItems:840,items:closed({materialIndexes:materialIndexesSchema,title:stringSchema,objectives:listSchema,prerequisites:listSchema,topics:listSchema,activities:listSchema,understandingEvidence:listSchema,assessment:nullableTextSchema,homework:nullableTextSchema,goalIndexes:{type:"array",maxItems:100,items:{type:"integer",minimum:0,maximum:99},uniqueItems:true},revisits:{type:"array",maxItems:100,items:closed({concept:{...stringSchema,description:"Newly authored human concept label; Host derives its course-scoped identity. Omit unchanged revisits on revision."},progression:{enum:["complexity","relationship","abstraction","formalization","representation","transfer","boundary"]},note:stringSchema})},visualOpportunities:listSchema})}});
  if (kind.startsWith("assignment")) return closed({overview:stringSchema,tasks:listSchema,deliverables:listSchema,rubric:listSchema,solutionNotes:listSchema});
  if (kind === "analysis") return closed(Object.fromEntries(["topicChains","prerequisiteGaps","duplicates","sequenceGaps","terminologyConflicts","practiceOpportunities","visualOpportunities"].map(name=>[name,listSchema])));
  if (kind === "checkpoint") return closed({coverage:{type:"array",maxItems:512,items:closed({summary:stringSchema,position:{type:"string",maxLength:4000},nextLesson:stringSchema})},completed:listSchema,remaining:listSchema,nextLesson:stringSchema});
  return closed({});
}
export function courseWorkflowAuthorSchema(kind: CourseWorkflowKind): ObjectSchema {
  const stateOnly = ["analysis","checkpoint","semester","lesson","assignment-plan"].includes(kind);
  const file = closed({format:{enum:kind === "assignment-artifacts" ? ["tex","rmd"] : kind === "html" ? ["html"] : kind === "rmd" ? ["rmd"] : ["tex","rmd"]},path:newArtifactPathSchema,documentKind:fileSchema.properties.documentKind,role:fileSchema.properties.role,outputMode:fileSchema.properties.outputMode,expectedPages:fileSchema.properties.expectedPages});
  file.required = ["format","path"];
  const schema = closed({...(stateOnly || kind === "assignment" || kind === "bundle" ? {draft:courseWorkflowSemanticSchema(kind)} : {}),files:{type:"array",minItems:stateOnly ? 0 : kind === "assignment-artifacts" ? 2 : 1,maxItems:stateOnly ? 0 : kind === "assignment-artifacts" ? 2 : kind === "bundle" ? 8 : 1,items:file},...(["deck","teacher-notes","html"].includes(kind) ? {title:stringSchema} : {}),...(kind === "deck" ? {frameOutline:COURSE_FRAME_OUTLINE_SCHEMA} : {}),...(kind === "html" ? {purpose:stringSchema} : {})});
  schema.required = stateOnly ? ["draft","files"] : ["files"];
  return schema;
}
const VERSION = "1.0.0";
/** Stable identities do not depend on the selected project/session/task. */
export const COURSE_WORKFLOW_TOOL_IDENTITIES: Record<string, ToolIdentity> = Object.fromEntries(["course_task_context", "course_task_route", "course_artifact_commit", "course_artifact_compile"].map(id => [id, { name: id, version: VERSION, sha256: hash(canonical({ id, version: VERSION, implementation: COURSE_WORKFLOW_IMPLEMENTATION_SHA256 })) }]));

export function courseWorkflowToolContracts(taskPath = ".", kind?: CourseWorkflowKind): CourseWorkflowToolContract[] {
  const common = { taskId: stringSchema };
  const mutation = { ...common, requestId: { type: "string", pattern: "^[a-zA-Z0-9_-]+$", minLength: 1, maxLength: 100 }, bindingSha256: { type: "string", pattern: "^[a-f0-9]+$", minLength: 64, maxLength: 64 } };
  const inputs: Record<string, Data> = {
    course_task_context: { type: "object", additionalProperties: false, required: ["taskId"], properties: common },
    course_task_route: { type: "object", additionalProperties: false, required: ["taskId"], properties: common },
    course_artifact_commit: { type: "object", additionalProperties: false, required: ["taskId", "requestId", "bindingSha256", "kind"], properties: { ...mutation, kind: { enum: ["analysis", "checkpoint", "semester", "lesson", "deck", "teacher-notes", "assignment", "rmd", "html", "experiment", "bundle"] }, draft: closed(Object.assign({},...(["analysis","checkpoint","semester","lesson","assignment"] as CourseWorkflowKind[]).map(value=>courseWorkflowSemanticSchema(value).properties))), lessonDraft: {type:"object"}, files: { type: "array", minItems: 0, maxItems: 8, items: commitFileSchema }, path: newArtifactPathSchema, source: refSchema, format: { enum: ["tex", "rmd", "html"], description: "Required for an experiment; a deck has fixed tex format." }, title: stringSchema, purpose: stringSchema, frameOutline: COURSE_FRAME_OUTLINE_SCHEMA } },
    course_artifact_compile: { type: "object", additionalProperties: false, required: ["taskId", "requestId", "bindingSha256"], properties: { ...mutation, files: { type: "array", minItems: 0, maxItems: 8, items: fileSchema }, source: refSchema, format: { enum: ["tex", "rmd", "html"] }, documentKind: { enum: ["beamer", "teacher-notes", "assignment"] }, outputMode: { enum: ["knit", "render"] }, expectedPages: { type: "integer", minimum: 1, maximum: 1000 } } },
  };
  const bindingSchema = { type: "object", required: ["sha256", "taskId"], properties: { sha256: { type: "string", pattern: "^[a-f0-9]+$", minLength: 64, maxLength: 64 }, taskId: stringSchema } };
  const outputs: Record<string, Data> = {
    course_task_context: { type: "object", required: ["taskId", "binding", "bindingSha256", "context"], properties: { taskId: stringSchema, binding: bindingSchema, bindingSha256: mutation.bindingSha256, context: { type: "object" } } },
    course_task_route: COURSE_PRODUCTION_ROUTE_SCHEMA,
    course_artifact_commit: { type: "object", required: ["taskId", "binding", "bindingSha256", "teacherReviewPending", "files", "succeeded"], properties: { taskId: stringSchema, binding: bindingSchema, bindingSha256: mutation.bindingSha256, teacherReviewPending: { type: "boolean" }, succeeded: { type: "boolean" }, files: { type: "array", items: fileSchema }, source: refSchema, artifact: { type: "object", additionalProperties: false, required: ["deckId", "revision", "sourceHash"], properties: { deckId: stringSchema, revision: { type: "integer", minimum: 1 }, sourceHash: { type: "string", pattern: "^sha256:[a-f0-9]+$", minLength: 71, maxLength: 71 } } } } },
    course_artifact_compile: { type: "object", required: ["taskId", "binding", "bindingSha256", "succeeded", "artifacts", "teacherReviewPending"], properties: { taskId: stringSchema, binding: bindingSchema, bindingSha256: mutation.bindingSha256, succeeded: { type: "boolean" }, artifacts: { type: "array", items: { type: "object" } }, teacherReviewPending: { type: "boolean" } } },
  };
  return Object.keys(inputs).map(id => ({ id, identity: COURSE_WORKFLOW_TOOL_IDENTITIES[id], argv: [], input_schema: inputs[id], output_schema: outputs[id], env_allow: [], permissions: { network: false, read_paths: [taskPath], write_paths: [taskPath] }, output_cap_bytes: 131072, deadline_ms: 300000, idempotency: { mode: ["course_task_context","course_task_route"].includes(id) ? "safe" : "reconcile_required" } }));
}

/** A private parent-owned adapter. Model inputs cannot choose a session, course, or target. */
export function createCourseWorkflowDomain(options: CourseWorkflowDomainOptions): CourseWorkflowDomain {
  const cwd = resolve(options.cwd), directory = resolve(options.taskDirectory);
  requireThat(inside(cwd, directory) && directory !== cwd, "TASK_DIRECTORY_REQUIRED", "Task artifacts need a dedicated directory beneath the bound workspace");
  requireThat(/^[a-zA-Z0-9_-]{1,100}$/u.test(options.taskId) && options.sessionId && typeof options.getHost === "function", "TASK_BINDING_REQUIRED", "A private task/session/Host binding is required");
  const journalDirectory = resolve(options.journalDirectory ?? join(cwd, ".pi", "course-workflow-host", options.taskId));
  requireThat(!inside(directory, journalDirectory), "PRIVATE_JOURNAL_REQUIRED", "Durable Host control records must be outside the child artifact workspace");
  requireThat(options.materialIds.length <= 512 && new Set(options.materialIds).size === options.materialIds.length, "MATERIAL_SELECTION_REQUIRED", "Select at most 512 distinct material IDs explicitly");
  const attachmentIds=options.attachmentIds ?? [], attachmentSources=options.attachmentSources ?? [];
  requireThat(attachmentIds.length <= 16 && new Set(attachmentIds).size === attachmentIds.length && attachmentIds.every(id=>/^[0-9a-f-]{36}$/u.test(id)),"ATTACHMENT_SELECTION_REQUIRED","Select at most 16 unique attachment UUIDs");
  requireThat(attachmentSources.length === attachmentIds.length && attachmentSources.every(source=>attachmentIds.includes(source.id) && typeof source.name === "string" && /^[a-f0-9]{64}$/u.test(source.sourceHash) && /^[a-f0-9]{64}$/u.test(source.textSha256)) && new Set(attachmentSources.map(source=>source.id)).size === attachmentSources.length && (!attachmentIds.length || options.readAttachment),"ATTACHMENT_BINDING_REQUIRED","Selected attachments need exact private verified source summaries and reader");
  const storagePaths = (options.storagePaths ?? []).map(path => resolve(path));
  const initial = options.getHost().getSnapshotForSession(options.sessionId);
  requireThat(initial, "COURSE_BINDING_REQUIRED", "The selected conversation has no course binding");
  const projectId = initial.project.projectId;
  let week: number | null = null, session: number | null = null;
  const kind = options.kind ?? "bundle";
  if (options.production) requireThat(COURSE_PRODUCT_DEFINITIONS[options.production.action]?.kind === kind,
    "PRODUCTION_KIND_MISMATCH", "Private production action differs from its product kind");
  requireThat(["analysis","semester"].includes(kind) ? "course" in options.target : kind.startsWith("assignment") ? "assignmentId" in options.target : true,"TARGET_KIND_MISMATCH","Task target differs from its selected product scope");
  const assignmentId = "assignmentId" in options.target ? options.target.assignmentId : null;
  const requestedLessonId = "lessonId" in options.target ? options.target.lessonId : null;
  if (requestedLessonId) {
    const lesson = initial.lessonPlans.find(item => item.lessonPlanId === requestedLessonId);
    requireThat(lesson, "LESSON_TARGET_REQUIRED", "The explicit lesson target is not in this course");
    week = lesson.week; session = lesson.session;
  } else if ("week" in options.target) { week = options.target.week; session = options.target.session; }
  else requireThat("course" in options.target || assignmentId, "TARGET_REQUIRED", "Select a course, assignment or lesson target");
  const privateBinding = { taskId: options.taskId, sessionId: options.sessionId, projectId, week, session, materialIds: [...options.materialIds], attachmentSources, kind, target: options.target, outputDirectory: options.outputDirectory ?? null, materialRoot: options.materialRoot ?? null, baselineFiles: options.baselineFiles ?? [], directory, journalDirectory,
    ...(options.production ? { production: { action: options.production.action, operation: options.production.operation, discardBaseline: options.production.discardBaseline === true }, repairBaselineFiles: options.repairBaselineFiles ?? [] } : {}) };
  const taskHash = hash(canonical(privateBinding));
  const active = new Map<string, { controller: AbortController; done: Promise<BrokerResult>; before: Map<string, FileRef>; observedReady: boolean; settled: boolean; effects: Effects }>();
  let queue: Promise<unknown> = Promise.resolve();
  const frozenBaseline = new Map<string, string>([...(options.baselineFiles ?? []),...(options.repairBaselineFiles ?? [])].map(file=>{const bytes = readFileSync(resolve(file.path)); requireThat(bytes.length <= 2097152,"SOURCE_LIMIT","Baseline exceeds 2 MiB"); return [resolve(file.path),hash(bytes)];}));
  if(assignmentId) for(const file of options.baselineFiles ?? []) for(const extension of file.format === "tex" ? [".pdf"] : file.format === "rmd" ? [".md",".html"] : []) {
    const path=join(resolve(file.path,".."),`${basename(file.path,extname(file.path))}${extension}`);
    try {frozenBaseline.set(path,hash(readFileSync(path)));} catch(error) {if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
  }
  const published = new Map<string, string>();
  // Restore only parent-owned durable control records. This retains the pre-write
  // baseline CAS and known published identities when a task resumes after restart.
  try {
    const completed = readdirSync(journalDirectory).filter(name=>/^request-[a-zA-Z0-9_-]+[.]json$/u.test(name)).map(name=>parseRecord(readFileSync(join(journalDirectory,name),"utf8"))).filter(saved=>saved.taskHash === taskHash && saved.status === "completed" && saved.hostFiles).sort((a,b)=>String(a.completedAt).localeCompare(String(b.completedAt)));
    const latest=completed.at(-1);
    if(latest) {
      const hostFiles=jsonRecord(latest.hostFiles);
      const pairs=(value:unknown):[string,string][]=>{requireThat(Array.isArray(value),"PRIVATE_JOURNAL_CORRUPT","Journal file identities must be an array");return value.map(pair=>{requireThat(Array.isArray(pair) && pair.length===2 && typeof pair[0]==="string" && typeof pair[1]==="string","PRIVATE_JOURNAL_CORRUPT","Journal file identity is malformed");return [pair[0],pair[1]];});};
      for(const [path,sha256] of pairs(hostFiles.baselines)) {requireThat(frozenBaseline.has(path) && /^[a-f0-9]{64}$/u.test(sha256),"PRIVATE_JOURNAL_CORRUPT","Journal baseline scope differs from the selected private task");frozenBaseline.set(path,sha256);}
      for(const [path,sha256] of pairs(hostFiles.published)) {requireThat((options.outputDirectory && inside(resolve(options.outputDirectory),path) || options.materialRoot && inside(resolve(options.materialRoot),path)) && /^[a-f0-9]{64}$/u.test(sha256),"PRIVATE_JOURNAL_CORRUPT","Published receipt escaped its selected private destination");published.set(path,sha256);}
    }
  } catch(error) {if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
  const observedExternalPaths = new Set<string>([...frozenBaseline.keys(),...published.keys()]);
  let operationBaseline: Map<string, FileRef> | null = null;
  const key = (context: Invocation["context"]) => canonical([context.run_id, context.node_id, context.attempt_id]);
  function withBindingSha256(output: CourseOutput) {
    const binding=jsonRecord(output.binding);
    requireThat(typeof binding.sha256 === "string" && /^[a-f0-9]{64}$/u.test(binding.sha256), "BINDING_OUTPUT_REQUIRED", "Host output must retain its exact CAS binding");
    requireThat(output.bindingSha256 === undefined || output.bindingSha256 === binding.sha256, "BINDING_OUTPUT_MISMATCH", "Host output's top-level CAS hash differs from its audit binding");
    return { ...output, bindingSha256: binding.sha256 };
  }
  async function route() {
    const production = options.production;
    requireThat(production && /^[a-f0-9]{64}$/u.test(production.bindingSha256 ?? ""), "PRODUCTION_BINDING_REQUIRED", "Route requires a prepared private production action and baseline");
    const current = selected(), scope = COURSE_PRODUCT_DEFINITIONS[production.action].scope;
    requireThat(scope === "course" ? "course" in options.target : scope === "assignment" ? !!assignmentId
      : scope === "existing-lesson" || scope === "existing-deck" ? !!requestedLessonId : true,
      "PRODUCTION_TARGET_MISMATCH", "Prepared action has the wrong target scope");
    if (scope === "existing-deck") requireThat(current.deck, "DECK_BASELINE_REQUIRED", "This action requires the selected existing deck");
    const hasProduct = kind === "semester" ? !!current.semester : kind === "analysis" ? !!current.state.materialAnalysis
      : kind === "lesson" || kind === "bundle" ? !!current.lesson : kind === "deck" ? !!current.deck
      : kind === "teacher-notes" ? !!current.notes : kind === "assignment-plan" ? !!current.assignment?.draft
      : kind === "checkpoint" ? !!current.checkpoint : !!options.baselineFiles?.length;
    const actualOperation = production.discardBaseline ? "new" : hasProduct || options.repairBaselineFiles?.length ? "revise" : "new";
    requireThat(actualOperation === production.operation, "PRODUCTION_OPERATION_MISMATCH", "Prepared branch differs from its exact product baseline");
    await checkFrozenBaselines();
    requireThat(current.binding.sha256 === production.bindingSha256, "PRODUCTION_BASELINE_CHANGED", "Prepared product baseline changed; prepare a fresh task");
    return courseProductionRoute(production.action, production.operation);
  }

  async function checkedDirectory() {
    await mkdir(directory, { recursive: true });
    requireThat(resolve(await realpath(directory)) === directory && resolve(await realpath(cwd)) === cwd, "TASK_PATH_ESCAPE", "Task/workspace directory contains a symlink or reparse escape");
    let parent = directory;
    while (parent !== cwd) { requireThat(!(await lstat(parent)).isSymbolicLink(), "TASK_PATH_ESCAPE", "Task directory ancestor is a symlink"); parent = resolve(parent, ".."); }
    await mkdir(journalDirectory, { recursive: true });
    requireThat(resolve(await realpath(journalDirectory)) === journalDirectory, "PRIVATE_JOURNAL_ESCAPE", "Private journal directory contains a symlink/reparse escape");
  }
  function selected() {
    const host = options.getHost(), state = host.getSnapshotForSession(options.sessionId);
    requireThat(state?.project.projectId === projectId, "COURSE_BINDING_CHANGED", "The private task course binding changed");
    const semester = state.semesterPlan;
    const needsApprovedSemester = ["lesson", "deck", "bundle", "checkpoint"].includes(kind);
    if (needsApprovedSemester) requireThat(semester && semester.status === "approved" && !semesterPlanningIssue(state.project, semester), "SEMESTER_APPROVAL_REQUIRED", "The current semester plan must have genuine teacher approval");
    const slot = semester?.sessions.find(item => item.week === week && item.session === session) ?? null;
    if (needsApprovedSemester) requireThat(slot, "SEMESTER_SLOT_REQUIRED", "The requested session is absent from the approved semester plan");
    const lesson = week === null ? null : state.lessonPlans.find(item => item.week === week && item.session === session) ?? null;
    if (requestedLessonId) requireThat(lesson?.lessonPlanId === requestedLessonId, "LESSON_TARGET_CHANGED", "The requested lesson identity changed");
    const deck = lesson ? state.decks.find(item => item.lessonPlanId === lesson.lessonPlanId) ?? null : null;
    const notes = deck ? state.teacherNotes.find(item => item.deckId === deck.deckId) ?? null : null;
    const checkpoint = lesson ? host.listCoverageCheckpoints(options.sessionId).find(item => item.lessonPlanId === lesson.lessonPlanId) ?? null : null;
    const assignment = assignmentId ? host.getAssignment(options.sessionId, assignmentId) : null;
    const materials = options.materialIds.map(id => {
      const material = state.materials.find(item => item.materialId === id);
      requireThat(material && (assignmentId ? material.metadata.materialScope === "assignment" && material.metadata.assignmentId === assignmentId && assignment!.materialIds.includes(id) : material.metadata.materialScope !== "assignment"), "MATERIAL_SCOPE_MISMATCH", `Selected reference ${id} is unavailable or outside this task's reference scope`);
      return material;
    });
    const cas = { taskId: options.taskId, projectId, projectRevision: state.project.revision, projectHash: state.project.contentHash, semesterId: semester?.semesterPlanId ?? null, semesterRevision: semester?.revision ?? 0, semesterHash: semester?.contentHash ?? null, week, session, lessonId: lesson?.lessonPlanId ?? null, lessonRevision: lesson?.revision ?? 0, lessonHash: lesson?.contentHash ?? null, artifactId: deck?.deckId ?? null, artifactRevision: deck?.revision ?? 0, artifactHash: deck?.contentHash ?? null, sourceHash: deck?.sourceHash ?? null, notesId: notes?.notesId ?? null, notesRevision: notes?.revision ?? 0, notesHash: notes?.contentHash ?? null, assignmentId, assignmentRevision: assignment?.revision ?? 0, assignmentHash: assignment?.contentHash ?? null, checkpointHash: checkpoint?.contentHash ?? null, analysisHash: kind === "analysis" ? state.materialAnalysis?.contentHash ?? null : null, materialIds: options.materialIds, materialHashes: materials.map(material => ({ materialId: material.materialId, sourceHash: material.sourceHash, textHash: material.textHash })) };
    const assetHashes = deck?.assetMaterialIds.map(id=>{const material=host.getMaterial(options.sessionId,id);return {id,sourceHash:material.sourceHash};}) ?? [];
    const settings = Object.fromEntries(projectSettingNames.map(name=>[name,state.project[name]]));
    const scope: Data = {taskId:options.taskId,projectId,kind,settings,materials:cas.materialHashes,attachments:attachmentSources,baselines:[...frozenBaseline].map(([path,sha256])=>({path,sha256}))};
    if (assignment) { scope.settings = {assignmentPreamble:state.project.assignmentPreamble,language:state.project.language}; scope.assignment = {id:assignment.assignmentId,revision:assignment.revision,hash:assignment.contentHash}; }
    else if (kind === "analysis") scope.analysis = state.materialAnalysis?.contentHash ?? null;
    else if (kind === "semester") scope.semester = {id:cas.semesterId,revision:cas.semesterRevision,hash:cas.semesterHash};
    else if (kind === "teacher-notes") { scope.deck = {id:cas.artifactId,revision:cas.artifactRevision,source:cas.sourceHash}; scope.notes = {id:cas.notesId,revision:cas.notesRevision,hash:cas.notesHash}; scope.assets = assetHashes; }
    else if (kind === "html" || kind === "rmd") { scope.lesson = {id:cas.lessonId}; }
    else { scope.semester = {id:cas.semesterId,revision:cas.semesterRevision,hash:cas.semesterHash}; scope.lesson = {id:cas.lessonId,revision:cas.lessonRevision,hash:cas.lessonHash}; if (kind === "deck" || options.kind === undefined) { scope.deck = {id:cas.artifactId,revision:cas.artifactRevision,hash:cas.artifactHash}; scope.assets = assetHashes; } if (kind === "checkpoint") scope.checkpoint = cas.checkpointHash; }
    return { host, state, semester, slot, lesson, deck, notes, assignment, checkpoint, materials, binding: { ...cas, sha256: hash(canonical(scope)),...(options.materialIds.length > 32 ? {materialCount:options.materialIds.length,materialSelectionSha256:hash(canonical(cas.materialHashes)),materialIds:options.materialIds.slice(0,32),materialHashes:cas.materialHashes.slice(0,32)} : {}) } };
  }
  async function readSourceFile(filePath: string) {
    requireThat(typeof filePath === "string" && filePath.length > 0 && filePath.length <= 4096, "SOURCE_PATH_REQUIRED", "A bounded source file path is required");
    const path = resolve(directory, filePath);
    requireThat(inside(directory, path) && resolve(await realpath(path)) === path, "SOURCE_PATH_ESCAPE", "Source must be a physical file inside this task directory");
    let ancestor = path;
    while (ancestor !== directory) { requireThat(!(await lstat(ancestor)).isSymbolicLink(), "SOURCE_PATH_ESCAPE", "Source path contains a symlink"); ancestor = resolve(ancestor, ".."); }
    const info = await lstat(path);
    requireThat(info.isFile() && info.size <= 2097152, "SOURCE_LIMIT", "Source must be a regular file at most 2 MiB");
    const bytes = await readFile(path);
    requireThat(bytes.length <= 2097152, "SOURCE_LIMIT", "Source exceeded its 2 MiB limit while reading");
    return { path, sha256: hash(bytes), bytes: bytes.length, text: bytes.toString("utf8") };
  }
  async function readSource(ref: FileRef) {
    requireThat(ref && /^[a-f0-9]{64}$/u.test(ref.sha256), "SOURCE_REF_REQUIRED", "Supply the exact Host source file and SHA256");
    const source = await readSourceFile(ref.path);
    requireThat(source.sha256 === ref.sha256 && (ref.bytes === undefined || ref.bytes === source.bytes), "SOURCE_HASH_MISMATCH", "Source bytes changed from the submitted reference");
    return source;
  }
  async function captureArtifactSource(file: ArtifactFile) {
    requireThat(file && ["tex", "rmd", "html"].includes(file.format ?? ""), "ARTIFACT_FORMAT_REQUIRED", "Artifact source format must be tex or rmd");
    const hasPath = Object.hasOwn(file, "path"), hasSource = Object.hasOwn(file, "source");
    requireThat(hasPath !== hasSource, "FILE_REFERENCE_AMBIGUOUS", "Supply exactly one new artifact path or legacy exact source reference");
    if (hasPath) {
      requireThat(typeof file.path === "string" && file.path.startsWith("sources/") && !/[\\:\x00-\x1f]/u.test(file.path) && file.path.split("/").every((part: string) => part !== "" && part !== "." && part !== ".."), "SOURCE_PATH_SCOPE", "New artifact paths must name a new file beneath sources/; do not copy context resource paths");
    }
    requireThat(hasPath ? typeof file.path === "string" : file.source, "SOURCE_REF_REQUIRED", "Artifact source identity is required");
    const source = hasPath ? await readSourceFile(file.path!) : await readSource(file.source!);
    requireThat(extname(source.path).toLowerCase() === (file.format === "tex" ? ".tex" : file.format === "rmd" ? ".rmd" : ".html"), "ARTIFACT_FORMAT_MISMATCH", "Artifact source format differs from its extension");
    return source;
  }
  async function normalizeCommittedFile(file: ArtifactFile): Promise<CommittedFile> {
    const source = await captureArtifactSource(file);
    return { ...Object.fromEntries(["format", "role", "documentKind", "outputMode", "expectedPages"].filter(name => Object.hasOwn(file, name)).map(name => [name, file[name]])), source: { path: source.path, sha256: source.sha256, bytes: source.bytes } };
  }
  async function files(): Promise<Map<string, FileRef>> {
    const result = new Map<string, FileRef>();
    const visit = async (path: string) => {
      let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      requireThat(!info.isSymbolicLink(), "EFFECT_PATH_ESCAPE", "Observed task/storage path contains a symlink");
      if (info.isDirectory()) { for (const name of await readdir(path)) await visit(join(path, name)); }
      else if (info.isFile()) { requireThat(result.size < 2048 && info.size <= 128 * 1024 * 1024, "EFFECT_OBSERVATION_LIMIT", "Observed files exceed the bounded effect budget"); const bytes = await readFile(path); result.set(path, { path, sha256: hash(bytes), bytes: bytes.length }); }
    };
    await visit(directory); await visit(journalDirectory); for (const path of storagePaths) await visit(path); for (const path of observedExternalPaths) await visit(path);
    return result;
  }
  async function effects(before: Map<string, FileRef>): Promise<Effects> {
    const after = await files(), changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path)?.sha256 !== after.get(path)?.sha256);
    return { observed: true, changed_paths: changed.filter(path => inside(directory, path)).map(path => portable(relative(directory, path))), outside_paths: changed.filter(path => !inside(directory, path)), artifacts: changed.filter(path => inside(directory, path) && after.has(path) && !path.endsWith(".json")).slice(0, 64).map(path => ({ id: portable(relative(directory, path)), sha256: after.get(path)!.sha256, bytes: after.get(path)!.bytes! })) };
  }
  async function immutable(path: string, content: string | Uint8Array): Promise<FileRef> {
    const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content), sha256 = hash(bytes);
    try { await writeFile(path, bytes, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; requireThat(hash(await readFile(path)) === sha256, "IMMUTABLE_FILE_CONFLICT", "An immutable task resource has different bytes"); }
    const handle = await open(path, "r+"); try { await handle.sync(); } finally { await handle.close(); }
    return { path, sha256, bytes: bytes.length };
  }
  async function durableOutcome(path: string, value: Data) {
    const temp = `${path}.outcome`;
    const handle = await open(temp, "wx");
    try { await handle.writeFile(canonical(value), "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
    requireThat(canonical(JSON.parse(await readFile(path, "utf8"))) === canonical(value), "OUTCOME_DURABILITY_FAILED", "Durable outcome reread differs from the committed result");
  }
  async function verifiedAttachments() {
    const result=[];
    for(const expected of attachmentSources) {
      const actual=await options.readAttachment!(expected.id);
      requireThat(actual.id === expected.id && actual.name === expected.name && actual.sourceHash === expected.sourceHash && hash(actual.text) === expected.textSha256,"ATTACHMENT_CAS_CONFLICT","Selected attachment changed or belongs to another scope");
      result.push(actual);
    }
    return result;
  }
  async function checkFrozenBaselines() {
    for (const [path,expected] of frozenBaseline) requireThat(resolve(await realpath(path)) === path && hash(await readFile(path)) === (published.get(path) ?? expected),"OUTPUT_CAS_CONFLICT","Frozen baseline source changed after task binding");
  }
  async function checkedDestination(path: string, bytes: Uint8Array) {
    const root = options.outputDirectory && inside(resolve(options.outputDirectory),path) ? resolve(options.outputDirectory) : options.materialRoot && inside(resolve(options.materialRoot),path) ? resolve(options.materialRoot) : null;
    requireThat(root && path !== root && resolve(await realpath(root)) === root,"OUTPUT_SCOPE_REQUIRED","Host destination escaped its private selected folder");
    let parent = resolve(path,"..");
    requireThat(resolve(await realpath(parent)) === parent,"OUTPUT_PATH_ESCAPE","Output parent contains a reparse escape");
    while(parent !== root) { requireThat(inside(root,parent) && !(await lstat(parent)).isSymbolicLink(),"OUTPUT_PATH_ESCAPE","Output parent escaped its selected folder"); parent=resolve(parent,".."); }
    try {
      requireThat(resolve(await realpath(path)) === path && (await lstat(path)).isFile(),"OUTPUT_PATH_ESCAPE","Existing output is not a physical file");
      const actual = hash(await readFile(path)), expected = frozenBaseline.get(path) ?? published.get(path);
      requireThat(actual === hash(bytes) || expected && actual === expected,"OUTPUT_CAS_CONFLICT","Existing output changed or was not explicitly frozen by Host");
    } catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; requireThat(!frozenBaseline.has(path),"OUTPUT_CAS_CONFLICT","A frozen output file was removed"); }
  }
  async function observeDestination(path: string) {
    if (observedExternalPaths.has(path)) return;
    observedExternalPaths.add(path);
    if (operationBaseline) try {const bytes=await readFile(path);operationBaseline.set(path,{path,sha256:hash(bytes),bytes:bytes.length});} catch(error) {if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
  }
  async function publishFile(path: string, bytes: Uint8Array, signal: AbortSignal) {
    await observeDestination(path);
    await checkedDestination(path,bytes); signal.throwIfAborted();
    const temporary = `${path}.course-${options.taskId}.new`;
    await observeDestination(temporary);
    await writeFile(temporary,bytes,{flag:"wx"});
    await checkedDestination(path,bytes); signal.throwIfAborted();
    await rename(temporary,path); published.set(path,hash(bytes));
    requireThat(hash(await readFile(path)) === hash(bytes),"OUTPUT_DURABILITY_FAILED","Published source bytes differ from the Host capture");
  }
  function assignmentDestination(file: ArtifactFile) {
    requireThat(file.role === "student" || file.role === "solution","ASSIGNMENT_ROLE_REQUIRED","Assignment files need a student or solution role");
    requireThat(options.outputDirectory && assignmentId,"ASSIGNMENT_OUTPUT_REQUIRED","Assignment files require an exact private output directory");
    const matches = (options.baselineFiles ?? []).filter(item=>item.role === file.role && item.format === file.format);
    requireThat(matches.length <= 1,"ASSIGNMENT_BASELINE_AMBIGUOUS","Select one exact existing source per Assignment role");
    const baseline = matches[0];
    return baseline ? resolve(baseline.path) : join(resolve(options.outputDirectory),basename(file.source!.path));
  }
  async function publishAssignmentFiles(committedFiles: CommittedFile[], signal: AbortSignal, authorize?: Invocation["authorize"]) {
    const captured = [];
    for(const file of committedFiles) { const source = await readSource(file.source!), destination = assignmentDestination(file); await checkedDestination(destination,Buffer.from(source.text)); captured.push({destination,bytes:Buffer.from(source.text)}); }
    requireThat(new Set(captured.map(item=>item.destination)).size === captured.length,"OUTPUT_DESTINATION_CONFLICT","Assignment sources resolve to the same file");
    for(const item of captured) { await authorize?.(); signal.throwIfAborted(); await publishFile(item.destination,item.bytes,signal); }
  }
  async function context(signal: AbortSignal) {
    const { state, semester, slot, lesson, deck, notes, assignment, materials, binding } = selected();
    const references = [];
    let excerptBudget = 12000;
    for (const material of materials) {
      signal.throwIfAborted();
      const bytes = material.metadata.storage === "local-link" ? await readLinkedCourseBuilderMaterialBytes(material) : Buffer.from(options.getHost().getMaterialBytes(options.sessionId, material.materialId));
      const source = {sha256:hash(bytes),bytes:bytes.length};
      const text = options.readMaterial ? await options.readMaterial(material) : material.metadata.storage === "local-link" ? await readLinkedCourseBuilderMaterial(material) : material.extractedText;
      requireThat(Buffer.byteLength(text) <= 32 * 1024 * 1024,"MATERIAL_TEXT_LIMIT","Selected extracted text exceeds 32 MiB");
      const textSource = await immutable(join(directory,`material-${hash(material.materialId).slice(0,12)}-${hash(text).slice(0,12)}.txt`),text);
      const excerptLength = Math.min(2000,excerptBudget,text.length); excerptBudget -= excerptLength;
      references.push({ materialId: material.materialId, name: material.name, kind: material.kind, recordSourceHash: material.sourceHash, source, text:text.slice(0,excerptLength), textSha256:hash(text), textSource, workspaceTextPath:portable(relative(directory,textSource.path)), textWindow:{offset:0,length:excerptLength,totalCharacters:text.length,truncated:excerptLength < text.length}, reading:"Read task-specific windows from workspaceTextPath with read_workspace; the frozen sidecar contains the full selected reference text." });
    }
    const attachments=[];
    for(const attachment of await verifiedAttachments()) {
      requireThat(Buffer.byteLength(attachment.text) <= 32 * 1024 * 1024,"ATTACHMENT_TEXT_LIMIT","Selected attachment extracted text exceeds 32 MiB");
      const source=await immutable(join(directory,`attachment-${attachment.id}-${hash(attachment.text).slice(0,12)}.txt`),attachment.text);
      const excerptLength=Math.min(2000,excerptBudget,attachment.text.length);excerptBudget-=excerptLength;
      attachments.push({id:attachment.id,name:attachment.name,sourceHash:attachment.sourceHash,textSha256:hash(attachment.text),source,workspaceTextPath:portable(relative(directory,source.path)),text:attachment.text.slice(0,excerptLength),textWindow:{offset:0,length:excerptLength,totalCharacters:attachment.text.length,truncated:excerptLength < attachment.text.length}});
    }
    const assets = [];
    if (deck && ["deck","teacher-notes","bundle"].includes(kind)) {
      await mkdir(join(directory,"assets"),{recursive:true});
      for(const id of deck.assetMaterialIds) {
        const material = options.getHost().getMaterial(options.sessionId,id), extension = /[.](png|jpe?g|pdf)$/iu.exec(material.name)?.[1]?.toLowerCase();
        requireThat(extension,"UNSUPPORTED_ASSET","Published deck assets must be PNG/JPEG/PDF");
        const source = await immutable(join(directory,"assets",`${id}.${extension}`),options.getHost().getMaterialBytes(options.sessionId,id));
        assets.push({name:material.name,source,workspacePath:portable(relative(directory,source.path))});
      }
    }
    const artifactSource = deck ? await immutable(join(directory, `current-${deck.deckId}-${deck.revision}.tex`), deck.source) : null;
    const notesSource = notes ? await immutable(join(directory, `current-${notes.notesId}-${notes.revision}.tex`), notes.source) : null;
    const baselineFiles = [];
    for (const file of [...(options.baselineFiles ?? []),...(options.repairBaselineFiles ?? [])]) {
      const path = resolve(file.path), root = assignment ? options.outputDirectory : options.materialRoot;
      requireThat(root && inside(resolve(root), path) && resolve(await realpath(path)) === path, "BASELINE_SCOPE_REQUIRED", "Baseline source must belong to the private selected output or material directory");
      const bytes = await readFile(path); requireThat(bytes.length <= 2097152, "SOURCE_LIMIT", "Baseline source exceeds 2 MiB");
      const source = await immutable(join(directory, `baseline-${hash(path).slice(0,12)}-${hash(bytes).slice(0,12)}${extname(path)}`), bytes);
      requireThat((published.get(path) ?? frozenBaseline.get(path)) === hash(bytes),"OUTPUT_CAS_CONFLICT","Baseline source changed after task binding");
      baselineFiles.push({ format: file.format, ...(file.role ? {role:file.role} : {}), source, workspacePath: portable(relative(directory, source.path)) });
    }
    signal.throwIfAborted();
    requireThat(selected().binding.sha256 === binding.sha256, "CAS_CONFLICT", "Course state changed while freezing task context");
    const lessonApproved = Boolean(lesson?.status === "approved" && lesson.semesterPlanId === semester?.semesterPlanId && lesson.semesterPlanRevision === semester?.revision);
    const frozenProduct = async (name:string,product:unknown,summary:Data) => {
      if(!product) return null;
      const body=canonical(product); if(Buffer.byteLength(body) <= 16000) return product;
      const source=await immutable(join(directory,`baseline-${name}-${hash(body).slice(0,12)}.json`),body);
      return {...summary,source,workspacePath:portable(relative(directory,source.path)),reading:"Read relevant baseline windows from the frozen product file; omitted fields are preserved by Host."};
    };
    const lessonContext=await frozenProduct("lesson",lesson,{lessonPlanId:lesson?.lessonPlanId,title:lesson?.title,revision:lesson?.revision,status:lesson?.status});
    const assignmentContext=await frozenProduct("assignment",assignment,{assignmentId:assignment?.assignmentId,title:assignment?.title,brief:assignment?.brief,revision:assignment?.revision,status:assignment?.status});
    const semesterContext=semester ? kind === "semester" ? await frozenProduct("semester",{title:semester.title,rationale:semester.rationale,sessions:semester.sessions,revision:semester.revision,status:semester.status},{title:semester.title,revision:semester.revision,status:semester.status,sessionCount:semester.sessions.length}) : {revision:semester.revision,status:semester.status,session:slot} : null;
    const course = Object.fromEntries(projectSettingNames.map(name => [name, state.project[name]]));
    if (assignment) course.assignmentPreamble = state.project.assignmentPreamble;
    let materialManifest: Data | null = null;
    let materialContext = references;
    if(references.length > 32 || Buffer.byteLength(canonical(references)) > 32000) {
      const source=await immutable(join(directory,`selected-material-manifest-${hash(canonical(references)).slice(0,12)}.json`),canonical(references));
      materialManifest={count:references.length,source,workspacePath:portable(relative(directory,source.path)),reading:"The full selected manifest is frozen here; read relevant windows. Context includes only the first 16 preview entries."};
      materialContext=references.slice(0,16);
    }
    const semanticContract = { draftSchema:courseWorkflowSemanticSchema(kind), firstDraftRequired:Object.keys(courseWorkflowSemanticSchema(kind).properties).filter(name=>name !== "materialIndexes"),firstSemesterSessionRequired:kind === "semester" ? Object.keys(jsonRecord(jsonRecord(courseWorkflowSemanticSchema("semester").properties.sessions.items).properties)) : null, revisionMode:"Only provide changed semantic fields; Host preserves omitted fields from the frozen current product. Semester sessions align to Host slot order; coverage aligns to selected material order.", revisitBinding:kind === "semester" ? "Author human concept labels in revisits; Host derives course-scoped concept IDs. Omitted revisits preserve frozen existing IDs; never copy conceptId." : null, kind, commitKind: kind.startsWith("assignment") ? "assignment" : kind, draftFields: kind === "semester" ? ["title","rationale","sessions"] : kind === "lesson" || kind === "bundle" ? ["title","objectives","prerequisites","misconceptions","segments","examples","exercises","visualRequests","notes"] : kind.startsWith("assignment") ? ["overview","tasks","deliverables","rubric","solutionNotes"] : [], hostOwned: ["identities","materialIds","status","review","revisions","hashes"], sourcePaths: "Author new files only beneath sources/; Host captures identities. Return paths, never copy context hashes.", stateOnly: ["analysis","checkpoint","semester","lesson","assignment-plan"].includes(kind), assignmentFileRoles: kind === "assignment-artifacts" ? {student:"tex",solution:"rmd"} : null };
    return { taskId: options.taskId, binding, context: { kind, semanticContract, course, semester:semesterContext, lesson:lessonContext, assignment:assignmentContext, materials:materialContext, materialManifest, materialIndexPath:materialManifest?.workspacePath ?? null, materialCount:references.length, attachments, currentArtifact: deck ? { deckId:deck.deckId,title:deck.title,revision:deck.revision,frameOutline:deck.frameOutline,assetMaterialIds:deck.assetMaterialIds,source:artifactSource,workspacePath:portable(relative(directory,artifactSource!.path)) } : null, currentNotes: notes ? {title:notes.title,revision:notes.revision,source:notesSource,workspacePath:portable(relative(directory,notesSource!.path))} : null, baselineFiles, assets, artifactDirectory:directory, prerequisites:{semesterApproved:semester?.status === "approved",lessonApproved,canSaveDomainDeck:lessonApproved}, teacherReviewPending:!lessonApproved, experimentalArtifactsAllowed:true } };
  }

  async function commit(input: DomainInput, signal: AbortSignal, authorize?: Invocation["authorize"]): Promise<Data> {
    const current = selected();
    for(const material of current.materials) current.host.getMaterialBytes(options.sessionId,material.materialId);
    await verifiedAttachments();
    await checkFrozenBaselines();
    requireThat(input.bindingSha256 === current.binding.sha256, "CAS_CONFLICT", "The task CAS binding is stale; refresh context explicitly");
    signal.throwIfAborted();
    const expectedKind = kind.startsWith("assignment") ? "assignment" : kind;
    requireThat(options.kind === undefined || input.kind === expectedKind, "TASK_KIND_MISMATCH", "Commit kind differs from the private selected task product");
    const semanticRevisits = (revisits: unknown) => {
      requireThat(Array.isArray(revisits) && revisits.length <= 100,"SEMANTIC_REVISITS_REQUIRED","Provide bounded semantic concept revisits");
      return revisits.map(item=>{
        requireThat(item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).every(name=>["concept","progression","note"].includes(name)),"HOST_OWNED_FIELDS","Revisit identities are Host-owned; supply only concept, progression and note");
        requireThat(typeof item.concept === "string" && item.concept.trim().length > 0 && item.concept.length <= 4096,"SEMANTIC_REVISITS_REQUIRED","Each new revisit needs a human concept label");
        const concept=item.concept.normalize("NFC").trim().replace(/\s+/gu," ").toLowerCase();
        return {conceptId:`concept_${hash(canonical({projectId:current.state.project.projectId,concept}))}`,progression:item.progression,note:item.note};
      });
    };
    const selectedMaterials = (indexes: unknown) => {
      requireThat(Array.isArray(indexes) && indexes.length <= 100 && new Set(indexes).size === indexes.length && indexes.every(index=>Number.isInteger(index) && index >= 0 && index < options.materialIds.length),"MATERIAL_SELECTION_REQUIRED","materialIndexes must select distinct entries from this task's frozen selected manifest");
      return indexes.map(index=>options.materialIds[index]);
    };
    const lessonContent = (draft: SemanticDraft) => {
      const {materialIndexes,...semantic} = draft;
      const existing = current.lesson ? Object.fromEntries(lessonFieldNames.map(name=>[name,current.lesson![name]])) : {};
      return {...existing,...semantic,...(semantic.segments ? {segments:semantic.segments.map((item:Data)=>({...item,checkForUnderstanding:item.checkForUnderstanding === "" ? null : item.checkForUnderstanding ?? null}))} : {}),week,session,materialIds:materialIndexes ? selectedMaterials(materialIndexes) : current.lesson?.materialIds ?? current.slot?.materialIds.filter(id=>options.materialIds.includes(id)) ?? []};
    };
    const assertDraft = (draft: SemanticDraft | undefined, draftKind: CourseWorkflowKind) => {
      requireThat(draft && typeof draft === "object" && !Array.isArray(draft), "SEMANTIC_DRAFT_REQUIRED", "Provide a semantic draft object");
      const allowed = Object.keys(courseWorkflowSemanticSchema(draftKind).properties);
      requireThat(Object.keys(draft).every(name => allowed.includes(name)), "HOST_OWNED_FIELDS", "Draft contains a Host-owned or unknown field");
    };
    const checkWrite = async () => {
      requireThat(storagePaths.length > 0 || options.inMemoryFixture, "STORAGE_OBSERVATION_REQUIRED", "Authoritative storage paths are required before a course write");
      await authorize?.(); signal.throwIfAborted();
      requireThat(selected().binding.sha256 === current.binding.sha256, "CAS_CONFLICT", "Course changed while authorizing the write");
    };
    if (["analysis", "checkpoint", "semester", "assignment"].includes(input.kind ?? "")) {
      const draftKind = input.kind === "assignment" ? kind : input.kind!;
      if (input.draft) assertDraft(input.draft, draftKind);
      const committedFiles: CommittedFile[] = [];
      for (const file of input.files ?? []) committedFiles.push(await normalizeCommittedFile({...file,...(file.role === "student" ? {documentKind:"assignment"} : {})}));
      if (input.kind !== "assignment") requireThat(committedFiles.length === 0, "STATE_ONLY_FILES", "This product saves a state draft without source artifacts");
      if (input.kind === "assignment") {
        requireThat(current.assignment, "ASSIGNMENT_TARGET_REQUIRED", "Assignment commits need a bound Assignment target");
        if (kind === "assignment-plan") requireThat(input.draft && committedFiles.length === 0, "ASSIGNMENT_PLAN_REQUIRED", "Assignment planning saves only a semantic draft");
        if (kind === "assignment-artifacts") requireThat(committedFiles.length === 2 && committedFiles.some(file=>file.role === "student" && file.format === "tex") && committedFiles.some(file=>file.role === "solution" && file.format === "rmd"), "ASSIGNMENT_FILES_REQUIRED", "Provide exactly one student TeX and one solution Rmd source");
        requireThat(input.draft || committedFiles.length > 0, "ASSIGNMENT_DRAFT_REQUIRED", "Provide a plan or Assignment artifacts");
      } else requireThat(input.draft, "SEMANTIC_DRAFT_REQUIRED", "This product requires a semantic draft");
      if (input.kind === "semester" && !input.draft!.sessions && current.semester) input = {...input,draft:{...input.draft,sessions:current.semester.sessions.map(()=>({}))}};
      if (input.kind === "semester") requireThat(Array.isArray(input.draft!.sessions) && input.draft!.sessions!.length === current.state.project.weeks * current.state.project.sessionsPerWeek && input.draft!.sessions!.every((slot:Data)=>slot && Object.keys(slot).every(name=>Object.hasOwn(jsonRecord(jsonRecord(courseWorkflowSemanticSchema("semester").properties.sessions.items).properties),name)) && (!slot.goalIndexes || Array.isArray(slot.goalIndexes) && slot.goalIndexes.every((index:number)=>Number.isInteger(index) && index >= 0 && index < current.state.project.goals.length))), "HOST_OWNED_FIELDS", "Semester material IDs are Host-owned");
      if(input.kind === "semester") for(const slot of input.draft!.sessions!) if(slot.materialIndexes) selectedMaterials(slot.materialIndexes);
      if(input.kind === "semester" && !current.semester) requireThat(input.draft!.sessions!.every((slot:Data)=>Object.hasOwn(slot,"materialIndexes")),"MATERIAL_SELECTION_REQUIRED","Each first-draft semester session requires materialIndexes; [] means no selected source for this slot");
      if (input.kind === "checkpoint") {
        if (!input.draft!.coverage && current.checkpoint) input = {...input,draft:{...input.draft,coverage:current.materials.map(material=>{const existing=current.checkpoint!.coverage.find(item=>item.materialId===material.materialId); requireThat(existing,"COVERAGE_SCOPE_REQUIRED","New material needs explicit coverage semantic content"); return {summary:existing.summary,position:existing.position,nextLesson:existing.nextLesson};})}};
        requireThat(current.lesson, "LESSON_TARGET_REQUIRED", "Coverage needs a current lesson");
        requireThat(Array.isArray(input.draft!.coverage) && input.draft!.coverage!.length === current.materials.length && input.draft!.coverage!.every((file:Data)=>Object.keys(file).every(name=>["summary","position","nextLesson"].includes(name))), "COVERAGE_SCOPE_REQUIRED", "Coverage entries align one-to-one with selected materials; Host assigns IDs/hashes");
      }
      if (input.kind === "analysis") {
        const all = current.state.materials.filter(item=>item.metadata.storage === "local-link" && item.metadata.materialScope !== "assignment").map(item=>item.materialId).sort();
        requireThat(canonical(all) === canonical([...options.materialIds].sort()), "ANALYSIS_SELECTION_REQUIRED", "Host source analysis covers the linked course library; explicitly select every linked course reference");
      }
      if (input.kind === "assignment" && committedFiles.length) for(const file of committedFiles) { const source = await readSource(file.source!); await checkedDestination(assignmentDestination(file),Buffer.from(source.text)); }
      await checkWrite();
      let product: unknown;
      if (input.kind === "semester") product = current.host.saveSemesterPlan(options.sessionId,{...(current.semester ? {title:current.semester.title,rationale:current.semester.rationale} : {}),...input.draft,sessions:input.draft!.sessions!.map(({goalIndexes,materialIndexes,...slot}:SemanticSession,index:number)=>{ const baseline = current.semester?.sessions[index]; return {...baseline,...slot,...(Object.hasOwn(slot,"revisits") ? {revisits:semanticRevisits(slot.revisits)} : {}),week:Math.floor(index/current.state.project.sessionsPerWeek)+1,session:index%current.state.project.sessionsPerWeek+1,assessment:slot.assessment === "" ? null : slot.assessment ?? baseline?.assessment ?? null,homework:slot.homework === "" ? null : slot.homework ?? baseline?.homework ?? null,courseGoalsCovered:goalIndexes ? goalIndexes.map((goal:number)=>current.state.project.goals[goal]) : baseline?.courseGoalsCovered ?? [],materialIds:materialIndexes ? selectedMaterials(materialIndexes) : baseline?.materialIds ?? []}; })},current.binding.semesterRevision);
      else if (input.kind === "analysis") product = current.host.saveMaterialAnalysis(options.sessionId,{...Object.fromEntries(analysisFieldNames.map(name=>[name,current.state.materialAnalysis?.[name]])),...input.draft});
      else if (input.kind === "checkpoint") product = current.host.saveCoverageCheckpoint(options.sessionId,{...(current.checkpoint ? Object.fromEntries((["completed","remaining","nextLesson"] as const).map(name=>[name,current.checkpoint![name]])) : {}),...input.draft,lessonPlanId:current.lesson!.lessonPlanId,lessonRevision:current.lesson!.revision,deckId:current.deck?.deckId ?? null,deckRevision:current.deck?.revision ?? null,coverage:input.draft!.coverage!.map((file:Data,index:number)=>({...file,materialId:current.materials[index].materialId,sourceHash:current.materials[index].sourceHash}))},current.checkpoint?.revision ?? 0);
      else product = input.draft ? current.host.saveAssignmentDraft(options.sessionId,assignmentId!,{...current.assignment!.draft,...input.draft,materialIds:options.materialIds},current.assignment!.revision) : current.assignment;
      if (input.kind === "assignment" && committedFiles.length) await publishAssignmentFiles(committedFiles,signal,authorize);
      return {taskId:options.taskId,kind:input.kind,product,files:committedFiles,binding:selected().binding,teacherReviewPending:input.kind !== "analysis",succeeded:true};
    }
    if (input.kind === "bundle") {
      requireThat(Array.isArray(input.files) && input.files.length > 0 && input.files.length <= 8, "ARTIFACT_FILES_REQUIRED", "A bundle needs 1..8 new artifact paths or exact source references");
      // Validate every source before the one synchronous domain write; an invalid file never partially saves a lesson.
      const committedFiles: CommittedFile[] = [];
      for (const file of input.files) committedFiles.push(await normalizeCommittedFile(file));
      signal.throwIfAborted();
      requireThat(selected().binding.sha256 === current.binding.sha256, "CAS_CONFLICT", "Course changed while capturing the bundle's source bytes");
      // A bundle may persist its lesson through the same guarded write without changing the private product kind.
      let lessonResult: {lesson: ReturnType<CourseBuilderHost["saveLessonPlan"]>} | null = null;
      if (input.lessonDraft || input.draft) {
        const draft = input.lessonDraft ?? input.draft; assertDraft(draft,"lesson"); requireThat(draft,"SEMANTIC_DRAFT_REQUIRED","Provide a semantic lesson draft"); await checkWrite();
        const lesson = current.host.saveLessonPlan(options.sessionId,lessonContent(draft),current.binding.lessonRevision,current.semester!.revision);
        lessonResult = {lesson};
      }
      const nextBinding = selected().binding;
      const receipt = { taskId: options.taskId, kind: "bundle", lesson: lessonResult?.lesson ?? current.lesson, files: committedFiles, binding: nextBinding, teacherReviewPending: true, succeeded: true };
      await immutable(join(directory, `experiment-${input.requestId}.json`), canonical(receipt));
      return receipt;
    }
    if (input.kind === "lesson") {
      requireThat(storagePaths.length > 0 || options.inMemoryFixture, "STORAGE_OBSERVATION_REQUIRED", "Authoritative storage paths are required before a course write");
      assertDraft(input.draft, "lesson");
      requireThat(input.draft,"SEMANTIC_DRAFT_REQUIRED","Provide a semantic lesson draft");
      const forbidden = ["week", "session", "projectId", "lessonPlanId", "materialIds", "status", "review", "approved"];
      requireThat(input.draft && forbidden.every(name => !(name in input.draft!)), "HOST_OWNED_FIELDS", "Lesson draft contains Host-owned identity, reference or approval fields");
      const existing = current.lesson ? Object.fromEntries(lessonFieldNames.map(name => [name, current.lesson![name]])) : {};
      await authorize?.(); signal.throwIfAborted();
      requireThat(selected().binding.sha256 === current.binding.sha256, "CAS_CONFLICT", "Course changed while authorizing the write");
      const lesson = current.host.saveLessonPlan(options.sessionId, lessonContent(input.draft), current.binding.lessonRevision, current.semester!.revision);
      return { taskId: options.taskId, kind: "lesson", lesson, files: [], succeeded: true, binding: selected().binding, teacherReviewPending: true };
    }
    requireThat(["deck","teacher-notes","experiment","rmd","html"].includes(input.kind ?? ""), "COMMIT_KIND_REQUIRED", "Unknown artifact commit kind");
    const file = input.files?.length === 1 ? input.files[0] : input;
    requireThat(!input.files || input.files.length === 1, "ARTIFACT_FILES_REQUIRED", "This product requires exactly one source file");
    const format = ["deck","teacher-notes"].includes(input.kind ?? "") ? "tex" : input.kind === "html" ? "html" : input.kind === "rmd" ? "rmd" : file.format;
    requireThat(file.format === undefined || file.format === format, "ARTIFACT_FORMAT_MISMATCH", "Source format differs from the product");
    const source = await captureArtifactSource({...file,format}); signal.throwIfAborted();
    const committedFile = await normalizeCommittedFile({...file,format,...(input.kind === "teacher-notes" ? {documentKind:"teacher-notes"} : input.kind === "deck" ? {documentKind:"beamer"} : {})});
    requireThat(committedFile.source.sha256 === source.sha256, "SOURCE_HASH_MISMATCH", "Artifact changed while capturing its source");
    requireThat(selected().binding.sha256 === current.binding.sha256, "CAS_CONFLICT", "Course state changed while reading the submitted source");
    if (["experiment","rmd"].includes(input.kind ?? "")) {
      const receipt = {taskId:options.taskId,kind:input.kind,format,source:committedFile.source,files:[committedFile],binding:current.binding,teacherReviewPending:true,succeeded:true};
      await immutable(join(directory,`experiment-${input.requestId}.json`),canonical(receipt)); return receipt;
    }
    if (input.kind === "teacher-notes") {
      requireThat(current.deck, "DECK_TARGET_REQUIRED", "Teacher notes require an existing current deck"); await checkWrite();
      const notes = current.host.saveTeacherNotes(options.sessionId,{deckId:current.deck.deckId,deckRevision:current.deck.revision,title:input.title ?? current.notes?.title ?? current.deck.title,source:source.text},current.binding.notesRevision);
      return {taskId:options.taskId,kind:input.kind,product:notes,files:[committedFile],source:committedFile.source,binding:selected().binding,teacherReviewPending:true,succeeded:true};
    }
    if (input.kind === "html") {
      requireThat(current.lesson && options.materialRoot, "HTML_DESTINATION_REQUIRED", "Interactive HTML requires a lesson and the teacher-selected course material folder");
      const validation = validateStandaloneInteractiveVisual(Buffer.from(source.text),basename(source.path));
      const root = resolve(options.materialRoot);
      requireThat(current.state.materials.some(material=>material.metadata.materialScope !== "assignment" && material.metadata.sourceRoot === root), "MATERIAL_ROOT_REQUIRED", "HTML destination must be an already linked selected course folder");
      requireThat(resolve(await realpath(root)) === root, "MATERIAL_ROOT_ESCAPE", "Selected material folder contains a reparse escape");
      const baselines = (options.baselineFiles ?? []).filter(file=>file.format === "html");
      requireThat(baselines.length <= 1,"HTML_BASELINE_AMBIGUOUS","Select one exact current HTML destination");
      const destination = baselines[0] ? resolve(baselines[0].path) : join(root,basename(source.path));
      requireThat(inside(root,destination),"HTML_DESTINATION_ESCAPE","HTML baseline destination escaped its selected material folder");
      await checkWrite();
      await publishFile(destination,Buffer.from(source.text),signal);
      const described = await describeCourseBuilderLocalFile(root,destination);
      const existing = current.state.materials.find(material=>material.metadata.materialScope !== "assignment" && material.metadata.sourcePath === destination);
      await authorize?.(); signal.throwIfAborted();
      requireThat(selected().binding.sha256 === current.binding.sha256, "CAS_CONFLICT", "Course changed during HTML publication");
      const material = existing ? current.host.syncLocalMaterials(options.sessionId,root,[described],current.state.project.revision)[0] : current.host.importMaterials(options.sessionId,[described],current.state.project.revision)[0];
      const linkedValidation = await validateLinkedInteractiveVisual(material);
      requireThat(linkedValidation.sourceHash === validation.sourceHash, "SOURCE_HASH_MISMATCH", "Registered HTML differs from validated source");
      await authorize?.(); signal.throwIfAborted();
      const visual = current.host.createInteractiveVisual(options.sessionId,current.lesson.lessonPlanId,{materialId:material.materialId,title:input.title ?? validation.title},input.purpose ?? input.title ?? validation.title,linkedValidation);
      return {taskId:options.taskId,kind:input.kind,product:visual,files:[committedFile],source:committedFile.source,binding:selected().binding,teacherReviewPending:true,succeeded:true};
    }
    requireThat(storagePaths.length > 0 || options.inMemoryFixture, "STORAGE_OBSERVATION_REQUIRED", "Authoritative storage paths are required before a course write");
    requireThat(current.lesson?.status === "approved", "LESSON_APPROVAL_REQUIRED", "Only genuine teacher-approved lessons may receive domain decks; use experiment artifacts while pending");
    await authorize?.(); signal.throwIfAborted();
    requireThat(selected().binding.sha256 === current.binding.sha256, "CAS_CONFLICT", "Course changed while authorizing the write");
    const deck = current.host.saveBeamerDeck(options.sessionId, { lessonPlanId: current.lesson.lessonPlanId, title: input.title ?? current.deck?.title, source: source.text, frameOutline: input.frameOutline ?? current.deck?.frameOutline, assetMaterialIds: current.deck?.assetMaterialIds ?? [] }, current.binding.artifactRevision, current.lesson.revision);
    return { taskId: options.taskId, kind: "deck", files: [committedFile], succeeded: true, artifact: { deckId: deck.deckId, revision: deck.revision, sourceHash: deck.sourceHash }, source: { path: source.path, sha256: source.sha256, bytes: source.bytes }, binding: selected().binding, teacherReviewPending: true };
  }
  async function compile(input: DomainInput, signal: AbortSignal, authorize?: Invocation["authorize"]) {
    const current = selected();
    for(const material of current.materials) current.host.getMaterialBytes(options.sessionId,material.materialId);
    await verifiedAttachments();
    await checkFrozenBaselines();
    requireThat(current.binding.sha256 === input.bindingSha256, "CAS_CONFLICT", "Compile binding is stale");
    if (input.format === "html") {
      const source = await readSource(input.source!); const validation = validateStandaloneInteractiveVisual(Buffer.from(source.text),basename(source.path));
      requireThat(selected().binding.sha256 === current.binding.sha256,"CAS_CONFLICT","Course changed during HTML validation");
      return {taskId:options.taskId,source:input.source,output:input.source,validation,format:"html",binding:current.binding,teacherReviewPending:true,succeeded:true};
    }
    requireThat(options.trustedExecution === true, "TRUSTED_EXECUTION_REQUIRED", "Local source execution must be explicitly enabled by the private Host owner");
    const source = await readSource(input.source!);
    requireThat(extname(source.path).toLowerCase() === (input.format === "tex" ? ".tex" : ".rmd"), "ARTIFACT_FORMAT_MISMATCH", "Compile format and source extension differ");
    const outputStem = join(directory, `compiled-${input.requestId}`);
    // Windows R/native package loading requires the actual platform architecture.
    const executionEnv: NodeJS.ProcessEnv = { ...Object.fromEntries(["PATH", "SYSTEMROOT", "WINDIR", "PROCESSOR_ARCHITECTURE", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "R_LIBS_USER", "R_LIBS_SITE", "R_HOME", "RSTUDIO_PANDOC"].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])), NODE_ENV: process.env.NODE_ENV ?? "production" };
    Object.assign(executionEnv, { HOME: directory, TMPDIR: directory, TEMP: directory, TMP: directory });
    let output: FileRef, log: string, pageCount: number | null = null, domainReceipt: Awaited<ReturnType<CourseBuilderHost["compileTeacherNotes"]>> | ReturnType<CourseBuilderHost["recordCompile"]> | null = null;
    let preflightRef: FileRef;
    let hostCompile: Awaited<ReturnType<typeof compileBeamerDeck>> | null = null;
    if (input.format === "tex") {
      const compiler = options.compiler ?? process.env.PI_XELATEX_PATH ?? "xelatex";
      const preflight = await runBoundedProcess({ command: compiler, args: ["--version"], cwd: directory, env: executionEnv, timeoutMs: 10000, maxOutputBytes: 65536, signal });
      preflightRef = await immutable(`${outputStem}.preflight.log`, `exitCode=${preflight.exitCode}\n${preflight.stdout}\n${preflight.stderr}`);
      requireThat(preflight.exitCode === 0, "TEX_PREFLIGHT_FAILED", `exitCode=${preflight.exitCode}; ${preflight.stdout.slice(-2048)} ${preflight.stderr.slice(-2048)}; inspect ${preflightRef.path}`);
      const exactCurrentDeck = current.deck?.sourceHash === `sha256:${source.sha256}` && (input.documentKind ?? "beamer") === "beamer";
      if (exactCurrentDeck) {
        requireThat(storagePaths.length > 0 || options.inMemoryFixture, "STORAGE_OBSERVATION_REQUIRED", "Authoritative storage paths are required before recording a domain compile");
        hostCompile = await compileBeamerDeck({ ...current.host.getDeckForCompile(options.sessionId, current.deck!.deckId), compiler, signal, workDirectory: directory });
      }
      const exactNotes = input.documentKind === "teacher-notes" && current.notes?.sourceHash === `sha256:${source.sha256}`;
      let notesResult: (Awaited<ReturnType<CourseBuilderHost["compileTeacherNotes"]>> & {pdfBytes: Uint8Array | null; log: string}) | null = null;
      if (exactNotes) {
        requireThat(storagePaths.length > 0 || options.inMemoryFixture,"STORAGE_OBSERVATION_REQUIRED","Native notes compile receipts need observed storage");
        const notesReceipt = await current.host.compileTeacherNotes(options.sessionId,current.notes!.notesId,current.notes!.revision,{trustedTex:true,compiler,signal,workDirectory:directory,env:executionEnv,assertActive:async()=>{await authorize?.();signal.throwIfAborted();requireThat(selected().binding.sha256 === current.binding.sha256,"CAS_CONFLICT","Notes/deck changed during compilation");}});
        domainReceipt = notesReceipt;
        notesResult = {...notesReceipt,pdfBytes:notesReceipt.succeeded ? current.host.getTeacherNotesPdf(options.sessionId,notesReceipt.receiptId) : null,log:current.host.getTeacherNotesCompileLog(options.sessionId,notesReceipt.receiptId)};
      }
      const result = notesResult ?? (hostCompile ? { ...hostCompile.receipt, pdfBytes: hostCompile.artifact?.pdfBytes ?? null, log: hostCompile.log } : await compileLatexDocument({ source: source.text, sourceHash: `sha256:${source.sha256}`, documentKind: input.documentKind === "assignment" ? "teacher-notes" : input.documentKind ?? "beamer", compiler, signal, workDirectory: directory, assets:current.deck?.assetMaterialIds.map(id=>{const material=current.host.getMaterial(options.sessionId,id),extension=/[.](png|jpe?g|pdf)$/iu.exec(material.name)?.[1]?.toLowerCase();return {path:`assets/${id}.${extension}`,bytes:current.host.getMaterialBytes(options.sessionId,id),contentHash:material.sourceHash};}) }));
      log = result.log; const logRef = await immutable(`${outputStem}.log`, log);
      requireThat(result.succeeded && result.pdfBytes && result.pageCount, "COMPILE_FAILED", `XeLaTeX did not produce a passing PDF; inspect ${logRef.path}`);
      requireThat(input.expectedPages === undefined || input.expectedPages === result.pageCount, "PDF_PAGE_COUNT_MISMATCH", `Expected ${input.expectedPages} pages, observed ${result.pageCount}; inspect ${logRef.path}`);
      output = await immutable(`${outputStem}.pdf`, result.pdfBytes); pageCount = result.pageCount;
    } else {
      requireThat(input.format === "rmd", "ARTIFACT_FORMAT_REQUIRED", "Unknown compile format");
      const rscript = options.rscript ?? "Rscript";
      const render = input.outputMode === "render";
      const expression = `stopifnot(requireNamespace("knitr",quietly=TRUE),requireNamespace("rmarkdown",quietly=TRUE)); ${render ? 'stopifnot(rmarkdown::pandoc_available());' : ''} cat(as.character(getRversion()),"\\n",as.character(packageVersion("knitr")),"\\n",as.character(packageVersion("rmarkdown")),"\\n")`;
      const preflight = await runBoundedProcess({ command: rscript, args: ["--vanilla", "-e", expression], cwd: directory, env: executionEnv, timeoutMs: 10000, maxOutputBytes: 65536, signal });
      preflightRef = await immutable(`${outputStem}.preflight.log`, `exitCode=${preflight.exitCode}\n${preflight.stdout}\n${preflight.stderr}`);
      requireThat(preflight.exitCode === 0, "RMD_PREFLIGHT_FAILED", `exitCode=${preflight.exitCode}; ${preflight.stdout.slice(-2048)} ${preflight.stderr.slice(-2048)}; inspect ${preflightRef.path}`);
      const outPath = `${outputStem}.${render ? "html" : "md"}`;
      const rQuote = (value: string) => JSON.stringify(portable(value));
      const program = render ? `rmarkdown::render(${rQuote(source.path)}, output_format="html_document", output_file=${rQuote(basename(outPath))}, output_dir=${rQuote(directory)}, quiet=TRUE, envir=new.env());` : `knitr::knit(${rQuote(source.path)}, output=${rQuote(outPath)}, quiet=TRUE, envir=new.env());`;
      const runner = await immutable(`${outputStem}.R`, `setwd(${rQuote(directory)}); ${program} stopifnot(file.exists(${rQuote(outPath)})); cat("COURSE_RMD_EXECUTED_OK\\n")\n`);
      const result = await runBoundedProcess({ command: rscript, args: ["--vanilla", runner.path], cwd: directory, env: executionEnv, timeoutMs: 240000, maxOutputBytes: 2097152, signal });
      log = `${result.stdout}\n${result.stderr}`; const logRef = await immutable(`${outputStem}.log`, log);
      requireThat(result.exitCode === 0 && !result.timedOut && !result.outputLimited && result.stdout.includes("COURSE_RMD_EXECUTED_OK"), "RMD_EXECUTION_FAILED", `R Markdown execution failed; inspect ${logRef.path}`);
      output = await readSource({ path: outPath, sha256: hash(await readFile(outPath)) });
      output = { path: output.path, sha256: output.sha256, bytes: output.bytes };
    }
    signal.throwIfAborted();
    requireThat((await readSource(input.source!)).sha256 === source.sha256 && selected().binding.sha256 === current.binding.sha256, "CAS_CONFLICT", "Source or course state changed during compilation");
    if (hostCompile) {
      await authorize?.(); signal.throwIfAborted();
      requireThat(selected().binding.sha256 === current.binding.sha256, "CAS_CONFLICT", "Course changed while authorizing its compile receipt");
      domainReceipt = current.host.recordCompile(options.sessionId, hostCompile.receipt, hostCompile.artifact, hostCompile.log);
    }
    return { taskId: options.taskId, source: { path: source.path, sha256: source.sha256, bytes: source.bytes }, output, preflight: preflightRef, log: { path: `${outputStem}.log`, sha256: hash(log), bytes: Buffer.byteLength(log) }, pageCount, format: input.format, outputMode: input.format === "rmd" ? input.outputMode ?? "knit" : "pdf", binding: selected().binding, domainReceipt, teacherReviewPending: true, succeeded: true };
  }
  async function compileRequested(input: DomainInput, signal: AbortSignal, authorize?: Invocation["authorize"]) {
    const files = input.files ?? (input.source && input.format ? [{ source: input.source, format: input.format, documentKind: input.documentKind, outputMode: input.outputMode, expectedPages: input.expectedPages }] : null);
    requireThat(Array.isArray(files) && files.length <= 8, "ARTIFACT_FILES_REQUIRED", "Validation needs 0..8 exact source references");
    requireThat(selected().binding.sha256 === input.bindingSha256,"CAS_CONFLICT","Validation binding is stale");
    if (options.kind) {
      let matched = false;
      for(const name of await readdir(journalDirectory)) {
        if (!/^request-[a-zA-Z0-9_-]+[.]json$/u.test(name)) continue;
        const saved = parseRecord(await readFile(join(journalDirectory,name),"utf8"));
        if(saved.taskHash === taskHash && saved.status === "completed" && isRecord(saved.output) && saved.output.kind && isRecord(saved.output.binding) && saved.output.binding.sha256 === input.bindingSha256 && canonical(saved.output.files) === canonical(files)) matched = true;
      }
      requireThat(matched,"COMMIT_RECEIPT_REQUIRED","Validation requires the exact files and binding returned by this task's completed Host commit");
    }
    if (files.length === 0) {
      const current = selected();
      requireThat(["analysis","checkpoint","semester","lesson","assignment-plan"].includes(kind),"STATE_ONLY_VALIDATION_REQUIRED","Empty file validation requires a state-only product");
      const product = kind === "analysis" ? current.state.materialAnalysis : kind === "checkpoint" ? current.checkpoint : kind === "semester" ? current.semester : kind === "lesson" ? current.lesson : current.assignment?.draft;
      requireThat(product,"STATE_DRAFT_REQUIRED","The expected Host state draft has not been saved");
      return {taskId:options.taskId,succeeded:true,artifacts:[],validation:{kind:"state-only",product:kind},binding:current.binding,teacherReviewPending:kind !== "analysis"};
    }
    const artifacts = [];
    let currentBinding = input.bindingSha256;
    for (let index = 0; index < files.length; index++) {
      try { const result: Awaited<ReturnType<typeof compile>> & {publishedOutput?:FileRef} = await compile({ ...input, ...files[index], bindingSha256: currentBinding, requestId: `${input.requestId}-${index}` }, signal, authorize); if (assignmentId && options.outputDirectory) {
        const destination = assignmentDestination(files[index]);
        requireThat(result.output,"COMPILE_FAILED","Successful compile has no output reference");
        const extension = extname(result.output.path);
        const outputPath = join(resolve(destination,".."),`${basename(destination,extname(destination))}${extension}`);
        await authorize?.(); signal.throwIfAborted(); await publishFile(outputPath,await readFile(result.output.path),signal);
        result.publishedOutput = {path:outputPath,sha256:result.output.sha256,bytes:result.output.bytes};
      } artifacts.push(result); currentBinding = result.binding.sha256; }
      catch (error) {
        if (!["TEX_PREFLIGHT_FAILED", "COMPILE_FAILED", "PDF_PAGE_COUNT_MISMATCH", "RMD_PREFLIGHT_FAILED", "RMD_EXECUTION_FAILED"].includes(errorCode(error) ?? "")) throw error;
        artifacts.push({ source: files[index].source, format: files[index].format, succeeded: false, diagnostic: `${errorCode(error)}: ${errorMessage(error)}` });
      }
    }
    return { taskId: options.taskId, succeeded: artifacts.every(item => item.succeeded), artifacts, binding: selected().binding, teacherReviewPending: true };
  }

  const registry: Record<string, CourseWorkflowBroker> = Object.fromEntries(Object.entries(COURSE_WORKFLOW_TOOL_IDENTITIES).map(([id, identity]) => {
    const execute = (invocation: Invocation) => {
      requireThat(invocation.input.taskId === options.taskId, "TASK_ID_MISMATCH", "This private registry cannot execute another task");
      if (id === "course_task_route") requireThat(Object.keys(invocation.input).every(field=>field === "taskId"), "ROUTE_INPUT_SCOPE", "Route inputs cannot choose a product or branch");
      requireThat(!invocation.context.workspace || resolve(invocation.context.workspace) === directory, "TASK_WORKSPACE_MISMATCH", "Run workspace differs from the exact course task directory");
      const attempt = key(invocation.context);
      requireThat(!active.has(attempt) || active.get(attempt)!.settled, "ATTEMPT_ALREADY_RUNNING", "This Host attempt is already running");
      const controller = new AbortController(), onAbort = () => controller.abort(invocation.signal?.reason);
      invocation.signal?.addEventListener("abort", onAbort, { once: true }); if (invocation.signal?.aborted) onAbort();
      const record = { controller, done: Promise.resolve<BrokerResult>({exit_code:1,output:null,diagnostic:"Not started",effects:emptyEffects()}), before: new Map<string, FileRef>(), observedReady: false, settled: false, effects: emptyEffects() };
      const operation = queue.then(async (): Promise<BrokerResult> => {
        let journal: string | null = null, fingerprint: string | null = null; let operationInput: DomainInput = {};
        try {
          controller.signal.throwIfAborted(); await invocation.authorize?.(); controller.signal.throwIfAborted(); await checkedDirectory(); record.before = await files(); operationBaseline = record.before; record.observedReady = true;
          if (!["course_task_context","course_task_route"].includes(id)) {
            operationInput = domainInput(invocation.input);
            requireThat(typeof invocation.input.requestId === "string" && /^[a-zA-Z0-9_-]{1,100}$/u.test(invocation.input.requestId), "REQUEST_ID_REQUIRED", "Mutations require a durable request ID");
            const journalId = scopedRequestId(operationInput, invocation.context);
            journal = join(journalDirectory, `request-${journalId}.json`); fingerprint = hash(canonical({ taskHash, id, input: invocation.input }));
            operationInput = journalId === invocation.input.requestId ? operationInput : { ...operationInput, requestId: journalId };
            let saved: Data | null = null; try { saved = parseRecord(await readFile(journal, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            if (saved) { requireThat(saved.fingerprint === fingerprint, "REQUEST_ID_CONFLICT", "Request ID was already used for different task input"); requireThat(saved.status === "completed", "RECONCILE_REQUIRED", "The original request began but has no confirmed durable outcome; do not repeat its write"); return { exit_code: 0, output: withBindingSha256(jsonRecord(saved.output)), effects: await effects(record.before) }; }
            await immutable(journal, canonical({ fingerprint, taskHash, status: "started", context: invocation.context }));
          }
          controller.signal.throwIfAborted();
          const output = id === "course_task_route" ? await route()
            : withBindingSha256(id === "course_task_context" ? await context(controller.signal) : id === "course_artifact_commit" ? await commit(operationInput, controller.signal, invocation.authorize) : await compileRequested(operationInput, controller.signal, invocation.authorize));
          if (id === "course_artifact_compile") { await invocation.authorize?.(); controller.signal.throwIfAborted(); }
          if (journal) await durableOutcome(journal, { fingerprint, taskHash, status: "completed", completedAt:new Date().toISOString(),hostFiles:{baselines:[...frozenBaseline],published:[...published]},output });
          record.effects = record.observedReady ? await effects(record.before) : emptyEffects();
          return { exit_code: 0, output, effects: record.effects };
        } catch (error) {
          record.effects = record.observedReady ? await effects(record.before) : emptyEffects();
          if (errorCode(error) === "PROCESS_TERMINATION_UNCONFIRMED") throw error;
          return { exit_code: 1, output: null, diagnostic: `${errorCode(error) ?? "COURSE_WORKFLOW_FAILED"}: ${errorMessage(error)}`, effects: record.effects };
        } finally { operationBaseline = null; record.settled = true; invocation.signal?.removeEventListener("abort", onAbort); }
      });
      record.done = operation; active.set(attempt, record); queue = operation.catch(() => undefined);
      return operation;
    };
    const cancel: CourseWorkflowBroker["cancel"] = async ({ context: runContext, reason }) => {
      const record = active.get(key(runContext));
      let evidenceSha = hash(canonical({ taskHash, context: runContext, quiescent: true, admitted: false }));
      if (record) {
        record.controller.abort(reason); const result = await record.done; record.effects = record.observedReady ? await effects(record.before) : emptyEffects();
        if (record.observedReady) {
          const evidencePath = join(journalDirectory, `cancel-${hash(key(runContext)).slice(0, 24)}.json`);
          let prior: Buffer | null = null; try { prior = await readFile(evidencePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (prior) { const saved = parseRecord(prior.toString("utf8")); requireThat(saved.taskHash === taskHash && saved.quiescent === true && canonical(saved.context) === canonical(runContext), "CANCELLATION_EVIDENCE_CONFLICT", "Persisted cancellation evidence belongs to another operation"); evidenceSha = hash(prior); }
          else {
            const saved = { taskHash, context: runContext, quiescent: true, processProtocol: "operation-completion-and-compiler-tree-close-if-started", operationExitCode: result.exit_code, effects: record.effects };
            evidenceSha = (await immutable(evidencePath, canonical(saved))).sha256;
          }
          record.effects = await effects(record.before);
        }
      }
      return { termination_confirmed: true, evidence: [{ kind: record ? "course-operation-quiescent" : "course-operation-not-admitted", sha256: evidenceSha }], effects: record?.effects ?? emptyEffects() };
    };
    return [id, { identity, execute, cancel, attestation: { qualified: true, cancellable: true, effect_observation: true, tool_identity: identity, broker_id: "pi-own-course-workflow-v1", evidence_sha256: hash(canonical({ identity, protocol: "exact-private-binding-cas-durable-requests-tree-termination-observed-task-storage-files" })) } }];
  }));
  return { registry, contracts: courseWorkflowToolContracts(), binding: { taskId: options.taskId, projectId, week, session, taskDirectory: directory }, contextBinding: () => selected().binding,
    committedReceipt: async requestId => {
      requireThat(/^[a-zA-Z0-9_-]{1,100}$/u.test(requestId), "COMMIT_RECEIPT_REQUIRED", "Select the exact original commit request");
      const names = (await readdir(journalDirectory)).filter(name => name === `request-${requestId}.json` || name.startsWith(`request-${requestId}-`) && name.endsWith(".json"));
      const saved = (await Promise.all(names.map(async name => ({ name, record: parseRecord(await readFile(join(journalDirectory, name), "utf8")) }))))
        .filter(item => item.record.taskHash === taskHash && item.record.status === "completed" && isRecord(item.record.output) && item.record.output.taskId === options.taskId && item.record.output.succeeded === true && item.record.output.kind && Array.isArray(item.record.output.files))
        .sort((left, right) => requestRound(right.name) - requestRound(left.name))[0];
      requireThat(saved, "COMMIT_RECEIPT_MISMATCH", "The private saved receipt is not this task's successful artifact commit");
      const output=jsonRecord(saved.record.output);
      requireThat(Array.isArray(output.files),"COMMIT_RECEIPT_MISMATCH","Commit receipt needs captured files");
      const receiptFiles=output.files.map((value):CommitReceipt["files"][number]=>{
        const file=fileInput(value), source=jsonRecord(file.source);
        requireThat(file.format === "tex" || file.format === "rmd" || file.format === "html","COMMIT_RECEIPT_MISMATCH","Receipt format is invalid");
        requireThat(file.role === undefined || file.role === "student" || file.role === "solution","COMMIT_RECEIPT_MISMATCH","Receipt role is invalid");
        requireThat(typeof source.path === "string" && typeof source.sha256 === "string" && typeof source.bytes === "number","COMMIT_RECEIPT_MISMATCH","Receipt source identity is invalid");
        const {role,...fields}=file;
        return {...fields,format:file.format,...(role === undefined ? {} : {role}),source:{path:source.path,sha256:source.sha256,bytes:source.bytes}};
      });
      let savedLesson:CommitReceipt["lesson"], savedProduct:CommitReceipt["product"];
      if(output.lesson) {const lesson=jsonRecord(output.lesson);requireThat(typeof lesson.contentHash === "string" && typeof lesson.revision === "number","COMMIT_RECEIPT_MISMATCH","Saved lesson identity is invalid");savedLesson=lesson as NonNullable<CommitReceipt["lesson"]>;}
      if(output.product) {const product=jsonRecord(output.product);requireThat(product.contentHash===undefined || typeof product.contentHash === "string","COMMIT_RECEIPT_MISMATCH","Saved product hash is invalid");requireThat(product.revision===undefined || typeof product.revision === "number","COMMIT_RECEIPT_MISMATCH","Saved product revision is invalid");requireThat(product.materialId===undefined || typeof product.materialId === "string","COMMIT_RECEIPT_MISMATCH","Saved product material is invalid");savedProduct=product as CommitReceipt["product"];}
      return {...withBindingSha256(output),files:receiptFiles,...(output.lesson === undefined ? {} : {lesson:savedLesson}),...(output.product === undefined ? {} : {product:savedProduct})};
    } };
}
function requestRound(name: string) {
  const match = /-r(\d+)[.]json$/u.exec(name);
  return match ? Number(match[1]) : 1;
}
function scopedRequestId(input: DomainInput, context: { attempt_id?: string }) {
  const attempt = context.attempt_id;
  const round = input.round;
  requireThat(round === undefined || typeof round === "number" && Number.isInteger(round) && round >= 1 && round <= 1000, "REQUEST_ROUND_INVALID", "Repair round must be an integer from 1 to 1000");
  // Attempt identities may be UUIDs or broker bookkeeping labels. Only numeric
  // runtime repair ordinals can partition a request; ordinary retries reuse its journal.
  const suffix = round !== undefined && Number.isInteger(round) && round > 1 ? `r${round}` : attempt && /^[1-9][0-9]*$/u.test(attempt) && Number(attempt) > 1 ? attempt : "";
  const id = suffix ? `${input.requestId}-${suffix}`.slice(0, 100) : input.requestId;
  requireThat(/^[a-zA-Z0-9_-]{1,100}$/u.test(id ?? ""), "REQUEST_ID_REQUIRED", "Round-scoped request ID is not a durable request ID");
  return id;
}
