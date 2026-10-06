/** The host owns mode selection and the package frame is already bound to one
 * verified snapshot. Rendering the host overlay inside the package would
 * recursively offer another copy of the package frontend. */
export type ModePackStatusKind = "generic" | "learning" | null;
export function SessionModePackOverlay(_props: { sessionId: string; onStatusKind?: (kind: ModePackStatusKind) => void }) {
  return null;
}
export function ModePackOverlay(_props: { onStatusKind?: (kind: ModePackStatusKind) => void }) {
  return null;
}
