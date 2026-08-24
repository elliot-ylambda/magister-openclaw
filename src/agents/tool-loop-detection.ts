import { createHash } from "node:crypto";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { DiagnosticToolLoopEvent } from "../infra/diagnostic-events.js";
import type {
  RuntimeResilienceRunState,
  SessionState,
  ToolCallRecord,
} from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPlainObject } from "../utils.js";

const log = createSubsystemLogger("agents/loop-detection");

type LoopDetectorKind = DiagnosticToolLoopEvent["detector"];

type LoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: "warning" | "critical";
      detector: LoopDetectorKind;
      count: number;
      message: string;
      pairedToolName?: string;
      warningKey?: string;
    };

export const TOOL_CALL_HISTORY_SIZE = 30;
export const WARNING_THRESHOLD = 10;
export const UNKNOWN_TOOL_THRESHOLD = 10;
export const CRITICAL_THRESHOLD = 20;
export const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;
const DEFAULT_LOOP_DETECTION_CONFIG = {
  enabled: false,
  historySize: TOOL_CALL_HISTORY_SIZE,
  warningThreshold: WARNING_THRESHOLD,
  unknownToolThreshold: UNKNOWN_TOOL_THRESHOLD,
  criticalThreshold: CRITICAL_THRESHOLD,
  globalCircuitBreakerThreshold: GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
  detectors: {
    genericRepeat: true,
    knownPollNoProgress: true,
    pingPong: true,
  },
};

const DEFAULT_RUNTIME_RESILIENCE_CONFIG = {
  enabled: false,
  failureWarningThreshold: 2,
  failureBlockThreshold: 5,
  denialBlockThreshold: 3,
  browserLaunchLimit: 10,
};

const RUNTIME_RESILIENCE_LEGACY_RUN_KEY = "__session__";
const MAX_RUNTIME_RESILIENCE_RUNS_PER_SESSION = 32;
const MAX_RUNTIME_FAILURE_STRATEGIES_PER_RUN = 256;

type ResolvedRuntimeResilienceConfig = typeof DEFAULT_RUNTIME_RESILIENCE_CONFIG;

export type RuntimeResilienceOutcomeDecision = {
  guidance?: string;
};

type ResolvedLoopDetectionConfig = {
  enabled: boolean;
  historySize: number;
  warningThreshold: number;
  unknownToolThreshold: number;
  criticalThreshold: number;
  globalCircuitBreakerThreshold: number;
  detectors: {
    genericRepeat: boolean;
    knownPollNoProgress: boolean;
    pingPong: boolean;
  };
};

type ToolLoopDetectionScope = {
  runId?: string;
  sideEffect?: "none" | "draft" | "internal_write" | "external_write" | "spend" | "delete";
};

function resolveRuntimeResilienceConfig(
  config?: ToolLoopDetectionConfig,
): ResolvedRuntimeResilienceConfig {
  const configured = config?.runtimeResilience;
  const failureWarningThreshold = asPositiveInt(
    configured?.failureWarningThreshold,
    DEFAULT_RUNTIME_RESILIENCE_CONFIG.failureWarningThreshold,
  );
  const requestedBlockThreshold = asPositiveInt(
    configured?.failureBlockThreshold,
    DEFAULT_RUNTIME_RESILIENCE_CONFIG.failureBlockThreshold,
  );
  return {
    enabled: configured?.enabled ?? DEFAULT_RUNTIME_RESILIENCE_CONFIG.enabled,
    failureWarningThreshold,
    failureBlockThreshold: Math.max(failureWarningThreshold + 1, requestedBlockThreshold),
    denialBlockThreshold: asPositiveInt(
      configured?.denialBlockThreshold,
      DEFAULT_RUNTIME_RESILIENCE_CONFIG.denialBlockThreshold,
    ),
    browserLaunchLimit: asPositiveInt(
      configured?.browserLaunchLimit,
      DEFAULT_RUNTIME_RESILIENCE_CONFIG.browserLaunchLimit,
    ),
  };
}

function normalizeRunId(runId?: string): string | undefined {
  const trimmed = runId?.trim();
  return trimmed ? trimmed : undefined;
}

function runtimeResilienceRunKey(runId?: string): string {
  return normalizeRunId(runId) ?? RUNTIME_RESILIENCE_LEGACY_RUN_KEY;
}

function getRuntimeResilienceRunState(
  state: SessionState,
  runId: string | undefined,
  options: { create: boolean },
): RuntimeResilienceRunState | undefined {
  const key = runtimeResilienceRunKey(runId);
  const existing = state.runtimeResilienceRuns?.get(key);
  if (existing) {
    existing.lastTouchedAt = Date.now();
    return existing;
  }
  if (!options.create) {
    return undefined;
  }
  const runs = (state.runtimeResilienceRuns ??= new Map());
  if (runs.size >= MAX_RUNTIME_RESILIENCE_RUNS_PER_SESSION) {
    let oldestKey: string | undefined;
    let oldestTouchedAt = Number.POSITIVE_INFINITY;
    for (const [candidateKey, candidate] of runs) {
      if (candidate.lastTouchedAt < oldestTouchedAt) {
        oldestKey = candidateKey;
        oldestTouchedAt = candidate.lastTouchedAt;
      }
    }
    if (oldestKey) {
      runs.delete(oldestKey);
    }
  }
  const created: RuntimeResilienceRunState = {
    lastTouchedAt: Date.now(),
    browserLaunchCallIds: new Set(),
    anonymousBrowserLaunchCount: 0,
    deniedOperationIds: new Set(),
    failuresByStrategy: new Map(),
  };
  runs.set(key, created);
  return created;
}

function runtimeBrowserLaunchCount(runState: RuntimeResilienceRunState | undefined): number {
  if (!runState) {
    return 0;
  }
  return runState.browserLaunchCallIds.size + runState.anonymousBrowserLaunchCount;
}

function recordRuntimeBrowserLaunch(params: {
  state: SessionState;
  runId?: string;
  toolCallId?: string;
}): void {
  const runState = getRuntimeResilienceRunState(params.state, params.runId, { create: true });
  if (!runState) {
    return;
  }
  if (params.toolCallId) {
    runState.browserLaunchCallIds.add(params.toolCallId);
    return;
  }
  runState.anonymousBrowserLaunchCount += 1;
}

function ensureRuntimeFailureStrategyCapacity(runState: RuntimeResilienceRunState): boolean {
  if (runState.failuresByStrategy.size < MAX_RUNTIME_FAILURE_STRATEGIES_PER_RUN) {
    return true;
  }
  runState.failureTrackingSaturated = true;
  return false;
}

function selectHistoryForScope(
  history: readonly ToolCallRecord[],
  scope?: ToolLoopDetectionScope,
): ToolCallRecord[] {
  const runId = normalizeRunId(scope?.runId);
  return history.filter((record) => normalizeRunId(record.runId) === runId);
}

function asPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function resolveLoopDetectionConfig(config?: ToolLoopDetectionConfig): ResolvedLoopDetectionConfig {
  let warningThreshold = asPositiveInt(
    config?.warningThreshold,
    DEFAULT_LOOP_DETECTION_CONFIG.warningThreshold,
  );
  let criticalThreshold = asPositiveInt(
    config?.criticalThreshold,
    DEFAULT_LOOP_DETECTION_CONFIG.criticalThreshold,
  );
  let globalCircuitBreakerThreshold = asPositiveInt(
    config?.globalCircuitBreakerThreshold,
    DEFAULT_LOOP_DETECTION_CONFIG.globalCircuitBreakerThreshold,
  );

  if (criticalThreshold <= warningThreshold) {
    criticalThreshold = warningThreshold + 1;
  }
  if (globalCircuitBreakerThreshold <= criticalThreshold) {
    globalCircuitBreakerThreshold = criticalThreshold + 1;
  }

  return {
    enabled: config?.enabled ?? DEFAULT_LOOP_DETECTION_CONFIG.enabled,
    historySize: asPositiveInt(config?.historySize, DEFAULT_LOOP_DETECTION_CONFIG.historySize),
    warningThreshold,
    unknownToolThreshold: asPositiveInt(
      config?.unknownToolThreshold,
      DEFAULT_LOOP_DETECTION_CONFIG.unknownToolThreshold,
    ),
    criticalThreshold,
    globalCircuitBreakerThreshold,
    detectors: {
      genericRepeat:
        config?.detectors?.genericRepeat ?? DEFAULT_LOOP_DETECTION_CONFIG.detectors.genericRepeat,
      knownPollNoProgress:
        config?.detectors?.knownPollNoProgress ??
        DEFAULT_LOOP_DETECTION_CONFIG.detectors.knownPollNoProgress,
      pingPong: config?.detectors?.pingPong ?? DEFAULT_LOOP_DETECTION_CONFIG.detectors.pingPong,
    },
  };
}

function resolveToolCallHistorySize(config?: ToolLoopDetectionConfig): number {
  return resolveLoopDetectionConfig(config).historySize;
}

/**
 * Hash a tool call for pattern matching.
 * Uses tool name + deterministic JSON serialization digest of params.
 */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${digestStable(params)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function digestStable(value: unknown): string {
  const serialized = stableStringifyFallback(value);
  return createHash("sha256").update(serialized).digest("hex");
}

function stableStringifyFallback(value: unknown): string {
  try {
    return stableStringify(value);
  } catch {
    if (value === null || value === undefined) {
      return `${value}`;
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return `${value}`;
    }
    if (value instanceof Error) {
      return `${value.name}:${value.message}`;
    }
    return Object.prototype.toString.call(value);
  }
}

const VOLATILE_STRATEGY_KEYS = new Set([
  "approval_id",
  "call_id",
  "hold_deadline",
  "idempotency_key",
  "operation_id",
  "request_id",
  "timestamp",
]);

function stripVolatileStrategyValues(value: unknown): unknown {
  try {
    if (Array.isArray(value)) {
      return value.map(stripVolatileStrategyValues);
    }
    if (!isPlainObject(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE_STRATEGY_KEYS.has(key.toLowerCase()))
        .map(([key, child]) => [key, stripVolatileStrategyValues(child)]),
    );
  } catch {
    // Tool params can be hostile proxies. Fall back to the same opaque value
    // path used by the legacy call hash instead of making diagnostics fatal.
    return value;
  }
}

function runtimeStrategyHash(toolName: string, params: unknown): string {
  return `${toolName}:${digestStable(stripVolatileStrategyValues(params))}`;
}

function isBrowserLaunch(toolName: string, params: unknown): boolean {
  if (toolName !== "browser" || !isPlainObject(params)) {
    return false;
  }
  return params.action === "start" || params.action === "open";
}

function isBrowserSideEffectAttempt(toolName: string, params: unknown): boolean {
  if (toolName !== "browser" || !isPlainObject(params)) {
    return false;
  }
  const action = params.action;
  if (action === "upload" || action === "dialog") {
    return true;
  }
  if (action !== "act") {
    return false;
  }
  const request = isPlainObject(params.request) ? params.request : params;
  const kind = request.kind;
  return (
    kind === "click" ||
    kind === "clickCoords" ||
    kind === "type" ||
    kind === "press" ||
    kind === "drag" ||
    kind === "select" ||
    kind === "fill" ||
    kind === "evaluate"
  );
}

function isTrustedSideEffect(sideEffect: ToolLoopDetectionScope["sideEffect"]): boolean {
  return sideEffect !== undefined && sideEffect !== "none";
}

function isSideEffectAttempt(
  toolName: string,
  params: unknown,
  scope?: ToolLoopDetectionScope,
): boolean {
  return isTrustedSideEffect(scope?.sideEffect) || isBrowserSideEffectAttempt(toolName, params);
}

function isKnownPollToolCall(toolName: string, params: unknown): boolean {
  if (toolName === "command_status") {
    return true;
  }
  if (toolName !== "process" || !isPlainObject(params)) {
    return false;
  }
  const action = params.action;
  return action === "poll" || action === "log";
}

function extractTextContent(result: unknown): string {
  if (!isPlainObject(result) || !Array.isArray(result.content)) {
    return "";
  }
  return result.content
    .filter(
      (entry): entry is { type: string; text: string } =>
        isPlainObject(entry) && typeof entry.type === "string" && typeof entry.text === "string",
    )
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function formatErrorForHash(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return `${error}`;
  }
  return stableStringify(error);
}

function errorIdentityField(error: unknown, key: "code" | "status"): string | number | undefined {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return undefined;
  }
  try {
    const value = (error as Record<string, unknown>)[key];
    return typeof value === "string" || typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

function extractUnknownToolName(error: unknown): string | undefined {
  const raw = formatErrorForHash(error).trim();
  if (!raw) {
    return undefined;
  }
  const match =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_.-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_.-]+)["']?\s+(?:not found|is not available)/i);
  const toolName = match?.[1]?.trim();
  return toolName ? toolName.toLowerCase() : undefined;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonEmptyStringField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function hashExecToolOutcome(details: Record<string, unknown>, text: string): string | undefined {
  const status = stringField(details.status);
  if (!status) {
    return undefined;
  }

  if (status === "running") {
    return digestStable({
      status,
      tail: stringField(details.tail) ?? "",
    });
  }

  if (status === "completed" || status === "failed") {
    return digestStable({
      status,
      exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
      timedOut: details.timedOut === true,
      output: nonEmptyStringField(details.aggregated) ?? text,
    });
  }

  if (status === "approval-pending" || status === "approval-unavailable") {
    return digestStable({
      status,
      reason: stringField(details.reason),
      host: stringField(details.host),
      command: stringField(details.command) ?? "",
      warningText: stringField(details.warningText) ?? "",
    });
  }

  return undefined;
}

function hashToolOutcome(
  toolName: string,
  params: unknown,
  result: unknown,
  error: unknown,
): { resultHash?: string; unknownToolName?: string } {
  if (error !== undefined) {
    const unknownToolName = extractUnknownToolName(error);
    return {
      resultHash: `error:${digestStable(formatErrorForHash(error))}`,
      unknownToolName,
    };
  }
  if (!isPlainObject(result)) {
    return { resultHash: result === undefined ? undefined : digestStable(result) };
  }

  const details = isPlainObject(result.details) ? result.details : {};
  const text = extractTextContent(result);
  if (toolName === "exec") {
    const execHash = hashExecToolOutcome(details, text);
    if (execHash) {
      return { resultHash: execHash };
    }
  }
  if (isKnownPollToolCall(toolName, params) && toolName === "process" && isPlainObject(params)) {
    const action = params.action;
    if (action === "poll") {
      return {
        resultHash: digestStable({
          action,
          status: details.status,
          exitCode: details.exitCode ?? null,
          exitSignal: details.exitSignal ?? null,
          aggregated: details.aggregated ?? null,
          text,
        }),
      };
    }
    if (action === "log") {
      return {
        resultHash: digestStable({
          action,
          status: details.status,
          totalLines: details.totalLines ?? null,
          totalChars: details.totalChars ?? null,
          truncated: details.truncated ?? null,
          exitCode: details.exitCode ?? null,
          exitSignal: details.exitSignal ?? null,
          text,
        }),
      };
    }
  }

  return {
    resultHash: digestStable({
      details,
      text,
    }),
  };
}

type RuntimeOutcomeClassification = {
  kind: NonNullable<ToolCallRecord["outcomeKind"]>;
  terminalFailureHash?: string;
  deniedOperationId?: string;
  sideEffecting?: boolean;
};

function parseTextObject(text: string): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function classifyMagisterEnvelope(
  envelope: Record<string, unknown>,
): RuntimeOutcomeClassification | null {
  if (
    typeof envelope.ok !== "boolean" ||
    !isPlainObject(envelope.status) ||
    typeof envelope.status.terminal !== "boolean"
  ) {
    return null;
  }
  const status = envelope.status;
  const error = isPlainObject(envelope.error) ? envelope.error : null;
  const receipt = isPlainObject(envelope.receipt) ? envelope.receipt : {};
  const approval = isPlainObject(receipt.approval) ? receipt.approval : null;
  const errorCode = nonEmptyStringField(error?.code);
  const sideEffect = nonEmptyStringField(envelope.side_effect);
  const sideEffecting = sideEffect !== null && sideEffect !== "none";
  const approvalState =
    nonEmptyStringField(approval?.state) ?? nonEmptyStringField(receipt.approval_state);

  if (approvalState === "denied") {
    return {
      kind: "denial",
      deniedOperationId:
        nonEmptyStringField(approval?.operation_id) ??
        nonEmptyStringField(envelope.operation_id) ??
        undefined,
      sideEffecting,
    };
  }
  if (
    status.terminal === false &&
    (errorCode === "approval_required" || approvalState === "pending" || status.state === "running")
  ) {
    return { kind: "pending", sideEffecting };
  }
  if (error?.retryable === true || errorCode === "rate_limited") {
    return { kind: "retryable", sideEffecting };
  }
  if (status.state === "failed" || !envelope.ok || errorCode) {
    return {
      kind: "failure",
      terminalFailureHash: `magister:${errorCode ?? "terminal_failed"}`,
      sideEffecting,
    };
  }
  return { kind: "success", sideEffecting };
}

function classifyRuntimeOutcome(params: {
  toolName: string;
  toolParams: unknown;
  result: unknown;
  error: unknown;
  trustedSideEffect?: ToolLoopDetectionScope["sideEffect"];
}): RuntimeOutcomeClassification {
  const trustedSideEffecting = isTrustedSideEffect(params.trustedSideEffect);
  if (params.error !== undefined) {
    const errorClass =
      params.error instanceof Error && params.error.name.trim()
        ? params.error.name.trim().toLowerCase()
        : typeof params.error;
    const errorCode = errorIdentityField(params.error, "code");
    const errorStatus = errorIdentityField(params.error, "status");
    return {
      kind: "failure",
      terminalFailureHash: `exception:${digestStable({
        class: errorClass,
        code: errorCode ?? null,
        status: errorStatus ?? null,
      })}`,
      sideEffecting: trustedSideEffecting,
    };
  }
  if (!isPlainObject(params.result)) {
    return params.result === undefined
      ? { kind: "neutral", sideEffecting: trustedSideEffecting }
      : { kind: "success", sideEffecting: trustedSideEffecting };
  }

  const details = isPlainObject(params.result.details) ? params.result.details : {};
  const text = extractTextContent(params.result);
  const envelope = parseTextObject(text);
  const magister = envelope ? classifyMagisterEnvelope(envelope) : null;
  if (magister) {
    return {
      ...magister,
      sideEffecting: magister.sideEffecting || trustedSideEffecting,
    };
  }

  const status = nonEmptyStringField(details.status)?.toLowerCase();
  const deniedReason = nonEmptyStringField(details.deniedReason)?.toLowerCase();
  const reason = nonEmptyStringField(details.reason)?.toLowerCase();
  if (status === "blocked" && deniedReason === "tool-loop") {
    return { kind: "neutral", sideEffecting: trustedSideEffecting };
  }
  if (status === "blocked" && deniedReason === "plugin-approval" && reason === "denied by user") {
    return {
      kind: "denial",
      deniedOperationId: runtimeStrategyHash(params.toolName, params.toolParams),
      sideEffecting:
        trustedSideEffecting || isBrowserSideEffectAttempt(params.toolName, params.toolParams),
    };
  }
  if (status === "blocked") {
    return { kind: "neutral", sideEffecting: trustedSideEffecting };
  }
  if (status === "approval-pending" || status === "running") {
    return { kind: "pending", sideEffecting: trustedSideEffecting };
  }
  if (status === "approval-unavailable") {
    return { kind: "retryable", sideEffecting: trustedSideEffecting };
  }
  if (params.toolName === "exec" && status === "completed") {
    const exitCode = typeof details.exitCode === "number" ? details.exitCode : null;
    if (exitCode !== null && exitCode !== 0) {
      return {
        kind: "failure",
        terminalFailureHash: `exec:exit:${exitCode}`,
        sideEffecting: trustedSideEffecting,
      };
    }
    return { kind: "success", sideEffecting: trustedSideEffecting };
  }
  if (status === "failed" || status === "error" || status === "timeout") {
    const code =
      nonEmptyStringField(details.errorCode) ?? nonEmptyStringField(details.code) ?? status;
    return {
      kind: "failure",
      terminalFailureHash: `tool:${code.toLowerCase()}`,
      sideEffecting: trustedSideEffecting,
    };
  }
  return { kind: "success", sideEffecting: trustedSideEffecting };
}

function getUnknownToolRepeatStreak(
  history: Array<{ toolName: string; unknownToolName?: string }>,
  toolName: string,
): { count: number; unknownToolName?: string } {
  let streak = 0;
  let repeatedUnknownToolName: string | undefined;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName || !record.unknownToolName) {
      break;
    }
    if (!repeatedUnknownToolName) {
      repeatedUnknownToolName = record.unknownToolName;
      streak = 1;
      continue;
    }
    if (record.unknownToolName !== repeatedUnknownToolName) {
      break;
    }
    streak += 1;
  }

  return { count: streak, unknownToolName: repeatedUnknownToolName };
}

function getNoProgressStreak(
  history: Array<{ toolName: string; argsHash: string; resultHash?: string }>,
  toolName: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName || record.argsHash !== argsHash) {
      continue;
    }
    if (typeof record.resultHash !== "string" || !record.resultHash) {
      continue;
    }
    if (!latestResultHash) {
      latestResultHash = record.resultHash;
      streak = 1;
      continue;
    }
    if (record.resultHash !== latestResultHash) {
      break;
    }
    streak += 1;
  }

  return { count: streak, latestResultHash };
}

function getPingPongStreak(
  history: Array<{ toolName: string; argsHash: string; resultHash?: string }>,
  currentSignature: string,
): {
  count: number;
  pairedToolName?: string;
  pairedSignature?: string;
  noProgressEvidence: boolean;
} {
  const last = history.at(-1);
  if (!last) {
    return { count: 0, noProgressEvidence: false };
  }

  let otherSignature: string | undefined;
  let otherToolName: string | undefined;
  for (let i = history.length - 2; i >= 0; i -= 1) {
    const call = history[i];
    if (!call) {
      continue;
    }
    if (call.argsHash !== last.argsHash) {
      otherSignature = call.argsHash;
      otherToolName = call.toolName;
      break;
    }
  }

  if (!otherSignature || !otherToolName) {
    return { count: 0, noProgressEvidence: false };
  }

  let alternatingTailCount = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const call = history[i];
    if (!call) {
      continue;
    }
    const expected = alternatingTailCount % 2 === 0 ? last.argsHash : otherSignature;
    if (call.argsHash !== expected) {
      break;
    }
    alternatingTailCount += 1;
  }

  if (alternatingTailCount < 2) {
    return { count: 0, noProgressEvidence: false };
  }

  const expectedCurrentSignature = otherSignature;
  if (currentSignature !== expectedCurrentSignature) {
    return { count: 0, noProgressEvidence: false };
  }

  const tailStart = Math.max(0, history.length - alternatingTailCount);
  let firstHashA: string | undefined;
  let firstHashB: string | undefined;
  let noProgressEvidence = true;
  for (let i = tailStart; i < history.length; i += 1) {
    const call = history[i];
    if (!call) {
      continue;
    }
    if (!call.resultHash) {
      noProgressEvidence = false;
      break;
    }
    if (call.argsHash === last.argsHash) {
      if (!firstHashA) {
        firstHashA = call.resultHash;
      } else if (firstHashA !== call.resultHash) {
        noProgressEvidence = false;
        break;
      }
      continue;
    }
    if (call.argsHash === otherSignature) {
      if (!firstHashB) {
        firstHashB = call.resultHash;
      } else if (firstHashB !== call.resultHash) {
        noProgressEvidence = false;
        break;
      }
      continue;
    }
    noProgressEvidence = false;
    break;
  }

  // Need repeated stable outcomes on both sides before treating ping-pong as no-progress.
  if (!firstHashA || !firstHashB) {
    noProgressEvidence = false;
  }

  return {
    count: alternatingTailCount + 1,
    pairedToolName: last.toolName,
    pairedSignature: last.argsHash,
    noProgressEvidence,
  };
}

function canonicalPairKey(signatureA: string, signatureB: string): string {
  return [signatureA, signatureB].toSorted().join("|");
}

function recordRuntimeResilienceOutcomeState(params: {
  state: SessionState;
  runId?: string;
  record: ToolCallRecord;
}): void {
  const runState = getRuntimeResilienceRunState(params.state, params.runId, { create: true });
  if (!runState) {
    return;
  }
  const record = params.record;
  const strategyHash = record.resilienceStrategyHash;
  if (record.outcomeKind === "success" && strategyHash) {
    runState.failuresByStrategy.delete(strategyHash);
  } else if (record.outcomeKind === "failure" && strategyHash && record.terminalFailureHash) {
    const existing = runState.failuresByStrategy.get(strategyHash);
    if (existing) {
      existing.count = existing.failureHash === record.terminalFailureHash ? existing.count + 1 : 1;
      existing.failureHash = record.terminalFailureHash;
      existing.updatedAt = Date.now();
    } else if (ensureRuntimeFailureStrategyCapacity(runState)) {
      runState.failuresByStrategy.set(strategyHash, {
        failureHash: record.terminalFailureHash,
        count: 1,
        updatedAt: Date.now(),
      });
    }
  }

  if (
    record.outcomeKind === "denial" &&
    record.sideEffecting === true &&
    record.deniedOperationId
  ) {
    const sizeBefore = runState.deniedOperationIds.size;
    runState.deniedOperationIds.add(record.deniedOperationId);
    record.resilienceDenialWasNew = runState.deniedOperationIds.size > sizeBefore;
  }
}

/** Independent, default-off hosted-runtime safeguards based on completed outcomes. */
export function detectRuntimeResilienceBlock(
  state: SessionState,
  toolName: string,
  params: unknown,
  config?: ToolLoopDetectionConfig,
  scope?: ToolLoopDetectionScope,
): LoopDetectionResult {
  const resolved = resolveRuntimeResilienceConfig(config);
  if (!resolved.enabled) {
    return { stuck: false };
  }
  const runState = getRuntimeResilienceRunState(state, scope?.runId, { create: false });

  if (isBrowserLaunch(toolName, params)) {
    const launchCount = runtimeBrowserLaunchCount(runState);
    if (launchCount >= resolved.browserLaunchLimit) {
      return {
        stuck: true,
        level: "critical",
        detector: "browser_launch_limit",
        count: launchCount,
        message:
          `Browser launch limit reached (${resolved.browserLaunchLimit} start/open calls in this run). ` +
          "Reuse an existing tab, change strategy, or report the blocker; do not launch another browser tab.",
        warningKey: `browser-launch:${scope?.runId ?? "session"}`,
      };
    }
  }

  const deniedCount = runState?.deniedOperationIds.size ?? 0;
  if (
    deniedCount >= resolved.denialBlockThreshold &&
    isSideEffectAttempt(toolName, params, scope)
  ) {
    return {
      stuck: true,
      level: "critical",
      detector: "denial_circuit_breaker",
      count: deniedCount,
      message:
        `Side-effect circuit breaker is active after ${deniedCount} distinct user denials in this run. ` +
        "Do not attempt another side effect or evade the decisions through another tool. Ask the user for a different approach; read-only verification remains available.",
      warningKey: `denial-breaker:${scope?.runId ?? "session"}`,
    };
  }

  const strategyHash = runtimeStrategyHash(toolName, params);
  const failureState = runState?.failuresByStrategy.get(strategyHash);
  const failureCount = failureState?.count ?? 0;
  if (failureCount >= resolved.failureBlockThreshold - 1) {
    return {
      stuck: true,
      level: "critical",
      detector: "terminal_failure",
      count: failureCount,
      message:
        `Blocked the ${resolved.failureBlockThreshold}th equivalent attempt after ${failureCount} terminal failures with the same strategy. ` +
        "Do not retry or cosmetically rephrase this call. Change strategy or report the blocker and the evidence already gathered.",
      warningKey: `terminal-failure:${scope?.runId ?? "session"}:${strategyHash}`,
    };
  }
  if (runState?.failureTrackingSaturated === true && !failureState) {
    return {
      stuck: true,
      level: "critical",
      detector: "terminal_failure",
      count: MAX_RUNTIME_FAILURE_STRATEGIES_PER_RUN,
      message:
        "Blocked a new strategy after this run exhausted its terminal-failure tracking capacity. " +
        "Stop broad retry exploration and report the blocker and evidence already gathered.",
      warningKey: `terminal-failure-capacity:${scope?.runId ?? "session"}`,
    };
  }

  return { stuck: false };
}

export function resolveRuntimeResilienceOutcomeDecision(
  state: SessionState,
  record: ToolCallRecord,
  config?: ToolLoopDetectionConfig,
  scope?: ToolLoopDetectionScope,
): RuntimeResilienceOutcomeDecision {
  const resolved = resolveRuntimeResilienceConfig(config);
  if (!resolved.enabled) {
    return {};
  }
  const runState = getRuntimeResilienceRunState(state, scope?.runId, { create: false });
  if (record.outcomeKind === "failure" && record.resilienceStrategyHash) {
    const failureState = runState?.failuresByStrategy.get(record.resilienceStrategyHash);
    const count =
      failureState && failureState.failureHash === record.terminalFailureHash
        ? failureState.count
        : 0;
    if (count === resolved.failureWarningThreshold) {
      return {
        guidance:
          `RECOVERY REQUIRED: this strategy has produced the same terminal failure ${count} times. ` +
          "Inspect the structured error and change strategy now. Do not retry with cosmetic argument changes; if no safe alternative exists, report the blocker truthfully.",
      };
    }
  }
  if (
    record.outcomeKind === "denial" &&
    record.sideEffecting === true &&
    record.deniedOperationId
  ) {
    const deniedCount = runState?.deniedOperationIds.size ?? 0;
    if (deniedCount === resolved.denialBlockThreshold && record.resilienceDenialWasNew === true) {
      return {
        guidance:
          `USER-DECISION CIRCUIT BREAKER: ${deniedCount} distinct side-effect operations were denied in this run. ` +
          "Further side effects will be blocked. Do not retry, rephrase, or use the browser to pursue the denied outcomes; ask the user for a different approach.",
      };
    }
  }
  return {};
}

/**
 * Detect if an agent is stuck in a repetitive tool call loop.
 * Checks if the same tool+params combination has been called excessively.
 */
export function detectToolCallLoop(
  state: SessionState,
  toolName: string,
  params: unknown,
  config?: ToolLoopDetectionConfig,
  scope?: ToolLoopDetectionScope,
): LoopDetectionResult {
  const resolvedConfig = resolveLoopDetectionConfig(config);
  if (!resolvedConfig.enabled) {
    return { stuck: false };
  }
  const history = selectHistoryForScope(state.toolCallHistory ?? [], scope);
  const currentHash = hashToolCall(toolName, params);
  const unknownToolStreak = getUnknownToolRepeatStreak(history, toolName);
  const noProgress = getNoProgressStreak(history, toolName, currentHash);
  const noProgressStreak = noProgress.count;
  const knownPollTool = isKnownPollToolCall(toolName, params);
  const pingPong = getPingPongStreak(history, currentHash);

  if (unknownToolStreak.count >= resolvedConfig.unknownToolThreshold) {
    return {
      stuck: true,
      level: "critical",
      detector: "unknown_tool_repeat",
      count: unknownToolStreak.count,
      message: `CRITICAL: attempted unavailable tool ${unknownToolStreak.unknownToolName ?? toolName} ${unknownToolStreak.count} times. Stop retrying that missing tool and answer without it.`,
      warningKey: `unknown-tool:${toolName}:${unknownToolStreak.unknownToolName ?? "unknown"}`,
    };
  }

  if (noProgressStreak >= resolvedConfig.globalCircuitBreakerThreshold) {
    log.error(
      `Global circuit breaker triggered: ${toolName} repeated ${noProgressStreak} times with no progress`,
    );
    return {
      stuck: true,
      level: "critical",
      detector: "global_circuit_breaker",
      count: noProgressStreak,
      message: `CRITICAL: ${toolName} has repeated identical no-progress outcomes ${noProgressStreak} times. Session execution blocked by global circuit breaker to prevent runaway loops.`,
      warningKey: `global:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
    };
  }

  if (
    knownPollTool &&
    resolvedConfig.detectors.knownPollNoProgress &&
    noProgressStreak >= resolvedConfig.criticalThreshold
  ) {
    log.error(`Critical polling loop detected: ${toolName} repeated ${noProgressStreak} times`);
    return {
      stuck: true,
      level: "critical",
      detector: "known_poll_no_progress",
      count: noProgressStreak,
      message: `CRITICAL: Called ${toolName} with identical arguments and no progress ${noProgressStreak} times. This appears to be a stuck polling loop. Session execution blocked to prevent resource waste.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
    };
  }

  if (
    knownPollTool &&
    resolvedConfig.detectors.knownPollNoProgress &&
    noProgressStreak >= resolvedConfig.warningThreshold
  ) {
    log.warn(`Polling loop warning: ${toolName} repeated ${noProgressStreak} times`);
    return {
      stuck: true,
      level: "warning",
      detector: "known_poll_no_progress",
      count: noProgressStreak,
      message: `WARNING: You have called ${toolName} ${noProgressStreak} times with identical arguments and no progress. Stop polling and either (1) increase wait time between checks, or (2) report the task as failed if the process is stuck.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
    };
  }

  const pingPongWarningKey = pingPong.pairedSignature
    ? `pingpong:${canonicalPairKey(currentHash, pingPong.pairedSignature)}`
    : `pingpong:${toolName}:${currentHash}`;

  if (
    resolvedConfig.detectors.pingPong &&
    pingPong.count >= resolvedConfig.criticalThreshold &&
    pingPong.noProgressEvidence
  ) {
    log.error(
      `Critical ping-pong loop detected: alternating calls count=${pingPong.count} currentTool=${toolName}`,
    );
    return {
      stuck: true,
      level: "critical",
      detector: "ping_pong",
      count: pingPong.count,
      message: `CRITICAL: You are alternating between repeated tool-call patterns (${pingPong.count} consecutive calls) with no progress. This appears to be a stuck ping-pong loop. Session execution blocked to prevent resource waste.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: pingPongWarningKey,
    };
  }

  if (resolvedConfig.detectors.pingPong && pingPong.count >= resolvedConfig.warningThreshold) {
    log.warn(
      `Ping-pong loop warning: alternating calls count=${pingPong.count} currentTool=${toolName}`,
    );
    return {
      stuck: true,
      level: "warning",
      detector: "ping_pong",
      count: pingPong.count,
      message: `WARNING: You are alternating between repeated tool-call patterns (${pingPong.count} consecutive calls). This looks like a ping-pong loop; stop retrying and report the task as failed.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: pingPongWarningKey,
    };
  }

  // Generic detector: warn-only for repeated identical calls.
  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === currentHash,
  ).length;

  if (
    !knownPollTool &&
    resolvedConfig.detectors.genericRepeat &&
    recentCount >= resolvedConfig.warningThreshold
  ) {
    log.warn(`Loop warning: ${toolName} called ${recentCount} times with identical arguments`);
    return {
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
      count: recentCount,
      message: `WARNING: You have called ${toolName} ${recentCount} times with identical arguments. If this is not making progress, stop retrying and report the task as failed.`,
      warningKey: `generic:${toolName}:${currentHash}`,
    };
  }

  return { stuck: false };
}

/**
 * Record a tool call in the session's history for loop detection.
 * Maintains sliding window of last N calls.
 */
export function recordToolCall(
  state: SessionState,
  toolName: string,
  params: unknown,
  toolCallId?: string,
  config?: ToolLoopDetectionConfig,
  scope?: ToolLoopDetectionScope,
): void {
  const historySize = resolveToolCallHistorySize(config);
  const runId = normalizeRunId(scope?.runId);
  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }

  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    resilienceStrategyHash: runtimeStrategyHash(toolName, params),
    sideEffecting: isTrustedSideEffect(scope?.sideEffect),
    browserLaunch: isBrowserLaunch(toolName, params),
    toolCallId,
    ...(runId && { runId }),
    timestamp: Date.now(),
  });

  if (resolveRuntimeResilienceConfig(config).enabled && isBrowserLaunch(toolName, params)) {
    recordRuntimeBrowserLaunch({ state, runId, toolCallId });
  }

  if (state.toolCallHistory.length > historySize) {
    state.toolCallHistory.shift();
  }
}

/**
 * Record a completed tool call outcome so loop detection can identify no-progress repeats.
 */
export function recordToolCallOutcome(
  state: SessionState,
  params: {
    toolName: string;
    toolParams: unknown;
    toolCallId?: string;
    result?: unknown;
    error?: unknown;
    config?: ToolLoopDetectionConfig;
    runId?: string;
    trustedSideEffect?: ToolLoopDetectionScope["sideEffect"];
  },
): ToolCallRecord | undefined {
  const historySize = resolveToolCallHistorySize(params.config);
  const runId = normalizeRunId(params.runId);
  const outcome = hashToolOutcome(params.toolName, params.toolParams, params.result, params.error);
  const resilienceOutcome = classifyRuntimeOutcome({
    toolName: params.toolName,
    toolParams: params.toolParams,
    result: params.result,
    error: params.error,
    trustedSideEffect: params.trustedSideEffect,
  });
  const resultHash = outcome.resultHash;
  if (!resultHash) {
    return undefined;
  }

  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }

  const argsHash = hashToolCall(params.toolName, params.toolParams);
  let matched = false;
  let recordedOutcome: ToolCallRecord | undefined;
  for (let i = state.toolCallHistory.length - 1; i >= 0; i -= 1) {
    const call = state.toolCallHistory[i];
    if (!call) {
      continue;
    }
    if (normalizeRunId(call.runId) !== runId) {
      continue;
    }
    if (params.toolCallId && call.toolCallId !== params.toolCallId) {
      continue;
    }
    if (call.toolName !== params.toolName || call.argsHash !== argsHash) {
      continue;
    }
    if (call.resultHash !== undefined) {
      continue;
    }
    call.resultHash = resultHash;
    call.unknownToolName = outcome.unknownToolName;
    call.resilienceStrategyHash ??= runtimeStrategyHash(params.toolName, params.toolParams);
    call.outcomeKind = resilienceOutcome.kind;
    call.terminalFailureHash = resilienceOutcome.terminalFailureHash;
    call.deniedOperationId =
      resilienceOutcome.deniedOperationId ??
      (resilienceOutcome.kind === "denial" ? call.resilienceStrategyHash : undefined);
    call.sideEffecting = resilienceOutcome.sideEffecting ?? call.sideEffecting;
    matched = true;
    recordedOutcome = call;
    break;
  }

  if (!matched) {
    const record: ToolCallRecord = {
      toolName: params.toolName,
      argsHash,
      toolCallId: params.toolCallId,
      ...(runId && { runId }),
      resultHash,
      unknownToolName: outcome.unknownToolName,
      resilienceStrategyHash: runtimeStrategyHash(params.toolName, params.toolParams),
      outcomeKind: resilienceOutcome.kind,
      terminalFailureHash: resilienceOutcome.terminalFailureHash,
      deniedOperationId:
        resilienceOutcome.deniedOperationId ??
        (resilienceOutcome.kind === "denial"
          ? runtimeStrategyHash(params.toolName, params.toolParams)
          : undefined),
      sideEffecting: resilienceOutcome.sideEffecting,
      browserLaunch: isBrowserLaunch(params.toolName, params.toolParams),
      timestamp: Date.now(),
    };
    state.toolCallHistory.push(record);
    recordedOutcome = record;
  }

  if (recordedOutcome && resolveRuntimeResilienceConfig(params.config).enabled) {
    recordRuntimeResilienceOutcomeState({ state, runId, record: recordedOutcome });
  }

  if (state.toolCallHistory.length > historySize) {
    state.toolCallHistory.splice(0, state.toolCallHistory.length - historySize);
  }
  return recordedOutcome;
}

/**
 * Get current tool call statistics for a session (for debugging/monitoring).
 */
export function getToolCallStats(state: SessionState): {
  totalCalls: number;
  uniquePatterns: number;
  mostFrequent: { toolName: string; count: number } | null;
} {
  const history = state.toolCallHistory ?? [];
  const patterns = new Map<string, { toolName: string; count: number }>();

  for (const call of history) {
    const key = call.argsHash;
    const existing = patterns.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      patterns.set(key, { toolName: call.toolName, count: 1 });
    }
  }

  let mostFrequent: { toolName: string; count: number } | null = null;
  for (const pattern of patterns.values()) {
    if (!mostFrequent || pattern.count > mostFrequent.count) {
      mostFrequent = pattern;
    }
  }

  return {
    totalCalls: history.length,
    uniquePatterns: patterns.size,
    mostFrequent,
  };
}
