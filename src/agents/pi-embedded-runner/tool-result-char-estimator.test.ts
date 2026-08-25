import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  getToolResultText,
} from "./tool-result-char-estimator.js";

/**
 * Regression tests for malformed tool result content blocks.
 * See https://github.com/openclaw/openclaw/issues/34979
 *
 * A plugin tool handler returning undefined produces {type: "text"} (no text
 * property) in the session JSONL. Without guards, this crashes the char
 * estimator with: TypeError: Cannot read properties of undefined (reading 'length')
 */
describe("tool-result-char-estimator", () => {
  it("does not crash on toolResult with malformed text block (missing text string)", () => {
    const malformed = {
      role: "toolResult",
      toolName: "sentinel_control",
      content: [{ type: "text" }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(() => estimateMessageCharsCached(malformed, cache)).not.toThrow();
    // Malformed block should be estimated via the unknown-block fallback, not zero
    expect(estimateMessageCharsCached(malformed, cache)).toBeGreaterThan(0);
  });

  it("does not crash on toolResult with null content entries", () => {
    const malformed = {
      role: "toolResult",
      toolName: "read",
      content: [null, { type: "text", text: "ok" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(() => estimateMessageCharsCached(malformed, cache)).not.toThrow();
  });

  it("getToolResultText skips malformed text blocks without crashing", () => {
    const malformed = {
      role: "toolResult",
      toolName: "sentinel_control",
      content: [{ type: "text" }, { type: "text", text: "valid" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    expect(() => getToolResultText(malformed)).not.toThrow();
    expect(getToolResultText(malformed)).toBe("valid");
  });

  it("estimates well-formed toolResult correctly", () => {
    const msg = {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "hello world" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    expect(chars).toBeGreaterThanOrEqual(11); // "hello world".length
  });
});

describe("tool-result-char-estimator details handling", () => {
  function makeToolResultWithDetails(): AgentMessage {
    return {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "x".repeat(100) }],
      details: { truncation: { truncated: true, outputLines: 100, content: "d".repeat(10_000) } },
      timestamp: Date.now(),
    } as unknown as AgentMessage;
  }

  it("excludes toolResult details from the default sent-size estimate", () => {
    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(makeToolResultWithDetails(), cache)).toBeLessThan(1_000);
  });

  it("includes toolResult details in the retained-size estimate when opted in", () => {
    const cache = createMessageCharEstimateCache({ includeToolResultDetails: true });
    expect(estimateMessageCharsCached(makeToolResultWithDetails(), cache)).toBeGreaterThan(10_000);
  });
});
