export type WorkspacePreviewTarget =
  | { kind: "file"; path: string; cwd?: string }
  | { kind: "artifact"; url: string; title: string; format: "markdown" | "text" | "pdf" | "html" };

const FORMATS = { "assignment-student": "markdown", "assignment-teacher": "markdown", tex: "text", log: "text", pdf: "pdf", visual: "html" } as const;

/** Only this session's actual Host exports are previewable as course artifacts. */
export function resolveCourseArtifactPreview(href: string, sessionId: string, origin: string): WorkspacePreviewTarget | null {
  let url: URL;
  try { url = new URL(href, origin); } catch { return null; }
  if (url.origin !== origin || url.pathname !== "/api/course-builder/export" || url.searchParams.get("sessionId") !== sessionId || !url.searchParams.get("id")) return null;
  const kind = url.searchParams.get("kind");
  if (!kind || !Object.hasOwn(FORMATS, kind)) return null;
  const format = FORMATS[kind as keyof typeof FORMATS];
  const title = kind === "assignment-student" ? "assignment-student.md" : kind === "assignment-teacher" ? "assignment-teacher.md" : kind === "tex" ? "deck.tex" : kind === "log" ? "compile.log" : kind === "pdf" ? "deck.pdf" : "visual.html";
  return { kind: "artifact", url: url.pathname + url.search, title, format };
}
