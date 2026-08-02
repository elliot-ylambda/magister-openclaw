import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  resetDiagnosticTraceContextForTest,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";
import { withTempConfig } from "./test-temp-config.js";

const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };

async function listen(server: ReturnType<typeof createGatewayHttpServer>): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function closeServer(server: ReturnType<typeof createGatewayHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

afterEach(() => {
  resetDiagnosticEventsForTest();
  resetDiagnosticTraceContextForTest();
  setLoggerOverride(null);
  resetLogger();
});

describe("gateway HTTP request trace scope", () => {
  it("emits a content-free diagnostic for an unhandled HTTP request failure", async () => {
    const events: unknown[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const httpServer = createGatewayHttpServer({
      canvasHost: null,
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "/__control__",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      resolvedAuth,
      getRuntimeConfig: () => {
        throw new Error("private config content");
      },
    });

    const port = await listen(httpServer);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/broken`);
      expect(response.status).toBe(500);
    } finally {
      await closeServer(httpServer);
      stop();
      consoleError.mockRestore();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "http.request.error",
      surface: "gateway_http",
      failureKind: "unhandled_exception",
    });
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("threads active request trace through logs and diagnostics", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-request-trace-"));
    const logPath = path.join(dir, "gateway.log");
    const events: Array<{ trace?: DiagnosticTraceContext; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ trace: event.trace, type: event.type });
    });
    let activeTraceInHandler: DiagnosticTraceContext | undefined;

    await withTempConfig({
      cfg: { gateway: { auth: { mode: "none" } } },
      run: async () => {
        setLoggerOverride({ level: "info", file: logPath });
        const httpServer = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async (_req, res) => {
            activeTraceInHandler = getActiveDiagnosticTraceContext();
            getLogger().info({ route: "/hook" }, "handled request trace");
            emitDiagnosticEvent({ type: "message.queued", source: "gateway-test" });
            res.statusCode = 204;
            res.end();
            return true;
          },
          resolvedAuth,
        });
        const port = await listen(httpServer);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/hook`);
          expect(response.status).toBe(204);
        } finally {
          await closeServer(httpServer);
        }
      },
    });

    stop();
    try {
      expect(activeTraceInHandler?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(activeTraceInHandler?.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(events).toEqual([{ trace: activeTraceInHandler, type: "message.queued" }]);

      const traceRecord = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((record) => record.message === "handled request trace");
      expect(traceRecord).toMatchObject({
        traceId: activeTraceInHandler?.traceId,
        spanId: activeTraceInHandler?.spanId,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
