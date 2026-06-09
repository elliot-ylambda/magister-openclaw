import { afterEach, describe, expect, it } from "vitest";
import {
  armOverflowRecovery,
  consumeSuppressedTerminal,
  disarmOverflowRecovery,
  noteOverflowAttemptStarted,
  shouldSuppressTerminalOverflowError,
} from "./overflow-recovery-registry.js";

const RUN_ID = "run-registry-test";
// Matches the real preemptive guard message (tool-result-context-guard.ts)
// that triggered the June 2026 incident — must classify as a context overflow.
const OVERFLOW_ERROR =
  "Context overflow: estimated context size exceeds safe threshold during tool loop.";

afterEach(() => {
  disarmOverflowRecovery(RUN_ID);
});

describe("overflow recovery registry", () => {
  it("suppresses an overflow error while budget remains and records it", () => {
    armOverflowRecovery(RUN_ID, () => true);
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(true);
    expect(consumeSuppressedTerminal(RUN_ID)).toBe(true);
    // consume is one-shot
    expect(consumeSuppressedTerminal(RUN_ID)).toBe(false);
  });

  it("does not suppress when the run is not armed", () => {
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(false);
  });

  it("does not suppress when budget is exhausted", () => {
    armOverflowRecovery(RUN_ID, () => false);
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(false);
    expect(consumeSuppressedTerminal(RUN_ID)).toBe(false);
  });

  it("does not suppress non-overflow errors", () => {
    armOverflowRecovery(RUN_ID, () => true);
    expect(shouldSuppressTerminalOverflowError(RUN_ID, "connection refused")).toBe(false);
  });

  it("does not suppress compaction-failure overflows (run loop gives up on those)", () => {
    armOverflowRecovery(RUN_ID, () => true);
    expect(
      shouldSuppressTerminalOverflowError(
        RUN_ID,
        "auto-compaction failed: summarization failed (request_too_large)",
      ),
    ).toBe(false);
  });

  it("clears the suppression record when a retry attempt starts", () => {
    armOverflowRecovery(RUN_ID, () => true);
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(true);
    noteOverflowAttemptStarted(RUN_ID);
    expect(consumeSuppressedTerminal(RUN_ID)).toBe(false);
  });

  it("disarm clears all state", () => {
    armOverflowRecovery(RUN_ID, () => true);
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(true);
    disarmOverflowRecovery(RUN_ID);
    expect(consumeSuppressedTerminal(RUN_ID)).toBe(false);
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(false);
  });

  it("tracks budget live through the predicate closure", () => {
    let attempts = 0;
    armOverflowRecovery(RUN_ID, () => attempts < 1);
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(true);
    noteOverflowAttemptStarted(RUN_ID);
    attempts = 1;
    expect(shouldSuppressTerminalOverflowError(RUN_ID, OVERFLOW_ERROR)).toBe(false);
  });

  it("ignores undefined runIds", () => {
    armOverflowRecovery(undefined, () => true);
    expect(shouldSuppressTerminalOverflowError(undefined, OVERFLOW_ERROR)).toBe(false);
    expect(consumeSuppressedTerminal(undefined)).toBe(false);
  });
});
