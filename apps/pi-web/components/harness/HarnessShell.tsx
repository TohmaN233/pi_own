"use client";

import { type ReactNode, useState } from "react";
import { ModePackOverlay, type ModePackStatusKind } from "@/components/mode-packs/ModePackOverlay";
import { HarnessShell as LearningHarnessShell } from "./HarnessShellBase";
import styles from "./HarnessShellModePack.module.css";

/** Show one Mode Pack selector: the reviewed learner bar for courses, or the generic Pi Own bar otherwise. */
export function HarnessShell({ children }: { children: ReactNode }) {
  const [kind, setKind] = useState<ModePackStatusKind>(null);
  return (
    <div className={kind === "generic" ? styles.generic : styles.shell}>
      <ModePackOverlay onStatusKind={setKind} />
      <LearningHarnessShell>{children}</LearningHarnessShell>
    </div>
  );
}
