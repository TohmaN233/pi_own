"use client";

import { useEffect, useState } from "react";
import type { SourceUpdateDetails, SourceUpdateProposal } from "../../../../packages/study-research-host/src/types.ts";
import styles from "@/app/study/Study.module.css";

export function StudySourceUpdates({ sessionId, proposals, busy, onDecision }: {
  sessionId: string; proposals: SourceUpdateProposal[]; busy: boolean;
  onDecision: (proposal: SourceUpdateProposal, decision: "accept" | "reject") => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<SourceUpdateDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedProposal = proposals.find((proposal) => proposal.proposalId === selected);
  const version = selectedProposal ? `${selectedProposal.proposalId}:${selectedProposal.status}:${selectedProposal.candidateHash}` : "";
  useEffect(() => {
    setDetails(null); setError(null);
    if (!selected || !version) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(`/api/study-research?${new URLSearchParams({ sessionId, action: "source-update", proposalId: selected })}`, { cache: "no-store", signal: controller.signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `无法读取候选更新 (${response.status})`);
      if (value.proposal?.proposalId !== selected || !value.affected || !value.candidateKnowledge) throw new Error("候选更新身份或内容无效");
      if (!controller.signal.aborted) setDetails(value as SourceUpdateDetails);
    })().catch((value: unknown) => { if (!controller.signal.aborted) { console.error("[study] source proposal read failed", value); setError(value instanceof Error ? value.message : String(value)); } });
    return () => controller.abort();
  }, [selected, sessionId, version]);
  if (proposals.length === 0) return null;
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  return <section className={styles.section} aria-label="来源变化与候选更新">
    <div className={styles.sectionHeader}><div><h3>来源变化与候选更新</h3><p>蓝色为改写，绿色为新增。人工记录保留；未重新确认的旧内容继续标为待核对。</p></div><span className={styles.statusBadge}>{pending.length} 项待确认</span></div>
    <div className={styles.readerButtons}>{proposals.map((proposal) => <button key={proposal.proposalId} className={styles.button} type="button" onClick={() => setSelected(proposal.proposalId)}>
      {proposal.status === "pending" ? "待确认" : proposal.status === "accepted" ? "已采纳" : proposal.status === "rejected" ? "已拒绝" : "已由新候选替代"} · {proposal.changeSummary.slice(0, 60)}
    </button>)}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {selected && !details && !error && <p role="status">正在读取差异…</p>}
    {details && <div className={styles.form}>
      <h4>{details.candidate.relativePath}</h4><p>{details.proposal.changeSummary}</p>
      {details.candidateKnowledge.notes.map((note, index) => {
        const before = note.replaceNoteId ? details.affected.notes.find((item) => item.noteId === note.replaceNoteId) : undefined;
        return <ChangePair key={`note:${index}`} label="笔记" before={before?.body} after={note.body} />;
      })}
      {details.candidateKnowledge.nodes.map((node) => {
        const before = node.replaceNodeId ? details.affected.nodes.find((item) => item.nodeId === node.replaceNodeId) : undefined;
        return <ChangePair key={`node:${node.localKey}`} label={`知识：${node.title}`} before={before?.statement} after={node.statement} />;
      })}
      <details className={styles.debugDetails}><summary>查看保留的旧记录与来源版本</summary>
        <p>旧来源：{details.proposal.previousHash}<br />候选来源：{details.proposal.candidateHash}</p>
        {details.affected.notes.filter((note) => !details.candidateKnowledge.notes.some((candidate) => candidate.replaceNoteId === note.noteId)).map((note) => <p key={note.noteId}>保留、待核对：{note.body}</p>)}
      </details>
      {details.proposal.status === "pending" && <div className={styles.formFooter}>
        <p className={styles.formHint}>确认时重新检查源文件及受影响记录；采纳后删除本次临时备份。</p>
        <div className={styles.readerButtons}><button type="button" className={styles.button} disabled={busy} onClick={() => void onDecision(details.proposal, "reject")}>拒绝，恢复并保留待核对标记</button>
          <button type="button" className={styles.buttonPrimary} disabled={busy} onClick={() => void onDecision(details.proposal, "accept")}>同意此候选更新</button></div>
      </div>}
    </div>}
  </section>;
}

function ChangePair({ label, before, after }: { label: string; before?: string; after: string }) {
  return <article className={styles.note}>
    <strong>{label} · {before === undefined ? "新增" : "改写"}</strong>
    {before !== undefined && <p><span style={{ color: "var(--text-muted)" }}>原文：</span>{before}</p>}
    <p style={{ color: before === undefined ? "#168146" : "#266bd5", whiteSpace: "pre-wrap" }}>候选：{after}</p>
  </article>;
}
