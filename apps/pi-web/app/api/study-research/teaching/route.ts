import { isApiRequestAllowed } from "@/lib/request-security";
import { isStudyBrowserMutation } from "@/lib/study-user-action";
import { readStudyRequest,studyApiError,studyInteger,studyText } from "@/lib/study-api-request";
import { studyTeachingState,transferStudyTeachingCopy } from "@/lib/study-teaching-service";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
  try{return Response.json(await studyTeachingState(studyText(new URL(request.url).searchParams.get("sessionId"),"sessionId")),{headers:{"cache-control":"no-store"}});}catch(error){return studyApiError(error);}
}
export async function POST(request:Request){
  if(!isStudyBrowserMutation(request))return Response.json({error:"Untrusted browser mutation"},{status:403});
  try{const b=await readStudyRequest(request);return Response.json(await transferStudyTeachingCopy({sessionId:studyText(b.sessionId,"sessionId"),expectedPhaseRevision:studyInteger(b.expectedPhaseRevision,"expectedPhaseRevision",1),courseSessionId:studyText(b.courseSessionId,"courseSessionId"),expectedCourseRevision:studyInteger(b.expectedCourseRevision,"expectedCourseRevision",1),lessonPlanId:studyText(b.lessonPlanId,"lessonPlanId"),expectedLessonRevision:studyInteger(b.expectedLessonRevision,"expectedLessonRevision",1),week:studyInteger(b.week,"week",1),session:studyInteger(b.session,"session",1),kind:studyText(b.kind,"kind") as "note"|"result"|"visualization",id:studyText(b.id,"id"),revision:studyInteger(b.revision,"revision",1),hash:studyText(b.hash,"hash"),requestId:studyText(b.requestId,"requestId")}));}catch(error){return studyApiError(error);}
}
