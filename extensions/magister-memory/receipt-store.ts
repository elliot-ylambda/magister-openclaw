import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { checkpointStateRoot } from "./checkpoint-state.js";
import { hashIdentifier, sanitizeReferenceText } from "./conversation-text.js";
import type { MemoryReceipt } from "./conversation-types.js";
import { atomicWriteFile, isRecord, readJsonIfExists } from "./file-utils.js";
import type { MemoryTarget } from "./memory-store.js";

export const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class ReceiptStore {
  private readonly workspaceHash: string;

  constructor(private readonly workspaceDir: string) {
    this.workspaceHash = hashIdentifier(workspaceDir);
  }

  async create(params: {
    id?: string;
    target: MemoryTarget;
    action: MemoryReceipt["action"];
    beforeEntries: readonly string[];
    afterEntries: readonly string[];
    topics: string[];
    createdAt?: number;
    groupId?: string;
    groupOrder?: number;
  }): Promise<MemoryReceipt> {
    const receipt: MemoryReceipt = {
      version: 1,
      id: params.id ?? randomUUID(),
      workspaceHash: this.workspaceHash,
      target: params.target,
      action: params.action,
      beforeEntries: [...params.beforeEntries],
      afterEntries: [...params.afterEntries],
      topics: params.topics
        .map((topic) => sanitizeReferenceText(topic, 80))
        .filter(Boolean)
        .slice(0, 5),
      createdAt: params.createdAt ?? Date.now(),
      ...(params.groupId ? { groupId: params.groupId } : {}),
      ...(params.groupOrder !== undefined ? { groupOrder: params.groupOrder } : {}),
    };
    const existing = await this.get(receipt.id);
    if (existing) {
      if (sameReceiptMutation(existing, receipt)) {
        return existing;
      }
      throw new Error("memory_receipt_id_conflict");
    }
    await this.write(receipt);
    return receipt;
  }

  async get(id: string): Promise<MemoryReceipt | undefined> {
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) {
      return undefined;
    }
    const receipt = parseReceipt(await readJsonIfExists(this.path(id)));
    return receipt?.workspaceHash === this.workspaceHash ? receipt : undefined;
  }

  async list(): Promise<MemoryReceipt[]> {
    let names: string[];
    try {
      names = await readdir(this.directory());
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    const receipts = await Promise.all(
      names
        .filter((name) => /^[A-Za-z0-9_-]{8,200}\.json$/.test(name))
        .map(async (name) => parseReceipt(await readJsonIfExists(join(this.directory(), name)))),
    );
    return receipts
      .filter((receipt): receipt is MemoryReceipt => receipt?.workspaceHash === this.workspaceHash)
      .toSorted((a, b) => b.createdAt - a.createdAt || (b.groupOrder ?? 0) - (a.groupOrder ?? 0));
  }

  async findUndoCandidate(id?: string, nowMs = Date.now()): Promise<MemoryReceipt | undefined> {
    const receipt = id ? await this.get(id) : (await this.list()).find((item) => !item.undoneAt);
    if (!receipt || receipt.undoneAt || nowMs - receipt.createdAt > RECEIPT_TTL_MS) {
      return undefined;
    }
    return receipt;
  }

  async listPending(nowMs = Date.now()): Promise<MemoryReceipt[]> {
    return (await this.list()).filter(
      (receipt) =>
        !receipt.deliveredAt && !receipt.undoneAt && nowMs - receipt.createdAt <= RECEIPT_TTL_MS,
    );
  }

  async markDelivered(ids: string[], deliveredAt = Date.now()): Promise<void> {
    for (const id of ids) {
      const receipt = await this.get(id);
      if (receipt && !receipt.deliveredAt) {
        await this.write({ ...receipt, deliveredAt });
      }
    }
  }

  async markUndone(id: string, undoneAt = Date.now()): Promise<void> {
    const receipt = await this.get(id);
    if (receipt && !receipt.undoneAt) {
      await this.write({ ...receipt, undoneAt });
    }
  }

  private directory(): string {
    return join(checkpointStateRoot(this.workspaceDir), "receipts");
  }

  private path(id: string): string {
    return join(this.directory(), `${id}.json`);
  }

  private async write(receipt: MemoryReceipt): Promise<void> {
    await atomicWriteFile(this.path(receipt.id), `${JSON.stringify(receipt)}\n`);
  }
}

export function formatReceiptNotice(receipts: MemoryReceipt[]): string | undefined {
  const topics = [
    ...new Set(receipts.flatMap((receipt) => receipt.topics).map((topic) => topic.trim())),
  ]
    .filter(Boolean)
    .slice(0, 3);
  if (topics.length === 0) {
    return undefined;
  }
  return `Updated Magister's memory about: ${topics.join(", ")}. Say "undo that" to revert.`;
}

function parseReceipt(value: unknown): MemoryReceipt | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  if (
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9_-]{8,200}$/.test(value.id) ||
    typeof value.workspaceHash !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.workspaceHash) ||
    (value.target !== "memory" && value.target !== "user") ||
    !isReceiptAction(value.action) ||
    !Array.isArray(value.beforeEntries) ||
    value.beforeEntries.length > 100 ||
    !value.beforeEntries.every((entry) => typeof entry === "string") ||
    totalChars(value.beforeEntries) > 10_000 ||
    !Array.isArray(value.afterEntries) ||
    value.afterEntries.length > 100 ||
    !value.afterEntries.every((entry) => typeof entry === "string") ||
    totalChars(value.afterEntries) > 10_000 ||
    !Array.isArray(value.topics) ||
    value.topics.length > 5 ||
    !value.topics.every((topic) => typeof topic === "string" && topic.length <= 80) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0 ||
    (value.groupId !== undefined &&
      (typeof value.groupId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.groupId))) ||
    (value.groupOrder !== undefined &&
      (typeof value.groupOrder !== "number" ||
        !Number.isInteger(value.groupOrder) ||
        value.groupOrder < 0)) ||
    !isOptionalTimestamp(value.deliveredAt) ||
    !isOptionalTimestamp(value.undoneAt)
  ) {
    return undefined;
  }
  return {
    version: 1,
    id: value.id,
    workspaceHash: value.workspaceHash,
    target: value.target,
    action: value.action,
    beforeEntries: [...value.beforeEntries],
    afterEntries: [...value.afterEntries],
    topics: [...value.topics],
    createdAt: value.createdAt,
    ...(typeof value.groupId === "string" ? { groupId: value.groupId } : {}),
    ...(typeof value.groupOrder === "number" ? { groupOrder: value.groupOrder } : {}),
    ...(typeof value.deliveredAt === "number" ? { deliveredAt: value.deliveredAt } : {}),
    ...(typeof value.undoneAt === "number" ? { undoneAt: value.undoneAt } : {}),
  };
}

function isReceiptAction(value: unknown): value is MemoryReceipt["action"] {
  return value === "add" || value === "replace" || value === "remove" || value === "promotion";
}

function sameReceiptMutation(left: MemoryReceipt, right: MemoryReceipt): boolean {
  return (
    left.target === right.target &&
    left.action === right.action &&
    left.groupId === right.groupId &&
    left.groupOrder === right.groupOrder &&
    sameEntries(left.beforeEntries, right.beforeEntries) &&
    sameEntries(left.afterEntries, right.afterEntries)
  );
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function totalChars(entries: unknown[]): number {
  let total = 0;
  for (const entry of entries) {
    if (typeof entry === "string") {
      total += entry.length;
    }
  }
  return total;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
