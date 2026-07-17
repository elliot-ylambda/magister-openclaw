import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegacyContextEngine } from "./legacy.js";
import {
  createMagisterMemoryContextEngine,
  MagisterMemoryContextEngine,
} from "./magister-memory.js";

describe("MagisterMemoryContextEngine", () => {
  let dir: string;
  let memoryPath: string;
  let userPath: string;
  let projectPath: string;
  let brandPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mem-engine-test-"));
    memoryPath = join(dir, "MEMORY.md");
    userPath = join(dir, "USER.md");
    projectPath = join(dir, "PROJECT.md");
    brandPath = join(dir, "BRAND.md");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns inner result unchanged when both files are absent", async () => {
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    const res = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(res.systemPromptAddition ?? "").not.toContain("## Memory");
    expect(res.systemPromptAddition ?? "").not.toContain("## User Profile");
  });

  it("folds memory, user, and project content into system prompt addition", async () => {
    await writeFile(memoryPath, "Fact 1\n§\nFact 2");
    await writeFile(userPath, "User likes X");
    await writeFile(projectPath, "Acme assignment");
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    const res = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(res.systemPromptAddition).toContain("## Memory (about the project)");
    expect(res.systemPromptAddition).toContain("Fact 1");
    expect(res.systemPromptAddition).toContain("## User Profile");
    expect(res.systemPromptAddition).toContain("User likes X");
    expect(res.systemPromptAddition).toContain("## Project Assignment");
    expect(res.systemPromptAddition).toContain("Acme assignment");
    expect(res.systemPromptAddition).toContain("provenance=trusted_project_state");
  });

  it("freezes snapshot per session — does not re-read file after first assemble", async () => {
    await writeFile(memoryPath, "Original");
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });

    const first = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(first.systemPromptAddition).toContain("Original");

    // File changes mid-session — engine MUST NOT pick this up for the same sessionId.
    await writeFile(memoryPath, "Updated");
    const second = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(second.systemPromptAddition).toContain("Original");
    expect(second.systemPromptAddition).not.toContain("Updated");
  });

  it("re-reads an empty snapshot on later assembles and freezes once content appears", async () => {
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });

    // First assemble: no files exist yet — snapshot is empty.
    const first = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(first.systemPromptAddition ?? "").not.toContain("Seeded memory entry");

    // Files appear after the session already started (the provision race).
    await writeFile(memoryPath, "Seeded memory entry");

    // Second assemble on the SAME session must pick the content up.
    const second = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(second.systemPromptAddition).toContain("Seeded memory entry");

    // And once non-empty, it freezes: later writes do not appear.
    await writeFile(memoryPath, "Rewritten later");
    const third = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(third.systemPromptAddition).toContain("Seeded memory entry");
    expect(third.systemPromptAddition).not.toContain("Rewritten later");
  });

  it("re-reads for a new session", async () => {
    await writeFile(memoryPath, "Original");
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    await engine.assemble({ sessionId: "s1", messages: [] });

    await writeFile(memoryPath, "Updated");
    const fresh = await engine.assemble({ sessionId: "s2", messages: [] });
    expect(fresh.systemPromptAddition).toContain("Updated");
  });

  it("production factory scopes file paths to the provided workspaceDir", async () => {
    // Simulates an agent with its own workspace (e.g. heartbeat): the engine
    // must read that workspace's files, not the hardcoded marketing root.
    await writeFile(memoryPath, "Workspace-scoped memory");
    const engine = createMagisterMemoryContextEngine({ workspaceDir: dir });
    const result = await engine.assemble({ sessionId: "ws1", messages: [] });
    expect(result.systemPromptAddition).toContain("Workspace-scoped memory");
  });

  it("injects bounded sourced brand claims only for relevant work", async () => {
    await writeFile(
      brandPath,
      [
        "# Brand context",
        "",
        "Content outside the generated markers is user-owned and takes precedence.",
        "",
        "Confirmed voice: precise and warm.",
        "<!-- MAGISTER:GENERATED BRAND START -->",
        "Audit inference: energetic tone.",
        "<!-- MAGISTER:GENERATED BRAND END -->",
      ].join("\n"),
    );
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });

    const irrelevant = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "What is the current server uptime?",
    });
    expect(irrelevant.systemPromptAddition ?? "").not.toContain("Confirmed voice");

    const relevant = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "Draft homepage copy in our brand voice",
    });
    expect(relevant.systemPromptAddition).toContain("Confirmed voice: precise and warm.");
    expect(relevant.systemPromptAddition).toContain("Audit inference: energetic tone.");
    expect(relevant.systemPromptAddition).toContain(
      "provenance=user_authored_content source=brand_file_overrides",
    );
    expect(relevant.systemPromptAddition).toContain(
      "provenance=trusted_project_state source=current_audit_inference",
    );
    expect(relevant.systemPromptAddition!.indexOf("Confirmed voice")).toBeLessThan(
      relevant.systemPromptAddition!.indexOf("Audit inference"),
    );
    expect(relevant.systemPromptAddition!.length).toBeLessThan(6_000);
  });
});
