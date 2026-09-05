import { isApiRequestAllowed } from "@/lib/request-security";
import { getCourseBuilderHost } from "@/lib/course-builder-service";
import { requireCourseBuilderRuntime,builderString,builderError } from "@/lib/course-builder-request";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request) {
 if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
 try {
  const q=new URL(request.url).searchParams,sid=builderString(q.get("sessionId")),id=builderString(q.get("id"));await requireCourseBuilderRuntime(sid);
  const host=getCourseBuilderHost(),kind=q.get("kind");let bytes:Uint8Array|string,filename:string,type:string;
  if(kind==="pdf") {bytes=host.getCompiledPdf(sid,id);filename="deck.pdf";type="application/pdf";}
  else if(kind==="log") {bytes=host.getCompileLog(sid,id);filename="compile.log";type="text/plain";}
  else if(kind==="tex") {const d=host.getSnapshotForSession(sid)?.decks.find(d=>d.deckId===id);if(!d)throw new Error("No deck in this project");bytes=d.source;filename="deck.tex";type="text/plain";}
  else throw new Error("Unknown export kind");
  return new Response(typeof bytes==="string"?bytes:new Uint8Array(bytes),{headers:{"content-type":type,"content-disposition":`attachment; filename="${filename}"`,"cache-control":"no-store","x-content-type-options":"nosniff"}});
 }catch(e){return builderError(e);}
}
