import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  definePluginEntry,
  jsonResult,
  KeyedAsyncQueue,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { mirrorAudit } from "./audit-mirror.js";
import { withContextLock } from "./context-lock.js";
import { resolveConversationCheckpointConfig } from "./conversation-config.js";
import { ConversationCheckpointManager } from "./conversation-manager.js";
import { MemoryStore, type MemoryResult, type MemoryTarget } from "./memory-store.js";
import { memoryOperationId, withHostMutationBoundary } from "./mutation-boundary.js";
import { ReceiptStore, RECEIPT_TTL_MS } from "./receipt-store.js";

const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;

// Serializes load→mutate→persist per memory file across concurrent agent
// turns in this process (up to 4 run in parallel on the `main` lane, plus
// cron). Without this, two turns can both loadFromDisk(), then the second
// persist() silently drops the first turn's entry (last-writer-wins).
const memoryWriteQueue = new KeyedAsyncQueue();

type MemoryPluginConfig = {
  enabled?: boolean;
  memoryCharLimit?: number;
  userCharLimit?: number;
  auditEndpoint?: string;
  conversationCheckpoints?: unknown;
};

type MemoryToolParams = {
  action?: string;
  target?: string;
  content?: string;
  old_text?: string;
  receipt_id?: string;
};

const TOOL_DESCRIPTION = `Persistent curated memory. Two stores, one tool.

target='memory' — what you've learned about the project/business (brand voice, audience, patterns).
target='user'   — what you've learned about the user (name, preferences, working style).

Both are loaded into your system prompt at session start and stay frozen for the session.
Writes here go to disk immediately and appear in the NEXT session's system prompt.

Use sparingly. Char limits are tight — every entry must be a single, durable, single-line fact.
If you can't summarize it in 20 words, it's not memory, it's a task note.

action='undo' reverts a receipt from a recent memory change. Omit receipt_id to undo the newest
eligible change. Undo is refused if memory changed after the receipt was created.`;

function resolveWorkspaceDir(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext): string {
  if (ctx.workspaceDir) {
    return ctx.workspaceDir;
  }
  const agentId = ctx.agentId ?? "main";
  return resolveAgentWorkspaceDir(api.config, agentId);
}

function resolveConfig(api: OpenClawPluginApi): {
  memoryCharLimit: number;
  userCharLimit: number;
  auditEndpoint: string;
  enabled: boolean;
} {
  const cfg = (api.pluginConfig ?? {}) as MemoryPluginConfig;
  const gateway = (
    process.env.GATEWAY_INTERNAL_URL ?? "http://magister-gateway.internal:8081"
  ).replace(/\/+$/, "");
  return {
    enabled: cfg.enabled !== false,
    memoryCharLimit: cfg.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: cfg.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT,
    auditEndpoint: cfg.auditEndpoint ?? `${gateway}/api/memory/audit`,
  };
}

function createMemoryTool(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext) {
  const cfg = resolveConfig(api);
  if (!cfg.enabled) {
    return null;
  }

  return {
    name: "memory",
    label: "Memory",
    description: TOOL_DESCRIPTION,
    parameters: Type.Object({
      action: Type.String({ enum: ["add", "replace", "remove", "undo"] }),
      target: Type.Optional(Type.String({ enum: ["memory", "user"] })),
      content: Type.Optional(
        Type.String({ description: "Required for add/replace. The new entry text." }),
      ),
      old_text: Type.Optional(
        Type.String({
          description:
            "Required for replace/remove. A short unique substring of the entry to modify.",
        }),
      ),
      receipt_id: Type.Optional(
        Type.String({ description: "Optional receipt id for undo; newest eligible when omitted." }),
      ),
    }),
    async execute(callId: string, rawParams: Record<string, unknown>) {
      const params = rawParams as MemoryToolParams;
      const action = params.action;
      const target: MemoryTarget = params.target === "user" ? "user" : "memory";
      const workspaceDir = resolveWorkspaceDir(api, ctx);

      return memoryWriteQueue.enqueue(workspaceDir, async () =>
        withContextLock(workspaceDir, async () => {
          const store = new MemoryStore({
            memoryDir: workspaceDir,
            memoryCharLimit: cfg.memoryCharLimit,
            userCharLimit: cfg.userCharLimit,
            mutationBoundary: (writeTarget, content, write) =>
              withHostMutationBoundary(
                {
                  operationId: memoryOperationId(callId, String(action), writeTarget, content),
                  target: writeTarget,
                  content,
                },
                write,
              ),
          });
          await store.loadFromDisk();
          const receiptStore = new ReceiptStore(workspaceDir);

          const gatewayToken = process.env.GATEWAY_TOKEN ?? "";
          const auditEnabled = gatewayToken.length > 0;
          const fireAudit = (
            auditTarget: MemoryTarget,
            kind: "add" | "replace" | "remove" | "blocked",
            content: string,
            blockedReason?: string,
          ): void => {
            if (!auditEnabled) {
              return;
            }
            void mirrorAudit(
              { endpoint: cfg.auditEndpoint, gatewayToken },
              { action: kind, target: auditTarget, content, blockedReason },
            );
          };
          const createReceipt = async (receiptParams: {
            receiptTarget: MemoryTarget;
            receiptAction: "add" | "replace" | "remove";
            beforeEntries: readonly string[];
            afterEntries: readonly string[];
          }): Promise<string | undefined> => {
            try {
              const receipt = await receiptStore.create({
                target: receiptParams.receiptTarget,
                action: receiptParams.receiptAction,
                beforeEntries: receiptParams.beforeEntries,
                afterEntries: receiptParams.afterEntries,
                topics: [
                  receiptParams.receiptTarget === "user" ? "user preferences" : "project context",
                ],
              });
              return receipt.id;
            } catch {
              const rollback = await store.restoreSnapshot(
                receiptParams.receiptTarget,
                receiptParams.afterEntries,
                receiptParams.beforeEntries,
              );
              if (!rollback.success) {
                throw new Error("memory_receipt_rollback_failed");
              }
              api.logger.warn(
                `magister-memory: receipt write failed; mutation rolled back (action=${receiptParams.receiptAction})`,
              );
              return undefined;
            }
          };

          if (action === "undo") {
            const receipt = await receiptStore.findUndoCandidate(params.receipt_id);
            if (!receipt) {
              return jsonResult({
                success: false,
                target,
                message: params.receipt_id
                  ? "Receipt not found, already undone, or older than 30 days"
                  : "No eligible memory receipt to undo",
              });
            }
            const allReceipts = await receiptStore.list();
            const group = receipt.groupId
              ? allReceipts.filter((item) => item.groupId === receipt.groupId)
              : [receipt];
            if (
              group.some((item) => item.undoneAt || Date.now() - item.createdAt > RECEIPT_TTL_MS)
            ) {
              return jsonResult({
                success: false,
                target: receipt.target,
                message: "The receipt group is incomplete, expired, or already partly undone",
              });
            }
            const ordered = group.toSorted(
              (left, right) =>
                (right.groupOrder ?? 0) - (left.groupOrder ?? 0) ||
                right.createdAt - left.createdAt,
            );
            const latestByTarget = new Map<MemoryTarget, (typeof ordered)[number]>();
            for (const item of ordered) {
              if (!latestByTarget.has(item.target)) {
                latestByTarget.set(item.target, item);
              }
            }
            const simulatedByTarget = new Map<MemoryTarget, readonly string[]>();
            for (const item of ordered) {
              const current = simulatedByTarget.get(item.target) ?? store.entriesFor(item.target);
              if (!sameEntries(current, item.afterEntries)) {
                return jsonResult({
                  success: false,
                  target: item.target,
                  message:
                    "Memory changed after this receipt was created, or the receipt group is inconsistent; undo was not applied",
                });
              }
              simulatedByTarget.set(item.target, item.beforeEntries);
            }
            const restored: typeof ordered = [];
            let res: MemoryResult = {
              success: false,
              target: receipt.target,
              message: "Undo could not be applied",
            };
            try {
              for (const item of ordered) {
                res = await store.restoreSnapshot(
                  item.target,
                  item.afterEntries,
                  item.beforeEntries,
                );
                if (!res.success) {
                  break;
                }
                restored.push(item);
              }
            } catch {
              res = {
                success: false,
                target: restored.at(-1)?.target ?? receipt.target,
                message: "Undo persistence failed; the prior memory state was restored",
              };
            }
            if (!res.success && restored.length > 0) {
              let rollbackSucceeded = true;
              for (const item of restored.toReversed()) {
                try {
                  const rollback = await store.restoreSnapshot(
                    item.target,
                    item.beforeEntries,
                    item.afterEntries,
                  );
                  rollbackSucceeded &&= rollback.success;
                } catch {
                  rollbackSucceeded = false;
                }
              }
              if (!rollbackSucceeded) {
                res = {
                  success: false,
                  target: receipt.target,
                  message: "Undo and automatic rollback both failed; memory requires manual review",
                };
              }
            }
            if (res.success) {
              for (const item of group) {
                await receiptStore.markUndone(item.id);
              }
              for (const item of latestByTarget.values()) {
                fireAudit(item.target, "replace", `undo receipt ${receipt.groupId ?? receipt.id}`);
              }
            }
            api.logger.info(
              `magister-memory: memory undo completed (receipt_count=${group.length}, success=${res.success})`,
            );
            return jsonResult({
              ...res,
              receipt_id: receipt.groupId ?? receipt.id,
              receipt_ids: group.map((item) => item.id),
              undone: res.success,
            });
          }

          if (action === "add") {
            if (!params.content) {
              return jsonResult({
                success: false,
                target,
                message: "content is required for add",
              });
            }
            const beforeEntries = [...store.entriesFor(target)];
            const res = await store.add(target, params.content);
            if (!res.success) {
              fireAudit(target, "blocked", params.content, res.message);
              return jsonResult(res);
            }
            const receiptId = await createReceipt({
              receiptTarget: target,
              receiptAction: "add",
              beforeEntries,
              afterEntries: [...store.entriesFor(target)],
            });
            if (!receiptId) {
              return jsonResult({
                success: false,
                target,
                message: "Memory receipt could not be stored; the change was rolled back",
              });
            }
            fireAudit(target, "add", params.content);
            return jsonResult({ ...res, receipt_id: receiptId });
          }

          if (action === "replace") {
            if (!params.old_text || !params.content) {
              return jsonResult({
                success: false,
                target,
                message: "old_text and content are required for replace",
              });
            }
            const beforeEntries = [...store.entriesFor(target)];
            const res = await store.replace(target, params.old_text, params.content);
            if (!res.success) {
              fireAudit(target, "blocked", params.content, res.message);
              return jsonResult(res);
            }
            const receiptId = await createReceipt({
              receiptTarget: target,
              receiptAction: "replace",
              beforeEntries,
              afterEntries: [...store.entriesFor(target)],
            });
            if (!receiptId) {
              return jsonResult({
                success: false,
                target,
                message: "Memory receipt could not be stored; the change was rolled back",
              });
            }
            fireAudit(target, "replace", params.content);
            return jsonResult({ ...res, receipt_id: receiptId });
          }

          if (action === "remove") {
            if (!params.old_text) {
              return jsonResult({
                success: false,
                target,
                message: "old_text is required for remove",
              });
            }
            const beforeEntries = [...store.entriesFor(target)];
            const res = await store.remove(target, params.old_text);
            if (!res.success) {
              return jsonResult(res);
            }
            const receiptId = await createReceipt({
              receiptTarget: target,
              receiptAction: "remove",
              beforeEntries,
              afterEntries: [...store.entriesFor(target)],
            });
            if (!receiptId) {
              return jsonResult({
                success: false,
                target,
                message: "Memory receipt could not be stored; the change was rolled back",
              });
            }
            fireAudit(target, "remove", params.old_text);
            return jsonResult({ ...res, receipt_id: receiptId });
          }

          return jsonResult({
            success: false,
            target,
            message: `Unknown action: ${String(action)}`,
          });
        }),
      );
    },
  };
}

export default definePluginEntry({
  id: "magister-memory",
  name: "Magister Memory",
  description:
    "Bounded curated memory with conversation checkpoints, recent recall, threat scanning, receipts, and audit mirroring.",
  register(api) {
    const memoryConfig = resolveConfig(api);
    const checkpointConfig = resolveConversationCheckpointConfig(api.pluginConfig);
    const checkpointManager = new ConversationCheckpointManager(api, checkpointConfig, {
      memoryCharLimit: memoryConfig.memoryCharLimit,
      userCharLimit: memoryConfig.userCharLimit,
      auditEndpoint: memoryConfig.auditEndpoint,
    });
    api.registerTool((ctx) => createMemoryTool(api, ctx), { name: "memory" });

    api.on("agent_end", async (event, ctx) => {
      try {
        await checkpointManager.captureAgentEnd(event, ctx);
      } catch {
        api.logger.warn("magister-memory: conversation capture failed");
      }
    });
    api.on("before_compaction", async (event, ctx) => {
      try {
        await checkpointManager.captureBeforeCompaction(event.messages, ctx);
      } catch {
        api.logger.warn("magister-memory: pre-compaction capture failed");
      }
    });
    api.on("session_end", (event, ctx) => {
      checkpointManager.scheduleSessionEnd({
        ...ctx,
        sessionId: event.sessionId,
        sessionKey: event.sessionKey ?? ctx.sessionKey,
      });
    });
    api.on("before_prompt_build", async (event, ctx) => {
      try {
        const recentContext = await checkpointManager.buildPromptContext({
          prompt: event.prompt,
          messages: event.messages,
          ctx,
        });
        return recentContext ? { prependSystemContext: recentContext } : undefined;
      } catch {
        api.logger.warn("magister-memory: recent conversation recall failed");
        return undefined;
      }
    });
    api.on("message_sending", async (event, ctx) => {
      try {
        const content = await checkpointManager.appendPendingReceipt(event.content, ctx);
        return content ? { content } : undefined;
      } catch {
        api.logger.warn("magister-memory: receipt delivery failed");
        return undefined;
      }
    });
    api.on("message_sent", async (event, ctx) => {
      try {
        await checkpointManager.confirmPendingReceiptDelivery(event, ctx);
      } catch {
        api.logger.warn("magister-memory: receipt confirmation failed");
      }
    });
    api.registerService({
      id: "magister-memory-conversation-checkpoints",
      start: (ctx) => checkpointManager.start(ctx.workspaceDir),
      stop: () => checkpointManager.stop(),
    });
  },
});

// Re-exports for unit tests.
export { createMemoryTool };
export { MemoryStore } from "./memory-store.js";
export { mirrorAudit } from "./audit-mirror.js";
export { scanMemoryContent } from "./threat-scan.js";
export { ConversationCheckpointManager } from "./conversation-manager.js";
export { resolveConversationCheckpointConfig } from "./conversation-config.js";

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
