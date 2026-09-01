import { Suspense, type ReactNode } from "react";

export default function ModePacksLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p role="status">Loading Mode Packs…</p>}>
      {children}
    </Suspense>
  );
}
