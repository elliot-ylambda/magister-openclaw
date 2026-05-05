import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MagisterIntegrationsContextEngine,
  registerMagisterIntegrationsContextEngine,
} from "./magister-integrations.js";
import { getContextEngineFactory, listContextEngineIds } from "./registry.js";
import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
} from "./types.js";

function makeMessage(text = "hi"): AgentMessage {
  return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

function makeInnerSpy(overrides?: Partial<AssembleResult>): {
  inner: ContextEngine;
  ingest: ReturnType<typeof vi.fn>;
  assemble: ReturnType<typeof vi.fn>;
  afterTurn: ReturnType<typeof vi.fn>;
  compact: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const ingest = vi.fn(async (): Promise<IngestResult> => ({ ingested: true }));
  const assemble = vi.fn(
    async (params: { messages: AgentMessage[] }): Promise<AssembleResult> => ({
      messages: params.messages,
      estimatedTokens: 7,
      ...overrides,
    }),
  );
  const afterTurn = vi.fn(async () => {});
  const compact = vi.fn(async (): Promise<CompactResult> => ({ ok: true, compacted: false }));
  const dispose = vi.fn(async () => {});

  const info: ContextEngineInfo = { id: "inner-spy", name: "Inner Spy" };

  const inner: ContextEngine = {
    info,
    ingest,
    assemble,
    afterTurn,
    compact,
    dispose,
  };

  return { inner, ingest, assemble, afterTurn, compact, dispose };
}

describe("MagisterIntegrationsContextEngine", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "magister-integrations-test-"));
    filePath = join(tempDir, "INTEGRATIONS.md");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns inner result unchanged when INTEGRATIONS.md is missing", async () => {
    const { inner } = makeInnerSpy();
    const engine = new MagisterIntegrationsContextEngine({ filePath, inner });

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [makeMessage()],
    });

    expect(result.systemPromptAddition).toBeUndefined();
    expect(result.estimatedTokens).toBe(7);
  });

  it("appends INTEGRATIONS.md content and emits no diff note on first turn", async () => {
    writeFileSync(filePath, "# Slack\n✅ Connected\n", "utf8");
    const { inner } = makeInnerSpy();
    const engine = new MagisterIntegrationsContextEngine({ filePath, inner });

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [makeMessage()],
    });

    expect(result.systemPromptAddition).toContain("## Available Integrations");
    expect(result.systemPromptAddition).toContain("# Slack");
    expect(result.systemPromptAddition).not.toContain("Note: integrations changed");
  });

  it("does not emit a diff note when the file is unchanged across turns", async () => {
    writeFileSync(filePath, "stable\n", "utf8");
    const { inner } = makeInnerSpy();
    const engine = new MagisterIntegrationsContextEngine({ filePath, inner });

    await engine.assemble({ sessionId: "s1", messages: [makeMessage()] });
    const second = await engine.assemble({ sessionId: "s1", messages: [makeMessage()] });

    expect(second.systemPromptAddition).not.toContain("Note: integrations changed");
  });

  it("emits a diff note when content changes between turns in the same session", async () => {
    writeFileSync(filePath, "v1\n", "utf8");
    const { inner } = makeInnerSpy();
    const engine = new MagisterIntegrationsContextEngine({ filePath, inner });

    await engine.assemble({ sessionId: "s1", messages: [makeMessage()] });

    writeFileSync(filePath, "v2\n", "utf8");
    const second = await engine.assemble({ sessionId: "s1", messages: [makeMessage()] });

    expect(second.systemPromptAddition).toContain("Note: integrations changed");
    expect(second.systemPromptAddition).toContain("v2");
  });

  it("emits the diff note only once — a third turn with stable content does not re-emit", async () => {
    writeFileSync(filePath, "v1\n", "utf8");
    const { inner } = makeInnerSpy();
    const engine = new MagisterIntegrationsContextEngine({ filePath, inner });

    await engine.assemble({ sessionId: "s1", messages: [makeMessage()] });
    writeFileSync(filePath, "v2\n", "utf8");
    const second = await engine.assemble({ sessionId: "s1", messages: [makeMessage()] });
    const third = await engine.assemble({ sessionId: "s1", messages: [makeMessage()] });

    expect(second.systemPromptAddition).toContain("Note: integrations changed");
    expect(third.systemPromptAddition).not.toContain("Note: integrations changed");
  });

  it("dispose() clears per-session state so the next assemble treats the session as fresh", async () => {
    writeFileSync(filePath, "v1\n", "utf8");
    const { inner } = makeInnerSpy();
    const engine = new MagisterIntegrationsContextEngine({ filePath, inner });

    await engine.assemble({ sessionId: "s1", messages: [makeMessage()] });
    await engine.dispose();

    writeFileSync(filePath, "v2\n", "utf8");
    const afterDispose = await engine.assemble({
      sessionId: "s1",
      messages: [makeMessage()],
    });

    expect(afterDispose.systemPromptAddition).not.toContain("Note: integrations changed");
  });

  it("treats different sessions independently — change in one doesn't note in another", async () => {
    writeFileSync(filePath, "v1\n", "utf8");
    const { inner } = makeInnerSpy();
    const engine = new MagisterIntegrationsContextEngine({ filePath, inner });

    await engine.assemble({ sessionId: "s1", messages: [makeMessage()] });
    writeFileSync(filePath, "v2\n", "utf8");

    const sessionTwoFirst = await engine.assemble({
      sessionId: "s2",
      messages: [makeMessage()],
    });

    expect(sessionTwoFirst.systemPromptAddition).not.toContain("Note: integrations changed");
  });

  it("merges with an inner systemPromptAddition rather than replacing it", async () => {
    writeFileSync(filePath, "x\n", "utf8");
    const { inner } = makeInnerSpy({
      messages: [],
      estimatedTokens: 7,
      systemPromptAddition: "inner addition",
    });
    const engine = new MagisterIntegrationsContextEngine({ filePath, inner });

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [makeMessage()],
    });

    expect(result.systemPromptAddition?.startsWith("inner addition")).toBe(true);
    expect(result.systemPromptAddition).toContain("## Available Integrations");
  });

  it("delegates ingest, afterTurn, compact, and dispose to the inner engine", async () => {
    const spy = makeInnerSpy();
    const engine = new MagisterIntegrationsContextEngine({ filePath, inner: spy.inner });

    await engine.ingest({ sessionId: "s1", message: makeMessage() });
    await engine.afterTurn({
      sessionId: "s1",
      sessionFile: "/tmp/x",
      messages: [],
      prePromptMessageCount: 0,
    });
    await engine.compact({ sessionId: "s1", sessionFile: "/tmp/x" });
    await engine.dispose();

    expect(spy.ingest).toHaveBeenCalledOnce();
    expect(spy.afterTurn).toHaveBeenCalledOnce();
    expect(spy.compact).toHaveBeenCalledOnce();
    expect(spy.dispose).toHaveBeenCalledOnce();
  });
});

describe("registerMagisterIntegrationsContextEngine", () => {
  it("registers the engine under id 'magister-integrations'", () => {
    registerMagisterIntegrationsContextEngine();
    expect(listContextEngineIds()).toContain("magister-integrations");
    const factory = getContextEngineFactory("magister-integrations");
    expect(factory).toBeDefined();
    const engine = factory!();
    expect(engine).toBeInstanceOf(MagisterIntegrationsContextEngine);
  });
});
