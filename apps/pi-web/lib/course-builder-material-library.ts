import { createHash } from "node:crypto";
import { readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import type { CourseBuilderHost, CourseBuilderMaterialInput } from "../../../packages/course-builder-host/src/index.ts";
import { describeCourseBuilderLocalFile } from "./course-builder-local-materials.ts";
import { captureCourseWebMaterial } from "./course-builder-web-material.ts";

const MAX_BYTES = 64 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function courseMaterialRoots(host: CourseBuilderHost, sessionId: string): string[] {
  const snapshot = host.getSnapshotForSession(sessionId);
  if (!snapshot) throw new Error("Course project is not bound");
  return [...new Set(snapshot.materials.filter(m => m.metadata.storage === "local-link" && m.metadata.materialScope !== "assignment")
    .map(m => m.metadata.sourceRoot).filter((root): root is string => typeof root === "string"))];
}
async function selectedRoot(host: CourseBuilderHost, sessionId: string, requested?: string) {
  const roots = await Promise.all(courseMaterialRoots(host,sessionId).map(path=>realpath(path)));
  if (!roots.length) throw new Error("请先在课程资料区链接你的素材文件夹；不会自动创建或改用课件输出目录。");
  const root = requested ? await realpath(requested) : roots.length === 1 ? roots[0] : undefined;
  if (!root) throw new Error(`课程链接了多个素材文件夹，请用 root 指定其中一个：${roots.join("; ")}`);
  if (!roots.includes(root) || !(await stat(root)).isDirectory()) throw new Error("素材只能保存到当前课程已链接的素材文件夹");
  return root;
}
function filename(name: string) {
  if (!name || name.length > 220 || basename(name) !== name || /[<>:"/\\|?*\x00-\x1f]/u.test(name) || /[. ]$/u.test(name)) throw new Error("Provide a plain safe material filename, without a directory");
  return name;
}
export interface NewCourseMaterial { name: string; bytes: Uint8Array; provenance?: {sourceUrl?:string;finalUrl?:string;method?:string;sourcePath?:string;purpose?:string} }

/** Copy into the teacher's existing library, then register lazy local references atomically. */
export async function saveCourseLibraryFiles(host: CourseBuilderHost, sessionId: string, files: NewCourseMaterial[], expectedRevision: number, requestedRoot?: string, assertActive?:()=>void|Promise<void>) {
  const project = host.getProjectForSession(sessionId);
  if (!project) throw new Error("Course project is not bound");
  const check = async () => {
    await assertActive?.();
    if (host.getAgentAssignmentScope(sessionId) !== null) throw new Error("当前是 Assignment 独立资料范围，不能向课程素材文件夹写入；请切回课程范围。");
    const current = host.getProjectForSession(sessionId);
    if (current?.projectId !== project.projectId || current.revision !== expectedRevision) throw new Error("课程资料版本已变化，请读取当前 state 后重试");
  };
  await check();
  if (!files.length || files.length > 100 || files.reduce((n,f)=>n+f.bytes.byteLength,0)>MAX_BYTES) throw new Error("Material batch requires 1..100 files within 64 MiB");
  const root = await selectedRoot(host,sessionId,requestedRoot);
  const created: {path:string;hash:string}[] = [], additions: CourseBuilderMaterialInput[] = [], results: {name:string;path:string;existingId?:string}[] = [];
  try {
    for (const file of files) {
      const base = filename(file.name), digest = hash(file.bytes);
      let path = join(root,base);
      for (let attempt = 0; ; attempt++) {
        try { await writeFile(path,file.bytes,{flag:"wx"}); created.push({path,hash:digest}); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const canonical = await realpath(path);
          const rel = relative(root,canonical);
          if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Existing material path escaped the selected folder");
          if ((await stat(canonical)).size === file.bytes.byteLength && hash(await readFile(canonical)) === digest) break;
          if (attempt > 0) throw new Error("Versioned material filename conflicts with different content");
          const ext = extname(base); path = join(root,`${base.slice(0,base.length-ext.length)}-${digest.slice(0,12)}${ext}`);
        }
      }
      const input = await describeCourseBuilderLocalFile(root,path);
      const provenance:Record<string,string>={};
      for(const [key,value] of Object.entries(file.provenance ?? {})) if(typeof value==="string") provenance[key]=value;
      input.metadata = {...input.metadata, importedContentHash:`sha256:${digest}`, provenance};
      const existing = host.getSnapshotForSession(sessionId)!.materials.find(m=>m.metadata.materialScope !== "assignment" && m.metadata.sourceRoot===root && m.name===input.name);
      if (existing && existing.sourceHash !== `sha256:${hash(input.sourceBytes)}`) throw new Error(`已有素材 ${input.name} 在磁盘上已变化，请先重新索引此素材文件夹`);
      if (!existing && !additions.some(m=>m.name===input.name)) additions.push(input);
      results.push({name:input.name,path,existingId:existing?.materialId});
    }
    await check();
    if (await selectedRoot(host,sessionId,root) !== root) throw new Error("Material folder binding changed");
    const saved = additions.length ? host.importMaterials(sessionId,additions,expectedRevision) : [];
    const materials = results.map(r=>({materialId:r.existingId ?? saved.find(m=>m.name===r.name)!.materialId,name:r.name,path:r.path}));
    console.info("[course-material-library] saved",{sessionId,projectId:project.projectId,root,count:materials.length,added:saved.length});
    return {projectId:project.projectId,revision:host.getProjectForSession(sessionId)!.revision,root,materials,replay:saved.length===0};
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const item of created) { try { if (hash(await readFile(item.path))!==item.hash) throw new Error(`New file changed before rollback: ${item.path}`); await unlink(item.path); } catch (cleanup) {cleanupErrors.push(cleanup);} }
    if (cleanupErrors.length) throw new AggregateError([error,...cleanupErrors],"Material registration failed; some new files could not be rolled back");
    throw error;
  }
}

export async function addCourseMaterial(host: CourseBuilderHost, sessionId: string, spec: unknown, expectedRevision: number, assertActive?:()=>void|Promise<void>) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Provide material spec {url or path, name?, root?, purpose?}");
  const input=spec as Record<string,unknown>;
  if ((typeof input.url==="string") === (typeof input.path==="string")) throw new Error("Provide exactly one url or local path");
  for (const field of ["name","root","purpose"]) if (input[field]!==undefined && typeof input[field]!=="string") throw new Error(`Invalid ${field}`);
  // Resolve destination before network/file work; never invent a storage directory.
  const root = await selectedRoot(host,sessionId,input.root as string|undefined);
  await assertActive?.();
  if (host.getAgentAssignmentScope(sessionId)!==null) throw new Error("Course material import is unavailable inside Assignment scope");
  let file:NewCourseMaterial;
  if(typeof input.url==="string") {
    const capture=await captureCourseWebMaterial(input.url);
    file={name:input.name as string ?? capture.name,bytes:capture.bytes,provenance:{sourceUrl:capture.sourceUrl,finalUrl:capture.finalUrl,method:capture.method,purpose:input.purpose as string|undefined}};
  } else {
    const path=await realpath(input.path as string);
    const info=await stat(path); if(!info.isFile() || info.size>MAX_BYTES)throw new Error("Local source must be a file within 64 MiB");
    file={name:input.name as string ?? basename(path),bytes:new Uint8Array(await readFile(path)),provenance:{sourcePath:path,purpose:input.purpose as string|undefined}};
  }
  return saveCourseLibraryFiles(host,sessionId,[file],expectedRevision,root,assertActive);
}
