import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginPromptPresence,
  markPromptRequestStarted,
  readActiveRuntimeBundle,
  recordPromptFirstToken,
  retryPromptPresence,
} from "./runtime-bundle-presence.js";
import { buildWorkspaceSkillSnapshot } from "./skills/workspace.js";
import { buildSystemPromptReport } from "./system-prompt-report.js";

const releaseId = `rb_${"a".repeat(64)}`;
const manifestSha256 = "b".repeat(64);
const templatesSha256 = "c".repeat(64);
const skillsSha256 = "d".repeat(64);

const temporaryDirectories: string[] = [];

async function activeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "runtime-presence-"));
  temporaryDirectories.push(workspace);
  const runtime = path.join(workspace, ".magister", "runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(
    path.join(runtime, "applied-manifest.json"),
    JSON.stringify({ release_id: releaseId, manifest_sha256: manifestSha256 }),
  );
  await writeFile(
    path.join(runtime, "bundle-active"),
    JSON.stringify({ release_id: releaseId, state: "active" }),
  );
  await writeFile(
    path.join(runtime, "process-state.json"),
    JSON.stringify({
      active: {
        release_id: releaseId,
        manifest_sha256: manifestSha256,
        templates_sha256: templatesSha256,
        skills_sha256: skillsSha256,
      },
      boot_id: "boot-1",
      lease: `lease-${"x".repeat(32)}`,
      machine_id: "machine-1",
      process_generation: "7",
    }),
  );
  return workspace;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("runtime bundle prompt presence", () => {
  it("binds skill snapshots and prompt reports to the active release", async () => {
    const workspace = await activeWorkspace();

    expect(readActiveRuntimeBundle(workspace)).toEqual({
      releaseId,
      manifestSha256,
      templatesSha256,
      skillsSha256,
    });
    expect(buildWorkspaceSkillSnapshot(workspace, { entries: [] }).releaseId).toBe(releaseId);
    expect(
      buildSystemPromptReport({
        source: "run",
        generatedAt: 1,
        workspaceDir: workspace,
        bootstrapMaxChars: 100,
        systemPrompt: "prompt",
        bootstrapFiles: [],
        injectedFiles: [],
        skillsPrompt: "",
        tools: [],
      }).runtimeBundle,
    ).toEqual({ releaseId, manifestSha256, templatesSha256, skillsSha256 });
  });

  it("records before the bounded send and retries a pending ACK after the request", async () => {
    const workspace = await activeWorkspace();
    vi.stubEnv("GATEWAY_TOKEN", "machine-token");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls += 1;
        const pending = path.join(workspace, ".magister", "runtime", "prompt-presence", "pending");
        expect(fs.readdirSync(pending)).toHaveLength(1);
        if (typeof init.body !== "string") {
          throw new TypeError("expected JSON request body");
        }
        const payload = JSON.parse(init.body);
        expect(payload).toMatchObject({
          phase: "prompt_present",
          release_id: releaseId,
          session_id: "session-1",
        });
        return { ok: calls > 1 } as Response;
      }),
    );

    const pending = await beginPromptPresence({ workspaceDir: workspace, sessionId: "session-1" });
    expect(pending).toBeDefined();
    expect(fs.existsSync(pending!.pendingPath)).toBe(true);

    await retryPromptPresence(pending);

    expect(calls).toBe(2);
    expect(fs.existsSync(pending!.pendingPath)).toBe(false);
    expect(JSON.parse(await readFile(pending!.sentPath, "utf8"))).toMatchObject({
      release_id: releaseId,
      session_id: "session-1",
    });
  });

  it("retries durable model-request evidence after the request", async () => {
    const workspace = await activeWorkspace();
    vi.stubEnv("GATEWAY_TOKEN", "machine-token");
    let modelRequestAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (typeof init.body !== "string") {
          throw new TypeError("expected JSON request body");
        }
        const payload = JSON.parse(init.body);
        if (payload.phase === "model_request_started") {
          modelRequestAttempts += 1;
          return { ok: modelRequestAttempts > 1 } as Response;
        }
        return { ok: true } as Response;
      }),
    );

    const record = await beginPromptPresence({
      workspaceDir: workspace,
      sessionId: "session-request-retry",
    });
    await markPromptRequestStarted(record);
    await retryPromptPresence(record);

    expect(modelRequestAttempts).toBe(2);
    expect(fs.existsSync(record!.modelRequestPendingPath)).toBe(false);
    expect(JSON.parse(await readFile(record!.modelRequestSentPath, "utf8"))).toMatchObject({
      release_id: releaseId,
      session_id: "session-request-retry",
    });
  });

  it("does not report a candidate when the active marker disagrees", async () => {
    const workspace = await activeWorkspace();
    await writeFile(
      path.join(workspace, ".magister", "runtime", "bundle-active"),
      JSON.stringify({ release_id: `rb_${"e".repeat(64)}`, state: "active" }),
    );
    vi.stubEnv("GATEWAY_TOKEN", "machine-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(readActiveRuntimeBundle(workspace)).toBeUndefined();
    expect(
      await beginPromptPresence({ workspaceDir: workspace, sessionId: "session" }),
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records model-request evidence before sending and preserves first-token latency", async () => {
    const workspace = await activeWorkspace();
    vi.stubEnv("GATEWAY_TOKEN", "machine-token");
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (typeof init.body !== "string") {
          throw new TypeError("expected JSON request body");
        }
        const payload = JSON.parse(init.body);
        if (payload.phase === "model_request_started") {
          const pending = path.join(
            workspace,
            ".magister",
            "runtime",
            "prompt-presence",
            "model-request-pending",
          );
          expect(fs.readdirSync(pending)).toHaveLength(1);
        }
        payloads.push(payload);
        return { ok: true } as Response;
      }),
    );
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const record = await beginPromptPresence({
      workspaceDir: workspace,
      sessionId: "session-latency",
    });
    expect(record).toBeDefined();

    now.mockReturnValue(2_000);
    await markPromptRequestStarted(record);
    now.mockReturnValue(2_125);
    recordPromptFirstToken(record);
    await retryPromptPresence(record);

    expect(payloads).toHaveLength(3);
    expect(payloads[1]).toMatchObject({
      phase: "model_request_started",
      release_id: releaseId,
      session_id: "session-latency",
    });
    expect(payloads[2]).toMatchObject({
      phase: "prompt_present",
      first_token_latency_ms: 125,
    });
    expect(fs.existsSync(record!.modelRequestPendingPath)).toBe(false);
    expect(JSON.parse(await readFile(record!.modelRequestSentPath, "utf8"))).toMatchObject({
      release_id: releaseId,
      session_id: "session-latency",
    });
    expect(JSON.parse(await readFile(record!.metricSentPath, "utf8"))).toMatchObject({
      first_token_latency_ms: 125,
      release_id: releaseId,
    });
  });
});
