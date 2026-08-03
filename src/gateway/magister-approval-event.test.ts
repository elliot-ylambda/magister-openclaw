import { describe, expect, it } from "vitest";
import { extractMagisterApprovalEvent } from "./magister-approval-event.js";

const approvalId = "11111111-1111-4111-8111-111111111111";
const operationId = `op_${"a".repeat(32)}`;

function pendingEnvelope(errorCode = "approval_required") {
  return {
    ok: false,
    operation_id: operationId,
    status: { state: "running", terminal: false },
    error: { code: errorCode, retryable: false },
    receipt: {
      approval_id: approvalId,
      approval_state: "pending",
      approval_presentation: "inline_web",
    },
  };
}

describe("extractMagisterApprovalEvent", () => {
  it("emits only the opaque identifiers from a closed pending envelope", () => {
    expect(
      extractMagisterApprovalEvent({
        phase: "result",
        name: "magister_send_agent_email",
        isError: false,
        result: JSON.stringify(pendingEnvelope()),
      }),
    ).toEqual({
      approval_id: approvalId,
      operation_id: operationId,
      state: "pending",
    });
  });

  it("accepts the legacy approval code during rolling upgrades", () => {
    expect(
      extractMagisterApprovalEvent({
        phase: "result",
        name: "magister_send_agent_email",
        isError: false,
        result: pendingEnvelope("not_authorized"),
      }),
    ).toEqual({
      approval_id: approvalId,
      operation_id: operationId,
      state: "pending",
    });
  });

  it("rejects unrelated authorization errors", () => {
    expect(
      extractMagisterApprovalEvent({
        phase: "result",
        name: "magister_send_agent_email",
        isError: false,
        result: pendingEnvelope("forbidden"),
      }),
    ).toBeUndefined();
  });

  it("rejects model-shaped tools and envelopes without inline presentation", () => {
    expect(
      extractMagisterApprovalEvent({
        phase: "result",
        name: "send_agent_email",
        isError: false,
        result: pendingEnvelope(),
      }),
    ).toBeUndefined();
    expect(
      extractMagisterApprovalEvent({
        phase: "result",
        name: "magister_send_agent_email",
        isError: false,
        result: {
          ...pendingEnvelope(),
          receipt: {
            ...pendingEnvelope().receipt,
            approval_presentation: "link_only",
          },
        },
      }),
    ).toBeUndefined();
  });
});
