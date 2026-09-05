import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { courseBuilderCommand } from "./course-builder-service";
import { COURSE_BUILDER_ACTIONS } from "../../../packages/course-builder-host/src/index.ts";

/** Only loaded by the selected physical Mode Pack resource, never auto-discovered. */
export default function courseBuilderExtension(pi: ExtensionAPI) {
 pi.registerTool({
  name:"course_builder",label:"Course Builder",description:"Read bounded project sources and submit versioned drafts. First call state. Human approvals exist only in the workspace; the agent cannot approve. See the fixed course-builder workflow for JSON draft fields.",
  parameters:Type.Object({
   action:Type.Union(COURSE_BUILDER_ACTIONS.map(a=>Type.Literal(a))),
   id:Type.Optional(Type.String()),draftJson:Type.Optional(Type.String({maxLength:2000000})),
   expectedRevision:Type.Optional(Type.Integer({minimum:0})),parentRevision:Type.Optional(Type.Integer({minimum:0})),
   offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:20000})),
   purpose:Type.Optional(Type.String()),specJson:Type.Optional(Type.String({maxLength:50000})),
  }),
  async execute(_id,params,signal,_update,ctx) {
   if (signal?.aborted) throw new Error("Course Builder operation cancelled");
   const sessionId=ctx.sessionManager.getSessionId();
   const result=await courseBuilderCommand(sessionId,{
    action:params.action,id:params.id,expectedRevision:params.expectedRevision,parentRevision:params.parentRevision,offset:params.offset,limit:params.limit,purpose:params.purpose,
    draft:params.draftJson ? JSON.parse(params.draftJson) : undefined,spec:params.specJson ? JSON.parse(params.specJson) : undefined,
   },()=>{if(signal?.aborted)throw new Error("Course Builder operation cancelled");});
   return {content:[{type:"text" as const,text:JSON.stringify(result)}],details:{}};
  },
 });
}
