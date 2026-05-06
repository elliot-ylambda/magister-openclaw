/**
 * Magister fork: round-trip the JSON that openclaw-image/entrypoint.sh
 * produces in a canary-shaped env through OpenClawSchema. Catches schema
 * drift the moment it appears (silent-ignored keys, strict() rejections,
 * fork-patched fields that didn't survive an upstream sync).
 *
 * Source of truth for what's tested here:
 * openclaw-image/entrypoint.sh in the parent magister-marketing repo.
 * If you change either side, update both.
 */
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

// Mirrors the canary's process.env. Values are the exact runtime shapes
// the entrypoint writes — secrets are dummy strings.
function buildCanaryRuntimeConfig() {
  // Values match openclaw-image/default-config/openclaw.json + every
  // mutation entrypoint.sh applies in proxy mode (GATEWAY_TOKEN set,
  // BYOK_ANTHROPIC_KEY unset, Slack disconnected).
  const c: Record<string, unknown> = {
    agents: {
      list: [
        {
          id: "marketing",
          name: "Magister Marketing Agent",
          workspace: "/data/.openclaw/workspace",
        },
      ],
      defaults: {
        maxConcurrent: 4,
        sandbox: { mode: "off" },
        model: { primary: "magister-gateway/anthropic/claude-sonnet-4-6" },
        heartbeat: {
          every: "24h",
          model: "magister-gateway/anthropic/claude-haiku-4-5",
          lightContext: true,
          activeHours: { start: "00:00", end: "01:00", timezone: "UTC" },
        },
      },
    },
    browser: { enabled: true },
    hooks: {
      internal: {
        enabled: true,
        load: { extraDirs: ["/data/.openclaw/workspace/hooks"] },
        entries: {
          "skills-sync": { enabled: true },
          "templates-sync": { enabled: true },
        },
      },
    },
    gateway: {
      mode: "local",
      bind: "lan",
      auth: { mode: "token" },
      controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
          responses: { enabled: true },
        },
      },
    },
    plugins: {
      slots: { contextEngine: "magister-integrations" },
      entries: {
        brave: {
          config: {
            webSearch: {
              apiKey: "MAGISTER_GATEWAY_TOKEN_DUMMY",
              mode: "web",
              baseUrl: "http://magister-gateway.internal:8081/api/search",
            },
          },
        },
      },
    },
    models: {
      providers: {
        "magister-gateway": {
          baseUrl: "http://magister-gateway.internal:8081/llm/v1",
          api: "openai-completions",
          apiKey: "MAGISTER_GATEWAY_API_KEY",
          models: [
            {
              id: "anthropic/claude-sonnet-4-6",
              name: "Default",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 16384,
            },
            {
              id: "anthropic/claude-haiku-4-5",
              name: "Haiku (heartbeat)",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 4096,
            },
          ],
        },
        google: {
          apiKey: "GEMINI_API_KEY",
          baseUrl: "http://magister-gateway.internal:8081/api/gemini/v1beta",
          models: [],
        },
      },
    },
    cron: {
      completionWebhook: "http://magister-gateway.internal:8081/api/cron-webhook",
      webhookToken: "GATEWAY_TOKEN_DUMMY",
    },
    // Entrypoint denies the native cron tool so workflows must use the
    // Magister API. See openclaw-image/entrypoint.sh line 118-122.
    tools: {
      deny: ["cron"],
    },
    subagent: {
      completionWebhook: "http://magister-gateway.internal:8081/api/subagent-webhook",
      webhookToken: "GATEWAY_TOKEN_DUMMY",
    },
    channels: {
      slack: { enabled: false },
    },
  };
  return c;
}

describe("Magister entrypoint config round-trip", () => {
  it("v2026.5.4 OpenClawSchema accepts the canary-shaped JSON the entrypoint writes", () => {
    const cfg = buildCanaryRuntimeConfig();
    const result = OpenClawSchema.safeParse(cfg);
    if (!result.success) {
      // Print the full zod error tree so the failure message points at
      // the exact key that's stale or misspelled.
      console.error(JSON.stringify(result.error.format(), null, 2));
    }
    expect(result.success).toBe(true);
  });

  it("Magister fork keys are present (regression guard)", () => {
    const cfg = buildCanaryRuntimeConfig();
    const parsed = OpenClawSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as Record<string, unknown>;
    // cron.completionWebhook — fork patch (Patches 3+4)
    expect((data.cron as { completionWebhook?: string }).completionWebhook).toBeTruthy();
    // subagent.completionWebhook — fork patch (Patch 5)
    expect((data.subagent as { completionWebhook?: string }).completionWebhook).toBeTruthy();
    // contextEngine slot bound to fork's magister-integrations — fork patch (Patch 6)
    expect(
      ((data.plugins as { slots?: { contextEngine?: string } }).slots ?? {}).contextEngine,
    ).toBe("magister-integrations");
  });

  it("Brave config is at the v2026.5.4 plugin path, not the legacy tools.web path", () => {
    const cfg = buildCanaryRuntimeConfig();
    const parsed = OpenClawSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as Record<string, unknown>;
    const plugins = data.plugins as { entries?: Record<string, unknown> };
    const brave = plugins.entries?.brave as { config?: { webSearch?: Record<string, unknown> } };
    expect(brave?.config?.webSearch).toEqual({
      apiKey: "MAGISTER_GATEWAY_TOKEN_DUMMY",
      mode: "web",
      baseUrl: "http://magister-gateway.internal:8081/api/search",
    });
    // The legacy tools.web.search.brave path would be silently dropped by
    // OpenClawSchema's strict() validator if we wrote it — guard against it.
    expect(
      (data as { tools?: { web?: { search?: { brave?: unknown } } } }).tools?.web?.search?.brave,
    ).toBeUndefined();
  });
});
