"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  getHarnessPractice,
  PracticeOperationKeys,
  type HarnessPracticeExercise,
  type HarnessPracticeInstance,
  requestHarnessPracticeHint,
  revealHarnessPracticeSolution,
  startHarnessPractice,
  submitHarnessPracticeAttempt,
  type HarnessPracticeAttemptResult,
} from "@/lib/harness-client";
import styles from "./HarnessShell.module.css";

export function PracticePanel({ sessionId, onError }: { sessionId: string; onError: (message: string) => void }) {
  const [exercises, setExercises] = useState<HarnessPracticeExercise[]>([]);
  const [exercise, setExercise] = useState<HarnessPracticeExercise | null>(null);
  const [instance, setInstance] = useState<HarnessPracticeInstance | null>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<HarnessPracticeAttemptResult | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [solution, setSolution] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const operationKeys = useRef(new PracticeOperationKeys()).current;

  const beginOperation = () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    return true;
  };

  const finishOperation = () => {
    inFlight.current = false;
    setBusy(false);
  };

  useEffect(() => {
    let active = true;
    void getHarnessPractice(sessionId)
      .then((value) => {
        if (active) setExercises(value.exercises);
      })
      .catch((error) => {
        if (active) onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [onError, sessionId]);

  const start = async (next: HarnessPracticeExercise) => {
    if (!beginOperation()) return;
    try {
      const idempotencyKey = operationKeys.start(next.exerciseId);
      const started = await startHarnessPractice(sessionId, next.exerciseId, idempotencyKey);
      operationKeys.completeStart(next.exerciseId);
      setExercise(started.exercise);
      setInstance(started.instance);
      setAnswer("");
      setResult(null);
      setHints([]);
      setSolution(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOperation();
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedAnswer = answer.trim();
    if (!instance || !normalizedAnswer) return;
    if (!beginOperation()) return;
    try {
      const idempotencyKey = operationKeys.attempt(instance.instanceId, normalizedAnswer);
      const submitted = await submitHarnessPracticeAttempt(sessionId, instance.instanceId, normalizedAnswer, idempotencyKey);
      operationKeys.completeAttempt(instance.instanceId, normalizedAnswer);
      setResult(submitted);
      setSolution(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOperation();
    }
  };

  const requestHint = async () => {
    if (!instance || !exercise) return;
    if (!beginOperation()) return;
    try {
      const next = await requestHarnessPracticeHint(sessionId, instance.instanceId, hints.length + 1);
      setHints((current) => [...current, next.hint]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOperation();
    }
  };

  const reveal = async () => {
    if (!result || solution !== null) return;
    if (!beginOperation()) return;
    try {
      setSolution((await revealHarnessPracticeSolution(sessionId, result.attempt.attemptId)).solution);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOperation();
    }
  };

  return (
    <section className={styles.panel} aria-label="Practice exercises">
      <h2 className={styles.panelTitle}>Practice</h2>
      {!instance && (
        <div className={styles.results}>
          {exercises.length === 0 && <p className={styles.empty}>No exercises are available for this course.</p>}
          {exercises.map((item) => (
            <button className={styles.result} type="button" key={item.exerciseId} onClick={() => void start(item)} disabled={busy}>
              <span>{item.prompt}</span>
              <span className={styles.resultMeta}>{item.conceptIds.join(", ") || "course practice"} · {item.hintCount} hints</span>
            </button>
          ))}
        </div>
      )}
      {instance && exercise && (
        <div className={styles.form}>
          <p className={styles.practicePrompt}>{exercise.prompt}</p>
          <form className={styles.form} onSubmit={submit}>
            <label>
              Your reasoning or answer
              <textarea className={styles.textarea} value={answer} onChange={(event) => setAnswer(event.target.value)} rows={5} />
            </label>
            <button className={styles.button} type="submit" disabled={busy || !answer.trim()}>Submit attempt</button>
          </form>
          {hints.map((hint, index) => <p className={styles.hint} key={`${index}:${hint}`}>Hint {index + 1}: {hint}</p>)}
          {hints.length < exercise.hintCount && <button className={styles.button} type="button" onClick={() => void requestHint()} disabled={busy}>Show hint {hints.length + 1}</button>}
          {result && (
            <div className={styles.practiceFeedback}>
              <span>{result.attempt.meaningful ? "Meaningful attempt recorded." : "A concrete reasoning attempt is required before solution access."}</span>
              <span>{result.evaluation.feedback}</span>
              {result.solutionAvailable && solution === null && <button className={styles.button} type="button" onClick={() => void reveal()} disabled={busy}>Reveal solution once</button>}
              {solution !== null && <pre className={styles.sourceText}>{solution}</pre>}
            </div>
          )}
          <button className={styles.button} type="button" onClick={() => { setInstance(null); setExercise(null); setResult(null); setHints([]); setSolution(null); }} disabled={busy}>Back to exercises</button>
        </div>
      )}
    </section>
  );
}
