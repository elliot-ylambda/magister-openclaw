/**
 * Reduce a Magister native-action result to an opaque browser correlation hint.
 *
 * Canonical presentation facts stay in the model-visible tool result and in
 * Magister's immutable presentation_results row. The browser stream receives
 * only this reference; the chat gateway loads and validates the row inside the
 * authenticated project before it builds a card.
 */

const ACTION_ENVELOPE_KEYS = new Set([
  "ok",
  "operation_id",
  "resource_id",
  "status",
  "side_effect",
  "idempotency_key",
  "source_action_id",
  "presentation_result_ref",
  "presentation_result",
  "receipt",
  "artifacts",
  "error",
]);
const ACTION_STATUS_KEYS = new Set(["state", "terminal", "poll_after_seconds", "stale_seconds"]);
const SOURCE_ACTION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MagisterPresentationResultRelayV1 = {
  v: 1;
  type: "presentation_result_ref";
  sourceActionId: string;
  resourceId: string | null;
  resultRef: string | null;
  resultRevision: number | null;
  state: "running" | "succeeded" | "failed";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

export function projectMagisterToolPresentation(
  toolName: string,
  sanitizedResult: unknown,
): MagisterPresentationResultRelayV1 | undefined {
  if (!toolName.startsWith("magister_") || !isRecord(sanitizedResult)) {
    return undefined;
  }
  const envelope = sanitizedResult.details;
  if (!isRecord(envelope) || !hasExactKeys(envelope, ACTION_ENVELOPE_KEYS)) {
    return undefined;
  }
  const status = envelope.status;
  if (
    !isRecord(status) ||
    !hasExactKeys(status, ACTION_STATUS_KEYS) ||
    !["running", "succeeded", "failed"].includes(String(status.state)) ||
    typeof status.terminal !== "boolean" ||
    status.terminal !== (status.state !== "running")
  ) {
    return undefined;
  }
  const sourceActionId = boundedString(envelope.source_action_id, 300);
  if (!sourceActionId || !SOURCE_ACTION_RE.test(sourceActionId)) {
    return undefined;
  }
  const resourceId = envelope.resource_id;
  if (resourceId !== null && boundedString(resourceId, 512) === null) {
    return undefined;
  }
  const resultRef = envelope.presentation_result_ref;
  if (resultRef !== null && (typeof resultRef !== "string" || !UUID_RE.test(resultRef))) {
    return undefined;
  }
  const canonical = envelope.presentation_result;
  if (canonical !== null && !isRecord(canonical)) {
    return undefined;
  }
  if (resultRef !== null && (!isRecord(canonical) || canonical.resultRef !== resultRef)) {
    return undefined;
  }
  const rawRevision = isRecord(canonical) ? canonical.resultRevision : null;
  const resultRevision =
    typeof rawRevision === "number" &&
    Number.isSafeInteger(rawRevision) &&
    rawRevision > 0 &&
    rawRevision <= 1_000_000
      ? rawRevision
      : null;

  return {
    v: 1,
    type: "presentation_result_ref",
    sourceActionId,
    resourceId: resourceId as string | null,
    resultRef,
    resultRevision,
    state: status.state as MagisterPresentationResultRelayV1["state"],
  };
}
