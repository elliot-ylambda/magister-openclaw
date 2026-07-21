import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPendingDurableWebhooks } from "./durable-webhook-outbox.js";
import { reconstructTaskCompletionOutbox } from "./task-outbox-reconciliation.js";

const taskRegistry = vi.hoisted(() => ({
  listTaskRecords: vi.fn(),
}));

vi.mock("../../tasks/task-registry.js", () => ({
  listTaskRecords: taskRegistry.listTaskRecords,
  setTaskOutboxIntentById: vi.fn(),
  setTaskOutboxIntentByRunId: vi.fn(),
}));

const temporaryRoots: string[] = [];

afterEach(() => {
  taskRegistry.listTaskRecords.mockReset();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function stateDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-outbox-reconciliation-test-"));
  temporaryRoots.push(root);
  return root;
}

describe("task outbox reconciliation", () => {
  it("isolates a conflicting task and continues reconstructing other callbacks", async () => {
    taskRegistry.listTaskRecords.mockReturnValue([
      {
        outboxRequired: true,
        status: "succeeded",
        eventId: "subagent:duplicate",
        outboxEventType: "subagent_completion",
        terminalPayload: { run_id: "first" },
      },
      {
        outboxRequired: true,
        status: "succeeded",
        eventId: "subagent:duplicate",
        outboxEventType: "subagent_completion",
        terminalPayload: { run_id: "conflict" },
      },
      {
        outboxRequired: true,
        status: "succeeded",
        eventId: "subagent:healthy",
        outboxEventType: "subagent_completion",
        terminalPayload: { run_id: "healthy" },
      },
    ]);
    const root = stateDir();
    const cfg = {
      subagent: { completionWebhook: "http://gateway.internal/subagent" },
    } as OpenClawConfig;

    await expect(reconstructTaskCompletionOutbox({ cfg, stateDir: root })).resolves.toEqual({
      reconstructed: 2,
      unavailable: 0,
      invalid: 1,
    });
    expect(await loadPendingDurableWebhooks(root)).toHaveLength(2);
  });
});
