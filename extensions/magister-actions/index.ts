import { createHash, createHmac } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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
const DEFAULT_WORKSPACE_DIR = "/data/.openclaw/workspace";
const MAX_COMPLETION_ARTIFACT_BYTES = 16 * 1024 * 1024;

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
  workspaceDir?: string;
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
    workspaceDir: config.workspaceDir ?? process.env.OPENCLAW_WORKSPACE ?? DEFAULT_WORKSPACE_DIR,
  };
}

class ArtifactValidationError extends Error {}

async function attestCompletionArtifacts(
  action: string,
  rawParams: Record<string, unknown>,
  gatewayToken: string,
  sessionKey: string | undefined,
  workspaceDir: string,
): Promise<{ params: Record<string, unknown>; attestation?: string }> {
  if (action !== "submit_workflow_completion") {
    return { params: rawParams };
  }
  const rawArtifacts = rawParams.artifacts;
  if (rawArtifacts === undefined || (Array.isArray(rawArtifacts) && rawArtifacts.length === 0)) {
    return { params: rawParams };
  }
  if (!Array.isArray(rawArtifacts)) {
    throw new ArtifactValidationError("Completion artifacts must be an array.");
  }

  let workspaceRoot: string;
  let resourcesRoot: string;
  try {
    workspaceRoot = await realpath(workspaceDir);
    resourcesRoot = await realpath(resolve(workspaceRoot, "resources"));
  } catch {
    throw new ArtifactValidationError("The workspace resources directory is unavailable.");
  }
  const relativeResources = relative(workspaceRoot, resourcesRoot);
  if (relativeResources.startsWith("..") || isAbsolute(relativeResources)) {
    throw new ArtifactValidationError("The resources directory escapes the workspace.");
  }
  const normalized: Array<Record<string, unknown>> = [];
  const manifest: string[][] = [];
  for (const rawArtifact of rawArtifacts) {
    if (!isRecord(rawArtifact)) {
      throw new ArtifactValidationError("Every completion artifact must be an object.");
    }
    const path = rawArtifact.path;
    const suppliedHash = rawArtifact.sha256;
    const kind = typeof rawArtifact.kind === "string" ? rawArtifact.kind : "file";
    if (
      typeof path !== "string" ||
      !/^resources\/[A-Za-z0-9._/-]{1,480}$/.test(path) ||
      typeof suppliedHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(suppliedHash) ||
      !/^[A-Za-z0-9._:-]{1,80}$/.test(kind)
    ) {
      throw new ArtifactValidationError("Completion artifact path or SHA-256 is invalid.");
    }
    let filePath: string;
    try {
      filePath = await realpath(resolve(workspaceDir, path));
    } catch {
      throw new ArtifactValidationError(`Completion artifact does not exist: ${path}.`);
    }
    const relativePath = relative(resourcesRoot, filePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new ArtifactValidationError("Completion artifact escapes the resources directory.");
    }
    let fileSize: number;
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        throw new Error("not a file");
      }
      fileSize = fileStat.size;
    } catch {
      throw new ArtifactValidationError(`Completion artifact cannot be read: ${path}.`);
    }
    if (fileSize > MAX_COMPLETION_ARTIFACT_BYTES) {
      throw new ArtifactValidationError(`Completion artifact is too large: ${path}.`);
    }
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      throw new ArtifactValidationError(`Completion artifact cannot be read: ${path}.`);
    }
    if (content.byteLength > MAX_COMPLETION_ARTIFACT_BYTES) {
      throw new ArtifactValidationError(`Completion artifact is too large: ${path}.`);
    }
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== suppliedHash) {
      throw new ArtifactValidationError(`Completion artifact hash mismatch for ${path}.`);
    }
    normalized.push({ path, sha256: actualHash, kind });
    manifest.push([path, actualHash, kind]);
  }

  const signed = `${sessionKey ?? ""}\n${JSON.stringify(manifest)}`;
  const attestation = `v1=${createHmac("sha256", gatewayToken).update(signed).digest("hex")}`;
  return { params: { ...rawParams, artifacts: normalized }, attestation };
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
        const prepared = await attestCompletionArtifacts(
          action.action,
          rawParams,
          gatewayToken,
          workflowSessionKey,
          config.workspaceDir,
        );
        const response = await fetchImpl(`${config.endpoint}/${action.action}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${gatewayToken}`,
            "content-type": "application/json",
            ...(workflowSessionKey ? { "x-magister-session-key": workflowSessionKey } : {}),
            ...(prepared.attestation
              ? { "x-magister-artifact-attestation": prepared.attestation }
              : {}),
          },
          body: JSON.stringify({ arguments: prepared.params }),
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
        const artifactInvalid = error instanceof ArtifactValidationError;
        return jsonResult(
          failureEnvelope(action, callId, {
            code: artifactInvalid ? "validation_error" : "upstream_failed",
            message: artifactInvalid
              ? error.message
              : timedOut
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
