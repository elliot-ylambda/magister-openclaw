import { describe, expect, it } from "vitest";
import { describeSessionsSpawnTool } from "./tool-description-presets.js";

// A spawned child's output never returns to the tool call — unlike every
// other tool. A model that does not know this delegates the current reply's
// deliverable to a child, ends its turn with a status line, and the answer
// lands after the turn (or nowhere). The description must state the
// fire-and-forget contract at the decision point, in every variant.
describe("sessions_spawn description: fire-and-forget contract", () => {
  const variants = [
    describeSessionsSpawnTool(),
    describeSessionsSpawnTool({ acpAvailable: false }),
    describeSessionsSpawnTool({ acpAvailable: true, threadAvailable: true }),
    describeSessionsSpawnTool({ acpAvailable: false, threadAvailable: true }),
  ];

  it("states that child output cannot reach the current reply", () => {
    for (const description of variants) {
      expect(description).toContain("can never appear in the reply you are composing now");
      expect(description).toContain(
        "Never spawn for work the current reply must contain - do that work inline yourself.",
      );
    }
  });

  it("scopes the use-this-when guidance to background work", () => {
    for (const description of variants) {
      expect(description).toContain("background or long-running side work");
    }
  });

  it("keeps the acp runtime guidance when acp is available", () => {
    expect(describeSessionsSpawnTool({ acpAvailable: true })).toContain(
      'runtime="acp"` is for external ACP harness ids',
    );
    expect(describeSessionsSpawnTool({ acpAvailable: false })).not.toContain(
      "external ACP harness ids",
    );
  });
});
