import { isApiRequestAllowed } from "@/lib/request-security";
import { courseBuilderCommand,courseBuilderState,getCourseBuilderHost } from "@/lib/course-builder-service";
import { requireCourseBuilderRuntime,readCourseBuilderJson,builderString,builderRevision,builderError } from "@/lib/course-builder-request";
import type { CourseBuilderCommand } from "../../../../../packages/course-builder-host/src/index.ts";
export const runtime="nodejs";
export const dynamic="force-dynamic";

export async function GET(request:Request) {
 if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
 try{const sid=builderString(new URL(request.url).searchParams.get("sessionId"));await requireCourseBuilderRuntime(sid);return Response.json(courseBuilderState(sid));}catch(e){return builderError(e);}
}
export async function POST(request:Request) {
 if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
 try {
  const b=await readCourseBuilderJson(request),sid=builderString(b.sessionId), action=builderString(b.action);
  const {wrapper,status}=await requireCourseBuilderRuntime(sid,true),host=getCourseBuilderHost();
  if(action==="create") {if(host.getSnapshotForSession(sid))throw new Error("This session is already bound to a project");const project=host.createProject(b.project);host.bindSession(sid,project.projectId);return Response.json(courseBuilderState(sid));}
  if(action==="bind") {host.bindSession(sid,builderString(b.projectId));return Response.json(courseBuilderState(sid));}
  if(action==="prompt") {
   if(typeof b.message!=="string"||!b.message.trim()||b.message.length>20000)throw new Error("Prompt must have 1..20000 characters");
   // Native Pi admission and streaming remain the only agent loop.
   const result=await wrapper.send({type:"prompt",message:b.message});return Response.json({queued:true,result});
  }
  if(["review_semester","review_lesson","accept"].includes(action)) {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   const id=builderString(b.id), rev=builderRevision(b.expectedRevision);
   if(action==="accept") {
    if(b.visualChecked!==true)throw new Error("Open and visually inspect the PDF before accepting");
    host.acceptDeck(sid,id,rev,builderString(b.compileReceiptId),builderString(b.reviewId));
   } else {
    if(b.decision!=="approve"&&b.decision!=="request-changes")throw new Error("Invalid teacher decision");
    if(typeof b.note!=="string")throw new Error("Teacher note required");
    if(action==="review_semester")host.reviewSemesterPlan(sid,id,rev,b.decision,b.note);
    else host.reviewLessonPlan(sid,id,rev,b.decision,b.note);
   }
   return Response.json(courseBuilderState(sid));
  }
  if(action!=="command" || !b.command || typeof b.command!=="object" || Array.isArray(b.command))throw new Error("Unknown action");
  const admittedSnapshotId=status.runtime.binding?.snapshot.resourceSnapshotId;
  const result=await courseBuilderCommand(sid,b.command as CourseBuilderCommand,async()=>{
   const current=await requireCourseBuilderRuntime(sid,true);
   if(current.wrapper!==wrapper || current.status.runtime.binding?.snapshot.resourceSnapshotId!==admittedSnapshotId)throw new Error("Course Builder Runtime changed; reload before retrying");
  });
  return Response.json({result,...courseBuilderState(sid)});
 }catch(e){return builderError(e);}
}
