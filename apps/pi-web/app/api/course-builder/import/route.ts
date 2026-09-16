import { isApiRequestAllowed } from "@/lib/request-security";
import { parseFormDataWithinLimit } from "@/lib/bounded-form-data";
import { saveCourseLibraryFiles } from "@/lib/course-builder-material-library";
import { getCourseBuilderHost,courseBuilderState } from "@/lib/course-builder-service";
import { requireCourseBuilderWorkspace,builderString,builderRevision,builderError } from "@/lib/course-builder-request";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request) {
 if(!isApiRequestAllowed(request))return Response.json({error:"Untrusted request"},{status:403});
 try {
  const sid=builderString(new URL(request.url).searchParams.get("sessionId"));await requireCourseBuilderWorkspace(sid,true);
  const form=await parseFormDataWithinLimit(request,65*1024*1024);
  const revision=builderRevision(Number(form.get("expectedRevision")));
  const files=form.getAll("files");if(files.some(f=>typeof f==="string"))throw new Error("Files required");
  const materials=await Promise.all((files as File[]).map(async(file)=>({name:file.name,bytes:new Uint8Array(await file.arrayBuffer())})));
  await requireCourseBuilderWorkspace(sid,true);
  const root=form.get("root");
  await saveCourseLibraryFiles(getCourseBuilderHost(),sid,materials,revision,typeof root==="string" ? root : undefined,()=>requireCourseBuilderWorkspace(sid,true));
  return Response.json(courseBuilderState(sid));
 }catch(e){return builderError(e);}
}
