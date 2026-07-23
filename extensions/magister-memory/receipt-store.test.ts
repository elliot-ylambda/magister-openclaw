import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatReceiptNotice, ReceiptStore, RECEIPT_TTL_MS } from "./receipt-store.js";

describe("receipt store", () => {
  let dir: string;
  let store: ReceiptStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "magister-receipts-"));
    store = new ReceiptStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists, delivers, and marks reversible receipts", async () => {
    const receipt = await store.create({
      id: "receipt_12345678",
      target: "memory",
      action: "add",
      beforeEntries: [],
      afterEntries: ["fact"],
      topics: ["target audience"],
      createdAt: 100,
    });
    expect(formatReceiptNotice([receipt])).toBe(
      'Updated Magister\'s memory about: target audience. Say "undo that" to revert.',
    );
    expect(await store.findUndoCandidate(receipt.id, 200)).toEqual(receipt);
    await store.markDelivered([receipt.id], 300);
    expect(await store.listPending(400)).toEqual([]);
    await store.markUndone(receipt.id, 500);
    expect(await store.findUndoCandidate(receipt.id, 600)).toBeUndefined();
  });

  it("expires receipts after 30 days", async () => {
    const receipt = await store.create({
      id: "receipt_expired",
      target: "user",
      action: "replace",
      beforeEntries: ["old"],
      afterEntries: ["new"],
      topics: ["reporting style"],
      createdAt: 10,
    });
    expect(await store.findUndoCandidate(receipt.id, 10 + RECEIPT_TTL_MS + 1)).toBeUndefined();
  });

  it("reuses only an identical deterministic receipt", async () => {
    const params = {
      id: "receipt_deterministic",
      target: "memory" as const,
      action: "promotion" as const,
      beforeEntries: ["before"],
      afterEntries: ["after"],
      topics: ["audience"],
      groupId: "checkpoint-group",
      groupOrder: 0,
      createdAt: 100,
    };
    const original = await store.create(params);
    expect(await store.create({ ...params, createdAt: 200 })).toEqual(original);
    await expect(store.create({ ...params, afterEntries: ["different"] })).rejects.toThrow(
      "memory_receipt_id_conflict",
    );
  });

  it("ignores a receipt copied from another workspace", async () => {
    const receipt = await store.create({
      id: "receipt_wrong_workspace",
      target: "memory",
      action: "add",
      beforeEntries: [],
      afterEntries: ["fact"],
      topics: ["context"],
    });
    const path = join(
      dir,
      ".magister",
      "state",
      "conversation-checkpoints",
      "receipts",
      `${receipt.id}.json`,
    );
    const serialized = JSON.parse(await readFile(path, "utf8")) as { workspaceHash: string };
    serialized.workspaceHash = "b".repeat(32);
    await writeFile(path, `${JSON.stringify(serialized)}\n`, "utf8");
    expect(await store.get(receipt.id)).toBeUndefined();
  });
});
