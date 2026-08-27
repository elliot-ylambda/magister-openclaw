import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeSubagentCompletionWebhookOutcome,
  sendSubagentCompletionWebhook,
  shouldSkipSubagentCompletionWebhook,
} from "./subagent-completion-webhook.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function stateDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-webhook-test-"));
  temporaryRoots.push(root);
  return root;
}

describe("normalizeSubagentCompletionWebhookOutcome", () => {
  it("does not report terminated subagents as successful completions", () => {
    expect(normalizeSubagentCompletionWebhookOutcome("ok")).toBe("ok");
    expect(normalizeSubagentCompletionWebhookOutcome(undefined)).toBe("ok");
    expect(normalizeSubagentCompletionWebhookOutcome("timeout")).toBe("timeout");
    expect(normalizeSubagentCompletionWebhookOutcome("error")).toBe("error");
    expect(normalizeSubagentCompletionWebhookOutcome("killed")).toBe("error");
    expect(normalizeSubagentCompletionWebhookOutcome("reset")).toBe("error");
    expect(normalizeSubagentCompletionWebhookOutcome("deleted")).toBe("error");
  });
});

describe("shouldSkipSubagentCompletionWebhook", () => {
  it("skips only a kill the requester issued itself", () => {
    // `subagents kill` by the owning session is a control action the requester
    // already knows about; reporting it would render a "Background task failed"
    // card in the user's chat for a turn that succeeded inline.
    expect(
      shouldSkipSubagentCompletionWebhook({ outcome: "killed", killedByRequester: true }),
    ).toBe(true);
    expect(shouldSkipSubagentCompletionWebhook({ outcome: "killed" })).toBe(false);
    expect(
      shouldSkipSubagentCompletionWebhook({ outcome: "killed", killedByRequester: false }),
    ).toBe(false);
    expect(shouldSkipSubagentCompletionWebhook({ outcome: "error", killedByRequester: true })).toBe(
      false,
    );
    expect(shouldSkipSubagentCompletionWebhook({ outcome: "ok" })).toBe(false);
  });
});

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
      stateDir: stateDir(),
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
    expect(body.event_id).toBe("subagent:r1");
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
        stateDir: stateDir(),
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
      stateDir: stateDir(),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
