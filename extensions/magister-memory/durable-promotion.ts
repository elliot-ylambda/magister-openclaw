import { createHash } from "node:crypto";
import type { DurableCandidate, MemoryReceipt, TranscriptEntry } from "./conversation-types.js";
import { MemoryStore, type MemoryResult, type MemoryStoreOptions } from "./memory-store.js";
import { ReceiptStore } from "./receipt-store.js";
import { scanMemoryContent } from "./threat-scan.js";

const KEY_PATTERN = /^(project|user)\.[a-z0-9][a-z0-9_.-]{1,79}$/;
const TRANSIENT_PATTERN =
  /\b(?:today|tomorrow|yesterday|right now|currently|for now|this task|one[- ]off|temporary|error|failed|failure|exception|stack trace|tool output|search result)\b/i;
const SECRET_PATTERN =
  /\b(?:password|passcode|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|credential|secret)\b/i;

export type PromotionResult = {
  promoted: number;
  blocked: number;
  unchanged: number;
  receipts: MemoryReceipt[];
  mutations: Array<{
    action: "add" | "replace";
    target: "memory" | "user";
    content: string;
  }>;
};

export async function promoteDurableCandidates(params: {
  workspaceDir: string;
  checkpointId: string;
  candidates: DurableCandidate[];
  entries: TranscriptEntry[];
  topics: string[];
  promotionConfidence: number;
  memoryCharLimit: number;
  userCharLimit: number;
  mutationBoundary?: MemoryStoreOptions["mutationBoundary"];
}): Promise<PromotionResult> {
  const store = new MemoryStore({
    memoryDir: params.workspaceDir,
    memoryCharLimit: params.memoryCharLimit,
    userCharLimit: params.userCharLimit,
    ...(params.mutationBoundary ? { mutationBoundary: params.mutationBoundary } : {}),
  });
  await store.loadFromDisk();
  const receiptStore = new ReceiptStore(params.workspaceDir);
  const userMessages = params.entries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.text);
  const result: PromotionResult = {
    promoted: 0,
    blocked: 0,
    unchanged: 0,
    receipts: [],
    mutations: [],
  };

  for (const [candidateIndex, candidate] of params.candidates.slice(0, 3).entries()) {
    if (!isPromotionAllowed(candidate, userMessages, params.promotionConfidence)) {
      result.blocked++;
      continue;
    }
    const tag = `[magister_learned:${candidate.key}]`;
    const content = `${tag} ${candidate.value}`;
    if (scanMemoryContent(content)) {
      result.blocked++;
      continue;
    }
    const beforeEntries = [...store.entriesFor(candidate.target)];
    const keyedEntries = beforeEntries.filter((entry) => entry.startsWith(`${tag} `));
    if (keyedEntries.length > 1) {
      result.blocked++;
      continue;
    }
    if (keyedEntries[0] === content) {
      result.unchanged++;
      continue;
    }
    let mutation: MemoryResult;
    try {
      mutation = keyedEntries[0]
        ? await store.replace(candidate.target, tag, content)
        : await store.add(candidate.target, content);
    } catch {
      result.blocked++;
      continue;
    }
    if (!mutation.success) {
      result.blocked++;
      continue;
    }
    const afterEntries = [...store.entriesFor(candidate.target)];
    let receipt: MemoryReceipt;
    try {
      receipt = await receiptStore.create({
        id: deterministicReceiptId(params.checkpointId, candidate.target, candidate.key),
        target: candidate.target,
        action: "promotion",
        beforeEntries,
        afterEntries,
        topics: params.topics.length > 0 ? params.topics : [humanizeKey(candidate.key)],
        groupId: params.checkpointId,
        groupOrder: candidateIndex,
      });
    } catch {
      try {
        const rollback = await store.restoreSnapshot(candidate.target, afterEntries, beforeEntries);
        if (!rollback.success) {
          throw new Error("memory_promotion_rollback_failed");
        }
      } catch {
        throw new Error("memory_promotion_rollback_failed");
      }
      result.blocked++;
      continue;
    }
    result.receipts.push(receipt);
    result.mutations.push({
      action: keyedEntries[0] ? "replace" : "add",
      target: candidate.target,
      content,
    });
    result.promoted++;
  }
  return result;
}

export function isPromotionAllowed(
  candidate: DurableCandidate,
  userMessages: string[],
  confidenceThreshold: number,
): boolean {
  if (candidate.confidence < confidenceThreshold || !KEY_PATTERN.test(candidate.key)) {
    return false;
  }
  const expectedPrefix = candidate.target === "memory" ? "project." : "user.";
  if (!candidate.key.startsWith(expectedPrefix)) {
    return false;
  }
  if (!userMessages.some((message) => message.includes(candidate.evidence))) {
    return false;
  }
  if (
    candidate.value.length > 300 ||
    candidate.evidence.length > 600 ||
    TRANSIENT_PATTERN.test(candidate.value) ||
    TRANSIENT_PATTERN.test(candidate.evidence) ||
    SECRET_PATTERN.test(candidate.value) ||
    SECRET_PATTERN.test(candidate.evidence)
  ) {
    return false;
  }
  return !scanMemoryContent(candidate.value) && !scanMemoryContent(candidate.evidence);
}

function deterministicReceiptId(checkpointId: string, target: string, key: string): string {
  return `checkpoint_${createHash("sha256")
    .update(checkpointId)
    .update("\0")
    .update(target)
    .update("\0")
    .update(key)
    .digest("hex")
    .slice(0, 32)}`;
}

function humanizeKey(key: string): string {
  return key.split(".").at(-1)?.replaceAll("_", " ").replaceAll("-", " ") ?? "project context";
}
