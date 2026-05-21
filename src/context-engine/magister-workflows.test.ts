import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyContextEngine } from "./legacy.js";
import { MagisterWorkflowsContextEngine } from "./magister-workflows.js";

const message: AgentMessage = {
  role: "user",
  content: [{ type: "text", text: "hello" }],
};

describe("MagisterWorkflowsContextEngine", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wf-md-"));
    filePath = join(tempDir, "WORKFLOWS.md");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns inner result unchanged when WORKFLOWS.md is missing", async () => {
    const inner = new LegacyContextEngine();
    const innerSpy = vi.spyOn(inner, "assemble");
    const engine = new MagisterWorkflowsContextEngine({ inner, filePath });

    const result = await engine.assemble({ sessionId: "s1", messages: [message] });

    expect(innerSpy).toHaveBeenCalledOnce();
    expect(result.systemPromptAddition ?? "").not.toContain("Available Workflows");
  });

  it("appends WORKFLOWS.md content and emits no diff note on first turn", async () => {
    await writeFile(filePath, "# Workflows\n\n- SEO Site Audit", "utf8");
    const engine = new MagisterWorkflowsContextEngine({ filePath });

    const result = await engine.assemble({ sessionId: "s1", messages: [message] });

    expect(result.systemPromptAddition).toContain("## Available Workflows");
    expect(result.systemPromptAddition).toContain("SEO Site Audit");
    expect(result.systemPromptAddition).not.toContain("workflows changed since your last reply");
  });

  it("emits diff note on subsequent turns after content changes", async () => {
    await writeFile(filePath, "v1", "utf8");
    const engine = new MagisterWorkflowsContextEngine({ filePath });
    await engine.assemble({ sessionId: "s1", messages: [message] });

    await writeFile(filePath, "v2", "utf8");
    const second = await engine.assemble({ sessionId: "s1", messages: [message] });

    expect(second.systemPromptAddition).toContain("workflows changed since your last reply");
    expect(second.systemPromptAddition).toContain("v2");
  });

  it("does not emit diff note when content is unchanged", async () => {
    await writeFile(filePath, "stable", "utf8");
    const engine = new MagisterWorkflowsContextEngine({ filePath });
    await engine.assemble({ sessionId: "s1", messages: [message] });

    const second = await engine.assemble({ sessionId: "s1", messages: [message] });

    expect(second.systemPromptAddition).not.toContain("workflows changed since your last reply");
  });

  it("tracks per-session hashes independently", async () => {
    await writeFile(filePath, "v1", "utf8");
    const engine = new MagisterWorkflowsContextEngine({ filePath });
    await engine.assemble({ sessionId: "s1", messages: [message] });

    await writeFile(filePath, "v2", "utf8");
    const otherSession = await engine.assemble({ sessionId: "s2", messages: [message] });

    // s2 has never seen v1, so no diff note for it.
    expect(otherSession.systemPromptAddition).not.toContain(
      "workflows changed since your last reply",
    );
  });

  it("composes with magister-integrations so both files fold in", async () => {
    const workflowsPath = filePath;
    const integrationsPath = join(tempDir, "INTEGRATIONS.md");
    await writeFile(workflowsPath, "WORKFLOWS body", "utf8");
    await writeFile(integrationsPath, "INTEGRATIONS body", "utf8");

    const { MagisterIntegrationsContextEngine } = await import("./magister-integrations.js");
    const engine = new MagisterWorkflowsContextEngine({
      filePath: workflowsPath,
      inner: new MagisterIntegrationsContextEngine({ filePath: integrationsPath }),
    });

    const result = await engine.assemble({ sessionId: "s1", messages: [message] });
    expect(result.systemPromptAddition).toContain("## Available Integrations");
    expect(result.systemPromptAddition).toContain("INTEGRATIONS body");
    expect(result.systemPromptAddition).toContain("## Available Workflows");
    expect(result.systemPromptAddition).toContain("WORKFLOWS body");
  });
});
