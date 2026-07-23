import { randomUUID } from "node:crypto";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { KeyedAsyncQueue, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { mirrorAudit } from "./audit-mirror.js";
import {
  createConversationSessionState,
  listConversationSessionStates,
  readConversationSessionState,
  writeConversationSessionState,
  writeShadowCheckpoint,
} from "./checkpoint-state.js";
import { appendCheckpoint, listRecentCheckpoints } from "./checkpoint-store.js";
import { buildFallbackSummary, summarizeCheckpoint } from "./checkpoint-summarizer.js";
import { withContextLock } from "./context-lock.js";
import {
  boundEntriesFromEnd,
  containsToolWorkInLatestTurn,
  countUserTurns,
  extractConversationDelta,
  extractTranscriptEntries,
  hashIdentifier,
  isMeaningfulConversation,
  requestsImmediateCheckpoint,
  transcriptCharCount,
} from "./conversation-text.js";
import type {
  CheckpointInFlight,
  CheckpointRecord,
  ConversationCheckpointConfig,
  ConversationSessionState,
} from "./conversation-types.js";
import { promoteDurableCandidates, type PromotionResult } from "./durable-promotion.js";
import { memoryOperationId, withHostMutationBoundary } from "./mutation-boundary.js";
import { ConversationReceiptDelivery, type ReceiptDeliveryContext } from "./receipt-delivery.js";
import { buildRecentConversationContext } from "./recent-recall.js";

const SERVICE_INTERVAL_MS = 60_000;
const CHECKPOINT_CHAR_THRESHOLD = 10_000;
const CHECKPOINT_USER_TURN_THRESHOLD = 20;
const MAX_MODEL_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
const EXCLUDED_SESSION_PATTERN =
  /(?:^|:)(?:cron|heartbeat|subagent|workflow|reviewer|memory-flush)(?:$|:)/i;

type AgentContext = ReceiptDeliveryContext & {
  agentId?: string;
  workspaceDir?: string;
  trigger?: string;
};

type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
};

type CaptureOutcome = {
  workspaceDir: string;
  sessionHash: string;
  forceFinalize: boolean;
};

export class ConversationCheckpointManager {
  private readonly stateQueue = new KeyedAsyncQueue();
  private readonly activeFinalizations = new Set<string>();
  private readonly knownWorkspaces = new Set<string>();
  private readonly sessionWorkspaces = new Map<string, string>();
  private readonly receiptDelivery: ConversationReceiptDelivery;
  private interval: NodeJS.Timeout | undefined;

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly config: ConversationCheckpointConfig,
    private readonly memoryLimits: {
      memoryCharLimit: number;
      userCharLimit: number;
      auditEndpoint?: string;
    },
  ) {
    this.receiptDelivery = new ConversationReceiptDelivery({
      resolveWorkspace: (ctx) => this.findSessionWorkspace(ctx),
      log: (message) => this.api.logger.debug?.(message),
    });
    for (const agent of api.config.agents?.list ?? []) {
      if (agent.id && agent.id !== "heartbeat") {
        this.knownWorkspaces.add(resolveAgentWorkspaceDir(api.config, agent.id));
      }
    }
  }

  start(workspaceDir?: string): void {
    if (workspaceDir) {
      this.knownWorkspaces.add(workspaceDir);
    }
    if (this.config.mode === "off" || this.interval) {
      return;
    }
    void this.tick();
    this.interval = setInterval(() => void this.tick(), SERVICE_INTERVAL_MS);
    this.interval.unref?.();
    this.api.logger.info(
      `magister-memory: conversation checkpoints started (mode=${this.config.mode}, interval_seconds=60)`,
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  async captureAgentEnd(event: AgentEndEvent, ctx: AgentContext): Promise<void> {
    if (this.config.mode === "off" || !event.success || !this.isInteractiveContext(ctx)) {
      return;
    }
    const outcome = await this.captureMessages(event.messages, ctx);
    if (outcome?.forceFinalize) {
      this.scheduleFinalize(outcome.workspaceDir, outcome.sessionHash, true, "threshold");
    }
  }

  async captureBeforeCompaction(messages: unknown[] | undefined, ctx: AgentContext): Promise<void> {
    if (this.config.mode === "off") {
      return;
    }
    const outcome =
      messages && this.isInteractiveContext(ctx)
        ? await this.captureMessages(messages, ctx)
        : undefined;
    const identity = this.resolveSessionIdentity(ctx);
    const workspaceDir = outcome?.workspaceDir ?? this.resolveWorkspaceDir(ctx);
    const sessionHash = outcome?.sessionHash ?? (identity ? hashIdentifier(identity) : undefined);
    if (sessionHash) {
      this.scheduleFinalize(workspaceDir, sessionHash, true, "compaction");
    }
  }

  scheduleSessionEnd(ctx: AgentContext): void {
    if (this.config.mode === "off") {
      return;
    }
    const identity = this.resolveSessionIdentity(ctx);
    if (!identity) {
      return;
    }
    this.scheduleFinalize(
      this.resolveWorkspaceDir(ctx),
      hashIdentifier(identity),
      true,
      "session_end",
    );
  }

  async buildPromptContext(params: {
    prompt: string;
    messages: unknown[];
    ctx: AgentContext;
  }): Promise<string | undefined> {
    if (this.config.mode !== "active" || !this.isInteractiveContext(params.ctx)) {
      return undefined;
    }
    const identity = this.resolveSessionIdentity(params.ctx);
    if (!identity) {
      return undefined;
    }
    const workspaceDir = this.resolveWorkspaceDir(params.ctx);
    const sessionHash = hashIdentifier(identity);
    this.rememberSessionWorkspace(params.ctx, workspaceDir);
    return this.stateQueue.enqueue(`${workspaceDir}:${sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir,
        sessionHash,
        agentId: params.ctx.agentId ?? "main",
      });
      if (state.recallFrozen) {
        return state.frozenRecall;
      }
      const [checkpoints, states] = await Promise.all([
        listRecentCheckpoints({
          workspaceDir,
          recentDays: this.config.recentDays,
          userTimezone: this.userTimezone(),
        }),
        listConversationSessionStates(workspaceDir),
      ]);
      const frozenRecall = buildRecentConversationContext({
        prompt: params.prompt,
        checkpoints,
        sessionStates: states,
        currentSessionHash: sessionHash,
        maxHeaderChars: this.config.maxHeaderChars,
        maxRecallChars: this.config.maxRecallChars,
        minimumPendingActivityAt: Date.now() - this.config.recentDays * 24 * 60 * 60 * 1_000,
      });
      state.recallFrozen = true;
      if (frozenRecall) {
        state.frozenRecall = frozenRecall;
      } else {
        delete state.frozenRecall;
      }
      await writeConversationSessionState(workspaceDir, state);
      this.api.logger.debug?.(
        `magister-memory: recent recall frozen (records=${checkpoints.length}, injected_chars=${frozenRecall?.length ?? 0})`,
      );
      return frozenRecall;
    });
  }

  async appendPendingReceipt(content: string, ctx: AgentContext): Promise<string | undefined> {
    return this.config.mode === "active" ? this.receiptDelivery.append(content, ctx) : undefined;
  }

  async confirmPendingReceiptDelivery(
    event: { content: string; success: boolean },
    ctx: AgentContext,
  ): Promise<void> {
    if (this.config.mode === "active") {
      await this.receiptDelivery.confirm(event, ctx);
    }
  }

  async finalizeSessionForTest(params: {
    workspaceDir: string;
    sessionHash: string;
    force?: boolean;
  }): Promise<void> {
    await this.finalizeSession(params.workspaceDir, params.sessionHash, params.force ?? true);
  }

  private async captureMessages(
    messages: unknown[],
    ctx: AgentContext,
  ): Promise<CaptureOutcome | undefined> {
    const identity = this.resolveSessionIdentity(ctx);
    if (!identity) {
      return undefined;
    }
    const workspaceDir = this.resolveWorkspaceDir(ctx);
    const sessionHash = hashIdentifier(identity);
    const agentId = ctx.agentId ?? "main";
    const entries = extractTranscriptEntries(messages);
    if (entries.length === 0) {
      return undefined;
    }
    this.knownWorkspaces.add(workspaceDir);
    this.rememberSessionWorkspace(ctx, workspaceDir);
    return this.stateQueue.enqueue(`${workspaceDir}:${sessionHash}`, async () => {
      const state = await readConversationSessionState({ workspaceDir, sessionHash, agentId });
      const delta = extractConversationDelta(entries, state.lastMessageFingerprint);
      state.lastMessageFingerprint = entries[entries.length - 1].fingerprint;
      if (delta.length === 0) {
        await writeConversationSessionState(workspaceDir, state);
        return { workspaceDir, sessionHash, forceFinalize: false };
      }
      state.lastActivityAt = Date.now();
      if (
        isMeaningfulConversation(delta, {
          hasToolWork: containsToolWorkInLatestTurn(messages),
        })
      ) {
        const knownFingerprints = new Set([
          ...state.pending.map((entry) => entry.fingerprint),
          ...(state.inFlight?.entries.map((entry) => entry.fingerprint) ?? []),
        ]);
        const additions = delta.filter((entry) => !knownFingerprints.has(entry.fingerprint));
        state.pending = boundEntriesFromEnd(
          [...state.pending, ...additions],
          this.config.maxInputChars * 2,
        );
        state.pendingUserTurns = countUserTurns(state.pending);
      }
      await writeConversationSessionState(workspaceDir, state);
      const forceFinalize =
        requestsImmediateCheckpoint(delta) ||
        transcriptCharCount(state.pending) >= CHECKPOINT_CHAR_THRESHOLD ||
        state.pendingUserTurns >= CHECKPOINT_USER_TURN_THRESHOLD;
      this.api.logger.debug?.(
        `magister-memory: conversation delta captured (delta_messages=${delta.length}, pending_chars=${transcriptCharCount(state.pending)}, force=${forceFinalize})`,
      );
      return { workspaceDir, sessionHash, forceFinalize };
    });
  }

  private async tick(): Promise<void> {
    if (this.config.mode === "off") {
      return;
    }
    for (const workspaceDir of this.knownWorkspaces) {
      try {
        const states = await listConversationSessionStates(workspaceDir);
        for (const state of states) {
          const nowMs = Date.now();
          if (
            (state.inFlight && (!state.retryAt || state.retryAt <= nowMs)) ||
            this.isDue(state, nowMs)
          ) {
            this.scheduleFinalize(workspaceDir, state.sessionHash, false, "service");
          }
        }
      } catch (error) {
        this.api.logger.warn(
          `magister-memory: conversation checkpoint scan failed (error=${errorCode(error)})`,
        );
      }
    }
  }

  private scheduleFinalize(
    workspaceDir: string,
    sessionHash: string,
    force: boolean,
    reason: string,
  ): void {
    const key = `${workspaceDir}:${sessionHash}`;
    if (this.activeFinalizations.has(key)) {
      return;
    }
    this.activeFinalizations.add(key);
    void this.finalizeSession(workspaceDir, sessionHash, force)
      .catch((error) => {
        this.api.logger.warn(
          `magister-memory: conversation checkpoint failed (reason=${reason}, error=${errorCode(error)})`,
        );
      })
      .finally(() => this.activeFinalizations.delete(key));
  }

  private async finalizeSession(
    workspaceDir: string,
    sessionHash: string,
    force: boolean,
  ): Promise<void> {
    const finalizeStartedAt = Date.now();
    const claimed = await this.claimCheckpoint(workspaceDir, sessionHash, force);
    if (!claimed) {
      return;
    }
    let summary = claimed.inFlight.prepared;
    if (!summary) {
      try {
        summary = await summarizeCheckpoint({
          api: this.api,
          config: this.config,
          context: {
            workspaceDir,
            agentId: claimed.agentId,
            sessionHash,
            entries: claimed.inFlight.entries,
            previousSummary: claimed.previousSummary,
          },
        });
      } catch (error) {
        const retryCount = claimed.retryCount + 1;
        if (retryCount < MAX_MODEL_ATTEMPTS) {
          await this.requeueFailedCheckpoint({
            workspaceDir,
            sessionHash,
            checkpointId: claimed.inFlight.checkpointId,
            retryCount,
          });
          this.api.logger.warn(
            `magister-memory: checkpoint summary retry scheduled (retry=${retryCount}, duration_ms=${Date.now() - finalizeStartedAt}, error=${errorCode(error)})`,
          );
          return;
        }
        summary = buildFallbackSummary(claimed.inFlight.entries, this.config.maxCheckpointChars);
      }
      await this.persistPreparedSummary(
        workspaceDir,
        sessionHash,
        claimed.inFlight.checkpointId,
        summary,
      );
    }

    // Keep the canonical date and marker stable when a prepared checkpoint is
    // retried after a downstream append, promotion, or receipt failure.
    const createdAt = claimed.inFlight.startedAt;
    const record: CheckpointRecord = {
      version: 1,
      checkpointId: claimed.inFlight.checkpointId,
      sessionHash,
      sequence: claimed.inFlight.sequence,
      startFingerprint: claimed.inFlight.startFingerprint,
      endFingerprint: claimed.inFlight.endFingerprint,
      createdAt,
      summary: summary.summary,
      topics: summary.topics,
    };
    let promotion: PromotionResult = {
      promoted: 0,
      blocked: 0,
      unchanged: 0,
      receipts: [],
      mutations: [],
    };
    try {
      if (this.config.mode === "active") {
        await withContextLock(workspaceDir, async () => {
          await appendCheckpoint({
            workspaceDir,
            userTimezone: this.userTimezone(),
            record,
          });
          promotion = await promoteDurableCandidates({
            workspaceDir,
            checkpointId: record.checkpointId,
            candidates: summary.durableCandidates,
            entries: claimed.inFlight.entries,
            topics: summary.topics,
            promotionConfidence: this.config.promotionConfidence,
            memoryCharLimit: this.memoryLimits.memoryCharLimit,
            userCharLimit: this.memoryLimits.userCharLimit,
            mutationBoundary: (target, content, write) =>
              withHostMutationBoundary(
                {
                  operationId: memoryOperationId(record.checkpointId, "promote", target, content),
                  target,
                  content,
                },
                write,
              ),
          });
        });
        const gatewayToken = process.env.GATEWAY_TOKEN ?? "";
        if (gatewayToken && this.memoryLimits.auditEndpoint) {
          for (const mutation of promotion.mutations) {
            void mirrorAudit(
              { endpoint: this.memoryLimits.auditEndpoint, gatewayToken },
              { action: mutation.action, target: mutation.target, content: mutation.content },
            );
          }
        }
      } else {
        await writeShadowCheckpoint({
          workspaceDir,
          checkpointId: record.checkpointId,
          sessionHash,
          sequence: record.sequence,
          createdAt,
          summary,
        });
      }
      await this.completeCheckpoint({
        workspaceDir,
        sessionHash,
        checkpointId: record.checkpointId,
        summary: summary.summary,
        sequence: record.sequence,
      });
    } catch (error) {
      await this.deferPreparedCheckpoint({
        workspaceDir,
        sessionHash,
        checkpointId: record.checkpointId,
      }).catch(() => undefined);
      throw error;
    }
    this.api.logger.info(
      `magister-memory: conversation checkpoint stored (mode=${this.config.mode}, duration_ms=${Date.now() - finalizeStartedAt}, summary_source=${summary.source}, summary_chars=${summary.summary.length}, promoted=${promotion.promoted}, blocked=${promotion.blocked})`,
    );
  }

  private async claimCheckpoint(
    workspaceDir: string,
    sessionHash: string,
    force: boolean,
  ): Promise<
    | {
        agentId: string;
        previousSummary?: string;
        retryCount: number;
        inFlight: CheckpointInFlight;
      }
    | undefined
  > {
    return this.stateQueue.enqueue(`${workspaceDir}:${sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir,
        sessionHash,
        agentId: "main",
      });
      if (state.retryAt !== undefined && state.retryAt > Date.now()) {
        return undefined;
      }
      if (state.inFlight) {
        return {
          agentId: state.agentId,
          previousSummary: state.previousSummary,
          retryCount: state.retryCount,
          inFlight: state.inFlight,
        };
      }
      const nowMs = Date.now();
      if (state.pending.length === 0 || (!force && !this.isDue(state, nowMs))) {
        return undefined;
      }
      const entries = state.pending;
      const inFlight: CheckpointInFlight = {
        checkpointId: randomUUID(),
        entries,
        startedAt: Date.now(),
        sequence: state.sequence + 1,
        startFingerprint: entries[0].fingerprint,
        endFingerprint: entries.at(-1)?.fingerprint ?? entries[0].fingerprint,
      };
      state.pending = [];
      state.pendingUserTurns = 0;
      state.inFlight = inFlight;
      await writeConversationSessionState(workspaceDir, state);
      return {
        agentId: state.agentId,
        previousSummary: state.previousSummary,
        retryCount: state.retryCount,
        inFlight,
      };
    });
  }

  private async persistPreparedSummary(
    workspaceDir: string,
    sessionHash: string,
    checkpointId: string,
    summary: NonNullable<CheckpointInFlight["prepared"]>,
  ): Promise<void> {
    await this.stateQueue.enqueue(`${workspaceDir}:${sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir,
        sessionHash,
        agentId: "main",
      });
      if (state.inFlight?.checkpointId !== checkpointId) {
        throw new Error("checkpoint_claim_changed");
      }
      state.inFlight.prepared = summary;
      await writeConversationSessionState(workspaceDir, state);
    });
  }

  private async requeueFailedCheckpoint(params: {
    workspaceDir: string;
    sessionHash: string;
    checkpointId: string;
    retryCount: number;
  }): Promise<void> {
    await this.stateQueue.enqueue(`${params.workspaceDir}:${params.sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir: params.workspaceDir,
        sessionHash: params.sessionHash,
        agentId: "main",
      });
      if (state.inFlight?.checkpointId !== params.checkpointId) {
        return;
      }
      state.pending = boundEntriesFromEnd(
        [...state.inFlight.entries, ...state.pending],
        this.config.maxInputChars * 2,
      );
      state.pendingUserTurns = countUserTurns(state.pending);
      state.retryCount = params.retryCount;
      state.retryAt = Date.now() + RETRY_DELAYS_MS[Math.min(params.retryCount - 1, 2)];
      delete state.inFlight;
      await writeConversationSessionState(params.workspaceDir, state);
    });
  }

  private async completeCheckpoint(params: {
    workspaceDir: string;
    sessionHash: string;
    checkpointId: string;
    summary: string;
    sequence: number;
  }): Promise<void> {
    await this.stateQueue.enqueue(`${params.workspaceDir}:${params.sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir: params.workspaceDir,
        sessionHash: params.sessionHash,
        agentId: "main",
      });
      if (state.inFlight?.checkpointId !== params.checkpointId) {
        return;
      }
      delete state.inFlight;
      delete state.retryAt;
      state.retryCount = 0;
      state.sequence = Math.max(state.sequence, params.sequence);
      state.previousSummary = params.summary;
      await writeConversationSessionState(params.workspaceDir, state);
    });
  }

  private async deferPreparedCheckpoint(params: {
    workspaceDir: string;
    sessionHash: string;
    checkpointId: string;
  }): Promise<void> {
    await this.stateQueue.enqueue(`${params.workspaceDir}:${params.sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir: params.workspaceDir,
        sessionHash: params.sessionHash,
        agentId: "main",
      });
      if (state.inFlight?.checkpointId !== params.checkpointId) {
        return;
      }
      state.retryAt = Date.now() + RETRY_DELAYS_MS[1];
      await writeConversationSessionState(params.workspaceDir, state);
    });
  }

  private isDue(state: ConversationSessionState, nowMs: number): boolean {
    if (state.pending.length === 0 || (state.retryAt && state.retryAt > nowMs)) {
      return false;
    }
    return nowMs - state.lastActivityAt >= this.config.idleMinutes * 60_000;
  }

  private isInteractiveContext(ctx: AgentContext): boolean {
    const identity = this.resolveSessionIdentity(ctx) ?? "";
    return (
      ctx.trigger === "user" &&
      ctx.agentId !== "heartbeat" &&
      !EXCLUDED_SESSION_PATTERN.test(`${identity}:${ctx.agentId ?? ""}`)
    );
  }

  private resolveWorkspaceDir(ctx: AgentContext): string {
    const workspace =
      ctx.workspaceDir ?? resolveAgentWorkspaceDir(this.api.config, ctx.agentId ?? "main");
    this.knownWorkspaces.add(workspace);
    return workspace;
  }

  private resolveSessionIdentity(ctx: AgentContext): string | undefined {
    return ctx.sessionId ?? ctx.sessionKey;
  }

  private rememberSessionWorkspace(ctx: AgentContext, workspaceDir: string): void {
    if (ctx.sessionKey) {
      this.sessionWorkspaces.set(ctx.sessionKey, workspaceDir);
    }
    if (ctx.sessionId) {
      this.sessionWorkspaces.set(ctx.sessionId, workspaceDir);
    }
  }

  private findSessionWorkspace(ctx: AgentContext): string | undefined {
    const identity = this.resolveSessionIdentity(ctx);
    const mapped = identity ? this.sessionWorkspaces.get(identity) : undefined;
    if (mapped) {
      return mapped;
    }
    if (ctx.channelId && ctx.conversationId && this.knownWorkspaces.size === 1) {
      return [...this.knownWorkspaces][0];
    }
    return undefined;
  }

  private userTimezone(): string | undefined {
    return this.api.config.agents?.defaults?.userTimezone;
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 40);
  }
  if (
    error instanceof Error &&
    /^[a-zA-Z0-9_.:-]{1,80}$/.test(error.message) &&
    (error.message.startsWith("checkpoint_") || error.message.startsWith("memory_"))
  ) {
    return error.message;
  }
  if (error instanceof Error && error.name) {
    return error.name.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 40);
  }
  return "unknown";
}

export { createConversationSessionState };
