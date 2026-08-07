import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getRootSessionKeyFromSessionStore,
  getSubagentDepthFromSessionStore,
} from "./subagent-depth.js";
import { resolveAgentTimeoutMs, resolveAgentTimeoutSeconds } from "./timeout.js";

describe("getSubagentDepthFromSessionStore", () => {
  it("uses spawnDepth from the session store when available", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: { spawnDepth: 2 },
      },
    });
    expect(depth).toBe(2);
  });

  it("derives depth from spawnedBy ancestry when spawnDepth is missing", () => {
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionStore(key3, {
      store: {
        [key1]: { spawnedBy: "agent:main:main" },
        [key2]: { spawnedBy: key1 },
        [key3]: { spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves depth when caller is identified by sessionId", () => {
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionStore("subagent-three-session", {
      store: {
        [key1]: { sessionId: "subagent-one-session", spawnedBy: "agent:main:main" },
        [key2]: { sessionId: "subagent-two-session", spawnedBy: key1 },
        [key3]: { sessionId: "subagent-three-session", spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves prefixed store keys when caller key omits the agent prefix", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-depth-"));
    const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
    const prefixedKey = "agent:main:subagent:flat";
    const storePath = storeTemplate.replaceAll("{agentId}", "main");
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [prefixedKey]: {
            sessionId: "subagent-flat",
            updatedAt: Date.now(),
            spawnDepth: 2,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const depth = getSubagentDepthFromSessionStore("subagent:flat", {
      cfg: {
        session: {
          store: storeTemplate,
        },
      },
    });

    expect(depth).toBe(2);
  });

  it("accepts JSON5 syntax in the on-disk depth store for backward compatibility", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-depth-json5-"));
    const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
    const storePath = storeTemplate.replaceAll("{agentId}", "main");
    fs.writeFileSync(
      storePath,
      `{
        // hand-edited legacy store
        "agent:main:subagent:flat": {
          sessionId: "subagent-flat",
          spawnDepth: 2,
        },
      }`,
      "utf-8",
    );

    const depth = getSubagentDepthFromSessionStore("subagent:flat", {
      cfg: {
        session: {
          store: storeTemplate,
        },
      },
    });

    expect(depth).toBe(2);
  });

  it("falls back to session-key segment counting when metadata is missing", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: {},
      },
    });
    expect(depth).toBe(1);
  });
});

describe("getRootSessionKeyFromSessionStore", () => {
  it("returns the direct session key when it has no parent", () => {
    const key = "agent:marketing:webchat:session-123";

    expect(getRootSessionKeyFromSessionStore(key, { store: { [key]: {} } })).toBe(key);
  });

  it("walks nested spawnedBy lineage to the owning web chat", () => {
    const root = "agent:marketing:webchat:session-123";
    const parent = "agent:marketing:subagent:parent";
    const child = "agent:marketing:subagent:child";

    expect(
      getRootSessionKeyFromSessionStore(child, {
        store: {
          [root]: {},
          [parent]: { spawnedBy: root },
          [child]: { spawnedBy: parent },
        },
      }),
    ).toBe(root);
  });

  it("falls back to agent-specific stores for cross-agent lineage", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-root-"));
    const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
    const root = "agent:marketing:webchat:session-123";
    const child = "agent:research:subagent:child";
    fs.writeFileSync(
      storeTemplate.replaceAll("{agentId}", "marketing"),
      JSON.stringify({ [root]: {} }),
      "utf-8",
    );
    fs.writeFileSync(
      storeTemplate.replaceAll("{agentId}", "research"),
      JSON.stringify({ [child]: { spawnedBy: root } }),
      "utf-8",
    );

    expect(
      getRootSessionKeyFromSessionStore(child, {
        cfg: { session: { store: storeTemplate } },
      }),
    ).toBe(root);
  });

  it("fails closed to the current key when lineage is cyclic", () => {
    const parent = "agent:marketing:subagent:parent";
    const child = "agent:marketing:subagent:child";

    expect(
      getRootSessionKeyFromSessionStore(child, {
        store: {
          [parent]: { spawnedBy: child },
          [child]: { spawnedBy: parent },
        },
      }),
    ).toBe(child);
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("defaults to 48 hours when config does not override the timeout", () => {
    expect(resolveAgentTimeoutSeconds()).toBe(48 * 60 * 60);
    expect(resolveAgentTimeoutMs({})).toBe(48 * 60 * 60 * 1000);
  });

  it("uses a timer-safe sentinel for no-timeout overrides", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(2_147_000_000);
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(2_147_000_000);
  });

  it("clamps very large timeout overrides to timer-safe values", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 9_999_999 })).toBe(2_147_000_000);
    expect(resolveAgentTimeoutMs({ overrideMs: 9_999_999_999 })).toBe(2_147_000_000);
  });
});
