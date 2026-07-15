import { createHash } from "node:crypto";
import {
  definePluginEntry,
  jsonResult,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import type { TSchema } from "typebox";
import contractJson from "./action-contract.json" with { type: "json" };

const DEFAULT_ENDPOINT = "http://magister-gateway.internal:8081/api/agent/actions";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

const ERROR_CODES = new Set([
  "validation_error",
  "not_authorized",
  "needs_connection",
  "rate_limited",
  "limit_reached",
  "upstream_failed",
  "conflict",
]);
const STATUS_STATES = new Set(["running", "succeeded", "failed"]);
const SIDE_EFFECTS = new Set([
  "none",
  "draft",
  "internal_write",
  "external_write",
  "spend",
  "delete",
]);

type ActionContract = {
  action: string;
  tool_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  side_effect: string;
};

type Contract = {
  schema_version: number;
  registry_revision: string;
  actions: ActionContract[];
};

type PluginConfig = {
  endpoint?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

type ActionEnvelope = {
  ok: boolean;
  operation_id: string;
  resource_id: string | null;
  status: {
    state: "running" | "succeeded" | "failed";
    terminal: boolean;
    poll_after_seconds: number;
    stale_seconds: number | null;
  };
  side_effect: "none" | "draft" | "internal_write" | "external_write" | "spend" | "delete";
  idempotency_key: string | null;
  receipt: Record<string, unknown>;
  artifacts: Array<Record<string, unknown>>;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    retry_after_seconds: number | null;
    user_action: string | null;
  } | null;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const contract = contractJson as Contract;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function parseActionEnvelope(value: unknown): ActionEnvelope | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return null;
  }
  if (
    typeof value.operation_id !== "string" ||
    value.operation_id.length < 4 ||
    !isNullableString(value.resource_id) ||
    !isNullableString(value.idempotency_key) ||
    !SIDE_EFFECTS.has(String(value.side_effect)) ||
    !isRecord(value.receipt) ||
    !Array.isArray(value.artifacts) ||
    !value.artifacts.every(isRecord)
  ) {
    return null;
  }
  const status = value.status;
  if (
    !isRecord(status) ||
    !STATUS_STATES.has(String(status.state)) ||
    typeof status.terminal !== "boolean" ||
    !isNullableNonNegativeNumber(status.poll_after_seconds) ||
    status.poll_after_seconds === null ||
    !isNullableNonNegativeNumber(status.stale_seconds)
  ) {
    return null;
  }
  if (value.ok && value.error !== null) {
    return null;
  }
  if (!value.ok) {
    const error = value.error;
    if (
      !isRecord(error) ||
      !ERROR_CODES.has(String(error.code)) ||
      typeof error.message !== "string" ||
      typeof error.retryable !== "boolean" ||
      !isNullableNonNegativeNumber(error.retry_after_seconds) ||
      !isNullableString(error.user_action)
    ) {
      return null;
    }
  }
  return value as ActionEnvelope;
}

function clientOperationId(action: string, callId: string): string {
  const digest = createHash("sha256").update(`${action}:${callId}`).digest("hex").slice(0, 32);
  return `op_client_${digest}`;
}

function failureEnvelope(
  action: ActionContract,
  callId: string,
  options: {
    code: string;
    message: string;
    retryable?: boolean;
    retryAfterSeconds?: number | null;
    userAction?: string | null;
  },
): ActionEnvelope {
  return {
    ok: false,
    operation_id: clientOperationId(action.action, callId),
    resource_id: null,
    status: {
      state: "failed",
      terminal: true,
      poll_after_seconds: 0,
      stale_seconds: 0,
    },
    side_effect: SIDE_EFFECTS.has(action.side_effect)
      ? (action.side_effect as ActionEnvelope["side_effect"])
      : "none",
    idempotency_key: null,
    receipt: {},
    artifacts: [],
    error: {
      code: ERROR_CODES.has(options.code) ? options.code : "upstream_failed",
      message: options.message.slice(0, 1000),
      retryable: options.retryable === true,
      retry_after_seconds: options.retryAfterSeconds ?? null,
      user_action: options.userAction?.slice(0, 1000) ?? null,
    },
  };
}

function resolveConfig(api: OpenClawPluginApi): Required<PluginConfig> {
  const config = (api.pluginConfig ?? {}) as PluginConfig;
  const endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "magister-gateway.internal" ||
    url.pathname !== "/api/agent/actions"
  ) {
    throw new Error("magister-actions endpoint must be the internal Magister gateway action path");
  }
  return {
    endpoint,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("response_too_large");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export function createMagisterActionTool(
  api: OpenClawPluginApi,
  action: ActionContract,
  fetchImpl: FetchLike = fetch,
  context: OpenClawPluginToolContext = {},
) {
  return {
    name: action.tool_name,
    label: action.tool_name,
    description: action.description,
    parameters: action.input_schema as unknown as TSchema,
    async execute(callId: string, rawParams: Record<string, unknown>) {
      const gatewayToken = process.env.GATEWAY_TOKEN;
      if (!gatewayToken) {
        return jsonResult(
          failureEnvelope(action, callId, {
            code: "not_authorized",
            message: "Project machine credential is unavailable.",
            userAction: "Retry after the project machine is reprovisioned or repaired.",
          }),
        );
      }

      let config: Required<PluginConfig>;
      try {
        config = resolveConfig(api);
      } catch {
        return jsonResult(
          failureEnvelope(action, callId, {
            code: "not_authorized",
            message: "The Magister action endpoint is not trusted.",
            userAction: "Restore the system-managed magister-actions plugin configuration.",
          }),
        );
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      const workflowSessionKey = context.sessionKey?.startsWith("workflow_run:")
        ? context.sessionKey
        : undefined;
      try {
        const response = await fetchImpl(`${config.endpoint}/${action.action}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${gatewayToken}`,
            "content-type": "application/json",
            ...(workflowSessionKey ? { "x-magister-session-key": workflowSessionKey } : {}),
          },
          body: JSON.stringify({ arguments: rawParams }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryAfter = Number(response.headers.get("retry-after"));
          return jsonResult(
            failureEnvelope(action, callId, {
              code:
                response.status === 401 || response.status === 403
                  ? "not_authorized"
                  : response.status === 429
                    ? "rate_limited"
                    : response.status >= 500
                      ? "upstream_failed"
                      : "validation_error",
              message: `Magister action request failed with HTTP ${response.status}.`,
              retryable: response.status === 429 || response.status >= 500,
              retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
            }),
          );
        }
        const body = await readBoundedBody(response, config.maxResponseBytes);
        let decoded: unknown;
        try {
          decoded = JSON.parse(body);
        } catch {
          decoded = null;
        }
        const envelope = parseActionEnvelope(decoded);
        if (!envelope) {
          return jsonResult(
            failureEnvelope(action, callId, {
              code: "upstream_failed",
              message: "Gateway returned an invalid Magister action envelope.",
              retryable: false,
              userAction: "Do not infer success; report the typed-tool contract failure.",
            }),
          );
        }
        return jsonResult(envelope);
      } catch (error) {
        const timedOut = controller.signal.aborted;
        const tooLarge = error instanceof Error && error.message === "response_too_large";
        return jsonResult(
          failureEnvelope(action, callId, {
            code: "upstream_failed",
            message: timedOut
              ? `Magister action timed out after ${config.timeoutMs}ms.`
              : tooLarge
                ? "Magister action response exceeded the configured size limit."
                : "Magister action transport failed.",
            retryable: timedOut && action.side_effect === "none",
            userAction:
              action.side_effect === "external_write" ||
              action.side_effect === "spend" ||
              action.side_effect === "delete"
                ? "Read back the target state before deciding whether to retry."
                : null,
          }),
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export default definePluginEntry({
  id: "magister-actions",
  name: "Magister Actions",
  description: "Typed project-scoped actions executed by the Magister gateway.",
  register(api) {
    for (const action of contract.actions) {
      api.registerTool((context) => createMagisterActionTool(api, action, fetch, context), {
        name: action.tool_name,
      });
    }
  },
});

export { contract as nativeActionContract };
