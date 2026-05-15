import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  definePluginEntry,
  jsonResult,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { mirrorAudit } from "./audit-mirror.js";
import { MemoryStore, type MemoryTarget } from "./memory-store.js";

const DEFAULT_AUDIT_ENDPOINT = "http://magister-gateway.internal:8081/api/memory/audit";
const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;

type MemoryPluginConfig = {
  enabled?: boolean;
  memoryCharLimit?: number;
  userCharLimit?: number;
  auditEndpoint?: string;
};

type MemoryToolParams = {
  action?: string;
  target?: string;
  content?: string;
  old_text?: string;
};

const TOOL_DESCRIPTION = `Persistent curated memory. Two stores, one tool.

target='memory' — what you've learned about the project/business (brand voice, audience, patterns).
target='user'   — what you've learned about the user (name, preferences, working style).

Both are loaded into your system prompt at session start and stay frozen for the session.
Writes here go to disk immediately and appear in the NEXT session's system prompt.

Use sparingly. Char limits are tight — every entry must be a single, durable, single-line fact.
If you can't summarize it in 20 words, it's not memory, it's a task note.`;

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
  return {
    enabled: cfg.enabled !== false,
    memoryCharLimit: cfg.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: cfg.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT,
    auditEndpoint: cfg.auditEndpoint ?? DEFAULT_AUDIT_ENDPOINT,
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
      action: Type.String({ enum: ["add", "replace", "remove"] }),
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
    }),
    async execute(_callId: string, rawParams: Record<string, unknown>) {
      const params = rawParams as MemoryToolParams;
      const action = params.action;
      const target: MemoryTarget = params.target === "user" ? "user" : "memory";

      const workspaceDir = resolveWorkspaceDir(api, ctx);
      const store = new MemoryStore({
        memoryDir: workspaceDir,
        memoryCharLimit: cfg.memoryCharLimit,
        userCharLimit: cfg.userCharLimit,
      });
      await store.loadFromDisk();

      const gatewayToken = process.env.GATEWAY_TOKEN ?? "";
      const auditEnabled = gatewayToken.length > 0;
      const fireAudit = (
        kind: "add" | "replace" | "remove" | "blocked",
        content: string,
        blockedReason?: string,
      ): void => {
        if (!auditEnabled) {
          return;
        }
        void mirrorAudit(
          { endpoint: cfg.auditEndpoint, gatewayToken },
          { action: kind, target, content, blockedReason },
        );
      };

      if (action === "add") {
        if (!params.content) {
          return jsonResult({
            success: false,
            target,
            message: "content is required for add",
          });
        }
        const res = await store.add(target, params.content);
        if (res.success) {
          fireAudit("add", params.content);
        } else {
          fireAudit("blocked", params.content, res.message);
        }
        return jsonResult(res);
      }

      if (action === "replace") {
        if (!params.old_text || !params.content) {
          return jsonResult({
            success: false,
            target,
            message: "old_text and content are required for replace",
          });
        }
        const res = await store.replace(target, params.old_text, params.content);
        if (res.success) {
          fireAudit("replace", params.content);
        } else {
          fireAudit("blocked", params.content, res.message);
        }
        return jsonResult(res);
      }

      if (action === "remove") {
        if (!params.old_text) {
          return jsonResult({
            success: false,
            target,
            message: "old_text is required for remove",
          });
        }
        const res = await store.remove(target, params.old_text);
        if (res.success) {
          fireAudit("remove", params.old_text);
        }
        return jsonResult(res);
      }

      return jsonResult({
        success: false,
        target,
        message: `Unknown action: ${String(action)}`,
      });
    },
  };
}

export default definePluginEntry({
  id: "magister-memory",
  name: "Magister Memory",
  description:
    "Bounded, file-backed agent memory with tool-mediated writes, threat scanning, and gateway audit mirroring.",
  register(api) {
    api.registerTool((ctx) => createMemoryTool(api, ctx), { name: "memory" });
  },
});

// Re-exports for unit tests.
export { createMemoryTool };
export { MemoryStore } from "./memory-store.js";
export { mirrorAudit } from "./audit-mirror.js";
export { scanMemoryContent } from "./threat-scan.js";
