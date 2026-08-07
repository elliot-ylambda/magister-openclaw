import {
  isCompactionFailureError,
  isLikelyContextOverflowError,
} from "../pi-embedded-helpers/errors.js";

/**
 * Magister fork: runId-keyed coordination between the embedded run loop's
 * retries (run.ts) and per-attempt terminal lifecycle emission
 * (pi-embedded-subscribe.handlers.lifecycle.ts).
 *
 * The run loop's `while (true)` reuses one runId across every attempt, but the
 * SDK fires `agent end` per attempt — so a retried attempt's terminal lifecycle
 * event is not terminal for the run. Emitting it anyway makes stream
 * subscribers (openai-http.ts chat completions, agent.wait waiters) finalize
 * while the run keeps working; the retried turn then completes headless and its
 * output never reaches the subscriber.
 *
 * That has now happened twice. The June 2026 orphaned webchat kickoff incident
 * was the context-overflow retry, and this registry was written for it. On
 * 2026-08-07 the same thing happened on the empty-response retry: GPT-5.6
 * returned no visible text, the run loop retried and produced the real answer
 * 13s later, and the user saw "Agent didn't return a response" because the
 * stream had already been closed by attempt 1's `phase: "end"`. The first fix
 * only covered `phase: "error"` — the four non-error retry paths went through
 * an unguarded emission — which is why this is named for retries in general
 * rather than for overflow.
 *
 * Contract:
 * - run.ts arms budget predicates at run start (armAttemptRetryRecovery) and
 *   disarms in its finally (disarmAttemptRetryRecovery).
 * - handleAgentEnd asks before emitting a terminal event:
 *   shouldSuppressTerminalOverflowError() for the error branch,
 *   withholdTerminalForPendingRetry() for the ordinary `end` branch.
 * - run.ts clears both records when a retry attempt actually starts
 *   (noteRetryAttemptStarted) — the new attempt owns the terminal now.
 * - On any give-up path run.ts emits the withheld terminal itself exactly once,
 *   via consumeSuppressedTerminal() (error) or consumeWithheldTerminal() (end).
 *
 * The two halves differ in what they can know, which is why they are separate
 * calls rather than one. Overflow is visible *during* an attempt — it is an API
 * error — so its predicate is a pure budget check. Whether the loop will retry
 * a no-visible-answer attempt is decided *after* the attempt resolves, which is
 * strictly later than `agent end`. So the `end` branch withholds on "budget
 * remains and this attempt produced nothing visible" and relies on the run
 * loop's finally to flush what it withheld. Over-withholding is safe (the event
 * is emitted microseconds later, still inside the run); under-withholding is
 * the bug.
 */

type Entry = {
  hasOverflowBudget: () => boolean;
  hasNoVisibleAnswerRetryBudget: () => boolean;
  suppressed: boolean;
  /**
   * The `data` of a withheld non-error terminal, minus `phase`/`endedAt`, so
   * the flusher reproduces the emission the handler would have made.
   */
  withheldTerminal: Record<string, unknown> | null;
};

const entries = new Map<string, Entry>();

export function armAttemptRetryRecovery(
  runId: string | undefined,
  budgets: {
    hasOverflowBudget: () => boolean;
    hasNoVisibleAnswerRetryBudget: () => boolean;
  },
): void {
  if (!runId) {
    return;
  }
  entries.set(runId, {
    hasOverflowBudget: budgets.hasOverflowBudget,
    hasNoVisibleAnswerRetryBudget: budgets.hasNoVisibleAnswerRetryBudget,
    suppressed: false,
    withheldTerminal: null,
  });
}

export function disarmAttemptRetryRecovery(runId: string | undefined): void {
  if (!runId) {
    return;
  }
  entries.delete(runId);
}

/** Clear recorded suppressions once the retry attempt actually starts. */
export function noteRetryAttemptStarted(runId: string | undefined): void {
  if (!runId) {
    return;
  }
  const entry = entries.get(runId);
  if (entry) {
    entry.suppressed = false;
    entry.withheldTerminal = null;
  }
}

/**
 * True when the run loop will retry this runId after a context-overflow
 * attempt error, in which case the per-attempt terminal lifecycle emission
 * must be suppressed. Records the suppression so the run loop can emit the
 * terminal error itself if recovery subsequently fails.
 */
export function shouldSuppressTerminalOverflowError(
  runId: string | undefined,
  errorMessage: string | undefined,
): boolean {
  if (!runId) {
    return false;
  }
  const entry = entries.get(runId);
  if (!entry) {
    return false;
  }
  if (!isLikelyContextOverflowError(errorMessage)) {
    return false;
  }
  // Compaction-failure overflows give up immediately in the run loop — they
  // are genuinely terminal, so the normal emission must proceed.
  if (isCompactionFailureError(errorMessage)) {
    return false;
  }
  if (!entry.hasOverflowBudget()) {
    return false;
  }
  entry.suppressed = true;
  return true;
}

/**
 * True when an ordinary (non-error) attempt end must be withheld because the
 * run loop may still retry it — it produced no visible assistant text and
 * retry budget remains. Stores *terminalData* so the run loop can emit the
 * exact event the handler withheld.
 *
 * An attempt that produced visible text is never withheld: the run loop's
 * no-visible-answer retries cannot fire for it, so withholding would delay a
 * terminal that is already correct.
 */
export function withholdTerminalForPendingRetry(
  runId: string | undefined,
  params: { hasAssistantVisibleText: boolean; terminalData: Record<string, unknown> },
): boolean {
  if (!runId) {
    return false;
  }
  const entry = entries.get(runId);
  if (!entry) {
    return false;
  }
  if (params.hasAssistantVisibleText) {
    return false;
  }
  if (!entry.hasNoVisibleAnswerRetryBudget()) {
    return false;
  }
  entry.withheldTerminal = params.terminalData;
  return true;
}

/**
 * True (at most once per suppression) when the last attempt's terminal error
 * was suppressed and no retry attempt started — the caller owns emitting the
 * terminal lifecycle error.
 */
export function consumeSuppressedTerminal(runId: string | undefined): boolean {
  if (!runId) {
    return false;
  }
  const entry = entries.get(runId);
  if (!entry || !entry.suppressed) {
    return false;
  }
  entry.suppressed = false;
  return true;
}

/**
 * The withheld non-error terminal's data, at most once, when no retry attempt
 * started after it — the caller owns emitting it. Null when nothing is
 * withheld.
 */
export function consumeWithheldTerminal(runId: string | undefined): Record<string, unknown> | null {
  if (!runId) {
    return null;
  }
  const entry = entries.get(runId);
  if (!entry || !entry.withheldTerminal) {
    return null;
  }
  const withheld = entry.withheldTerminal;
  entry.withheldTerminal = null;
  return withheld;
}
