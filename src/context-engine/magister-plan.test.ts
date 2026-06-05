import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyContextEngine } from "./legacy.js";
import { MagisterPlanContextEngine } from "./magister-plan.js";

describe("MagisterPlanContextEngine", () => {
  let dir: string;
  let fallbackPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "plan-engine-test-"));
    fallbackPath = join(dir, "PLAN.md");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("folds the gateway live-plan summary into the system prompt", async () => {
    const fetchImpl = vi.fn(
      async (_input: string, init?: { headers?: Record<string, string> }) => ({
        ok: true,
        status: 200,
        json: async () => ({
          plan_id: "plan-1",
          version: 1,
          summary_hash: "hash-1",
          summary: "## Current Marketing Plan\n\nPriority items:\n- [ready] Fix metadata",
        }),
        init,
      }),
    );
    const engine = new MagisterPlanContextEngine({
      gatewayBaseUrl: "http://gateway.test",
      gatewayToken: "machine-token",
      fallbackPath,
      fetchImpl,
      inner: new LegacyContextEngine(),
    });

    const res = await engine.assemble({ sessionId: "s1", messages: [] });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://gateway.test/api/orchestrator/current-plan/summary",
      expect.objectContaining({
        headers: { Authorization: "Bearer machine-token" },
      }),
    );
    expect(res.systemPromptAddition).toContain("Current Marketing Plan");
    expect(res.systemPromptAddition).toContain("Fix metadata");
  });

  it("adds the current-plan heading when gateway returns a bare summary", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        summary: "Priority items:\n- [ready] Fix metadata",
      }),
    }));
    const engine = new MagisterPlanContextEngine({
      gatewayBaseUrl: "http://gateway.test",
      gatewayToken: "machine-token",
      fallbackPath,
      fetchImpl,
      inner: new LegacyContextEngine(),
    });

    const res = await engine.assemble({ sessionId: "s1", messages: [] });

    expect(res.systemPromptAddition).toContain("## Current Marketing Plan");
    expect(res.systemPromptAddition).toContain("Fix metadata");
  });

  it("falls back to PLAN.md when the gateway summary is unavailable", async () => {
    await writeFile(fallbackPath, "# Current Marketing Plan\n\n- [ready] Draft page");
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));
    const engine = new MagisterPlanContextEngine({
      gatewayBaseUrl: "http://gateway.test",
      gatewayToken: "machine-token",
      fallbackPath,
      fetchImpl,
      inner: new LegacyContextEngine(),
    });

    const res = await engine.assemble({ sessionId: "s1", messages: [] });

    expect(res.systemPromptAddition).toContain("Current Marketing Plan");
    expect(res.systemPromptAddition).toContain("Draft page");
  });

  it("returns inner result unchanged when no gateway token or PLAN.md exists", async () => {
    const engine = new MagisterPlanContextEngine({
      gatewayToken: "",
      fallbackPath,
      inner: new LegacyContextEngine(),
    });

    const res = await engine.assemble({ sessionId: "s1", messages: [] });

    expect(res.systemPromptAddition ?? "").not.toContain("Current Marketing Plan");
  });
});
