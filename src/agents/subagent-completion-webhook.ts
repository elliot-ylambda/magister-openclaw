// Magister fork: bridge OpenClaw `subagent_ended` lifecycle events to the
// Magister gateway, which inserts a `chat_messages` row so webchat users see
// sub-agent results without re-prompting. Mirrors `cron.completionWebhook`
// (see `src/gateway/server-cron.ts:415-432`).
//
// We send the OPAQUE OpenClaw session key (the parent/requester session key
// from the hook ctx). The gateway resolves it to `chat_sessions.id` via the
// `openclaw_session_key` column, avoiding any brittle UUID-extraction regex.

import { loadConfig } from "../config/config.js";
import { getGlobalPluginRegistry } from "../plugins/hook-runner-global.js";
import type {
  PluginHookHandlerMap,
  PluginHookSubagentContext,
  PluginHookSubagentEndedEvent,
} from "../plugins/types.js";
import { captureSubagentCompletionReply } from "./subagent-announce.js";

function trimToOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type SubagentCompletionWebhookOutcome = "ok" | "error" | "timeout";

export type SubagentCompletionWebhookPayload = {
  /** Opaque OpenClaw session key for the PARENT chat session (requesterSessionKey). */
  openclaw_session_key: string;
  /** OpenClaw subagent runId — used as the gateway-side idempotency key. */
  run_id: string;
  /** Opaque session key of the sub-agent itself (targetSessionKey). */
  child_session_key: string;
  outcome: SubagentCompletionWebhookOutcome;
  summary: string;
  runtime_ms: number;
  error?: string;
  input_tokens?: number;
  output_tokens?: number;
};

/**
 * POST a sub-agent completion payload to the gateway. Best-effort: a delivery
 * failure logs and swallows so the lifecycle hook chain doesn't crash.
 */
export async function sendSubagentCompletionWebhook(params: {
  url: string;
  token: string;
  payload: SubagentCompletionWebhookPayload;
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
      // Best-effort: log + swallow. The user can still see results via the
      // existing on-load `agent_turns` poll if delivery fails entirely.
      // eslint-disable-next-line no-console
      console.warn(
        `[subagent-completion-webhook] non-2xx response status=${res.status} run=${params.payload.run_id}`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[subagent-completion-webhook] delivery failed:", err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Built-in `subagent_ended` hook that POSTs a completion webhook on every
 * sub-agent termination. Idempotent at registration: returns early if config
 * is missing or the hook is already registered.
 *
 * The hook receives `event: PluginHookSubagentEndedEvent` and
 * `ctx: PluginHookSubagentContext`. The PARENT session key lives on
 * `ctx.requesterSessionKey` (verified in `subagent-registry-completion.ts:84`,
 * which constructs the ctx). The CHILD/target session key is on
 * `event.targetSessionKey`. Token usage / startedAt are not exposed by the
 * registry's public reader API, so we omit them — runtime_ms defaults to 0.
 */
export function registerSubagentCompletionWebhookHook(): void {
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return;
  }
  const url = trimToOptionalString(cfg.subagent?.completionWebhook);
  // webhookToken is SecretInput (string | SecretRef). Only inline string tokens
  // are supported here, matching how `cron.webhookToken` is consumed in
  // `server-cron.ts`. SecretRef values are unsupported (would need runtime
  // resolution); the webhook simply stays unconfigured in that case.
  const token = trimToOptionalString(cfg.subagent?.webhookToken);
  if (!url || !token) {
    return;
  }
  const registry = getGlobalPluginRegistry();
  if (!registry) {
    return;
  }
  // Guard against duplicate registrations on hot-reload / test rebuilds.
  if (
    registry.typedHooks.some(
      (h) => h.hookName === "subagent_ended" && h.pluginId === SUBAGENT_WEBHOOK_PLUGIN_ID,
    )
  ) {
    return;
  }

  const handler: PluginHookHandlerMap["subagent_ended"] = async (event, ctx) => {
    try {
      await deliverSubagentCompletionWebhook({ event, ctx, url, token });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[subagent-completion-webhook] hook handler error:", err);
    }
  };

  registry.typedHooks.push({
    pluginId: SUBAGENT_WEBHOOK_PLUGIN_ID,
    hookName: "subagent_ended",
    handler,
    priority: 0,
    source: "magister-fork",
  } as (typeof registry.typedHooks)[number]);
}

const SUBAGENT_WEBHOOK_PLUGIN_ID = "magister-subagent-completion-webhook";

async function deliverSubagentCompletionWebhook(params: {
  event: PluginHookSubagentEndedEvent;
  ctx: PluginHookSubagentContext;
  url: string;
  token: string;
}): Promise<void> {
  // The PARENT session is the user's chat session — what we map to chat_sessions.id.
  const openclawSessionKey = params.ctx.requesterSessionKey?.trim();
  if (!openclawSessionKey) {
    return;
  }
  const childSessionKey = params.event.targetSessionKey;
  const runId = params.event.runId?.trim();
  if (!runId) {
    return;
  }

  const summaryRaw = await captureSubagentCompletionReply(childSessionKey).catch(() => undefined);
  const summary = (summaryRaw ?? "(no output)").trim();

  const rawOutcome = params.event.outcome;
  const outcome: SubagentCompletionWebhookOutcome =
    rawOutcome === "error" || rawOutcome === "timeout" ? rawOutcome : "ok";

  await sendSubagentCompletionWebhook({
    url: params.url,
    token: params.token,
    payload: {
      openclaw_session_key: openclawSessionKey,
      run_id: runId,
      child_session_key: childSessionKey,
      outcome,
      summary,
      // Token usage and startedAt are not exposed via a public reader on the
      // subagent registry today. The gateway treats these as nice-to-haves;
      // omit cleanly rather than fabricate.
      runtime_ms: 0,
      error: params.event.error,
    },
  });
}
