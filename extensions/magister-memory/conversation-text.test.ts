import { describe, expect, it } from "vitest";
import {
  containsToolWorkInLatestTurn,
  extractConversationDelta,
  extractTranscriptEntries,
  isMeaningfulConversation,
  requestsImmediateCheckpoint,
} from "./conversation-text.js";

describe("conversation text capture", () => {
  it("extracts only user and assistant text with stable fingerprints", () => {
    const entries = extractTranscriptEntries([
      { role: "system", content: "hidden" },
      { role: "user", content: [{ type: "text", text: "  Hello   there  " }] },
      { role: "tool", content: "untrusted result" },
      { role: "assistant", content: "Hi" },
    ]);
    expect(entries.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Hello there" },
      { role: "assistant", text: "Hi" },
    ]);
    expect(entries[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("advances from a cursor and falls back to the newest user turn when stale", () => {
    const entries = extractTranscriptEntries([
      { role: "user", content: "First request with enough useful detail" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second request with different useful detail" },
      { role: "assistant", content: "Second answer" },
    ]);
    expect(extractConversationDelta(entries, entries[1].fingerprint)).toEqual(entries.slice(2));
    expect(extractConversationDelta(entries, "0".repeat(64))).toEqual(entries.slice(2));
  });

  it("skips greetings and acknowledgements but keeps durable context", () => {
    expect(
      isMeaningfulConversation(extractTranscriptEntries([{ role: "user", content: "Thanks!" }])),
    ).toBe(false);
    const preference = extractTranscriptEntries([
      { role: "user", content: "From now on, prefer concise campaign reports." },
      { role: "assistant", content: "Understood." },
    ]);
    expect(isMeaningfulConversation(preference)).toBe(true);
    expect(requestsImmediateCheckpoint(preference)).toBe(true);

    const correction = extractTranscriptEntries([
      { role: "user", content: "Actually, the campaign launches in September, not August." },
      { role: "assistant", content: "Thanks for the correction." },
    ]);
    expect(isMeaningfulConversation(correction)).toBe(true);
    expect(requestsImmediateCheckpoint(correction)).toBe(true);
  });

  it("recognizes tool-backed work in the latest turn without using older tool history", () => {
    const latestToolTurn = [
      { role: "user", content: "Check it" },
      { role: "assistant", content: [{ type: "tool_call", name: "search" }] },
      { role: "tool", content: "result" },
      { role: "assistant", content: "Done" },
    ];
    expect(containsToolWorkInLatestTurn(latestToolTurn)).toBe(true);
    expect(
      isMeaningfulConversation(extractTranscriptEntries(latestToolTurn), { hasToolWork: true }),
    ).toBe(true);
    expect(
      isMeaningfulConversation(
        extractTranscriptEntries([
          { role: "user", content: "Okay" },
          { role: "assistant", content: "I completed the requested update." },
        ]),
        { hasToolWork: true },
      ),
    ).toBe(true);

    expect(
      containsToolWorkInLatestTurn([
        ...latestToolTurn,
        { role: "user", content: "Thanks" },
        { role: "assistant", content: "You are welcome" },
      ]),
    ).toBe(false);
  });
});
