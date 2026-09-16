"use client";

import { Suspense } from "react";
import { StudyWorkspace } from "@/components/study/StudyWorkspace";
import { I18nProvider } from "@/hooks/useI18n";
import styles from "./Study.module.css";

function StudyLoading() {
	return <main className={styles.page}><div className={styles.content}><div className={styles.loading} role="status"><span className={styles.spinner}/><strong>正在打开 Study 工作区…</strong></div></div></main>;
}

export default function StudyPage() {
	return <I18nProvider><Suspense fallback={<StudyLoading />}><StudyWorkspace /></Suspense></I18nProvider>;
}
