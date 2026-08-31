import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithSessionHeader } from "./session-header-stream.js";

describe("wrapStreamFnWithSessionHeader", () => {
  it("forwards the canonical session key through request-option headers", () => {
    const upstream = vi.fn<StreamFn>();
    const wrapped = wrapStreamFnWithSessionHeader(
      upstream,
      "agent:marketing:subagent:child",
      "agent:marketing:webchat:session-123",
    );
    const model = { id: "test-model" } as Parameters<StreamFn>[0];
    const context = { messages: [] } as Parameters<StreamFn>[1];

    void wrapped(model, context, {
      headers: {
        "X-Existing": "kept",
        "x-session-id": "stale-session",
        "x-magister-activity-session-id": "stale-root",
      },
    });

    expect(upstream).toHaveBeenCalledWith(model, context, {
      headers: {
        "X-Existing": "kept",
        "X-Session-Id": "agent:marketing:subagent:child",
        "X-Magister-Activity-Session-Id": "agent:marketing:webchat:session-123",
      },
    });
  });

  it("keeps the original stream function when no session key exists", () => {
    const upstream = vi.fn<StreamFn>();

    expect(wrapStreamFnWithSessionHeader(upstream, undefined)).toBe(upstream);
  });
});
