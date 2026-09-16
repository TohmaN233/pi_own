import type { SourceVersion } from "../../../packages/study-research-host/src/types.ts";

/** Import role is historical provenance. Prefer editable primary sources without rewriting old versions. */
export function preferredStudySources<T extends Pick<SourceVersion, "kind" | "sourceRole">>(sources: readonly T[]): T[] {
  const rank = (source: T) => source.sourceRole === "primary"
    ? (source.kind === "tex" || source.kind === "docx" ? 0 : 1)
    : 2;
  return [...sources].sort((left, right) => rank(left) - rank(right));
}
