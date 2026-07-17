import { describe, expect, it } from "vitest";
import {
  prependSystemPromptAdditionAfterCacheBoundary,
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "./system-prompt-cache-boundary.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("system prompt cache boundary helpers", () => {
  it("splits stable and dynamic prompt regions", () => {
    expect(
      splitSystemPromptCacheBoundary(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`),
    ).toEqual({
      stablePrefix: "Stable prefix",
      dynamicSuffix: "Dynamic suffix",
    });
  });

  it("strips the internal marker from prompt text", () => {
    expect(
      stripSystemPromptCacheBoundary(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`),
    ).toBe("Stable prefix\nDynamic suffix");
  });

  it("inserts prompt additions after the cache boundary", () => {
    expect(
      prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        systemPromptAddition: "Per-turn lab context",
      }),
    ).toBe(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Per-turn lab context\n\nDynamic suffix`);
  });

  it("normalizes structured additions and dynamic suffix whitespace", () => {
    expect(
      prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix  \r\n\r\nMore detail \t\r\n`,
        systemPromptAddition: "  Per-turn lab context \r\nSecond line\t\r\n",
      }),
    ).toBe(
      `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Per-turn lab context\nSecond line\n\nDynamic suffix\n\nMore detail`,
    );
  });

  it("places the complete skills catalog in the stable prefix and hints below the boundary", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/data/.openclaw/workspace",
      toolNames: ["exec", "message"],
      skillsPrompt: "Task-selected skill hints for the current request follow.",
      skillsCatalogPrompt: "<available_skills>CATALOG_SENTINEL</available_skills>",
      contextFiles: [{ path: "AGENTS.md", content: "Static platform policy" }],
      runtimeInfo: { channel: "webchat", capabilities: ["inlineButtons"] },
    });
    const split = splitSystemPromptCacheBoundary(prompt);
    expect(split).toBeDefined();
    expect(split?.stablePrefix).toContain("CATALOG_SENTINEL");
    expect(split?.stablePrefix).toContain("## Skills catalog (complete)");
    expect(split?.dynamicSuffix).not.toContain("CATALOG_SENTINEL");
    expect(split?.dynamicSuffix).toContain("Task-selected skill hints");
    expect(split?.stablePrefix).not.toContain("Task-selected skill hints");
  });

  it("keys the memoized stable prefix on the skills catalog", () => {
    const build = (catalog: string) =>
      buildAgentSystemPrompt({
        workspaceDir: "/data/.openclaw/workspace",
        toolNames: ["exec", "message"],
        skillsCatalogPrompt: catalog,
        contextFiles: [{ path: "AGENTS.md", content: "Static platform policy" }],
        runtimeInfo: { channel: "webchat", capabilities: ["inlineButtons"] },
      });
    const first = splitSystemPromptCacheBoundary(
      build("<available_skills>CATALOG_A</available_skills>"),
    );
    const second = splitSystemPromptCacheBoundary(
      build("<available_skills>CATALOG_B</available_skills>"),
    );
    expect(first?.stablePrefix).toContain("CATALOG_A");
    expect(second?.stablePrefix).toContain("CATALOG_B");
    expect(second?.stablePrefix).not.toContain("CATALOG_A");
  });

  it("keeps channel, task-selected skills, and project state out of stable bytes", () => {
    const build = (params: { channel: string; skillsPrompt: string }) =>
      buildAgentSystemPrompt({
        workspaceDir: "/data/.openclaw/workspace",
        toolNames: ["exec", "message", "sessions_spawn"],
        skillsPrompt: params.skillsPrompt,
        contextFiles: [
          { path: "AGENTS.md", content: "Static platform policy" },
          { path: "TOOLS.md", content: "Static capability router" },
        ],
        runtimeInfo: {
          channel: params.channel,
          capabilities:
            params.channel === "webchat" ? ["inlineButtons"] : ["threadbound-acp-spawn"],
        },
      });

    const webchat = splitSystemPromptCacheBoundary(
      build({ channel: "webchat", skillsPrompt: "SEO task-selected hint" }),
    );
    const slack = splitSystemPromptCacheBoundary(
      build({ channel: "slack", skillsPrompt: "Email task-selected hint" }),
    );
    expect(webchat).toBeDefined();
    expect(slack).toBeDefined();
    expect(webchat?.stablePrefix).toBe(slack?.stablePrefix);
    expect(webchat?.dynamicSuffix).toContain("SEO task-selected hint");
    expect(webchat?.dynamicSuffix).toContain("Webchat supports canonical `<json-render>`");
    expect(webchat?.dynamicSuffix).toContain("Default to one minimal JSON-render block");
    expect(webchat?.dynamicSuffix).toContain("2–5 concrete choices");
    expect(webchat?.dynamicSuffix).toContain("up to three short non-sensitive fields");
    expect(webchat?.dynamicSuffix).toContain("never bypass approval requirements");
    expect(webchat?.dynamicSuffix).not.toContain("This channel does not render JSON-render");
    expect(slack?.dynamicSuffix).toContain("Email task-selected hint");
    expect(slack?.dynamicSuffix).toContain("Never emit `<json-render>`");
    expect(slack?.dynamicSuffix).not.toContain("Default to one minimal JSON-render block");

    const stable = webchat!.stablePrefix;
    for (const addition of [
      "Current plan v2",
      "Workflow list changed",
      "Integration readiness changed",
    ]) {
      const composed = prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: build({ channel: "webchat", skillsPrompt: "SEO task-selected hint" }),
        systemPromptAddition: addition,
      });
      expect(splitSystemPromptCacheBoundary(composed)?.stablePrefix).toBe(stable);
      expect(splitSystemPromptCacheBoundary(composed)?.dynamicSuffix).toContain(addition);
    }
  });
});
