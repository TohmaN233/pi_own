import { isApiRequestAllowed } from "@/lib/request-security";
import { getCourseBuilderHost } from "@/lib/course-builder-service";
import { requireCourseBuilderWorkspace, builderString, builderError } from "@/lib/course-builder-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Source and revision must be read together; the course overview deliberately omits source. */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const query = new URL(request.url).searchParams;
    const sessionId = builderString(query.get("sessionId"));
    const deckId = builderString(query.get("id"));
    await requireCourseBuilderWorkspace(sessionId);
    const deck = getCourseBuilderHost().getSnapshotForSession(sessionId)?.decks.find((item) => item.deckId === deckId);
    if (!deck) return Response.json({ error: "当前课程没有这份课件。" }, { status: 404 });
    if (typeof deck.source !== "string" || !deck.source.trim()) throw new Error(`Saved TeX source is missing: ${deckId} r${deck.revision}`);
    console.info("[course-builder] read editable TeX", { sessionId, deckId, revision: deck.revision, sourceCharacters: deck.source.length });
    return Response.json({ deck, compilerEnabled: process.env.PI_COURSE_BUILDER_TRUSTED_TEX === "1" }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return builderError(error); }
}
