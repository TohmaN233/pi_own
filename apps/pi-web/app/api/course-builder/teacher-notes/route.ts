import { isApiRequestAllowed } from "@/lib/request-security";
import { getCourseBuilderHost } from "@/lib/course-builder-service";
import { requireCourseBuilderWorkspace, builderString, builderError } from "@/lib/course-builder-request";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({error:"Untrusted request"},{status:403});
  try {
    const query=new URL(request.url).searchParams,sessionId=builderString(query.get("sessionId")),id=builderString(query.get("id"));
    await requireCourseBuilderWorkspace(sessionId);
    const host=getCourseBuilderHost(),notes=host.getTeacherNotes(sessionId,id);
    const snapshot=host.getSnapshotForSession(sessionId);
    const deck=snapshot?.decks.find(item=>item.deckId===notes.deckId);
    if(!deck)throw new Error("教师讲稿对应的课件不存在，请检查课程记录。");
    console.info("[course-builder] read teacher notes",{sessionId,notesId:notes.notesId,revision:notes.revision,deckRevision:notes.deckRevision});
    const compileReceipt=snapshot?.teacherNotesCompileReceipts.filter(receipt=>receipt.notesId===notes.notesId && receipt.notesRevision===notes.revision && receipt.sourceHash===notes.sourceHash).at(-1) ?? null;
    const sourceSyncAvailable=!!compileReceipt?.succeeded && host.hasTeacherNotesSyncTex(sessionId,compileReceipt.receiptId);
    return Response.json({notes,currentDeckRevision:deck.revision,compilerEnabled:process.env.PI_COURSE_BUILDER_TRUSTED_TEX==="1",compileReceipt,sourceSyncAvailable},{headers:{"cache-control":"no-store"}});
  } catch(error) {return builderError(error);}
}
