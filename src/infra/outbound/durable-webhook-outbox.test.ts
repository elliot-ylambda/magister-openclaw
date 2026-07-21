import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueAndDeliverDurableWebhook,
  enqueueDurableWebhook,
  loadPendingDurableWebhooks,
  recoverDurableWebhookOutbox,
} from "./durable-webhook-outbox.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function stateDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-outbox-test-"));
  temporaryRoots.push(root);
  return root;
}

describe("durable webhook outbox", () => {
  it("fsyncs an event before delivery and removes it only after acknowledgement", async () => {
    const root = stateDir();
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("ok", { status: 200 }),
    );
    expect(
      await enqueueAndDeliverDurableWebhook({
        eventId: "slack:run-1",
        eventType: "slack_completion",
        url: "http://gateway.internal/slack",
        payload: { run_id: "run-1", success: true },
        token: "current-token",
        fetchImpl,
        stateDir: root,
      }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ Authorization: "Bearer current-token" });
    if (typeof request?.body !== "string") {
      throw new Error("expected a JSON request body");
    }
    const sent = JSON.parse(request.body) as Record<string, unknown>;
    expect(sent).toMatchObject({
      event_id: "slack:run-1",
      event_type: "slack_completion",
      run_id: "run-1",
    });
    expect(await loadPendingDurableWebhooks(root)).toEqual([]);
  });

  it("reconstructs pending delivery after a dropped response without persisting a token", async () => {
    const root = stateDir();
    await enqueueAndDeliverDurableWebhook({
      eventId: "subagent:run-2",
      eventType: "subagent_completion",
      url: "http://gateway.internal/subagent",
      payload: { run_id: "run-2" },
      token: "must-not-persist",
      fetchImpl: vi.fn(async () => {
        throw new Error("response dropped");
      }),
      stateDir: root,
    });
    const pending = await loadPendingDurableWebhooks(root);
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain("must-not-persist");

    const retry = vi.fn(async () => new Response("ok", { status: 200 }));
    const result = await recoverDurableWebhookOutbox({
      tokens: { subagent_completion: "rotated-token" },
      fetchImpl: retry,
      stateDir: root,
      now: Number.MAX_SAFE_INTEGER,
    });
    expect(result.delivered).toBe(1);
    expect(await loadPendingDurableWebhooks(root)).toEqual([]);
  });

  it("uses stable event identity and rejects a conflicting payload replay", async () => {
    const root = stateDir();
    await enqueueDurableWebhook({
      eventId: "cron:job-1:1234",
      eventType: "cron_completion",
      url: "http://gateway.internal/cron",
      payload: { jobId: "job-1", runAtMs: 1234 },
      stateDir: root,
    });
    await expect(
      enqueueDurableWebhook({
        eventId: "cron:job-1:1234",
        eventType: "cron_completion",
        url: "http://gateway.internal/cron",
        payload: { jobId: "job-1", runAtMs: 9999 },
        stateDir: root,
      }),
    ).rejects.toThrow("conflicting durable webhook event replay");
  });

  it("treats omitted and undefined object properties as the same payload", async () => {
    const root = stateDir();
    const base = {
      eventId: "cron:job-undefined:1234",
      eventType: "cron_completion" as const,
      url: "http://gateway.internal/cron",
      stateDir: root,
    };

    await enqueueDurableWebhook({
      ...base,
      payload: { jobId: "job-undefined", optionalSummary: undefined },
    });
    await expect(
      enqueueDurableWebhook({
        ...base,
        payload: { jobId: "job-undefined" },
      }),
    ).resolves.toMatchObject({ eventId: base.eventId });
  });

  it("repairs a legacy pending hash and callback URL without resetting retries", async () => {
    const root = stateDir();
    const eventId = "cron:job-legacy:5678";
    await enqueueDurableWebhook({
      eventId,
      eventType: "cron_completion",
      url: "http://broker.internal/api/cron-webhook",
      payload: { jobId: "job-legacy" },
      stateDir: root,
    });

    const directory = path.join(root, "durable-webhook-outbox");
    const filename = fs.readdirSync(directory).find((name) => name.endsWith(".json"));
    if (!filename) {
      throw new Error("expected a pending outbox entry");
    }
    const filePath = path.join(directory, filename);
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const legacyHash = createHash("sha256")
      .update('{"jobId":"job-legacy","optionalSummary":null}')
      .digest("hex");
    stored.payloadHash = legacyHash;
    stored.attemptCount = 3;
    stored.lastError = "webhook returned HTTP 403";
    stored.payload = {
      ...(stored.payload as Record<string, unknown>),
      payload_hash: legacyHash,
    };
    fs.writeFileSync(filePath, JSON.stringify(stored, null, 2));

    const repaired = await enqueueDurableWebhook({
      eventId,
      eventType: "cron_completion",
      url: "http://broker.internal/callbacks/cron",
      payload: { jobId: "job-legacy" },
      stateDir: root,
    });

    expect(repaired).toMatchObject({
      eventId,
      url: "http://broker.internal/callbacks/cron",
      attemptCount: 3,
      lastError: "webhook returned HTTP 403",
    });
    expect(repaired.payloadHash).not.toBe(legacyHash);
    expect(repaired.payload.payload_hash).toBe(repaired.payloadHash);
  });

  it("retains a content-free delivery receipt so task reconstruction cannot resend", async () => {
    const root = stateDir();
    const first = vi.fn(async () => new Response("ok", { status: 200 }));
    const params = {
      eventId: "cron:job-2:5678",
      eventType: "cron_completion" as const,
      url: "http://gateway.internal/cron",
      payload: { jobId: "job-2", runAtMs: 5678, summary: "private output" },
      token: "token",
      stateDir: root,
    };
    expect(await enqueueAndDeliverDurableWebhook({ ...params, fetchImpl: first })).toBe(true);

    const second = vi.fn(async () => new Response("ok", { status: 200 }));
    expect(await enqueueAndDeliverDurableWebhook({ ...params, fetchImpl: second })).toBe(true);
    expect(second).not.toHaveBeenCalled();
    const files = fs.readdirSync(path.join(root, "durable-webhook-outbox"));
    const receipt = files.find((name) => name.endsWith(".delivered"));
    expect(receipt).toBeTruthy();
    expect(
      fs.readFileSync(path.join(root, "durable-webhook-outbox", receipt ?? ""), "utf8"),
    ).not.toContain("private output");
  });
});
