import { describe, expect, it } from "vitest";
import { projectMagisterToolPresentation } from "./magister-presentation.js";

const RESULT_REF = "d772df9d-4841-46f0-aa62-2effd01536df";

function actionResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: [{ type: "text", text: "model-visible canonical result" }],
    details: {
      ok: true,
      operation_id: "op_1234567890",
      resource_id: "analytics:overview:30d",
      status: {
        state: "succeeded",
        terminal: true,
        poll_after_seconds: 0,
        stale_seconds: 0,
      },
      side_effect: "none",
      idempotency_key: null,
      source_action_id: "tool:8e9775f4d653d74900c9",
      presentation_result_ref: RESULT_REF,
      presentation_result: {
        resultRef: RESULT_REF,
        resultRevision: 3,
        viewKind: "analytics_overview",
        facts: { privateMarker: "sentinel-must-not-cross-the-browser-boundary" },
      },
      receipt: { private: "sentinel-receipt" },
      artifacts: [],
      error: null,
      ...overrides,
    },
  };
}

describe("projectMagisterToolPresentation", () => {
  it("relays only the immutable presentation correlation fields", () => {
    const result = projectMagisterToolPresentation("magister_query_analytics", actionResult());

    expect(result).toEqual({
      v: 1,
      type: "presentation_result_ref",
      sourceActionId: "tool:8e9775f4d653d74900c9",
      resourceId: "analytics:overview:30d",
      resultRef: RESULT_REF,
      resultRevision: 3,
      state: "succeeded",
    });
    expect(JSON.stringify(result)).not.toContain("sentinel");
    expect(JSON.stringify(result)).not.toContain("facts");
  });

  it("relays a running action before an immutable result exists", () => {
    expect(
      projectMagisterToolPresentation(
        "magister_run_aeo_audit",
        actionResult({
          status: {
            state: "running",
            terminal: false,
            poll_after_seconds: 6,
            stale_seconds: 180,
          },
          presentation_result_ref: null,
          presentation_result: null,
        }),
      ),
    ).toEqual({
      v: 1,
      type: "presentation_result_ref",
      sourceActionId: "tool:8e9775f4d653d74900c9",
      resourceId: "analytics:overview:30d",
      resultRef: null,
      resultRevision: null,
      state: "running",
    });
  });

  it("relays terminal failures without exposing the error receipt", () => {
    const projected = projectMagisterToolPresentation(
      "magister_run_aeo_audit",
      actionResult({
        ok: false,
        status: {
          state: "failed",
          terminal: true,
          poll_after_seconds: 0,
          stale_seconds: 0,
        },
        presentation_result_ref: null,
        presentation_result: null,
        receipt: { private: "sentinel-failure" },
        error: {
          code: "upstream_failed",
          message: "private provider detail",
          retryable: false,
          retry_after_seconds: null,
          user_action: null,
        },
      }),
    );

    expect(projected).toMatchObject({ state: "failed", resultRef: null });
    expect(JSON.stringify(projected)).not.toContain("provider");
    expect(JSON.stringify(projected)).not.toContain("sentinel");
  });

  it.each([
    ["non-Magister tool", "exec", actionResult()],
    ["unknown envelope key", "magister_query_analytics", actionResult({ injected: true })],
    [
      "invalid source action id",
      "magister_query_analytics",
      actionResult({ source_action_id: "contains spaces" }),
    ],
    [
      "invalid result UUID",
      "magister_query_analytics",
      actionResult({
        presentation_result_ref: "not-a-uuid",
        presentation_result: { resultRef: "not-a-uuid", resultRevision: 1 },
      }),
    ],
    [
      "mismatched canonical reference",
      "magister_query_analytics",
      actionResult({
        presentation_result: {
          resultRef: "94bbb653-b54d-4898-af58-a96287ee4b83",
          resultRevision: 1,
        },
      }),
    ],
    [
      "contradictory terminal status",
      "magister_query_analytics",
      actionResult({
        status: {
          state: "running",
          terminal: true,
          poll_after_seconds: 0,
          stale_seconds: 0,
        },
      }),
    ],
  ])("rejects %s", (_label, toolName, result) => {
    expect(projectMagisterToolPresentation(toolName, result)).toBeUndefined();
  });
});
