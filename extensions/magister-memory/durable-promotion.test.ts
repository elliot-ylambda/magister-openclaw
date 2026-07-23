import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DurableCandidate, TranscriptEntry } from "./conversation-types.js";
import { isPromotionAllowed, promoteDurableCandidates } from "./durable-promotion.js";

describe("durable candidate promotion", () => {
  let dir: string;
  const entries: TranscriptEntry[] = [
    {
      role: "user",
      text: "Our target audience is independent dental practices.",
      fingerprint: "1".repeat(64),
    },
  ];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "magister-promotion-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("promotes exact high-confidence user evidence and returns a receipt", async () => {
    const result = await promoteDurableCandidates({
      workspaceDir: dir,
      checkpointId: "checkpoint-one",
      candidates: [candidate()],
      entries,
      topics: ["target audience"],
      promotionConfidence: 0.95,
      memoryCharLimit: 2_200,
      userCharLimit: 1_375,
    });
    expect(result).toMatchObject({ promoted: 1, blocked: 0 });
    expect(result.receipts).toHaveLength(1);
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe(
      "[magister_learned:project.target_audience] Targets independent dental practices",
    );
  });

  it("replaces only the existing stable key", async () => {
    await promoteDurableCandidates({
      workspaceDir: dir,
      checkpointId: "checkpoint-one",
      candidates: [candidate()],
      entries,
      topics: [],
      promotionConfidence: 0.95,
      memoryCharLimit: 2_200,
      userCharLimit: 1_375,
    });
    const updatedEvidence = "Our target audience is independent dental groups.";
    const updated = await promoteDurableCandidates({
      workspaceDir: dir,
      checkpointId: "checkpoint-two",
      candidates: [
        candidate({
          value: "Targets independent dental groups",
          evidence: updatedEvidence,
          action: "replace",
        }),
      ],
      entries: [{ role: "user", text: updatedEvidence, fingerprint: "2".repeat(64) }],
      topics: [],
      promotionConfidence: 0.95,
      memoryCharLimit: 2_200,
      userCharLimit: 1_375,
    });
    expect(updated.promoted).toBe(1);
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toContain("dental groups");
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).not.toContain("dental practices");
  });

  it("blocks low confidence, missing evidence, transient failures, and target/key mismatch", () => {
    const userMessages = entries.map((entry) => entry.text);
    expect(isPromotionAllowed(candidate({ confidence: 0.8 }), userMessages, 0.95)).toBe(false);
    expect(isPromotionAllowed(candidate({ evidence: "A tool said so" }), userMessages, 0.95)).toBe(
      false,
    );
    expect(
      isPromotionAllowed(
        candidate({ value: "The campaign failed today", evidence: entries[0].text }),
        userMessages,
        0.95,
      ),
    ).toBe(false);
    expect(isPromotionAllowed(candidate({ key: "user.target_audience" }), userMessages, 0.95)).toBe(
      false,
    );
  });
});

function candidate(overrides: Partial<DurableCandidate> = {}): DurableCandidate {
  return {
    target: "memory",
    key: "project.target_audience",
    value: "Targets independent dental practices",
    action: "add",
    evidence: "Our target audience is independent dental practices.",
    confidence: 0.99,
    ...overrides,
  };
}
