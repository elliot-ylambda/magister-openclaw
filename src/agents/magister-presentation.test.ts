import { describe, expect, it } from "vitest";
import { projectMagisterToolPresentation } from "./magister-presentation.js";

const AUDIT_ID = "d772df9d-4841-46f0-aa62-2effd01536df";

function actionResult(
  audit: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const failed = audit.status === "failed";
  const pending = audit.status === "pending";
  return {
    content: [{ type: "text", text: "private full result" }],
    details: {
      ok: !failed,
      operation_id: "op_1234567890",
      resource_id: AUDIT_ID,
      status: {
        state: pending ? "running" : failed ? "failed" : "succeeded",
        terminal: !pending,
        poll_after_seconds: pending ? 6 : 0,
        stale_seconds: pending ? 180 : 0,
      },
      side_effect: "none",
      idempotency_key: null,
      receipt: {
        audit,
        secret: "sentinel-must-not-cross-the-http-boundary",
      },
      artifacts: [],
      error: failed
        ? {
            code: "upstream_failed",
            message: "fetch failed",
            retryable: false,
            retry_after_seconds: null,
            user_action: null,
          }
        : null,
      ...overrides,
    },
  };
}

describe("projectMagisterToolPresentation", () => {
  it("projects only canonical AEO fields and drops the rest of the receipt", () => {
    const result = projectMagisterToolPresentation(
      "magister_get_aeo_audit",
      actionResult({
        id: AUDIT_ID,
        project_id: "private-project",
        status: "ready",
        url: "https://example.com/",
        score: 88,
        checks: [
          {
            id: "llms-txt",
            label: "llms.txt",
            category: "discovery",
            pass: true,
            value: "Found",
            detail: "The file is available.",
          },
        ],
        session_token: "private-token",
      }),
    );

    expect(result).toEqual({
      v: 1,
      type: "aeo_audit",
      sourceId: AUDIT_ID,
      status: "ready",
      url: "https://example.com/",
      score: 88,
      checks: [
        {
          id: "llms-txt",
          label: "llms.txt",
          category: "discovery",
          pass: true,
          value: "Found",
          detail: "The file is available.",
        },
      ],
      error: null,
    });
    expect(JSON.stringify(result)).not.toContain("sentinel");
    expect(JSON.stringify(result)).not.toContain("private-project");
    expect(JSON.stringify(result)).not.toContain("private-token");
  });

  it("preserves bounded typed audit failure data", () => {
    expect(
      projectMagisterToolPresentation(
        "magister_run_aeo_audit",
        actionResult({
          id: AUDIT_ID,
          status: "failed",
          url: "https://example.com/",
          score: null,
          checks: [],
          terminal_reason: "stale_timeout",
          error_message: "Audit timed out.",
        }),
      ),
    ).toMatchObject({
      status: "failed",
      error: { reason: "stale_timeout", message: "Audit timed out." },
    });
  });

  it.each([
    ["other_tool", actionResult({ id: AUDIT_ID, status: "pending", url: "https://example.com" })],
    [
      "magister_get_aeo_audit",
      actionResult({ id: "not-a-uuid", status: "pending", url: "https://example.com" }),
    ],
    [
      "magister_get_aeo_audit",
      actionResult(
        { id: AUDIT_ID, status: "ready", url: "https://example.com", checks: [] },
        { unexpected: true },
      ),
    ],
    [
      "magister_get_aeo_audit",
      actionResult({
        id: AUDIT_ID,
        status: "ready",
        url: "https://example.com",
        checks: Array.from({ length: 21 }, (_, index) => ({
          id: `check-${index}`,
          label: "Check",
          category: "content",
          pass: true,
          value: "",
          detail: "",
        })),
      }),
    ],
  ])("rejects unknown tools and malformed envelopes", (toolName, result) => {
    expect(projectMagisterToolPresentation(toolName, result)).toBeUndefined();
  });
});
