/**
 * Global Plugin Hook Runner
 *
 * Singleton hook runner that's initialized when plugins are loaded
 * and can be called from anywhere in the codebase.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { PluginHookGatewayContext, PluginHookGatewayStopEvent } from "./hook-types.js";
import { createHookRunner, type HookRunner } from "./hooks.js";

type HookRunnerGlobalState = {
  hookRunner: HookRunner | null;
  registry: GlobalHookRunnerRegistry | null;
  registryPinned: boolean;
};

const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");
const getState = () =>
  resolveGlobalSingleton<HookRunnerGlobalState>(hookRunnerGlobalStateKey, () => ({
    hookRunner: null,
    registry: null,
    registryPinned: false,
  }));

const getLog = () => createSubsystemLogger("plugins");

/**
 * Initialize the global hook runner with a plugin registry.
 * Called once when plugins are loaded during gateway startup.
 */
function installGlobalHookRunner(registry: GlobalHookRunnerRegistry): void {
  const state = getState();
  const log = getLog();
  state.registry = registry;
  state.hookRunner = createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
    failurePolicyByHook: {
      before_tool_call: "fail-closed",
    },
  });

  const hookCount = registry.hooks.length;
  if (hookCount > 0) {
    log.debug(`hook runner initialized with ${hookCount} registered hooks`);
  }
}

export function initializeGlobalHookRunner(registry: GlobalHookRunnerRegistry): void {
  const state = getState();
  if (state.registryPinned && state.registry !== registry) {
    return;
  }
  installGlobalHookRunner(registry);
}

/**
 * Keep the gateway's hook registry authoritative across later plugin loads.
 *
 * Tool and binding discovery can activate other registries after gateway
 * startup. Those registries must not replace lifecycle hooks that own durable
 * completion callbacks. Gateway reloads call this again with their new
 * registry, which deliberately advances the pin.
 */
export function pinGlobalHookRunnerRegistry(registry: GlobalHookRunnerRegistry): void {
  installGlobalHookRunner(registry);
  getState().registryPinned = true;
}

/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner(): HookRunner | null {
  return getState().hookRunner;
}

/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalPluginRegistry(): GlobalHookRunnerRegistry | null {
  return getState().registry;
}

/**
 * Check if any hooks are registered for a given hook name.
 */
export function hasGlobalHooks(hookName: Parameters<HookRunner["hasHooks"]>[0]): boolean {
  return getState().hookRunner?.hasHooks(hookName) ?? false;
}

export async function runGlobalGatewayStopSafely(params: {
  event: PluginHookGatewayStopEvent;
  ctx: PluginHookGatewayContext;
  onError?: (err: unknown) => void;
}): Promise<void> {
  const log = getLog();
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("gateway_stop")) {
    return;
  }
  try {
    await hookRunner.runGatewayStop(params.event, params.ctx);
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    log.warn(`gateway_stop hook failed: ${String(err)}`);
  }
}

/**
 * Reset the global hook runner (for testing).
 */
export function resetGlobalHookRunner(): void {
  const state = getState();
  state.hookRunner = null;
  state.registry = null;
  state.registryPinned = false;
}
