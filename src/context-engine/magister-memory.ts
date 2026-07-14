import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { MagisterIntegrationsContextEngine } from "./magister-integrations.js";
import { MagisterPlanContextEngine } from "./magister-plan.js";
import { renderMagisterContextBlock } from "./magister-provenance.js";
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
const DEFAULT_PROJECT_PATH = "/data/.openclaw/workspace/PROJECT.md";
const DEFAULT_BRAND_PATH = "/data/.openclaw/workspace/BRAND.md";
const MAX_TRACKED_SESSIONS = 200;
const MAX_BRAND_CONTEXT_CHARS = 4_500;
const MAX_USER_BRAND_CHARS = 2_500;
const BRAND_GENERATED_START = "<!-- MAGISTER:GENERATED BRAND START -->";
const BRAND_GENERATED_END = "<!-- MAGISTER:GENERATED BRAND END -->";
const BRAND_TASK_PATTERN =
  /\b(ad|audience|brand|campaign|content|copy|creative|design|email|homepage|landing|logo|message|positioning|social|tone|visual|voice)\b/i;

type Options = {
  memoryPath?: string;
  userPath?: string;
  projectPath?: string;
  brandPath?: string;
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
    version: "1.2.0",
    ownsWorkspaceBootstrapFiles: ["MEMORY.md", "USER.md", "PROJECT.md", "BRAND.md"],
  };

  private readonly inner: ContextEngine;
  private readonly memoryPath: string;
  private readonly userPath: string;
  private readonly projectPath: string;
  private readonly brandPath: string;
  private readonly snapshotBySession = new Map<string, string>();

  constructor(options: Options = {}) {
    this.inner = options.inner ?? new MagisterIntegrationsContextEngine();
    this.memoryPath = options.memoryPath ?? DEFAULT_MEMORY_PATH;
    this.userPath = options.userPath ?? DEFAULT_USER_PATH;
    this.projectPath = options.projectPath ?? DEFAULT_PROJECT_PATH;
    this.brandPath = options.brandPath ?? DEFAULT_BRAND_PATH;
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

    const brandContext = await this.renderBrandContext(params.prompt);
    if (!snapshot && !brandContext) {
      return innerResult;
    }

    const previous = innerResult.systemPromptAddition?.trim();
    const merged = [previous, snapshot, brandContext].filter(Boolean).join("\n\n");
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
    const [memory, user, project] = await Promise.all([
      readTextOrEmpty(this.memoryPath),
      readTextOrEmpty(this.userPath),
      readTextOrEmpty(this.projectPath),
    ]);

    const blocks: string[] = [];
    if (memory) {
      blocks.push(
        renderMagisterContextBlock({
          provenance: "trusted_project_state",
          source: "older_inferred_memory",
          title: "Memory (about the project)",
          content: memory,
        }),
      );
    }
    if (user) {
      blocks.push(
        renderMagisterContextBlock({
          provenance: "trusted_project_state",
          source: "confirmed_user_profile",
          title: "User Profile",
          content: user,
        }),
      );
    }
    if (project) {
      blocks.push(
        renderMagisterContextBlock({
          provenance: "trusted_project_state",
          source: "project_assignment",
          title: "Project Assignment",
          content: project,
        }),
      );
    }
    return blocks.join("\n\n");
  }

  private async renderBrandContext(prompt: string | undefined): Promise<string> {
    if (!prompt || !BRAND_TASK_PATTERN.test(prompt)) {
      return "";
    }
    const raw = await readTextOrEmpty(this.brandPath);
    if (!raw) {
      return "";
    }
    const start = raw.indexOf(BRAND_GENERATED_START);
    const end = raw.indexOf(BRAND_GENERATED_END, start + BRAND_GENERATED_START.length);
    const generated =
      start >= 0 && end > start ? raw.slice(start + BRAND_GENERATED_START.length, end).trim() : "";
    const userAuthored = (
      start >= 0 && end > start
        ? `${raw.slice(0, start)}\n${raw.slice(end + BRAND_GENERATED_END.length)}`
        : raw
    )
      .replace(/^# Brand context\s*/i, "")
      .replace(
        /^Content outside the generated markers is user-owned and takes precedence\.\s*/i,
        "",
      )
      .trim();

    const boundedUser = userAuthored.slice(0, MAX_USER_BRAND_CHARS);
    const remaining = Math.max(0, MAX_BRAND_CONTEXT_CHARS - boundedUser.length);
    const boundedGenerated = generated.slice(0, remaining);
    return [
      boundedUser
        ? renderMagisterContextBlock({
            provenance: "user_authored_content",
            source: "brand_file_overrides",
            title: "Confirmed brand guide and overrides",
            content: boundedUser,
          })
        : "",
      boundedGenerated
        ? renderMagisterContextBlock({
            provenance: "trusted_project_state",
            source: "current_audit_inference",
            title: "Current bounded audit-derived brand claims",
            content: boundedGenerated,
          })
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
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
