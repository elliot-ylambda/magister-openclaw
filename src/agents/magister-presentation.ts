const AEO_TOOL_NAMES = new Set(["magister_run_aeo_audit", "magister_get_aeo_audit"]);
const ACTION_ENVELOPE_KEYS = new Set([
  "ok",
  "operation_id",
  "resource_id",
  "status",
  "side_effect",
  "idempotency_key",
  "receipt",
  "artifacts",
  "error",
]);
const ACTION_STATUS_KEYS = new Set(["state", "terminal", "poll_after_seconds", "stale_seconds"]);
const CHECK_KEYS = new Set(["id", "label", "category", "pass", "value", "detail"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROJECTION_BYTES = 32 * 1024;
const MAX_CHECKS = 20;

type AeoAuditStatus = "pending" | "ready" | "failed";

export type MagisterAeoPresentationProjectionV1 = {
  v: 1;
  type: "aeo_audit";
  sourceId: string;
  status: AeoAuditStatus;
  url: string;
  score: number | null;
  checks: Array<{
    id: string;
    label: string;
    category: string;
    pass: boolean;
    value: string;
    detail: string;
  }>;
  error: {
    reason: "execution_error" | "stale_timeout" | null;
    message: string | null;
  } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)) {
    return null;
  }
  return value;
}

function parseCheck(value: unknown): MagisterAeoPresentationProjectionV1["checks"][number] | null {
  if (!isRecord(value) || !hasExactKeys(value, CHECK_KEYS)) {
    return null;
  }
  const id = boundedString(value.id, 80);
  const label = boundedString(value.label, 160);
  const category = boundedString(value.category, 80);
  const checkValue = boundedString(value.value, 500, true);
  const detail = boundedString(value.detail, 1000, true);
  if (
    id === null ||
    label === null ||
    category === null ||
    checkValue === null ||
    detail === null ||
    typeof value.pass !== "boolean"
  ) {
    return null;
  }
  return { id, label, category, pass: value.pass, value: checkValue, detail };
}

function parseChecks(value: unknown): MagisterAeoPresentationProjectionV1["checks"] | null {
  if (!Array.isArray(value) || value.length > MAX_CHECKS) {
    return null;
  }
  const checks: MagisterAeoPresentationProjectionV1["checks"] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const check = parseCheck(raw);
    if (!check || ids.has(check.id)) {
      return null;
    }
    ids.add(check.id);
    checks.push(check);
  }
  return checks;
}

function expectedEnvelopeState(status: AeoAuditStatus): "running" | "succeeded" | "failed" {
  if (status === "pending") {
    return "running";
  }
  return status === "ready" ? "succeeded" : "failed";
}

/**
 * Extract the only successful-result data the Magister HTTP bridge may expose.
 *
 * The input is the already-sanitized tool result. The full result remains private:
 * this helper validates the typed ActionEnvelope correlation and constructs a new,
 * field-allowlisted projection instead of copying any receipt object.
 */
export function projectMagisterToolPresentation(
  toolName: string,
  sanitizedResult: unknown,
): MagisterAeoPresentationProjectionV1 | undefined {
  if (!AEO_TOOL_NAMES.has(toolName) || !isRecord(sanitizedResult)) {
    return undefined;
  }
  const envelope = sanitizedResult.details;
  if (!isRecord(envelope) || !hasExactKeys(envelope, ACTION_ENVELOPE_KEYS)) {
    return undefined;
  }
  const statusEnvelope = envelope.status;
  const receipt = envelope.receipt;
  if (
    !isRecord(statusEnvelope) ||
    !hasExactKeys(statusEnvelope, ACTION_STATUS_KEYS) ||
    !isRecord(receipt) ||
    !Array.isArray(envelope.artifacts) ||
    typeof envelope.ok !== "boolean" ||
    typeof envelope.operation_id !== "string"
  ) {
    return undefined;
  }
  const audit = receipt.audit;
  if (!isRecord(audit)) {
    return undefined;
  }
  const sourceId = boundedString(audit.id, 36);
  const url = boundedString(audit.url, 2048);
  const auditStatus = audit.status;
  if (
    !sourceId ||
    !UUID_RE.test(sourceId) ||
    !url ||
    !["pending", "ready", "failed"].includes(String(auditStatus)) ||
    envelope.resource_id !== sourceId
  ) {
    return undefined;
  }
  const status = auditStatus as AeoAuditStatus;
  const expectedState = expectedEnvelopeState(status);
  if (
    statusEnvelope.state !== expectedState ||
    statusEnvelope.terminal !== (status !== "pending") ||
    envelope.ok !== (status !== "failed") ||
    (envelope.ok ? envelope.error !== null : !isRecord(envelope.error))
  ) {
    return undefined;
  }
  const score = audit.score;
  if (
    score !== null &&
    score !== undefined &&
    (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100)
  ) {
    return undefined;
  }
  const checks = parseChecks(audit.checks ?? []);
  if (!checks) {
    return undefined;
  }

  let error: MagisterAeoPresentationProjectionV1["error"] = null;
  if (status === "failed") {
    const rawReason = audit.terminal_reason;
    const reason =
      rawReason === "execution_error" || rawReason === "stale_timeout" ? rawReason : null;
    const envelopeMessage = isRecord(envelope.error) ? envelope.error.message : null;
    const message = boundedString(audit.error_message ?? envelopeMessage, 1000, true);
    if (message === null) {
      return undefined;
    }
    error = { reason, message };
  }

  const projection: MagisterAeoPresentationProjectionV1 = {
    v: 1,
    type: "aeo_audit",
    sourceId,
    status,
    url,
    score: typeof score === "number" ? score : null,
    checks,
    error,
  };
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > MAX_PROJECTION_BYTES) {
    return undefined;
  }
  return projection;
}
