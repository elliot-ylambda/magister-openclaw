// Magister fork: bridge `agent_end` lifecycle events for Slack-triggered runs
// to the Magister gateway. The gateway's Slack forwarder holds the project's
// agent_turns slot after delivering an event; this webhook is what releases
// it, giving Slack the same end-to-end one-turn-per-project serialization as
// web chat. Mirrors `subagent-completion-webhook.ts` and
// `cron.completionWebhook` (src/gateway/server-cron.ts).

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGlobalPluginRegistry } from "../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../plugins/types.js";

const SLACK_COMPLETION_WEBHOOK_PLUGIN_ID = "magister-slack-completion-webhook";

/** Machine-side Slack session keys look like `agent:<agentId>:slack:...`. */
export function isSlackSessionKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) {
    return false;
  }
  return /^agent:[^:]+:slack:/.test(sessionKey);
}

export type SlackCompletionWebhookPayload = {
  /** Machine-side OpenClaw session key of the Slack run. */
  openclaw_session_key: string;
  /** OpenClaw run id — idempotency/debug key on the gateway side. */
  run_id: string;
  success: boolean;
  error?: string;
  duration_ms?: number;
};

/**
 * POST a Slack-run completion payload to the gateway. Best-effort: a delivery
 * failure logs and swallows — the gateway's hold loop fail-opens on timeout,
 * so a lost webhook can delay but never wedge the project queue.
 */
export async function sendSlackCompletionWebhook(params: {
  url: string;
  token: string;
  payload: SlackCompletionWebhookPayload;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  if (!params.url || !params.token) {
    return;
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 5_000);
  try {
    const res = await fetchImpl(params.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify(params.payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[slack-completion-webhook] non-2xx response status=${res.status} run=${params.payload.run_id}`,
      );
    }
  } catch (err) {
    console.warn("[slack-completion-webhook] delivery failed:", err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Built-in `agent_end` hook that POSTs a completion webhook whenever a
 * Slack-session run finishes (success or error). Idempotent at registration.
 * `webhookToken` supports inline string tokens only, matching how
 * `subagent.webhookToken` is consumed.
 */
export function registerSlackCompletionWebhookHook(cfg: OpenClawConfig): void {
  const url = cfg.slackCompletion?.completionWebhook?.trim();
  const rawToken = cfg.slackCompletion?.webhookToken;
  const token = typeof rawToken === "string" ? rawToken.trim() : undefined;
  if (!url || !token) {
    return;
  }
  const registry = getGlobalPluginRegistry();
  if (!registry) {
    return;
  }
  if (
    registry.typedHooks.some(
      (h) => h.hookName === "agent_end" && h.pluginId === SLACK_COMPLETION_WEBHOOK_PLUGIN_ID,
    )
  ) {
    return;
  }

  const handler: PluginHookHandlerMap["agent_end"] = async (event, ctx) => {
    try {
      if (!isSlackSessionKey(ctx.sessionKey)) {
        return;
      }
      await sendSlackCompletionWebhook({
        url,
        token,
        payload: {
          openclaw_session_key: ctx.sessionKey ?? "",
          run_id: event.runId ?? ctx.runId ?? "",
          success: event.success,
          ...(event.error ? { error: event.error } : {}),
          ...(typeof event.durationMs === "number" ? { duration_ms: event.durationMs } : {}),
        },
      });
    } catch (err) {
      console.warn("[slack-completion-webhook] hook handler error:", err);
    }
  };

  registry.typedHooks.push({
    pluginId: SLACK_COMPLETION_WEBHOOK_PLUGIN_ID,
    hookName: "agent_end",
    handler,
    priority: 0,
    source: "magister-fork",
  } as (typeof registry.typedHooks)[number]);
}
