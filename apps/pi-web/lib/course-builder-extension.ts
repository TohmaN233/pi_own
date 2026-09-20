import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { courseBuilderCommand, getCourseBuilderHost } from "./course-builder-service";
import { CourseDeliveryLoop, DELIVERY_ENTRY, DELIVERY_REQUEST_ENTRY, deliveryRequest, type DeliveryTask } from "./course-builder-delivery";
import type { DeliveryTarget } from "./course-builder-delivery-target";
import { completeCourseRevisionTasks } from "./course-builder-revisions";
import { COURSE_BUILDER_ACTIONS } from "../../../packages/course-builder-host/src/index.ts";

/** Only loaded by the selected physical Mode Pack resource, never auto-discovered. */
export function createCourseBuilderExtension(hostProvider = getCourseBuilderHost, executeCommand = courseBuilderCommand) {
 return function courseBuilderExtension(pi: ExtensionAPI) {
 const loop = (ctx: ExtensionContext) => new CourseDeliveryLoop({
  snapshot:()=>{ const snapshot=hostProvider().getSnapshotForSession(ctx.sessionManager.getSessionId()); if(!snapshot)throw new Error("Delivery course is unavailable"); return snapshot; },
  checkpoints:()=>hostProvider().listCoverageCheckpoints(ctx.sessionManager.getSessionId()),
  load:()=>{const entry=[...ctx.sessionManager.getBranch()].reverse().find((item)=>item.type==="custom"&&item.customType===DELIVERY_ENTRY); return entry?.type==="custom" ? entry.data as DeliveryTask : undefined;},
  save:(task)=>{pi.appendEntry(DELIVERY_ENTRY,task);console.info("[course-delivery] transition",{sessionId:ctx.sessionManager.getSessionId(),taskId:task.id,status:task.status,rounds:task.rounds,target:task.target,requirements:task.requirements.length,reason:task.reason,repair:task.bindingRepair});},
 });
 const selectedTarget = (ctx: ExtensionContext, prompt: string) => {
  const entry = [...ctx.sessionManager.getBranch()].reverse().find((item)=>item.type==="custom" && item.customType===DELIVERY_REQUEST_ENTRY);
  if(entry?.type!=="custom")return undefined;
  const request=entry.data as {promptHash:string;target:DeliveryTarget;consumed?:boolean};
  if(request.consumed || request.promptHash!==deliveryRequest(prompt,request.target).promptHash)return undefined;
  pi.appendEntry(DELIVERY_REQUEST_ENTRY,{...request,consumed:true});
  return request.target;
 };
 pi.on("session_start",(_event,ctx)=>{loop(ctx).restore();});
 pi.on("before_agent_start",(event,ctx)=>({message:{customType:"course-delivery-instructions",content:loop(ctx).start(event.prompt,selectedTarget(ctx,event.prompt)),display:false}}));
 pi.on("input",(event,ctx)=>{
  if(event.streamingBehavior && event.source!=="extension") pi.sendMessage({customType:"course-delivery-instructions",content:loop(ctx).start(event.text),display:false},{deliverAs:"steer"});
 });
 pi.on("agent_end",(event,ctx)=>{
  const last=[...event.messages].reverse().find((message)=>message.role==="assistant");
  const next=loop(ctx).end(last?.role==="assistant" ? last.stopReason : undefined);
  if(next)pi.sendMessage({customType:"course-delivery-continuation",content:next.message,display:!next.continue},{triggerTurn:next.continue,deliverAs:next.continue ? "followUp" : "nextTurn"});
 });
 pi.on("agent_settled",(_event,ctx)=>{const reason=loop(ctx).settled();if(reason)pi.sendMessage({customType:"course-delivery-blocked",content:reason,display:true},{deliverAs:"nextTurn"});});
 pi.registerTool({
  name:"course_builder",label:"Course Builder",description:"Read bounded course or Assignment sources and submit versioned drafts. Classroom visualization default: author a self-contained interactive .html in an existing state.workspace.materialDirectories folder, add_material it, then interactive_visual with id=lessonPlanId and spec {materialId,title}. It must use inline JS/CSS, real controls and live Canvas/SVG redraws; visual is only for explicitly requested fixed noninteractive diagrams. Assignment state includes the course-level fixed preamble and a Host-owned output directory; write current .tex, .Rmd, .md and .pdf deliverables there and revise existing files in place unless the teacher explicitly abandons them. Course references are only state.materials in teacher-selected folders; state.generatedAssets are output images, not reference materials. Teacher scripts: save_teacher_notes with expectedRevision and structured draft {deckId,deckRevision,title,source}, standalone article/report/ctexart TeX. read_teacher_notes uses id=notesId plus offset/limit. patch_teacher_notes uses id=notesId, expectedRevision=notes revision, parentRevision=current observed deck revision, draft:{edits:[{oldText,newText}]}. compile_teacher_notes uses id=notesId and expectedRevision=notes revision. A failure includes diagnostics and a bounded log excerpt; read_teacher_notes_compile_log uses id=receiptId with offset/limit. Repair with patch_teacher_notes and recompile; delivery requires a successful current PDF receipt. Existing decks need no new approval or source change to generate notes. First call state for the course chain or assignment_state with an assignmentId for one isolated Assignment. Never cross those material scopes. Read preparation coverage through read_checkpoints (JSON text, offset/limit pagination) before later lessons; stale/planned entries are not confirmed completion. After saving lesson/deck content, use save_checkpoint with expectedRevision and draftJson: {lessonPlanId,lessonRevision,deckId,deckRevision,coverage:[{materialId,sourceHash,summary,position:string,nextLesson:string}],completed:[string],remaining:[string],nextLesson:string}. Use current observed identities; deckId/deckRevision may both be null. One file entry per lesson/materialId. Summarize actual lesson usage and where to continue; position is optional text (empty when unknown). Do not split one file by read batches. To revise an existing deck, read_deck then patch_deck with id, expectedRevision, parentRevision and draftJson:{edits:[{oldText,newText}]}; each oldText must match exactly once. Preserve unrelated assets. Rewrite only if the user explicitly abandons them. Chat attachments can be read with read_attachment, id=attachmentId, offset/limit; they stay scoped to the current conversation and Assignment. Checkpoints describe preparation, not learner mastery. Human approvals and checkpoint confirmation exist only in the workspace; the agent cannot approve.",
  parameters:Type.Object({
   action:Type.Union([...COURSE_BUILDER_ACTIONS,"delivery_route","delivery_status","delivery_finish"].map(a=>Type.Literal(a))),
   id:Type.Optional(Type.String()),assignmentId:Type.Optional(Type.String()),draftJson:Type.Optional(Type.String({maxLength:2000000})),
   draft:Type.Optional(Type.Object({}, {additionalProperties:true,description:"Structured draft or patch {edits:[{oldText,newText}],addAssetMaterialIds?:string[]}. Add Host-returned IDs to retain existing assets while inserting new figures. Prefer this over JSON encoded inside draftJson."})),
   spec:Type.Optional(Type.Object({}, {additionalProperties:true,description:"interactive_visual: {materialId,title} after writing self-contained HTML into an existing course material folder and registering it with add_material. add_material: {url OR path,name?,root?,purpose?}, expectedRevision=current project revision; save new files or captured website Markdown in an existing state.workspace.materialDirectories folder, never a new folder. Returns materials [{materialId,name,path}]. import_generated_asset: {path,lessonPlanId,sourcePath?,purpose} imports computed PNG/JPEG/PDF from state.workspace.outputDirectory for Beamer, not teaching references. delivery_route {kind,week?,session?,lessonPlanId?,deckId?,includeTeacherNotes?,requirements:[{text,verification:content|compile-review|checkpoint|materials,id?}]}. Host owns IDs. delivery_status returns saved requirement IDs, evidence readiness and exact finishTemplate. Never guess requirement IDs."})),
   expectedRevision:Type.Optional(Type.Integer({minimum:0})),parentRevision:Type.Optional(Type.Integer({minimum:0})),
   offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:20000})),
   purpose:Type.Optional(Type.String()),specJson:Type.Optional(Type.String({maxLength:50000})),
  }),
  async execute(_id,params,signal,_update,ctx) {
   if (signal?.aborted) throw new Error("Course Builder operation cancelled");
   const sessionId=ctx.sessionManager.getSessionId();
   const delivery=loop(ctx);
   const payload=(structured:unknown,encoded:string|undefined,name:string,limit:number)=>{
    if(structured!==undefined && encoded!==undefined)throw new Error(`Provide ${name} or ${name}Json, not both`);
    const value=structured!==undefined ? structured : encoded ? JSON.parse(encoded) : undefined;
    if(value!==undefined && JSON.stringify(value).length>limit)throw new Error(`${name} exceeds ${limit} characters`);
    return value;
   };
   if(params.action==="delivery_status") return {content:[{type:"text" as const,text:JSON.stringify(delivery.status())}],details:{}};
   if(params.action==="delivery_route" || params.action==="delivery_finish") {
    try {
     const spec=payload(params.spec,params.specJson,"spec",50000) ?? {};
     if(params.action==="delivery_finish") for(const id of delivery.materialImportsToVerify()) {
      await executeCommand(sessionId,{action:"read_material",id,limit:1},()=>{if(signal?.aborted)throw new Error("Material verification cancelled");});
     }
     const materialText:Record<string,string>={};
     if(params.action==="delivery_finish") for(const check of delivery.materialChecks(spec)) {
      const result=await executeCommand(sessionId,{action:"read_material",id:check.materialId,offset:check.offset,limit:20000},()=>{if(signal?.aborted)throw new Error("Material verification cancelled");});
      if (!result || typeof result!=="object" || !("text" in result) || typeof result.text!=="string") throw new Error("read_material did not return a verifiable text window");
      materialText[check.requirementId]=result.text;
     }
     const result=params.action==="delivery_route" ? delivery.route(spec) : delivery.finish(spec,materialText);
     if(result.status==="completed" && result.delivered) {
      const kind=result.target?.kind;
      if(kind==="semester" || kind==="lesson" || kind==="assignment") completeCourseRevisionTasks(sessionId,{action:`save_${kind}`},{[kind==="semester" ? "semesterPlanId" : kind==="lesson" ? "lessonPlanId" : "assignmentId"]:result.delivered.id,revision:result.delivered.revision});
     }
     return {content:[{type:"text" as const,text:JSON.stringify({...result,evidenceContract:delivery.status()})}],details:{}};
    } catch(error) {delivery.observe(params,null,error instanceof Error ? error.message : String(error));throw error;}
   }
   try {
   delivery.assertProductionAction(params.action);
   const command=delivery.prepare({
    action:params.action,id:params.id,assignmentId:params.assignmentId,expectedRevision:params.expectedRevision,parentRevision:params.parentRevision,offset:params.offset,limit:params.limit,purpose:params.purpose,
    draft:payload(params.draft,params.draftJson,"draft",2000000),spec:payload(params.spec,params.specJson,"spec",50000),
   });
   const result=await executeCommand(sessionId,command,()=>{if(signal?.aborted)throw new Error("Course Builder operation cancelled");});
   delivery.observe(command,result);
   return {content:[{type:"text" as const,text:JSON.stringify(result)}],details:{}};
   } catch(error) {delivery.observe(params,null,error instanceof Error ? error.message : String(error));throw error;}
  },
 });
 };
}

export default createCourseBuilderExtension();
