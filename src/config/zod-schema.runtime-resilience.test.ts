import { describe, expect, it } from "vitest";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema tools.loopDetection.runtimeResilience validation", () => {
  it("accepts a complete runtime resilience configuration", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          enabled: false,
          runtimeResilience: {
            enabled: true,
            failureWarningThreshold: 2,
            failureBlockThreshold: 5,
            denialBlockThreshold: 3,
            browserLaunchLimit: 10,
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts an empty runtime resilience object with safe defaults", () => {
    const result = ToolsSchema.safeParse({
      loopDetection: { runtimeResilience: {} },
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown runtime resilience keys", () => {
    const result = ToolsSchema.safeParse({
      loopDetection: {
        runtimeResilience: { enabled: true, unexpected: 1 },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-positive and non-integer thresholds", () => {
    expect(
      ToolsSchema.safeParse({
        loopDetection: { runtimeResilience: { denialBlockThreshold: 0 } },
      }).success,
    ).toBe(false);
    expect(
      ToolsSchema.safeParse({
        loopDetection: { runtimeResilience: { browserLaunchLimit: 1.5 } },
      }).success,
    ).toBe(false);
  });

  it("requires the guidance threshold to stay below the block threshold", () => {
    expect(
      ToolsSchema.safeParse({
        loopDetection: {
          runtimeResilience: {
            failureWarningThreshold: 5,
            failureBlockThreshold: 5,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ToolsSchema.safeParse({
        loopDetection: { runtimeResilience: { failureBlockThreshold: 2 } },
      }).success,
    ).toBe(false);
  });
});
