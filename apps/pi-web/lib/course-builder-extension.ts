import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { courseBuilderCommand, getCourseBuilderHost } from "./course-builder-service";
import { CourseDeliveryLoop, DELIVERY_ENTRY, type DeliveryTask } from "./course-builder-delivery";
import { completeCourseRevisionTasks } from "./course-builder-revisions";
import { COURSE_BUILDER_ACTIONS } from "../../../packages/course-builder-host/src/index.ts";

/** Only loaded by the selected physical Mode Pack resource, never auto-discovered. */
export function createCourseBuilderExtension(hostProvider = getCourseBuilderHost, executeCommand = courseBuilderCommand) {
 return function courseBuilderExtension(pi: ExtensionAPI) {
 const loop = (ctx: ExtensionContext) => new CourseDeliveryLoop({
  snapshot:()=>{ const snapshot=hostProvider().getSnapshotForSession(ctx.sessionManager.getSessionId()); if(!snapshot)throw new Error("Delivery course is unavailable"); return snapshot; },
  load:()=>{const entry=[...ctx.sessionManager.getBranch()].reverse().find((item)=>item.type==="custom"&&item.customType===DELIVERY_ENTRY); return entry?.type==="custom" ? entry.data as DeliveryTask : undefined;},
  save:(task)=>{pi.appendEntry(DELIVERY_ENTRY,task);console.info("[course-delivery] transition",{sessionId:ctx.sessionManager.getSessionId(),taskId:task.id,status:task.status,rounds:task.rounds,target:task.target,requirements:task.requirements.length,reason:task.reason});},
 });
 pi.on("before_agent_start",(event,ctx)=>({message:{customType:"course-delivery-instructions",content:loop(ctx).start(event.prompt),display:false}}));
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
  name:"course_builder",label:"Course Builder",description:"Read bounded course or Assignment sources and submit versioned drafts. First call state for the course chain or assignment_state with an assignmentId for one isolated Assignment. Never cross those material scopes. Read preparation coverage through read_checkpoints (JSON text, offset/limit pagination) before later lessons; stale/planned entries are not confirmed completion. After saving lesson/deck content, use save_checkpoint with expectedRevision and draftJson: {lessonPlanId,lessonRevision,deckId,deckRevision,coverage:[{materialId,sourceHash,summary,position:string,nextLesson:string}],completed:[string],remaining:[string],nextLesson:string}. Use current observed identities; deckId/deckRevision may both be null. One file entry per lesson/materialId. Summarize actual lesson usage and where to continue; position is optional text (empty when unknown). Do not split one file by read batches. To revise an existing deck, read_deck then patch_deck with id, expectedRevision, parentRevision and draftJson:{edits:[{oldText,newText}]}; each oldText must match exactly once. Preserve unrelated assets. Rewrite only if the user explicitly abandons them. Chat attachments can be read with read_attachment, id=attachmentId, offset/limit; they stay scoped to the current conversation and Assignment. Checkpoints describe preparation, not learner mastery. Human approvals and checkpoint confirmation exist only in the workspace; the agent cannot approve.",
  parameters:Type.Object({
   action:Type.Union([...COURSE_BUILDER_ACTIONS,"delivery_route","delivery_finish"].map(a=>Type.Literal(a))),
   id:Type.Optional(Type.String()),assignmentId:Type.Optional(Type.String()),draftJson:Type.Optional(Type.String({maxLength:2000000})),
   draft:Type.Optional(Type.Object({}, {additionalProperties:true,description:"Structured draft or patch {edits:[{oldText,newText}]}; prefer this over JSON encoded inside draftJson."})),
   spec:Type.Optional(Type.Object({}, {additionalProperties:true,description:"Structured delivery_route {kind,id?,requirements:[{id,text}]} or delivery_finish {id,checks:[{requirementId,quote}]}; also used for visual specifications. Prefer this over specJson."})),
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
   if(params.action==="delivery_route" || params.action==="delivery_finish") {
    try {
     const spec=payload(params.spec,params.specJson,"spec",50000) ?? {};
     const result=params.action==="delivery_route" ? delivery.route(spec) : delivery.finish(spec);
     if(result.status==="completed" && result.delivered) {
      const kind=result.target?.kind;
      if(kind==="semester" || kind==="lesson" || kind==="assignment") completeCourseRevisionTasks(sessionId,{action:`save_${kind}`},{[kind==="semester" ? "semesterPlanId" : kind==="lesson" ? "lessonPlanId" : "assignmentId"]:result.delivered.id,revision:result.delivered.revision});
     }
     return {content:[{type:"text" as const,text:JSON.stringify(result)}],details:{}};
    } catch(error) {delivery.observe(params,null,error instanceof Error ? error.message : String(error));throw error;}
   }
   try {
   delivery.assertProductionAction(params.action);
   const result=await executeCommand(sessionId,{
    action:params.action,id:params.id,assignmentId:params.assignmentId,expectedRevision:params.expectedRevision,parentRevision:params.parentRevision,offset:params.offset,limit:params.limit,purpose:params.purpose,
    draft:payload(params.draft,params.draftJson,"draft",2000000),spec:payload(params.spec,params.specJson,"spec",50000),
   },()=>{if(signal?.aborted)throw new Error("Course Builder operation cancelled");});
   delivery.observe(params,result);
   return {content:[{type:"text" as const,text:JSON.stringify(result)}],details:{}};
   } catch(error) {delivery.observe(params,null,error instanceof Error ? error.message : String(error));throw error;}
  },
 });
 };
}

export default createCourseBuilderExtension();
