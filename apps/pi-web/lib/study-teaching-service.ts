import { randomUUID } from "node:crypto";
import { contentHash, stableStringify } from "../../../packages/harness-core/src/index.ts";
import type { KnowledgeNote, ResearchResult, VisualizationDraft } from "../../../packages/study-research-host/src/types.ts";
import type { StudyTeachingHost } from "../../../packages/study-research-host/src/study-teaching-host.ts";
import { getLearningHarness } from "./harness-server";
import { assertCourseBuilderSession, courseBuilderWorkspaceState } from "./course-builder-service";
import { resolveDeliveryTarget } from "./course-builder-delivery-target";
import { studyContext } from "./study-research-service";
import { studyVisualRuntimeIdentity } from "./study-visual-sandbox";
import { resolveSessionPath } from "./session-reader";

type VisualGate=ReturnType<StudyTeachingHost["visualGate"]>;
export interface StudyTeachingCopy {
  version:1;
  copyId:string;
  owner:{kind:"course-builder";projectId:string;lessonPlanId:string;lessonRevision:number;lessonHash:string;week:number;session:number};
  origin:{projectId:string;sessionId:string;kind:"note"|"result"|"visualization";id:string;revision:number;hash:string};
  sources:Array<{sourceId:string;contentHash:string;relativePath:string;parser:string;version:number}>;
  payload:{kind:"note";note:KnowledgeNote}|{kind:"result";result:ResearchResult}|{kind:"visualization";visualization:VisualizationDraft;gate:VisualGate};
  createdAt:string;
  contentHash:string;
}

async function courseSnapshot(sessionId:string) {
  assertCourseBuilderSession(sessionId);
  if(!await resolveSessionPath(sessionId))throw new Error("The selected course conversation is unavailable");
  const snapshot=getLearningHarness().courseBuilder.getSnapshotForSession(sessionId);
  if(!snapshot)throw new Error("Select a real bound Course Builder conversation");
  return snapshot;
}

export async function studyTeachingTargets(sessionId:string) {
  await studyContext(sessionId);
  const state=await courseBuilderWorkspaceState(null),host=getLearningHarness().courseBuilder;
  return state.projects.flatMap(project=>(state.projectSessions[project.projectId]??[]).map(courseSessionId=>{
    const snapshot=host.getSnapshotForSession(courseSessionId);
    return {courseSessionId,projectId:project.projectId,title:project.title,revision:project.revision,lessons:snapshot?.lessonPlans.map(lesson=>({lessonPlanId:lesson.lessonPlanId,title:lesson.title,revision:lesson.revision,contentHash:lesson.contentHash,week:lesson.week,session:lesson.session,status:lesson.status}))??[]};
  }));
}

export async function studyTeachingState(sessionId:string) {
  const targets=await studyTeachingTargets(sessionId),{host,scope}=await studyContext(sessionId);
  return {targets,items:[...host.getKnowledge(scope).notes.map(note=>({kind:"note" as const,id:note.noteId,revision:note.revision,hash:note.contentHash,label:note.body.slice(0,120),eligible:!note.stale})),...host.listResults(scope).map(result=>({kind:"result" as const,id:result.resultId,revision:result.revision,hash:result.contentHash,label:result.summary.slice(0,120),eligible:result.state==="confirmed"})),...host.listVisualizations(scope).map(visual=>({kind:"visualization" as const,id:visual.visualizationId,revision:visual.revision,hash:visual.contentHash,label:visual.purpose.slice(0,120),eligible:getLearningHarness().studyTeaching.visualGate(scope,visual.visualizationId,contentHash(studyVisualRuntimeIdentity())).ready}))]};
}

/** User-initiated copy into an existing Host-owned course; the Study session is never rebound. */
export async function transferStudyTeachingCopy(input:{sessionId:string;expectedPhaseRevision:number;courseSessionId:string;expectedCourseRevision:number;lessonPlanId:string;expectedLessonRevision:number;week:number;session:number;kind:"note"|"result"|"visualization";id:string;revision:number;hash:string;requestId:string}) {
  if(!/^[a-zA-Z0-9-]{16,80}$/u.test(input.requestId))throw new Error("Teaching transfer requires a stable request ID");
  const context=await studyContext(input.sessionId,input.expectedPhaseRevision);
  const snapshot=await courseSnapshot(input.courseSessionId);
  const target=resolveDeliveryTarget(snapshot,{kind:"visual",lessonPlanId:input.lessonPlanId,week:input.week,session:input.session});
  const lesson=snapshot.lessonPlans.find(item=>item.lessonPlanId===target.lessonPlanId);
  if(!lesson||lesson.revision!==input.expectedLessonRevision)throw new Error("Teaching lesson revision changed");
  const harness=getLearningHarness(),name=`study-copy-${input.requestId}.json`;
  const requestHash=contentHash(input);
  const existing=snapshot.materials.find(item=>item.name===name);
  if(existing){if(existing.metadata.studyRequestHash!==requestHash)throw new Error("Teaching request ID was reused with different content");return {materialId:existing.materialId,replay:true};}
  if(snapshot.project.revision!==input.expectedCourseRevision)throw new Error("Course project revision changed before transfer");
  const current=await studyContext(input.sessionId,input.expectedPhaseRevision);
  if(current.scope.projectId!==context.scope.projectId)throw new Error("Study project changed during teaching transfer");
  let payload:StudyTeachingCopy["payload"];
  if(input.kind==="visualization"){
    const visualization=current.host.getVisualizationDraft(current.scope,input.id);
    const gate=harness.studyTeaching.visualGate(current.scope,input.id,contentHash(studyVisualRuntimeIdentity()));
    if(!gate.ready)throw new Error(`Visualization remains a draft: ${gate.reasons.join(" ")}`);
    payload={kind:"visualization",visualization,gate};
  }else if(input.kind==="result"){
    const result=current.host.getResult(current.scope,input.id);
    const reviews=current.host.listIndependentReviews(current.scope,{targetKind:"result",targetId:result.resultId,targetHash:result.contentHash,targetRevision:result.revision});
    if(result.state!=="confirmed"||!reviews.some(review=>review.status==="passed")||reviews.some(review=>review.status!=="passed"))throw new Error("Research result is not a confirmed, independently reviewed conclusion");
    payload={kind:"result",result};
  }else if(input.kind==="note"){
    const note=current.host.getKnowledge(current.scope).notes.find(item=>item.noteId===input.id);
    if(!note||note.stale)throw new Error("Note is unavailable or stale");
    payload={kind:"note",note};
  }else throw new Error("Unknown teaching source kind");
  const item=payload.kind==="visualization"?payload.visualization:payload.kind==="result"?payload.result:payload.note;
  if(item.revision!==input.revision||item.contentHash!==input.hash)throw new Error("Study source revision changed before transfer");
  const raw={version:1 as const,copyId:`teaching-copy_${input.requestId}`,owner:{kind:"course-builder" as const,projectId:snapshot.project.projectId,lessonPlanId:lesson.lessonPlanId,lessonRevision:lesson.revision,lessonHash:lesson.contentHash,week:lesson.week,session:lesson.session},origin:{projectId:current.scope.projectId,sessionId:input.sessionId,kind:input.kind,id:input.id,revision:input.revision,hash:input.hash},sources:current.host.listSources(current.scope).map(({sourceId,contentHash,relativePath,parser,version})=>({sourceId,contentHash,relativePath,parser,version})),payload,createdAt:new Date().toISOString()};
  const copy:StudyTeachingCopy={...raw,contentHash:contentHash(raw)};
  const serialized=stableStringify(copy);
  const label=payload.kind==="note"?payload.note.body:payload.kind==="result"?payload.result.summary:payload.visualization.purpose;
  const latest=harness.courseBuilder.getSnapshotForSession(input.courseSessionId)?.lessonPlans.find(item=>item.lessonPlanId===lesson.lessonPlanId);
  if(!latest||latest.revision!==lesson.revision||latest.contentHash!==lesson.contentHash)throw new Error("Teaching lesson changed during transfer");
  const [material]=harness.courseBuilder.importMaterials(input.courseSessionId,[{name,kind:"asset",sourceBytes:Buffer.from(serialized),extractedText:`Study 学习成果独立副本（待课程教师批准）\n${label}\n来源项目 ${current.scope.projectId}，${input.id} r${input.revision} ${input.hash}\n课程第 ${lesson.week} 周第 ${lesson.session} 次；不自动改写原 Study 内容。`,metadata:{studyCopyVersion:1,studyCopyHash:copy.contentHash,studyRequestHash:requestHash,studyLessonId:lesson.lessonPlanId,studyOriginKind:input.kind}}],input.expectedCourseRevision);
  console.info("[study-teaching] immutable course copy created",{originProjectId:current.scope.projectId,courseProjectId:snapshot.project.projectId,materialId:material.materialId,copyHash:copy.contentHash});
  return {materialId:material.materialId,replay:false};
}

export async function courseStudyCopies(sessionId:string,lessonPlanId?:string) {
  const snapshot=await courseSnapshot(sessionId),harness=getLearningHarness();
  const copies=snapshot.materials.filter(item=>item.metadata.studyCopyVersion===1&&(!lessonPlanId||item.metadata.studyLessonId===lessonPlanId)).map(material=>{
    const copy=JSON.parse(Buffer.from(harness.courseBuilder.getMaterialBytes(sessionId,material.materialId)).toString("utf8")) as StudyTeachingCopy;
    const {contentHash:hash,...raw}=copy;
    if(copy.version!==1||contentHash(raw)!==hash||material.metadata.studyCopyHash!==hash||copy.owner.projectId!==snapshot.project.projectId||copy.owner.kind!=="course-builder"||copy.owner.lessonPlanId!==material.metadata.studyLessonId)throw new Error("Teaching copy identity or ownership mismatch");
    const lesson=snapshot.lessonPlans.find(item=>item.lessonPlanId===copy.owner.lessonPlanId);
    const approval=harness.studyTeaching.teachingApproval(sessionId,material.materialId);
    const currentLesson=!!lesson&&lesson.status==="approved"&&lesson.revision===copy.owner.lessonRevision&&lesson.contentHash===copy.owner.lessonHash&&snapshot.semesterPlan?.status==="approved"&&lesson.semesterPlanId===snapshot.semesterPlan.semesterPlanId&&lesson.semesterPlanRevision===snapshot.semesterPlan.revision;
    const rendererCurrent=copy.payload.kind!=="visualization"||copy.payload.visualization.environmentHash===contentHash(studyVisualRuntimeIdentity());
    const approved=!!approval&&approval.copyHash===hash&&approval.lessonRevision===lesson?.revision&&approval.lessonHash===lesson?.contentHash&&currentLesson&&rendererCurrent;
    return {materialId:material.materialId,copy,approval,approved,canApprove:currentLesson&&rendererCurrent,reason:!currentLesson?"教案未批准或已变更，需要对当前教案重新移交。":!rendererCurrent?"渲染器已更新，需要重新验证并移交。":!approval?"等待课程教师批准这份独立副本。":null};
  });
  return {project:{projectId:snapshot.project.projectId,title:snapshot.project.title,revision:snapshot.project.revision},copies};
}
export async function approveCourseStudyCopy(input:{sessionId:string;materialId:string;copyHash:string;lessonRevision:number;confirmed:boolean}) {
  if(input.confirmed!==true)throw new Error("Explicit teacher confirmation is required");
  const state=await courseStudyCopies(input.sessionId),entry=state.copies.find(item=>item.materialId===input.materialId);
  if(!entry||entry.copy.contentHash!==input.copyHash||entry.copy.owner.lessonRevision!==input.lessonRevision||!entry.canApprove)throw new Error("Teaching copy or lesson changed before approval");
  return getLearningHarness().studyTeaching.approveTeachingCopy(input.sessionId,{materialId:entry.materialId,courseProjectId:entry.copy.owner.projectId,copyHash:entry.copy.contentHash,lessonPlanId:entry.copy.owner.lessonPlanId,lessonRevision:entry.copy.owner.lessonRevision,lessonHash:entry.copy.owner.lessonHash},`ui-teaching-copy:${randomUUID()}`);
}
