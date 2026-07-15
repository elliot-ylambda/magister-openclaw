import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import type { SkillEntry } from "./skills/types.js";
import {
  resolveSkillsPromptForRun,
  selectSkillsForTask,
  SKILL_INDEX_RELATIVE_PATH,
} from "./skills/workspace.js";

describe("resolveSkillsPromptForRun", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
  });
  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
      }),
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });

  it("loads only task-selected descriptions and writes a complete on-demand index", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "skill-selection-"));
    const seo = createFixtureSkill({
      name: "seo-audit",
      description: "Audit technical SEO, keywords, and search performance",
      filePath: "/app/skills/seo-audit/SKILL.md",
      baseDir: "/app/skills/seo-audit",
      source: "openclaw-workspace",
    });
    const gmail = createFixtureSkill({
      name: "magister-gmail",
      description: "Read and send Gmail messages",
      filePath: "/app/skills/magister-gmail/SKILL.md",
      baseDir: "/app/skills/magister-gmail",
      source: "openclaw-workspace",
    });
    try {
      const prompt = resolveSkillsPromptForRun({
        skillsSnapshot: { prompt: "legacy 90k prompt", skills: [], resolvedSkills: [gmail, seo] },
        workspaceDir,
        taskText: "Audit our SEO keywords and search performance",
      });

      expect(prompt).toContain("Audit technical SEO");
      expect(prompt).not.toContain("Read and send Gmail messages");
      expect(prompt).not.toContain("legacy 90k prompt");
      expect(prompt.length).toBeLessThan(12_000);

      const index = readFileSync(join(workspaceDir, SKILL_INDEX_RELATIVE_PATH), "utf8");
      expect(index).toContain("`seo-audit`");
      expect(index).toContain("`magister-gmail`");
      expect(index).not.toContain("Audit technical SEO");
      expect(index).not.toContain("Read and send Gmail messages");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("honors explicit skill negation", () => {
    const gmail = createFixtureSkill({
      name: "magister-gmail",
      description: "Send email from a connected Gmail identity",
      filePath: "/app/skills/magister-gmail/SKILL.md",
      baseDir: "/app/skills/magister-gmail",
      source: "openclaw-workspace",
    });
    const platformEmail = createFixtureSkill({
      name: "magister-email",
      description: "Send email from the platform domain",
      filePath: "/app/skills/magister-email/SKILL.md",
      baseDir: "/app/skills/magister-email",
      source: "openclaw-workspace",
    });

    const selected = selectSkillsForTask(
      [gmail, platformEmail],
      "Email the report from the agent domain; do not use my Gmail identity.",
    ).map((skill) => skill.name);

    expect(selected).toContain("magister-email");
    expect(selected).not.toContain("magister-gmail");
  });

  it("disambiguates AEO probes from SEO audits and visibility tracking", () => {
    const aeo = createFixtureSkill({
      name: "magister-aeo-audit",
      description: "One-time AEO site audit with prioritized fixes for ChatGPT visibility",
      filePath: "/app/skills/magister-aeo-audit/SKILL.md",
      baseDir: "/app/skills/magister-aeo-audit",
      source: "openclaw-workspace",
    });
    const visibility = createFixtureSkill({
      name: "magister-ai-visibility",
      description: "Track brand appearances in ChatGPT and Gemini over time",
      filePath: "/app/skills/magister-ai-visibility/SKILL.md",
      baseDir: "/app/skills/magister-ai-visibility",
      source: "openclaw-workspace",
    });

    expect(
      selectSkillsForTask([aeo, visibility], "Audit our site for SEO problems").map(
        (skill) => skill.name,
      ),
    ).not.toContain("magister-aeo-audit");
    expect(
      selectSkillsForTask(
        [aeo, visibility],
        "Track how our brand appears in ChatGPT and Gemini over time",
      ).map((skill) => skill.name),
    ).toEqual(["magister-ai-visibility"]);
    expect(
      selectSkillsForTask([aeo, visibility], "Run a one-time standalone AEO probe").map(
        (skill) => skill.name,
      ),
    ).toEqual(["magister-aeo-audit"]);
  });

  it("disambiguates workflow authoring from an existing workflow run", () => {
    const authoring = createFixtureSkill({
      name: "magister-workflows",
      description: "Schedule recurring daily or weekly workflows",
      filePath: "/app/skills/magister-workflows/SKILL.md",
      baseDir: "/app/skills/magister-workflows",
      source: "openclaw-workspace",
    });
    const runtime = createFixtureSkill({
      name: "magister-workflow-runtime",
      description: "Run an existing workflow now by UUID",
      filePath: "/app/skills/magister-workflow-runtime/SKILL.md",
      baseDir: "/app/skills/magister-workflow-runtime",
      source: "openclaw-workspace",
    });

    expect(
      selectSkillsForTask([authoring, runtime], "Schedule a weekly report every Monday").map(
        (skill) => skill.name,
      ),
    ).toEqual(["magister-workflows"]);
    expect(
      selectSkillsForTask([authoring, runtime], "Run my existing workflow now by UUID").map(
        (skill) => skill.name,
      ),
    ).toEqual(["magister-workflow-runtime"]);
  });

  it("keeps legacy entries with disableModelInvocation hidden when exposure metadata is absent", () => {
    const hidden: SkillEntry = {
      skill: createFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
        disableModelInvocation: true,
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [hidden],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("inherits agents.defaults.skills when rebuilding prompt for an agent", () => {
    const visible: SkillEntry = {
      skill: createFixtureSkill({
        name: "github",
        description: "GitHub",
        filePath: "/app/skills/github/SKILL.md",
        baseDir: "/app/skills/github",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const hidden: SkillEntry = {
      skill: createFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [visible, hidden],
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).toContain("/app/skills/github/SKILL.md");
    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("uses agents.list[].skills as a full replacement for defaults", () => {
    const inheritedEntry: SkillEntry = {
      skill: createFixtureSkill({
        name: "weather",
        description: "Weather",
        filePath: "/app/skills/weather/SKILL.md",
        baseDir: "/app/skills/weather",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const explicitEntry: SkillEntry = {
      skill: createFixtureSkill({
        name: "docs-search",
        description: "Docs",
        filePath: "/app/skills/docs-search/SKILL.md",
        baseDir: "/app/skills/docs-search",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [inheritedEntry, explicitEntry],
      config: {
        agents: {
          defaults: {
            skills: ["weather"],
          },
          list: [{ id: "writer", skills: ["docs-search"] }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).not.toContain("/app/skills/weather/SKILL.md");
    expect(prompt).toContain("/app/skills/docs-search/SKILL.md");
  });
});

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation?: boolean;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}
