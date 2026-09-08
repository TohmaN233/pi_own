import { isApiRequestAllowed } from "@/lib/request-security";
import { getCourseBuilderHost } from "@/lib/course-builder-service";
import { requireCourseBuilderWorkspace,builderString,builderError } from "@/lib/course-builder-request";
import type { CourseBuilderAssignment } from "../../../../../../packages/course-builder-host/src/index.ts";
export const runtime="nodejs";
export const dynamic="force-dynamic";

function assignmentMarkdown(assignment:CourseBuilderAssignment,teacherCopy:boolean):string {
 const draft=assignment.draft;if(!draft)throw new Error("Assignment draft is unavailable");
 const section=(title:string,items:string[],ordered=false)=>`## ${title}\n\n${items.map((item,index)=>`${ordered?`${index+1}.`:"-"} ${item}`).join("\n")}`;
 return [
  `# ${assignment.title}`,
  draft.overview,
  section("任务",draft.tasks,true),
  section("提交内容",draft.deliverables),
  section("评分标准",draft.rubric),
  ...(teacherCopy?[section("教师用解题提示",draft.solutionNotes)]:[]),
  `---\nAssignment ID: ${assignment.assignmentId}  \nRevision: ${assignment.revision}  \nStatus: ${assignment.status}`,
 ].join("\n\n")+"\n";
}
export async function GET(request:Request) {
 if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
 try {
  const q=new URL(request.url).searchParams,sid=builderString(q.get("sessionId")),id=builderString(q.get("id"));await requireCourseBuilderWorkspace(sid);
  const host=getCourseBuilderHost(),kind=q.get("kind");let bytes:Uint8Array|string,filename:string,type:string,disposition="attachment";
  if(kind==="pdf") {bytes=host.getCompiledPdf(sid,id);filename="deck.pdf";type="application/pdf";disposition=q.get("download")==="1"?"attachment":"inline";}
  else if(kind==="log") {bytes=host.getCompileLog(sid,id);filename="compile.log";type="text/plain";}
  else if(kind==="tex") {const d=host.getSnapshotForSession(sid)?.decks.find(d=>d.deckId===id);if(!d)throw new Error("No deck in this project");bytes=d.source;filename="deck.tex";type="text/plain";}
  else if(kind==="visual") {const v=host.getSnapshotForSession(sid)?.visuals.find(v=>v.visualId===id);if(!v)throw new Error("No visual in this project");bytes=v.artifact.html;filename="visual.html";type="text/html; charset=utf-8";disposition="inline";}
  else if(kind==="assignment-student"||kind==="assignment-teacher") {const a=host.getAssignment(sid,id);bytes=assignmentMarkdown(a,kind==="assignment-teacher");filename=kind==="assignment-teacher"?"assignment-teacher.md":"assignment-student.md";type="text/markdown; charset=utf-8";}
  else throw new Error("Unknown export kind");
  return new Response(typeof bytes==="string"?bytes:new Uint8Array(bytes),{headers:{"content-type":type,"content-disposition":`${disposition}; filename="${filename}"`,"cache-control":"no-store","x-content-type-options":"nosniff",...(kind==="visual"?{"content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}:{})}});
 }catch(e){return builderError(e);}
}
