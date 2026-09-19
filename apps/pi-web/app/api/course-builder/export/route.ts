import { isApiRequestAllowed } from "@/lib/request-security";
import { getCourseBuilderHost } from "@/lib/course-builder-service";
import { requireCourseBuilderWorkspace,builderString,builderError } from "@/lib/course-builder-request";
import { assignmentMarkdown } from "@/lib/course-builder-assignment-markdown";
export const runtime="nodejs";
export const dynamic="force-dynamic";

export async function GET(request:Request) {
 if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
 try {
  const q=new URL(request.url).searchParams,sid=builderString(q.get("sessionId")),id=builderString(q.get("id"));await requireCourseBuilderWorkspace(sid);
  const host=getCourseBuilderHost(),kind=q.get("kind");let bytes:Uint8Array|string,filename:string,type:string,disposition="attachment";
  if(kind==="pdf") {bytes=host.getCompiledPdf(sid,id);filename="deck.pdf";type="application/pdf";disposition=q.get("download")==="1"?"attachment":"inline";}
  else if(kind==="log") {bytes=host.getCompileLog(sid,id);filename="compile.log";type="text/plain";}
  else if(kind==="tex") {const d=host.getSnapshotForSession(sid)?.decks.find(d=>d.deckId===id);if(!d)throw new Error("No deck in this project");bytes=d.source;filename="deck.tex";type="text/plain";}
  else if(kind==="teacher-notes") {const notes=host.getTeacherNotes(sid,id);bytes=notes.source;filename="teacher-notes.tex";type="text/plain; charset=utf-8";}
  else if(kind==="teacher-notes-pdf") {bytes=host.getTeacherNotesPdf(sid,id);filename="teacher-notes.pdf";type="application/pdf";disposition=q.get("download")==="1"?"attachment":"inline";}
  else if(kind==="teacher-notes-log") {bytes=host.getTeacherNotesCompileLog(sid,id);filename="teacher-notes-compile.log";type="text/plain; charset=utf-8";}
  else if(kind==="visual") {const v=host.getSnapshotForSession(sid)?.visuals.find(v=>v.visualId===id);if(!v)throw new Error("No visual in this project");bytes=v.artifact.html;filename="visual.html";type="text/html; charset=utf-8";disposition="inline";}
  else if(kind==="assignment-student"||kind==="assignment-teacher") {const a=host.getAssignment(sid,id),project=host.getProjectForSession(sid);if(!project)throw new Error("No course project");bytes=assignmentMarkdown(a,kind==="assignment-teacher",project);filename=kind==="assignment-teacher"?"assignment-teacher.md":"assignment-student.md";type="text/markdown; charset=utf-8";disposition=q.get("download")==="1"?"attachment":"inline";}
  else throw new Error("Unknown export kind");
  return new Response(typeof bytes==="string"?bytes:new Uint8Array(bytes),{headers:{"content-type":type,"content-disposition":`${disposition}; filename="${filename}"`,"cache-control":"no-store","x-content-type-options":"nosniff",...(kind==="visual"?{"content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}:{})}});
 }catch(e){return builderError(e);}
}
