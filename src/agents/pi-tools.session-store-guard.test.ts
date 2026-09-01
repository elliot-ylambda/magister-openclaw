import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNotAgentSessionStorePath,
  isAgentSessionStorePath,
  wrapToolSessionStoreGuard,
} from "./pi-tools.session-store-guard.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function recordingTool(): { tool: AnyAgentTool; calls: unknown[] } {
  const calls: unknown[] = [];
  const tool = {
    name: "read",
    description: "test read tool",
    parameters: { type: "object", properties: {} },
    execute: async (_toolCallId: string, args: unknown) => {
      calls.push(args);
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  } as unknown as AnyAgentTool;
  return { tool, calls };
}

describe("agent session store guard", () => {
  let tmpDir = "";
  let stateDir = "";
  let workspace = "";
  let env: NodeJS.ProcessEnv;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  async function setup() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-guard-"));
    stateDir = path.join(tmpDir, "state");
    workspace = path.join(stateDir, "workspace");
    await fs.mkdir(path.join(stateDir, "agents", "marketing", "sessions"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "agents", "marketing", "sessions", "abc.jsonl"),
      "{}\n",
      "utf8",
    );
    await fs.writeFile(path.join(workspace, "notes.md"), "notes", "utf8");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  }

  it("recognizes every agent's sessions directory and nothing else under the state root", async () => {
    await setup();
    const store = (agent: string, rest: string) =>
      path.join(stateDir, "agents", agent, "sessions", rest);
    expect(isAgentSessionStorePath(store("marketing", "abc.jsonl"), env)).toBe(true);
    expect(isAgentSessionStorePath(store("main", "sessions.json"), env)).toBe(true);
    expect(
      isAgentSessionStorePath(store("main", "abc.jsonl.deleted.2026-09-01T04-56-03.442Z"), env),
    ).toBe(true);
    expect(isAgentSessionStorePath(store("main", path.join("nested", "x.jsonl")), env)).toBe(true);
    expect(isAgentSessionStorePath(path.join(stateDir, "agents", "main", "sessions"), env)).toBe(
      true,
    );

    expect(isAgentSessionStorePath(path.join(workspace, "notes.md"), env)).toBe(false);
    expect(isAgentSessionStorePath(path.join(stateDir, "agents", "main", "agent.json"), env)).toBe(
      false,
    );
    expect(isAgentSessionStorePath(path.join(stateDir, "agents"), env)).toBe(false);
    expect(isAgentSessionStorePath(path.join(stateDir, "openclaw.json"), env)).toBe(false);
    expect(isAgentSessionStorePath(path.join(tmpDir, "elsewhere", "sessions", "x"), env)).toBe(
      false,
    );
  });

  it("refuses the store by absolute, relative, and tilde-free paths and lets workspace paths through", async () => {
    await setup();
    const { tool, calls } = recordingTool();
    const guarded = wrapToolSessionStoreGuard(tool, workspace, { env });

    await expect(
      guarded.execute(
        "call-1",
        { path: path.join(stateDir, "agents", "marketing", "sessions", "abc.jsonl") },
        undefined as never,
        undefined as never,
      ),
    ).rejects.toThrow(/agent session store/);
    await expect(
      guarded.execute(
        "call-2",
        { path: path.join("..", "agents", "marketing", "sessions", "abc.jsonl") },
        undefined as never,
        undefined as never,
      ),
    ).rejects.toThrow(/sessions_history/);
    expect(calls).toHaveLength(0);

    await guarded.execute("call-3", { path: "notes.md" }, undefined as never, undefined as never);
    await guarded.execute(
      "call-4",
      { path: path.join(workspace, "notes.md") },
      undefined as never,
      undefined as never,
    );
    expect(calls).toHaveLength(2);
  });

  it.runIf(process.platform !== "win32")(
    "sees through a symlink planted in the workspace",
    async () => {
      await setup();
      const link = path.join(workspace, "innocent.jsonl");
      await fs.symlink(path.join(stateDir, "agents", "marketing", "sessions", "abc.jsonl"), link);
      await expect(
        assertNotAgentSessionStorePath({ filePath: link, cwd: workspace, env }),
      ).rejects.toThrow(/agent session store/);
    },
  );

  it("guards every configured path parameter and ignores missing ones", async () => {
    await setup();
    const { tool, calls } = recordingTool();
    const guarded = wrapToolSessionStoreGuard(tool, workspace, {
      env,
      pathParamKeys: ["path", "target"],
    });
    await expect(
      guarded.execute(
        "call-1",
        { path: "notes.md", target: path.join(stateDir, "agents", "main", "sessions", "s.json") },
        undefined as never,
        undefined as never,
      ),
    ).rejects.toThrow(/agent session store/);
    await guarded.execute("call-2", { path: "notes.md" }, undefined as never, undefined as never);
    expect(calls).toHaveLength(1);
  });
});
