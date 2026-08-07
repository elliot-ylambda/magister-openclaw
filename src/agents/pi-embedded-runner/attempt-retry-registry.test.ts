import { afterEach, describe, expect, it } from "vitest";
import {
  armAttemptRetryRecovery,
  consumeSuppressedTerminal,
  consumeWithheldTerminal,
  disarmAttemptRetryRecovery,
  noteRetryAttemptStarted,
  shouldSuppressTerminalOverflowError,
  withholdTerminalForPendingRetry,
} from "./attempt-retry-registry.js";

const RUN_ID = "run-registry-test";
// Matches the real preemptive guard message (tool-result-context-guard.ts)
// that triggered the June 2026 incident — must classify as a context overflow.
const OVERFLOW_ERROR =
  "Context overflow: estimated context size exceeds safe threshold during tool loop.";
const TERMINAL_DATA = { livenessState: "abandoned" };

function arm(
  budgets: { overflow?: () => boolean; noAnswer?: () => boolean } = {},
  runId: string | undefined = RUN_ID,
) {
  armAttemptRetryRecovery(runId, {
    hasOverflowBudget: budgets.overflow ?? (() => true),
    hasNoVisibleAnswerRetryBudget: budgets.noAnswer ?? (() => true),
  });
}

afterEach(() => {
  disarmAttemptRetryRecovery(RUN_ID);
});

describe("attempt retry registry: overflow errors", () => {
  it("suppresses an overflow error while budget remains and records it", () => {
    arm();
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(true);
    expect(consumeSuppressedTerminal(RUN_ID)).toBe(true);
    // consume is one-shot
    expect(consumeSuppressedTerminal(RUN_ID)).toBe(false);
  });

  it("does not suppress when the run is not armed", () => {
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(false);
  });

  it("does not suppress when budget is exhausted", () => {
    arm({ overflow: () => false });
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(false);
    expect(consumeSuppressedTerminal(RUN_ID)).toBe(false);
  });

  it("does not suppress non-overflow errors", () => {
    arm();
    expect(shouldSuppressTerminalOverflowError(RUN_ID, "connection refused")).toBe(false);
  });

  it("does not suppress compaction-failure overflows (run loop gives up on those)", () => {
    arm();
    expect(
      shouldSuppressTerminalOverflowError(
        RUN_ID,
        "auto-compaction failed: summarization failed (request_too_large)",
      ),
    ).toBe(false);
  });

  it("clears the suppression record when a retry attempt starts", () => {
    arm();
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(true);
    noteRetryAttemptStarted(RUN_ID);
    expect(consumeSuppressedTerminal(RUN_ID)).toBe(false);
  });

  it("tracks budget live through the predicate closure", () => {
    let attempts = 0;
    arm({ overflow: () => attempts < 1 });
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(true);
    noteRetryAttemptStarted(RUN_ID);
    attempts = 1;
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(false);
  });
});

describe("attempt retry registry: ordinary attempt ends", () => {
  it("withholds an empty attempt's terminal while a retry is still possible", () => {
    arm();
    expect(
      withholdTerminalForPendingRetry(RUN_ID, {
        hasAssistantVisibleText: false,
        terminalData: TERMINAL_DATA,
      }),
    ).toBe(true);
    expect(consumeWithheldTerminal(RUN_ID)).toEqual(TERMINAL_DATA);
    // consume is one-shot
    expect(consumeWithheldTerminal(RUN_ID)).toBeNull();
  });

  it("never withholds an attempt that produced a visible answer", () => {
    arm();
    expect(
      withholdTerminalForPendingRetry(RUN_ID, {
        hasAssistantVisibleText: true,
        terminalData: TERMINAL_DATA,
      }),
    ).toBe(false);
    expect(consumeWithheldTerminal(RUN_ID)).toBeNull();
  });

  it("does not withhold once every no-visible-answer retry is spent", () => {
    arm({ noAnswer: () => false });
    expect(
      withholdTerminalForPendingRetry(RUN_ID, {
        hasAssistantVisibleText: false,
        terminalData: TERMINAL_DATA,
      }),
    ).toBe(false);
    expect(consumeWithheldTerminal(RUN_ID)).toBeNull();
  });

  it("does not withhold when the run is not armed", () => {
    expect(
      withholdTerminalForPendingRetry(RUN_ID, {
        hasAssistantVisibleText: false,
        terminalData: TERMINAL_DATA,
      }),
    ).toBe(false);
  });

  it("hands the withheld terminal to the retry that actually starts", () => {
    arm();
    withholdTerminalForPendingRetry(RUN_ID, {
      hasAssistantVisibleText: false,
      terminalData: TERMINAL_DATA,
    });
    noteRetryAttemptStarted(RUN_ID);
    // The retry owns the terminal now; the run loop's flush must stay silent
    // or the run emits two `end` events for one runId.
    expect(consumeWithheldTerminal(RUN_ID)).toBeNull();
  });

  it("keeps the last attempt's terminal data, not the first", () => {
    arm();
    withholdTerminalForPendingRetry(RUN_ID, {
      hasAssistantVisibleText: false,
      terminalData: { livenessState: "working" },
    });
    noteRetryAttemptStarted(RUN_ID);
    withholdTerminalForPendingRetry(RUN_ID, {
      hasAssistantVisibleText: false,
      terminalData: { livenessState: "abandoned" },
    });
    expect(consumeWithheldTerminal(RUN_ID)).toEqual({ livenessState: "abandoned" });
  });
});

describe("attempt retry registry: lifecycle", () => {
  it("disarm clears all state", () => {
    arm();
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(true);
    withholdTerminalForPendingRetry(RUN_ID, {
      hasAssistantVisibleText: false,
      terminalData: TERMINAL_DATA,
    });
    disarmAttemptRetryRecovery(RUN_ID);
    expect(consumeSuppressedTerminal(RUN_ID)).toBe(false);
    expect(consumeWithheldTerminal(RUN_ID)).toBeNull();
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(false);
  });

  it("ignores undefined runIds", () => {
    arm({}, undefined);
    expect(shouldSuppressTerminalOverflowError(undefined, OVERFLOW_ERROR)).toBe(false);
    expect(consumeSuppressedTerminal(undefined)).toBe(false);
    expect(
      withholdTerminalForPendingRetry(undefined, {
        hasAssistantVisibleText: false,
        terminalData: TERMINAL_DATA,
      }),
    ).toBe(false);
    expect(consumeWithheldTerminal(undefined)).toBeNull();
  });
});
