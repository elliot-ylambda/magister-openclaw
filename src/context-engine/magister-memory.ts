import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { MagisterIntegrationsContextEngine } from "./magister-integrations.js";
import { MagisterPlanContextEngine } from "./magister-plan.js";
import { MagisterWorkflowsContextEngine } from "./magister-workflows.js";
import { registerContextEngine } from "./registry.js";
import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  ContextEngineRuntimeContext,
  IngestResult,
} from "./types.js";

const DEFAULT_MEMORY_PATH = "/data/.openclaw/workspace/MEMORY.md";
const DEFAULT_USER_PATH = "/data/.openclaw/workspace/USER.md";
const MAX_TRACKED_SESSIONS = 200;

type Options = {
  memoryPath?: string;
  userPath?: string;
  inner?: ContextEngine;
};

/**
 * Wraps another context engine (default: MagisterIntegrationsContextEngine) and
 * folds MEMORY.md + USER.md content into the system prompt as a FROZEN SNAPSHOT
 * per session.
 *
 * Why frozen: Anthropic prompt caching requires byte-identical prefixes across
 * turns. Re-reading the files every turn (as MagisterIntegrationsContextEngine
 * does for INTEGRATIONS.md, which is fine because integrations change rarely)
 * would invalidate the cache every time the agent's own memory tool wrote a
 * new entry mid-session. So we cache by sessionId on the first assemble() call
 * and never re-read for that session — mid-session writes are durable to disk
 * but only appear in the NEXT session's system prompt.
 */
export class MagisterMemoryContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "magister-memory",
    name: "Magister Memory Context Engine",
    version: "1.0.0",
  };

  private readonly inner: ContextEngine;
  private readonly memoryPath: string;
  private readonly userPath: string;
  private readonly snapshotBySession = new Map<string, string>();

  constructor(options: Options = {}) {
    this.inner = options.inner ?? new MagisterIntegrationsContextEngine();
    this.memoryPath = options.memoryPath ?? DEFAULT_MEMORY_PATH;
    this.userPath = options.userPath ?? DEFAULT_USER_PATH;
  }

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return this.inner.ingest(params);
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: MemoryCitationsMode;
    model?: string;
    prompt?: string;
  }): Promise<AssembleResult> {
    const innerResult = await this.inner.assemble(params);

    let snapshot = this.snapshotBySession.get(params.sessionId);
    if (snapshot === undefined) {
      snapshot = await this.renderSnapshot();
      this.rememberSnapshot(params.sessionId, snapshot);
    }

    if (!snapshot) {
      return innerResult;
    }

    const previous = innerResult.systemPromptAddition?.trim();
    const merged = previous ? `${previous}\n\n${snapshot}` : snapshot;
    return { ...innerResult, systemPromptAddition: merged };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    if (this.inner.afterTurn) {
      await this.inner.afterTurn(params);
    }
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    return this.inner.compact(params);
  }

  async dispose(): Promise<void> {
    if (this.inner.dispose) {
      await this.inner.dispose();
    }
    this.snapshotBySession.clear();
  }

  private async renderSnapshot(): Promise<string> {
    const [memory, user] = await Promise.all([
      readTextOrEmpty(this.memoryPath),
      readTextOrEmpty(this.userPath),
    ]);

    const blocks: string[] = [];
    if (memory) {
      blocks.push(`## Memory (about the project)\n\n${memory}`);
    }
    if (user) {
      blocks.push(`## User Profile\n\n${user}`);
    }
    return blocks.join("\n\n");
  }

  private rememberSnapshot(sessionId: string, snapshot: string): void {
    // Map preserves insertion order; re-inserting on hit gives LRU eviction.
    this.snapshotBySession.delete(sessionId);
    this.snapshotBySession.set(sessionId, snapshot);
    pruneMapToMaxSize(this.snapshotBySession, MAX_TRACKED_SESSIONS);
  }
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf-8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export function registerMagisterMemoryContextEngine(): void {
  // Compose ON TOP of magister-plan so the active 'magister-memory' slot folds
  // MEMORY.md + USER.md (frozen per-session snapshot), the live marketing plan,
  // WORKFLOWS.md, and INTEGRATIONS.md. The chain is:
  //   MagisterMemoryContextEngine (frozen)
  //     -> MagisterPlanContextEngine (per-turn gateway summary + PLAN.md fallback)
  //       -> MagisterWorkflowsContextEngine (per-turn)
  //         -> MagisterIntegrationsContextEngine (per-turn)
  //           -> LegacyContextEngine
  registerContextEngine(
    "magister-memory",
    () =>
      new MagisterMemoryContextEngine({
        inner: new MagisterPlanContextEngine({
          inner: new MagisterWorkflowsContextEngine({
            inner: new MagisterIntegrationsContextEngine(),
          }),
        }),
      }),
  );
}
