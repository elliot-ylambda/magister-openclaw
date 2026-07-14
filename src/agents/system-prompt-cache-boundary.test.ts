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
    expect(webchat?.dynamicSuffix).toContain("Webchat may emit canonical");
    expect(slack?.dynamicSuffix).toContain("Email task-selected hint");
    expect(slack?.dynamicSuffix).toContain("Never emit `<json-render>`");

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
