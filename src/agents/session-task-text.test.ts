import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionStableTaskText } from "./session-task-text.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sessionFile(lines: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-task-text-test-"));
  temporaryRoots.push(root);
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(
    file,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"),
  );
  return file;
}

describe("resolveSessionStableTaskText", () => {
  it("returns undefined without touching the file when there is no current prompt", async () => {
    const result = await resolveSessionStableTaskText({
      sessionFile: path.join(os.tmpdir(), "does-not-exist.jsonl"),
      currentPrompt: undefined,
    });
    expect(result).toBeUndefined();
  });

  it("keys the first turn on its own prompt (no session file yet)", async () => {
    expect(await resolveSessionStableTaskText({ currentPrompt: "plan a launch" })).toBe(
      "plan a launch",
    );
    expect(
      await resolveSessionStableTaskText({
        sessionFile: path.join(os.tmpdir(), "missing-session-task-text.jsonl"),
        currentPrompt: "plan a launch",
      }),
    ).toBe("plan a launch");
  });

  it("keys later turns on the session's first user message, not the current prompt", async () => {
    const file = sessionFile([
      { type: "session", version: 3 },
      { message: { role: "assistant", content: "welcome" } },
      { message: { role: "user", content: "audit my ad spend ledger" } },
      { message: { role: "assistant", content: "done" } },
      { message: { role: "user", content: "what colour is the sky?" } },
    ]);
    const result = await resolveSessionStableTaskText({
      sessionFile: file,
      currentPrompt: "what colour is the sky?",
    });
    expect(result).toBe("audit my ad spend ledger");
  });

  it("is stable across turns: every later prompt resolves to the same text", async () => {
    const file = sessionFile([{ message: { role: "user", content: "audit my ad spend ledger" } }]);
    const turn2 = await resolveSessionStableTaskText({
      sessionFile: file,
      currentPrompt: "now the weekly numbers",
    });
    const turn3 = await resolveSessionStableTaskText({
      sessionFile: file,
      currentPrompt: "and refund drag?",
    });
    expect(turn2).toBe("audit my ad spend ledger");
    expect(turn3).toBe(turn2);
  });

  it("extracts text from block-array content", async () => {
    const file = sessionFile([
      {
        message: {
          role: "user",
          content: [
            { type: "image", source: "ignored" },
            { type: "text", text: "review the tracking setup" },
          ],
        },
      },
    ]);
    expect(await resolveSessionStableTaskText({ sessionFile: file, currentPrompt: "next" })).toBe(
      "review the tracking setup",
    );
  });

  it("scans past an image-only opener to the first user message with text", async () => {
    const file = sessionFile([
      { message: { role: "user", content: [{ type: "image", source: "x" }] } },
      { message: { role: "user", content: "describe this screenshot" } },
    ]);
    expect(await resolveSessionStableTaskText({ sessionFile: file, currentPrompt: "next" })).toBe(
      "describe this screenshot",
    );
  });

  it("skips malformed lines and falls back to the current prompt when no text exists", async () => {
    const file = sessionFile([
      "{not json",
      { message: { role: "assistant", content: "hi" } },
      { message: { role: "user", content: [{ type: "image", source: "x" }] } },
    ]);
    expect(
      await resolveSessionStableTaskText({ sessionFile: file, currentPrompt: "fallback" }),
    ).toBe("fallback");
  });

  it("caps very long first messages", async () => {
    const file = sessionFile([{ message: { role: "user", content: "x".repeat(40_000) } }]);
    const result = await resolveSessionStableTaskText({
      sessionFile: file,
      currentPrompt: "next",
    });
    expect(result).toHaveLength(16_000);
  });
});
