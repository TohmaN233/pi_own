import { isApiRequestAllowed } from "@/lib/request-security";
import { isStudyBrowserMutation } from "@/lib/study-user-action";
import { readStudyRequest,studyApiError,studyInteger,studyText } from "@/lib/study-api-request";
import { approveCourseStudyCopy,courseStudyCopies } from "@/lib/study-teaching-service";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
  try{const q=new URL(request.url).searchParams;return Response.json(await courseStudyCopies(studyText(q.get("sessionId"),"sessionId"),q.has("lessonPlanId")?studyText(q.get("lessonPlanId"),"lessonPlanId"):undefined),{headers:{"cache-control":"no-store"}});}catch(error){return studyApiError(error);}
}
export async function POST(request:Request){
  if(!isStudyBrowserMutation(request))return Response.json({error:"Untrusted teacher confirmation"},{status:403});
  try{const b=await readStudyRequest(request);return Response.json(await approveCourseStudyCopy({sessionId:studyText(b.sessionId,"sessionId"),materialId:studyText(b.materialId,"materialId"),copyHash:studyText(b.copyHash,"copyHash"),lessonRevision:studyInteger(b.lessonRevision,"lessonRevision",1),confirmed:b.confirmed===true}));}catch(error){return studyApiError(error);}
}
