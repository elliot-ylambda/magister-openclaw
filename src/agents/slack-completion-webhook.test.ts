import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSlackSessionKey, sendSlackCompletionWebhook } from "./slack-completion-webhook.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function stateDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slack-webhook-test-"));
  temporaryRoots.push(root);
  return root;
}

describe("isSlackSessionKey", () => {
  it("matches only agent-qualified slack session keys", () => {
    expect(isSlackSessionKey("agent:main:slack:channel:c123")).toBe(true);
    expect(isSlackSessionKey("agent:main:slack:channel:c123:thread:1712.34")).toBe(true);
    expect(isSlackSessionKey("agent:other-agent:slack:channel:c1")).toBe(true);
    expect(isSlackSessionKey("agent:main:webchat:abc-123")).toBe(false);
    expect(isSlackSessionKey("workflow_run:r1")).toBe(false);
    expect(isSlackSessionKey("slack:T1:C1")).toBe(false); // gateway lane key, not a machine session key
    expect(isSlackSessionKey(undefined)).toBe(false);
    expect(isSlackSessionKey("")).toBe(false);
  });
});

describe("sendSlackCompletionWebhook", () => {
  it("POSTs payload with bearer token", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    await sendSlackCompletionWebhook({
      url: "https://gw.internal/api/slack-run-webhook",
      token: "tok-1",
      payload: {
        openclaw_session_key: "agent:main:slack:channel:c123",
        run_id: "r1",
        success: true,
        duration_ms: 4200,
      },
      fetchImpl: fetchSpy as unknown as typeof fetch,
      stateDir: stateDir(),
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.internal/api/slack-run-webhook");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-1");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.openclaw_session_key).toBe("agent:main:slack:channel:c123");
    expect(body.success).toBe(true);
    expect(body.event_id).toBe("slack:r1");
  });

  it("logs and swallows non-2xx responses (best-effort)", async () => {
    const fetchSpy = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      sendSlackCompletionWebhook({
        url: "https://gw.internal/api/slack-run-webhook",
        token: "tok-1",
        payload: { openclaw_session_key: "k", run_id: "r1", success: false, error: "boom" },
        fetchImpl: fetchSpy as unknown as typeof fetch,
        stateDir: stateDir(),
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing when url or token missing", async () => {
    const fetchSpy = vi.fn();
    await sendSlackCompletionWebhook({
      url: "",
      token: "tok-1",
      payload: { openclaw_session_key: "k", run_id: "r1", success: true },
      fetchImpl: fetchSpy as unknown as typeof fetch,
      stateDir: stateDir(),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
