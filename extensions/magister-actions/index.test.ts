import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMagisterActionTool, nativeActionContract, parseActionEnvelope } from "./index.js";

const dir = dirname(fileURLToPath(import.meta.url));
const action = nativeActionContract.actions.find((row) => row.action === "get_brand");
if (!action) {
  throw new Error("get_brand contract missing");
}
const completionAction = nativeActionContract.actions.find(
  (row) => row.action === "submit_workflow_completion",
);
if (!completionAction) {
  throw new Error("submit_workflow_completion contract missing");
}

function api(config: Record<string, unknown> = {}) {
  return { pluginConfig: config } as unknown as Parameters<typeof createMagisterActionTool>[0];
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    operation_id: "op_12345678",
    resource_id: null,
    status: {
      state: "succeeded",
      terminal: true,
      poll_after_seconds: 0,
      stale_seconds: 0,
    },
    side_effect: "none",
    idempotency_key: null,
    receipt: { brand: null },
    artifacts: [],
    error: null,
    ...overrides,
  };
}

function resultJson(
  result: Awaited<ReturnType<ReturnType<typeof createMagisterActionTool>["execute"]>>,
) {
  const content = result.content?.[0] as { type: string; text: string } | undefined;
  return JSON.parse(content?.text ?? "null") as Record<string, unknown>;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected a string request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => {
  delete process.env.GATEWAY_TOKEN;
});

describe("Magister action manifest contract", () => {
  it("declares every generated tool exactly once", () => {
    const manifest = JSON.parse(readFileSync(join(dir, "openclaw.plugin.json"), "utf8")) as {
      contracts: { tools: string[] };
    };
    const tools = nativeActionContract.actions.map((row) => row.tool_name);
    expect(new Set(tools).size).toBe(tools.length);
    expect(manifest.contracts.tools).toEqual(tools);
  });

  it("uses strict schemas and never exposes project_id", () => {
    for (const row of nativeActionContract.actions) {
      expect(row.input_schema.additionalProperties).toBe(false);
      expect(JSON.stringify(row.input_schema)).not.toContain("project_id");
    }
  });
});

describe("typed gateway execution", () => {
  it("sends the machine token only to the fixed internal action endpoint", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    let request: { input: string; init?: RequestInit } | undefined;
    const tool = createMagisterActionTool(api(), action, async (input, init) => {
      request = { input: requestUrl(input), init };
      return new Response(JSON.stringify(envelope()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const output = resultJson(await tool.execute("call-1", {}));
    expect(output.ok).toBe(true);
    expect(request?.input).toBe(
      "http://magister-gateway.internal:8081/api/agent/actions/get_brand",
    );
    expect(request?.init?.headers).toMatchObject({
      authorization: "Bearer secret-machine-token",
    });
    expect(requestBody(request?.init)).toEqual({ arguments: {} });
  });

  it("forwards trusted workflow context without exposing it in tool arguments", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    let request: { init?: RequestInit } | undefined;
    const tool = createMagisterActionTool(
      api(),
      action,
      async (_input, init) => {
        request = { init };
        return new Response(JSON.stringify(envelope()), { status: 200 });
      },
      { sessionKey: "workflow_run:00000000-0000-4000-8000-000000000001" },
    );

    await tool.execute("call-workflow", {});
    expect(request?.init?.headers).toMatchObject({
      "x-magister-session-key": "workflow_run:00000000-0000-4000-8000-000000000001",
    });
    expect(requestBody(request?.init)).toEqual({ arguments: {} });
  });

  it("does not forward ordinary chat session keys", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    let request: { init?: RequestInit } | undefined;
    const tool = createMagisterActionTool(
      api(),
      action,
      async (_input, init) => {
        request = { init };
        return new Response(JSON.stringify(envelope()), { status: 200 });
      },
      { sessionKey: "agent:main:webchat:session-1" },
    );

    await tool.execute("call-chat", {});
    expect(request?.init?.headers).not.toHaveProperty("x-magister-session-key");
  });

  it("fails closed without a machine token", async () => {
    const tool = createMagisterActionTool(api(), action, async () => {
      throw new Error("fetch must not run");
    });
    const output = resultJson(await tool.execute("call-2", {}));
    expect(output.ok).toBe(false);
    expect((output.error as { code: string }).code).toBe("not_authorized");
  });

  it("rejects a raw legacy result instead of inferring success", async () => {
    process.env.GATEWAY_TOKEN = "token";
    const tool = createMagisterActionTool(
      api(),
      action,
      async () => new Response(JSON.stringify({ brand: { voice: "warm" } }), { status: 200 }),
    );
    const output = resultJson(await tool.execute("call-3", {}));
    expect(output.ok).toBe(false);
    expect((output.error as { code: string }).code).toBe("upstream_failed");
  });

  it("rejects an operator-configured non-internal endpoint before fetch", async () => {
    process.env.GATEWAY_TOKEN = "token";
    const tool = createMagisterActionTool(
      api({ endpoint: "https://attacker.example/api/agent/actions" }),
      action,
      async () => {
        throw new Error("fetch must not run");
      },
    );
    const output = resultJson(await tool.execute("call-4", {}));
    expect(output.ok).toBe(false);
    expect((output.error as { code: string }).code).toBe("not_authorized");
  });

  it("bounds gateway response bytes", async () => {
    process.env.GATEWAY_TOKEN = "token";
    const tool = createMagisterActionTool(
      api({ maxResponseBytes: 1024 }),
      action,
      async () => new Response("x".repeat(1025), { status: 200 }),
    );
    const output = resultJson(await tool.execute("call-5", {}));
    expect(output.ok).toBe(false);
    expect((output.error as { message: string }).message).toContain("size limit");
  });

  it("verifies and attests completion artifacts from the workspace", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    const workspace = await mkdtemp(join(tmpdir(), "magister-actions-"));
    try {
      await mkdir(join(workspace, "resources"));
      const content = "verified report\n";
      await writeFile(join(workspace, "resources", "report.md"), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const sessionKey = "workflow_run:00000000-0000-4000-8000-000000000001";
      let request: { init?: RequestInit } | undefined;
      const tool = createMagisterActionTool(
        api({ workspaceDir: workspace }),
        completionAction,
        async (_input, init) => {
          request = { init };
          return new Response(JSON.stringify(envelope()), { status: 200 });
        },
        { sessionKey },
      );
      const argumentsPayload = {
        version: 1,
        idempotency_key: "plan-task-key-1",
        verification: [
          {
            requirement: "The report exists.",
            status: "passed",
            evidence_refs: [`artifact:${sha256}`],
          },
        ],
        artifacts: [{ path: "resources/report.md", sha256, kind: "file" }],
        blocker: null,
        finding_headline: "Report completed",
        key_metrics: {},
      };

      const output = resultJson(await tool.execute("completion-1", argumentsPayload));

      expect(output.ok).toBe(true);
      expect(requestBody(request?.init)).toEqual({ arguments: argumentsPayload });
      const manifest = [["resources/report.md", sha256, "file"]];
      const expected = createHmac("sha256", "secret-machine-token")
        .update(`${sessionKey}\n${JSON.stringify(manifest)}`)
        .digest("hex");
      expect(request?.init?.headers).toMatchObject({
        "x-magister-artifact-attestation": `v1=${expected}`,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a completion artifact whose bytes do not match its hash", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    const workspace = await mkdtemp(join(tmpdir(), "magister-actions-"));
    try {
      await mkdir(join(workspace, "resources"));
      await writeFile(join(workspace, "resources", "report.md"), "actual bytes\n");
      let fetched = false;
      const tool = createMagisterActionTool(
        api({ workspaceDir: workspace }),
        completionAction,
        async () => {
          fetched = true;
          return new Response(JSON.stringify(envelope()), { status: 200 });
        },
        { sessionKey: "workflow_run:00000000-0000-4000-8000-000000000001" },
      );

      const output = resultJson(
        await tool.execute("completion-2", {
          artifacts: [{ path: "resources/report.md", sha256: "a".repeat(64), kind: "file" }],
        }),
      );

      expect(output.ok).toBe(false);
      expect((output.error as { code: string }).code).toBe("validation_error");
      expect((output.error as { message: string }).message).toContain("hash mismatch");
      expect(fetched).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("envelope validator", () => {
  it("accepts the complete closed contract", () => {
    expect(parseActionEnvelope(envelope())).not.toBeNull();
  });

  it("rejects success with an error and unknown side effects", () => {
    expect(parseActionEnvelope(envelope({ error: { code: "conflict" } }))).toBeNull();
    expect(parseActionEnvelope(envelope({ side_effect: "root_shell" }))).toBeNull();
  });
});
