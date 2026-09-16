import { isApiRequestAllowed } from "@/lib/request-security";
import { persistGenericSession } from "@/lib/rpc-manager";
import { courseBuilderCommand,courseBuilderState,courseBuilderWorkspaceState,createCourseBuilderWorkspace,getCourseBuilderHost } from "@/lib/course-builder-service";
import { requireCourseBuilderWorkspace,requireCourseBuilderRuntime,readCourseBuilderJson,builderString,builderRevision,builderError } from "@/lib/course-builder-request";
import type { CourseBuilderCommand } from "../../../../../packages/course-builder-host/src/index.ts";
import { requestCourseRevision, type ReviewAction } from "@/lib/course-builder-revisions";
import { courseLessonTasks, teacherNotesTask, withCourseTaskRequirements } from "@/lib/course-builder-lesson-tasks";
import { DELIVERY_REQUEST_ENTRY, deliveryRequest } from "@/lib/course-builder-delivery";
import type { DeliveryTarget } from "@/lib/course-builder-delivery-target";
export const runtime="nodejs";
export const dynamic="force-dynamic";

export async function GET(request:Request) {
 if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
 try{const sid=new URL(request.url).searchParams.get("sessionId");if(sid)await requireCourseBuilderWorkspace(builderString(sid));return Response.json(await courseBuilderWorkspaceState(sid));}catch(e){return builderError(e);}
}
export async function POST(request:Request) {
 if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
 try {
  const b=await readCourseBuilderJson(request),action=builderString(b.action);
  if(action==="create" && (b.sessionId===undefined || b.sessionId==="")) {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   const sessionId=await createCourseBuilderWorkspace(b.project,builderString(b.createdAt));
   return Response.json({sessionId,...courseBuilderState(sessionId)});
  }
  const sid=builderString(b.sessionId);
  await requireCourseBuilderWorkspace(sid,!(action.startsWith("review_") && b.decision==="request-changes"));
  const host=getCourseBuilderHost();
  if(action==="compile_teacher_notes") {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   const receipt=await host.compileTeacherNotes(sid,builderString(b.id),builderRevision(b.expectedRevision),{trustedTex:process.env.PI_COURSE_BUILDER_TRUSTED_TEX==="1",assertActive:()=>requireCourseBuilderWorkspace(sid,true)});
   console.info("[course-builder] teacher compiled lecture script",{sessionId:sid,notesId:receipt.notesId,notesRevision:receipt.notesRevision,receiptId:receipt.receiptId,succeeded:receipt.succeeded,diagnosticCodes:receipt.diagnostics.map(item=>item.code)});
   return Response.json({receipt,sourceSyncAvailable:receipt.succeeded && host.hasTeacherNotesSyncTex(sid,receipt.receiptId),...courseBuilderState(sid)});
  }
  if(action==="cleanup_materials") {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   const cleanup=host.cleanupStoredCourseAssets(sid,b.dryRun===true);
   console.info("[course-builder] cleaned unreferenced asset copies",cleanup);
   return Response.json({cleanup,...courseBuilderState(sid)});
  }
  if(action==="save_checkpoint" || action==="confirm_checkpoint") {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   const checkpoint=action==="save_checkpoint" ? host.saveCoverageCheckpoint(sid,b.draft,builderRevision(b.expectedRevision)) : host.confirmCoverageCheckpoint(sid,builderString(b.id),builderRevision(b.expectedRevision));
   console.info("[course-builder] checkpoint saved",{sessionId:sid,lessonPlanId:checkpoint.lessonPlanId,revision:checkpoint.revision,status:checkpoint.status,ranges:checkpoint.coverage.length});
   return Response.json({checkpoint,...courseBuilderState(sid)});
  }
  if(action==="create") {if(host.getSnapshotForSession(sid))throw new Error("This session is already bound to a project");await persistGenericSession(sid);const project=host.createProject(b.project);host.bindSession(sid,project.projectId);return Response.json(courseBuilderState(sid));}
  if(action==="bind") {await persistGenericSession(sid);host.bindSession(sid,builderString(b.projectId));return Response.json(courseBuilderState(sid));}
  if(action==="update_project") {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   const project=host.getProjectForSession(sid);
   if(!project)throw new Error("This session has no course project");
   host.updateProject(project.projectId,b.project,builderRevision(b.expectedRevision));
   console.info("[course-builder] teacher updated project",{sessionId:sid,projectId:project.projectId,previousRevision:project.revision});
   return Response.json(courseBuilderState(sid));
  }
  if(action==="create_assignment") {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   host.createAssignment(sid,b.assignment);
   return Response.json(courseBuilderState(sid));
  }
  if(action==="edit_lesson") {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   const state=host.getSnapshotForSession(sid);
   const lesson=state?.lessonPlans.find((item)=>item.lessonPlanId===builderString(b.id));
   if(!lesson || !state?.semesterPlan)throw new Error("Lesson unavailable in this course");
   const draft=b.draft;
   if(!draft || typeof draft!=="object" || Array.isArray(draft) || !("week" in draft) || !("session" in draft) || draft.week!==lesson.week || draft.session!==lesson.session)throw new Error("Editing a lesson cannot change its course slot");
   const saved=host.saveLessonPlan(sid,draft,builderRevision(b.expectedRevision),builderRevision(b.parentRevision));
   console.info("[course-builder] teacher edited lesson",{sessionId:sid,lessonPlanId:saved.lessonPlanId,revision:saved.revision});
   return Response.json(courseBuilderState(sid));
  }
  if(action==="edit_deck") {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   const deck=host.getSnapshotForSession(sid)?.decks.find((item)=>item.deckId===builderString(b.id));
   if(!deck)throw new Error("Deck unavailable in this course");
   if(typeof b.source!=="string" || !b.source.trim())throw new Error("TeX source must not be empty");
   const saved=host.saveBeamerDeck(sid,{lessonPlanId:deck.lessonPlanId,title:deck.title,source:b.source,frameOutline:b.frameOutline ?? deck.frameOutline,assetMaterialIds:deck.assetMaterialIds},builderRevision(b.expectedRevision),builderRevision(b.parentRevision));
   console.info("[course-builder] teacher edited TeX",{sessionId:sid,deckId:saved.deckId,revision:saved.revision});
   return Response.json({deck:saved,...courseBuilderState(sid)});
  }
  if(action==="edit_teacher_notes") {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   const current=host.getTeacherNotes(sid,builderString(b.id));
   const notes=host.saveTeacherNotes(sid,{deckId:current.deckId,deckRevision:builderRevision(b.deckRevision),source:b.source,title:b.title},builderRevision(b.expectedRevision));
   console.info("[course-builder] teacher edited lecture script",{sessionId:sid,notesId:notes.notesId,revision:notes.revision});
   return Response.json({notes,currentDeckRevision:notes.deckRevision,...courseBuilderState(sid)});
  }
  if(action==="prompt" || action==="lesson_task" || action==="teacher_notes_task") {
   const {wrapper}=await requireCourseBuilderRuntime(sid,true);
   let message=b.message;
   let deliveryTarget:DeliveryTarget|undefined;
   if(action==="teacher_notes_task") {
    const snapshot=host.getSnapshotForSession(sid),deck=snapshot?.decks.find(item=>item.deckId===builderString(b.deckId));
    if(!deck)throw new Error("当前课程没有这份 Beamer；请先生成课件。");
    message=teacherNotesTask(deck);
    deliveryTarget={kind:"teacher-notes",deckId:deck.deckId,lessonPlanId:deck.lessonPlanId};
   }
   if(action==="lesson_task") {
    if(b.task!=="plan" && b.task!=="beamer" && b.task!=="checkpoint")throw new Error("Unknown lesson task");
    const state=courseBuilderState(sid).snapshot;
    if(!state?.project)throw new Error("No course project selected");
    const task=courseLessonTasks(state.semesterPlan,state.lessonPlans,builderRevision(b.week),builderRevision(b.session),state.project,state.coverageCheckpoints)[b.task];
    if(task.disabledReason)throw new Error(task.disabledReason);
    message=task.message;
    if(b.teacherNotes!==undefined && typeof b.teacherNotes!=="boolean")throw new Error("teacherNotes must be boolean");
    if(b.task!=="checkpoint")deliveryTarget={kind:b.task==="beamer" ? "deck" : "lesson",week:builderRevision(b.week),session:builderRevision(b.session),...(b.task==="beamer"&&b.teacherNotes===true ? {includeTeacherNotes:true} : {})};
    if(b.task==="beamer"&&b.teacherNotes===true)message+=`\n${teacherNotesTask()}`;
   }
   if(typeof message!=="string"||!message.trim())throw new Error("Prompt must have 1..20000 characters");
   if(b.additionalRequirements!==undefined && typeof b.additionalRequirements!=="string")throw new Error("Additional requirements must be text");
   const finalMessage=withCourseTaskRequirements(message,typeof b.additionalRequirements==="string" ? b.additionalRequirements : "");
   if(finalMessage.length>20000)throw new Error("Prompt including additional requirements must have 1..20000 characters");
   const assignmentId=action!=="prompt" || b.assignmentId===undefined ? null : builderString(b.assignmentId);
   host.setAgentAssignmentScope(sid,assignmentId);
   console.info("[course-builder] set agent material scope",{sessionId:sid,scope:assignmentId ? "assignment" : "course",assignmentId,action,additionalRequirementCharacters:typeof b.additionalRequirements==="string" ? b.additionalRequirements.length : 0});
   // Native Pi admission and streaming remain the only agent loop.
   if(deliveryTarget)wrapper.inner.sessionManager.appendCustomEntry(DELIVERY_REQUEST_ENTRY,deliveryRequest(finalMessage,deliveryTarget));
   const result=await wrapper.send({type:"prompt",message:finalMessage});return Response.json({queued:true,result});
  }
  if(["review_semester","review_lesson","review_assignment","accept","revoke_acceptance"].includes(action)) {
   if(request.headers.get("x-course-builder-teacher")!=="1")return Response.json({error:"Teacher workspace action required"},{status:403});
   const id=builderString(b.id), rev=builderRevision(b.expectedRevision);
   if(action==="revoke_acceptance") {
    host.revokeDeckAcceptance(sid,id,rev);
    console.info("[course-builder] teacher revoked deck acceptance",{sessionId:sid,deckId:id,revision:rev});
   } else if(action==="accept") {
    if(b.visualChecked!==true)throw new Error("Open and visually inspect the PDF before accepting");
    host.acceptDeck(sid,id,rev,builderString(b.compileReceiptId),builderString(b.reviewId));
   } else {
    if(b.decision!=="approve"&&b.decision!=="request-changes")throw new Error("Invalid teacher decision");
    if(typeof b.note!=="string")throw new Error("Teacher note required");
    if(b.decision==="request-changes") {
     const {wrapper}=await requireCourseBuilderRuntime(sid);
     const revisionTask=await requestCourseRevision(host,wrapper,{sessionId:sid,action:action as ReviewAction,id,revision:rev,note:b.note,requestId:builderString(b.requestId)});
     return Response.json({revisionTask,...courseBuilderState(sid)});
    }
    if(action==="review_semester")host.reviewSemesterPlan(sid,id,rev,b.decision,b.note);
    else if(action==="review_lesson")host.reviewLessonPlan(sid,id,rev,b.decision,b.note);
    else host.reviewAssignment(sid,id,rev,b.decision,b.note);
   }
   return Response.json(courseBuilderState(sid));
  }
  if(action!=="command" || !b.command || typeof b.command!=="object" || Array.isArray(b.command))throw new Error("Unknown action");
  const {wrapper,status}=await requireCourseBuilderRuntime(sid,true);
  // Teacher-side compile/review buttons are outside the model turn and deliberately return to the course scope.
  if(request.headers.get("x-course-builder-teacher")==="1")host.setAgentAssignmentScope(sid,null);
  const admittedSnapshotId=status.runtime.binding?.snapshot.resourceSnapshotId;
  const result=await courseBuilderCommand(sid,b.command as CourseBuilderCommand,async()=>{
   const current=await requireCourseBuilderRuntime(sid,true);
   if(current.wrapper!==wrapper || current.status.runtime.binding?.snapshot.resourceSnapshotId!==admittedSnapshotId)throw new Error("Course Builder Runtime changed; reload before retrying");
  });
  return Response.json({result,...courseBuilderState(sid)});
 }catch(e){return builderError(e);}
}
