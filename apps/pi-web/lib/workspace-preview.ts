export type WorkspacePreviewTarget =
  | { kind: "file"; path: string; cwd?: string }
  | { kind: "assignment-asset"; url: string; title: string; assignmentId: string; path: string; pdfPath: string | null; format: "tex" | "markdown" | "pdf" | "text" }
  | { kind: "artifact"; url: string; title: string; format: "markdown" | "text" | "pdf" | "html" };

const FORMATS = { "assignment-student": "markdown", "assignment-teacher": "markdown", "teacher-notes":"text", "teacher-notes-pdf":"pdf", "teacher-notes-log":"text", tex: "text", log: "text", pdf: "pdf", visual: "html" } as const;

/** Only this session's actual Host exports are previewable as course artifacts. */
export function resolveCourseArtifactPreview(href: string, sessionId: string, origin: string): WorkspacePreviewTarget | null {
  let url: URL;
  try { url = new URL(href, origin); } catch { return null; }
  if (url.origin === origin && url.pathname === "/api/course-builder/assignment-assets" && url.searchParams.get("sessionId") === sessionId) {
    const assignmentId = url.searchParams.get("assignmentId"), path = url.searchParams.get("path");
    if (!assignmentId || !path) return null;
    const extension = path.toLocaleLowerCase().split(".").at(-1);
    const format = extension === "tex" ? "tex" : extension === "rmd" || extension === "md" ? "markdown" : extension === "pdf" ? "pdf" : "text";
    return { kind: "assignment-asset", url: url.pathname + url.search, title: path.split("/").at(-1) ?? path, assignmentId, path, pdfPath: url.searchParams.get("pdfPath"), format };
  }
  if (url.origin !== origin || url.pathname !== "/api/course-builder/export" || url.searchParams.get("sessionId") !== sessionId || !url.searchParams.get("id")) return null;
  const kind = url.searchParams.get("kind");
  if (!kind || !Object.hasOwn(FORMATS, kind)) return null;
  const format = FORMATS[kind as keyof typeof FORMATS];
  const title = kind === "teacher-notes" ? "teacher-notes.tex" : kind === "teacher-notes-pdf" ? "teacher-notes.pdf" : kind === "teacher-notes-log" ? "teacher-notes-compile.log" : kind === "assignment-student" ? "assignment-student.md" : kind === "assignment-teacher" ? "assignment-teacher.md" : kind === "tex" ? "deck.tex" : kind === "log" ? "compile.log" : kind === "pdf" ? "deck.pdf" : "visual.html";
  return { kind: "artifact", url: url.pathname + url.search, title, format };
}
