import { describe, expect, it } from "vitest";
import { SUBAGENT_SPAWN_ACCEPTED_NOTE } from "./subagent-spawn-accepted-note.js";
import { describeSessionsSpawnTool } from "./tool-description-presets.js";

// A spawned child's output never returns to the tool call — unlike every
// other tool. A model that does not know this delegates the current reply's
// deliverable to a child, ends its turn with a status line, and the answer
// lands after the turn (or nowhere). The description must state the
// fire-and-forget contract at the decision point for every interactive
// variant — and must NOT state it for cron isolated sessions, where the agent
// turn is the whole run and child results are collected inside it.
const CONTRACT =
  "cannot appear in the reply you are composing now; never spawn for work the current reply must contain";
const ACP_LINE = 'runtime="acp"` is for external ACP harness ids';
const INHERIT_LINE = "Subagents inherit the parent workspace directory automatically.";
const FORK_LINE = 'For native subagents only, set `context="fork"`';
const CRON_USE_LINE =
  "Use this when the work should happen in a fresh child session instead of the current one.";

describe("sessions_spawn description: fire-and-forget contract", () => {
  const interactiveVariants = [
    describeSessionsSpawnTool(),
    describeSessionsSpawnTool({ acpAvailable: false }),
    describeSessionsSpawnTool({ acpAvailable: true, threadAvailable: true }),
    describeSessionsSpawnTool({ acpAvailable: false, threadAvailable: true }),
    describeSessionsSpawnTool({ foregroundReply: true }),
  ];

  it("states the contract in every interactive variant", () => {
    for (const description of interactiveVariants) {
      expect(description).toContain(CONTRACT);
      expect(description).toContain(
        "background side work the user is not waiting on in this reply",
      );
      expect(description).not.toContain(CRON_USE_LINE);
    }
  });

  it("keeps the cron in-turn protocol: no foreground contract for cron isolated sessions", () => {
    const cronVariants = [
      describeSessionsSpawnTool({ foregroundReply: false }),
      describeSessionsSpawnTool({
        acpAvailable: false,
        threadAvailable: true,
        foregroundReply: false,
      }),
    ];
    for (const description of cronVariants) {
      expect(description).not.toContain("reply you are composing");
      expect(description).not.toContain("not waiting on in this reply");
      expect(description).toContain(CRON_USE_LINE);
      expect(description).toContain(INHERIT_LINE);
      expect(description).toContain(FORK_LINE);
    }
  });

  it("orders the acp runtime guidance between the workspace and fork lines, only when acp is available", () => {
    const withAcp = describeSessionsSpawnTool({ acpAvailable: true });
    expect(withAcp).toContain('`runtime="subagent"` or `runtime="acp"`');
    const acpAt = withAcp.indexOf(ACP_LINE);
    expect(acpAt).toBeGreaterThan(withAcp.indexOf(INHERIT_LINE));
    expect(acpAt).toBeLessThan(withAcp.indexOf(FORK_LINE));
    expect(withAcp.indexOf(CONTRACT)).toBeLessThan(withAcp.indexOf(INHERIT_LINE));

    const withoutAcp = describeSessionsSpawnTool({ acpAvailable: false });
    expect(withoutAcp).toContain("with the native subagent runtime.");
    expect(withoutAcp).not.toContain("external ACP harness ids");
    expect(withoutAcp).not.toContain('runtime="acp"');
  });
});

describe("sessions_spawn accepted note: one rule and a callable recovery", () => {
  it("restates only the clause the recovery depends on and names a callable kill form", () => {
    // `subagents(action="kill")` without a target throws ToolInputError; the
    // note must name a form the model can call verbatim.
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain('subagents(action="kill", target="last")');
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain(
      "can never reach the reply you are composing now",
    );
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain("what is running and that results will follow");
    // The retained yield-and-wait flow must not read as "the final answer
    // depends on the child" — that is the delegation the contract forbids.
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).not.toContain("final answer");
    expect(SUBAGENT_SPAWN_ACCEPTED_NOTE).toContain("NO_REPLY");
  });
});
