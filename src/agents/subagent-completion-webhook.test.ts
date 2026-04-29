import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendSubagentCompletionWebhook } from "./subagent-completion-webhook.js";

describe("sendSubagentCompletionWebhook", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POSTs payload with bearer token", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    await sendSubagentCompletionWebhook({
      url: "https://gw.internal/api/subagent-webhook",
      token: "tok-1",
      payload: {
        openclaw_session_key: "agent:marketing:abc",
        run_id: "r1",
        child_session_key: "ck1",
        outcome: "ok",
        summary: "did the thing",
        runtime_ms: 1234,
      },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.internal/api/subagent-webhook");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-1");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.outcome).toBe("ok");
    expect(body.run_id).toBe("r1");
    expect(body.openclaw_session_key).toBe("agent:marketing:abc");
  });

  it("logs and swallows non-2xx responses (best-effort)", async () => {
    const fetchSpy = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      sendSubagentCompletionWebhook({
        url: "https://gw.internal/api/subagent-webhook",
        token: "tok-1",
        payload: {
          openclaw_session_key: "k",
          run_id: "r1",
          child_session_key: "ck1",
          outcome: "ok",
          summary: "x",
          runtime_ms: 1,
        },
        fetchImpl: fetchSpy as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does nothing when url or token missing", async () => {
    const fetchSpy = vi.fn();
    await sendSubagentCompletionWebhook({
      url: "",
      token: "tok-1",
      payload: {
        openclaw_session_key: "k",
        run_id: "r1",
        child_session_key: "ck1",
        outcome: "ok",
        summary: "x",
        runtime_ms: 1,
      },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
