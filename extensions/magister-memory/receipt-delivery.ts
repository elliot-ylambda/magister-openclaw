import { randomUUID } from "node:crypto";
import { withContextLock } from "./context-lock.js";
import { formatReceiptNotice, ReceiptStore } from "./receipt-store.js";

export type ReceiptDeliveryContext = {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  callDepth?: number;
  channelId?: string;
  conversationId?: string;
};

type PendingReceiptDelivery = {
  key: string;
  workspaceDir: string;
  receiptIds: string[];
  notice: string;
  attemptedAt: number;
};

export class ConversationReceiptDelivery {
  private readonly attempts = new Map<string, PendingReceiptDelivery>();

  constructor(
    private readonly options: {
      resolveWorkspace: (ctx: ReceiptDeliveryContext) => string | undefined;
      log?: (message: string) => void;
    },
  ) {}

  async append(content: string, ctx: ReceiptDeliveryContext): Promise<string | undefined> {
    if (
      !content.trim() ||
      content.includes("Updated Magister's memory about:") ||
      (ctx.callDepth ?? 0) > 0
    ) {
      return undefined;
    }
    const workspaceDir = this.options.resolveWorkspace(ctx);
    if (!workspaceDir) {
      return undefined;
    }
    return withContextLock(workspaceDir, async () => {
      this.prune();
      if ([...this.attempts.values()].some((attempt) => attempt.workspaceDir === workspaceDir)) {
        return undefined;
      }
      const store = new ReceiptStore(workspaceDir);
      const pending = await store.listPending();
      const newest = pending[0];
      const receiptGroup = newest
        ? pending.filter((receipt) =>
            newest.groupId ? receipt.groupId === newest.groupId : receipt.id === newest.id,
          )
        : [];
      const notice = formatReceiptNotice(receiptGroup);
      if (!notice) {
        return undefined;
      }
      const key = deliveryKey(ctx) ?? `receipt:${newest?.groupId ?? newest?.id ?? randomUUID()}`;
      this.attempts.set(key, {
        key,
        workspaceDir,
        receiptIds: receiptGroup.map((receipt) => receipt.id),
        notice,
        attemptedAt: Date.now(),
      });
      this.options.log?.(`magister-memory: receipt queued (receipt_count=${receiptGroup.length})`);
      return `${content.trimEnd()}\n\n${notice}`;
    });
  }

  async confirm(
    event: { content: string; success: boolean },
    ctx: ReceiptDeliveryContext,
  ): Promise<void> {
    this.prune();
    const keyed = deliveryKey(ctx);
    const attempt =
      (keyed ? this.attempts.get(keyed) : undefined) ??
      [...this.attempts.values()].find((candidate) => event.content.includes(candidate.notice));
    if (!attempt || !event.content.includes(attempt.notice)) {
      return;
    }
    if (!event.success) {
      this.attempts.delete(attempt.key);
      return;
    }
    await withContextLock(attempt.workspaceDir, async () => {
      await new ReceiptStore(attempt.workspaceDir).markDelivered(attempt.receiptIds);
    });
    this.attempts.delete(attempt.key);
    this.options.log?.(
      `magister-memory: receipt delivered (receipt_count=${attempt.receiptIds.length})`,
    );
  }

  private prune(nowMs = Date.now()): void {
    for (const [key, attempt] of this.attempts) {
      if (nowMs - attempt.attemptedAt > 5 * 60_000) {
        this.attempts.delete(key);
      }
    }
  }
}

function deliveryKey(ctx: ReceiptDeliveryContext): string | undefined {
  if (ctx.runId) {
    return `run:${ctx.runId}`;
  }
  if (ctx.sessionKey) {
    return `session:${ctx.sessionKey}`;
  }
  if (ctx.channelId && ctx.conversationId) {
    return `conversation:${ctx.channelId}:${ctx.conversationId}`;
  }
  return undefined;
}
