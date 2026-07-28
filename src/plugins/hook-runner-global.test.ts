import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

async function importHookRunnerGlobalModule() {
  return import("./hook-runner-global.js");
}

async function expectGlobalRunnerState(expected: { hasRunner: boolean; registry?: unknown }) {
  const mod = await importHookRunnerGlobalModule();
  expect(mod.getGlobalHookRunner() === null).toBe(!expected.hasRunner);
  if ("registry" in expected) {
    expect(mod.getGlobalPluginRegistry()).toBe(expected.registry ?? null);
  }
  return mod;
}

afterEach(async () => {
  const mod = await importHookRunnerGlobalModule();
  mod.resetGlobalHookRunner();
});

describe("hook-runner-global", () => {
  async function createInitializedModule() {
    const modA = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);
    modA.initializeGlobalHookRunner(registry);
    return { modA, registry };
  }

  it("preserves the initialized runner across module reloads", async () => {
    const { modA, registry } = await createInitializedModule();
    expect(modA.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);

    vi.resetModules();

    const modB = await expectGlobalRunnerState({ hasRunner: true, registry });
    expect(modB.getGlobalHookRunner()).not.toBeNull();
    expect(modB.getGlobalHookRunner()?.hasHooks("message_received")).toBe(true);
  });

  it("clears the shared state across module reloads", async () => {
    await createInitializedModule();

    vi.resetModules();

    const modB = await expectGlobalRunnerState({ hasRunner: true });
    modB.resetGlobalHookRunner();
    expect(modB.getGlobalHookRunner()).toBeNull();
    expect(modB.getGlobalPluginRegistry()).toBeNull();

    vi.resetModules();

    await expectGlobalRunnerState({ hasRunner: false });
  });

  it("keeps pinned gateway lifecycle hooks across later registry initialization", async () => {
    const mod = await importHookRunnerGlobalModule();
    const agentEnd = vi.fn();
    const gatewayRegistry = createMockPluginRegistry([
      { hookName: "agent_end", handler: agentEnd },
    ]);
    const laterRegistry = createMockPluginRegistry([
      { hookName: "message_received", handler: vi.fn() },
    ]);

    mod.pinGlobalHookRunnerRegistry(gatewayRegistry);
    mod.initializeGlobalHookRunner(laterRegistry);

    expect(mod.getGlobalPluginRegistry()).toBe(gatewayRegistry);
    expect(mod.getGlobalHookRunner()?.hasHooks("agent_end")).toBe(true);
    expect(mod.getGlobalHookRunner()?.hasHooks("message_received")).toBe(false);

    await mod.getGlobalHookRunner()?.runAgentEnd(
      { messages: [], success: true },
      {
        runId: "run-1",
        agentId: "marketing",
        sessionKey: "agent:marketing:slack:channel:c1",
      },
    );

    expect(agentEnd).toHaveBeenCalledOnce();
  });
});
