import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegacyContextEngine } from "./legacy.js";
import { MagisterMemoryContextEngine } from "./magister-memory.js";

describe("MagisterMemoryContextEngine", () => {
  let dir: string;
  let memoryPath: string;
  let userPath: string;
  let projectPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mem-engine-test-"));
    memoryPath = join(dir, "MEMORY.md");
    userPath = join(dir, "USER.md");
    projectPath = join(dir, "PROJECT.md");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns inner result unchanged when both files are absent", async () => {
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
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
      inner: new LegacyContextEngine(),
    });
    const res = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(res.systemPromptAddition).toContain("## Memory (about the project)");
    expect(res.systemPromptAddition).toContain("Fact 1");
    expect(res.systemPromptAddition).toContain("## User Profile");
    expect(res.systemPromptAddition).toContain("User likes X");
    expect(res.systemPromptAddition).toContain("## Project Assignment");
    expect(res.systemPromptAddition).toContain("Acme assignment");
  });

  it("freezes snapshot per session — does not re-read file after first assemble", async () => {
    await writeFile(memoryPath, "Original");
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
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

  it("re-reads for a new session", async () => {
    await writeFile(memoryPath, "Original");
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      inner: new LegacyContextEngine(),
    });
    await engine.assemble({ sessionId: "s1", messages: [] });

    await writeFile(memoryPath, "Updated");
    const fresh = await engine.assemble({ sessionId: "s2", messages: [] });
    expect(fresh.systemPromptAddition).toContain("Updated");
  });
});
