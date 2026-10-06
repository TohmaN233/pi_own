import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJiti} from 'jiti';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const destination=join(root,'docs/course-workflows/authoring/course-production');
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {courseWorkflowAuthorSchema}=await jiti.import(join(root,'apps/pi-web/lib/course-workflow-domain.ts'));
const products=[
 ['analysis','资料分析','course-material-analysis'],['semester','学期计划','course-semester-plan'],
 ['lesson','单课教案','course-lesson-plan'],['deck','Beamer 课件','course-beamer-deck'],
 ['teacher-notes','教师讲稿','course-teacher-notes'],['assignment-plan','Assignment 计划','course-assignment-plan'],
 ['assignment-artifacts','Assignment 学生 TeX / 解答 Rmd','course-assignment-artifacts'],
 ['rmd','Rmd 实验','course-rmd-lab'],['html','交互 HTML','course-interactive-html'],
 ['checkpoint','覆盖检查点','course-coverage-checkpoint'],['bundle','单课草案至 PDF/Rmd','course-lesson-artifacts'],
];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(await readFile(join(root,'docs/course-workflows/authoring/manifest.json'),'utf8'));
if(manifest.products.length!==12)throw new Error('Expected retained full-method source inventory');
await mkdir(destination,{recursive:true});
const local=relative(root,destination);if(!local||local.startsWith('..')||!local.startsWith(`docs${sep}course-workflows${sep}authoring${sep}`))throw new Error('Unsafe source destination');
// This directory is generated source, never user material, a Skill discovery root, or a Run store.
await rm(join(destination,'references'),{recursive:true,force:true});
const copied=new Set();
async function copyGuidance(action){
 if(copied.has(action))return;
 copied.add(action);
 const source=join(root,'docs/course-workflows/authoring',action,'references');
 for(const entry of await readdir(source,{withFileTypes:true})){
  if(!entry.isFile())throw new Error(`Unexpected nested guidance entry ${action}/${entry.name}`);
  if(entry.name==='author-result.schema.json')continue;
  const target=join(destination,'references',action,entry.name);await mkdir(dirname(target),{recursive:true});
  await writeFile(target,await readFile(join(source,entry.name)));
 }
}
let body=`---\nname: course-production\ndescription: One teacher production Workflow with deterministic Host branches for course planning, revisions, Beamer, teacher notes, Assignment, Rmd and interactive HTML.\n---\n\n# 备课生产\n\nOne top-level Workflow serves all teacher production actions. Root inputs are Host-created taskId, commitRequestId, compileRequestId and the teacher task. The UI chooses the product, never a separate Workflow definition. Only one conditional branch executes per Run. No model chooses a branch, reproduces IDs, or loads all course methods.\n\n## Load the selected context\n\nCall registered course_task_context with directly bound Root taskId. Host validates the current course/Assignment/lesson target, frozen selected sources, attachment scope, prerequisites, baseline revisions and teacher approval where required. Its context and top-level bindingSha256 stay authoritative. Authors receive only context and Root task, never course history or Host identifiers.\n\n## Route the prepared task\n\nCall registered course_task_route with Root taskId. This deterministic read-only Host tool returns the prepared product and new/revise operation, the exact branch scalar, and the normalized commit kind. Its branch output selects one of the branches below through native conditional control flow. The other branches are skipped. Keep all routing scalars on Host nodes. Unknown branch/identity/target/CAS errors stop visibly; do not ask an agent to guess or compensate.\n`;
for(const [kind,name,baseAction] of products){
 const schemaPath=`references/results/${kind}.schema.json`;await mkdir(dirname(join(destination,schemaPath)),{recursive:true});
 await writeFile(join(destination,schemaPath),JSON.stringify(courseWorkflowAuthorSchema(kind),null,2)+'\n');
 for(const operation of ['new','revise']){
  const action=kind==='deck'&&operation==='revise'?'course-slide-revision':baseAction;
  await copyGuidance(action);
  const entries=(await readdir(join(destination,'references',action))).filter(name=>name.endsWith('.md'));
  if(!entries.includes('product-guide.md'))throw new Error(`Missing full product guide ${action}`);
  const links=entries.map(file=>`[${file}](references/${action}/${file})`).join(', ');
  body+=`\n## ${kind}:${operation} — ${name}${operation==='new'?'新建':'修订'}\n\nExecute only when the Host branch is exactly ${kind}:${operation}. One explicitly bound Pi Provider authors this product with bounded writes only under sources/. Read the full applicable methods in ${links}; they retain the complete teaching method rather than a summary. Shared historical mechanical tool calls in those references are superseded by this Workflow's four Host tools. Other products' references are unavailable to this author. ${operation==='revise'?'Read the frozen existing artifact and feedback, make the smallest substantive change, and keep correct content. Never rewrite the whole asset unless the teacher explicitly discards it.':'Create only this selected product from the verified selected context. First drafts satisfy context.semanticContract.firstDraftRequired; missing prerequisite or source support is a visible limitation, not invented evidence.'}\n\nReturn exactly one result output selecting the Host-resolved full semantic_output SourceContract for [${kind} result](${schemaPath}) as result.contract_ref. Preserve its exact nested bounds and optional fields. Do not recreate schemas or split optional fields into required outputs. Return only newly authored or changed semantic fields; the Host retains unchanged fields. Required files is [] only when this exact product schema permits a state-only draft; otherwise write and return the newly chosen relative sources/ filenames required by that schema. Never return existing paths, identities, hashes, revisions, approval or receipts. New material-index selections are semantic choices; do not forbid the fields allowed by the exact selected schema.\n\nThen call registered course_artifact_commit in this same branch: Root taskId, Root commitRequestId as requestId, route.kind, context top-level bindingSha256, and direct projections from this author's result. Required files is always directly bound; optional semantic arguments are omitted only when absent. The Host reads bytes, validates the selected product contract and CAS, assigns IDs, merges baseline fields and saves pending teacher review. No model copies or supplies mechanical fields. The branch's committed output feeds the one common finalizer below.\n`;
 }
}
body+=`\n## Compile and validate the selected committed product\n\nOne common registered course_artifact_compile node follows the selected branch's commit. Bind Root taskId, Root compileRequestId as requestId, and the exact bindingSha256 and complete files from the executed branch's commit using graph coalesce projections over mutually exclusive committed outputs. These tool output fields are required. There is no author or Main transcription between commit and compile. This unique deterministic Host finalizer must return succeeded=true. State-only results are validated; TeX gets a real PDF, Rmd actually executes, and HTML is verified and registered in the selected material folder. A saved source or a model statement is not a delivery receipt.\n\nCompile failures retain the exact saved source, diagnostics and previous successful PDF. A separately scoped repair uses fresh Host request IDs and the selected existing asset, rather than regenerating a course. Identity, missing prerequisite, permission, route or CAS errors cannot be repaired by repeated model calls. Keep human approval and revoke controls; no branch approves teacher products. Assignment references and outputs remain in their independent chosen folders. One lesson/source file has one coverage checkpoint. No whole-course conversation loop follows a successful finalizer.\n\n## Provenance\n\nFull methods are retained from Pi Own's course-planning-beamer Skill and applicable teaching Skills, including OpenMAIC MIT at commit 1e10f60b151cedb59ac21ddbcceb5ee0eed9c984 and original attributions. This is one conditional production graph with branch-scoped references, not twelve top-level Workflows. Source interfaces and effects are Host code; pedagogical prose remains scoped guidance.\n`;
await writeFile(join(destination,'SKILL.md'),body);
// Native SkillInventory binds the entrypoint bytes; imported reference bytes are separately pinned.
const product={id:'course-production',name:'备课生产',kind:'master',sourceHash:hash(Buffer.from(body)),branches:products.flatMap(([kind])=>['new','revise'].map(op=>`${kind}:${op}`))};
await writeFile(join(root,'docs/course-workflows/authoring/production-manifest.json'),JSON.stringify({version:1,products:[product],methodSources:manifest.products.map(p=>({id:p.id,sourceHash:p.sourceHash}))},null,2)+'\n');
console.log(JSON.stringify({id:product.id,branches:product.branches.length,sourceHash:product.sourceHash,entryBytes:Buffer.byteLength(body),guideDirectories:copied.size}));
