import {
  isCompactionFailureError,
  isLikelyContextOverflowError,
} from "../pi-embedded-helpers/errors.js";

/**
 * Magister fork: runId-keyed coordination between the embedded run loop's
 * overflow recovery (run.ts) and per-attempt terminal lifecycle emission
 * (pi-embedded-subscribe.handlers.lifecycle.ts).
 *
 * A context-overflow attempt error is NOT terminal for the run while the run
 * loop still has overflow-compaction budget: it compacts and retries the same
 * runId. Emitting a terminal lifecycle `error` for such an attempt makes
 * stream subscribers (openai-http.ts chat completions, agent.wait waiters)
 * finalize while the run keeps working — the retried turn then completes
 * headless and its output never reaches the subscriber (June 2026 orphaned
 * webchat kickoff incident).
 *
 * Contract:
 * - run.ts arms a budget predicate at run start (armOverflowRecovery) and
 *   disarms it in its finally (disarmOverflowRecovery).
 * - handleAgentEnd asks shouldSuppressTerminalOverflowError() before emitting
 *   a terminal error; a true return records the suppression.
 * - run.ts clears the record when a retry attempt actually starts
 *   (noteOverflowAttemptStarted) and, on any give-up path, emits the terminal
 *   error itself exactly once when consumeSuppressedTerminal() returns true.
 */

type Entry = {
  hasBudget: () => boolean;
  suppressed: boolean;
};

const entries = new Map<string, Entry>();

export function armOverflowRecovery(runId: string | undefined, hasBudget: () => boolean): void {
  if (!runId) {
    return;
  }
  entries.set(runId, { hasBudget, suppressed: false });
}

export function disarmOverflowRecovery(runId: string | undefined): void {
  if (!runId) {
    return;
  }
  entries.delete(runId);
}

/** Clear a recorded suppression once the retry attempt actually starts. */
export function noteOverflowAttemptStarted(runId: string | undefined): void {
  if (!runId) {
    return;
  }
  const entry = entries.get(runId);
  if (entry) {
    entry.suppressed = false;
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
  if (!entry.hasBudget()) {
    return false;
  }
  entry.suppressed = true;
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
