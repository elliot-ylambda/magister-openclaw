import { formatErrorMessage } from "../../../infra/errors.js";
import { coerceToFailoverError, describeFailoverError } from "../../failover-error.js";
import { classifyFailoverReason } from "../../pi-embedded-helpers.js";

export type RunCompletionOutcome = "completed" | "aborted" | "error";

export type RunCompletionFlags = {
  /** External stop request: user cancel, session reset, or shutdown. */
  externalAbortRequested: boolean;
  aborted: boolean;
  timedOut: boolean;
  idleTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  timedOutDuringToolExecution: boolean;
};

/**
 * Decide the run.completed outcome. An external stop usually severs the
 * in-flight prompt, so the prompt error is set for most cancels; the abort
 * request must win over the error, otherwise every user cancel is recorded
 * as an "error" run.
 */
export function resolveRunCompletionOutcome(
  flags: RunCompletionFlags,
  err: unknown,
): RunCompletionOutcome {
  if (flags.externalAbortRequested) {
    return "aborted";
  }
  if (err) {
    return "error";
  }
  if (flags.aborted || flags.timedOut || flags.idleTimedOut || flags.timedOutDuringCompaction) {
    return "aborted";
  }
  return "completed";
}

/**
 * Low-cardinality failure classification for terminal run diagnostics.
 * Errors classify through the failover machinery ("timeout", "rate_limit",
 * "auth", ...); aborted runs are "canceled" when externally stopped and
 * "timeout" when a watchdog ended them.
 */
export function resolveRunCompletionDiagnostic(params: {
  outcome: RunCompletionOutcome;
  err: unknown;
  flags: RunCompletionFlags;
  provider?: string;
  model?: string;
}): { failureKind?: string; reasonCode?: string } {
  const { outcome, err, flags } = params;
  const anyTimeout =
    flags.timedOut ||
    flags.idleTimedOut ||
    flags.timedOutDuringCompaction ||
    flags.timedOutDuringToolExecution;
  const failureKind =
    outcome === "error"
      ? classifyRunFailureKind(err, params)
      : outcome === "aborted"
        ? flags.externalAbortRequested
          ? "canceled"
          : anyTimeout
            ? "timeout"
            : "canceled"
        : undefined;
  const reasonCode = flags.externalAbortRequested
    ? "external_abort"
    : flags.timedOutDuringCompaction
      ? "compaction_timeout"
      : flags.timedOutDuringToolExecution
        ? "tool_timeout"
        : flags.idleTimedOut
          ? "idle_timeout"
          : flags.timedOut
            ? "run_timeout"
            : undefined;
  return {
    ...(failureKind ? { failureKind } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function classifyRunFailureKind(err: unknown, opts: { provider?: string; model?: string }): string {
  const normalized =
    coerceToFailoverError(err, { provider: opts.provider, model: opts.model }) ?? err;
  const details = describeFailoverError(normalized);
  const text = details.message || formatErrorMessage(err);
  return (
    details.reason ?? classifyFailoverReason(text, { provider: opts.provider }) ?? "unclassified"
  );
}
