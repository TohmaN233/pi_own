import { isApiRequestAllowed } from "@/lib/request-security";
import { parseFormDataWithinLimit } from "@/lib/bounded-form-data";
import { parseCourseBuilderFiles } from "@/lib/course-builder-import";
import { getCourseBuilderHost,courseBuilderState } from "@/lib/course-builder-service";
import { requireCourseBuilderRuntime,builderString,builderRevision,builderError } from "@/lib/course-builder-request";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request) {
 if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
 try {
  const sid=builderString(new URL(request.url).searchParams.get("sessionId"));await requireCourseBuilderRuntime(sid,true);
  const form=await parseFormDataWithinLimit(request,65*1024*1024);
  const revision=builderRevision(Number(form.get("expectedRevision")));
  const files=form.getAll("files");if(files.some(f=>typeof f==="string"))throw new Error("Files required");
  const materials=await parseCourseBuilderFiles(files as File[]);
  await requireCourseBuilderRuntime(sid,true);
  getCourseBuilderHost().importMaterials(sid,materials,revision);
  return Response.json(courseBuilderState(sid));
 }catch(e){return builderError(e);}
}
