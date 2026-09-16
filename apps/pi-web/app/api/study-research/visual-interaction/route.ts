import { isApiRequestAllowed } from "@/lib/request-security";
import { isStudyBrowserMutation } from "@/lib/study-user-action";
import { readStudyRequest,studyApiError,studyInteger,studyText } from "@/lib/study-api-request";
import { recordStudyVisualInteraction,studyVisualInteractionState } from "@/lib/study-visual-interaction-service";
import type { BrowserVisualObservation } from "../../../../../../packages/study-research-host/src/study-teaching-host.ts";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
  try{const q=new URL(request.url).searchParams;return Response.json(await studyVisualInteractionState(studyText(q.get("sessionId"),"sessionId"),studyText(q.get("visualizationId"),"visualizationId")),{headers:{"cache-control":"no-store"}});}catch(error){return studyApiError(error);}
}
export async function POST(request:Request){
  if(!isStudyBrowserMutation(request))return Response.json({error:"Untrusted browser mutation"},{status:403});
  try{const b=await readStudyRequest(request);return Response.json(await recordStudyVisualInteraction({sessionId:studyText(b.sessionId,"sessionId"),expectedPhaseRevision:studyInteger(b.expectedPhaseRevision,"expectedPhaseRevision",1),visualizationId:studyText(b.visualizationId,"visualizationId"),revision:studyInteger(b.revision,"revision",1),targetHash:studyText(b.targetHash,"targetHash"),specificationId:studyText(b.specificationId,"specificationId"),specificationRevision:studyInteger(b.specificationRevision,"specificationRevision",1),observations:b.observations as BrowserVisualObservation[]}));}catch(error){return studyApiError(error);}
}
