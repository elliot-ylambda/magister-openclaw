import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversationSessionState,
  listConversationSessionStates,
  readConversationSessionState,
  writeConversationSessionState,
} from "./checkpoint-state.js";

describe("checkpoint session state", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "magister-checkpoint-state-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists pending cursors, prepared candidates, and frozen recall across restarts", async () => {
    const sessionHash = "a".repeat(32);
    const state = createConversationSessionState({ sessionHash, agentId: "marketing" });
    state.lastMessageFingerprint = "1".repeat(64);
    state.recallFrozen = true;
    state.frozenRecall = "recent header";
    state.inFlight = {
      checkpointId: "checkpoint-123",
      entries: [{ role: "user", text: "Remember this", fingerprint: "2".repeat(64) }],
      startedAt: 10,
      sequence: 1,
      startFingerprint: "2".repeat(64),
      endFingerprint: "2".repeat(64),
      prepared: {
        summary: "A durable preference",
        topics: ["preference"],
        durableCandidates: [
          {
            target: "user",
            key: "user.reporting_style",
            value: "Prefers concise reports",
            action: "add",
            evidence: "Remember this",
            confidence: 0.99,
          },
        ],
        source: "model",
      },
    };
    await writeConversationSessionState(dir, state);

    const reloaded = await readConversationSessionState({
      workspaceDir: dir,
      sessionHash,
      agentId: "main",
    });
    expect(reloaded).toEqual(state);
    expect(await listConversationSessionStates(dir)).toEqual([state]);
  });
});
