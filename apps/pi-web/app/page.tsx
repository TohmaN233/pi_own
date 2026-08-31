import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { HarnessShell } from "@/components/harness/HarnessShell";
import { I18nProvider } from "@/hooks/useI18n";

export default function Home() {
  return (
    <Suspense>
      <I18nProvider>
        <HarnessShell>
          <AppShell />
        </HarnessShell>
      </I18nProvider>
    </Suspense>
  );
}
