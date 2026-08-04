import { copyPluginToolMeta } from "../plugins/tools.js";
import { bindAbortRelay } from "../utils/fetch-timeout.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

type RunnerMarkedAbortError = Error & { openclawRunnerAborted?: boolean };

function throwAbortError(runnerAborted: boolean): never {
  const err: RunnerMarkedAbortError = new Error("Aborted");
  err.name = "AbortError";
  if (runnerAborted) {
    err.openclawRunnerAborted = true;
  }
  throw err;
}

/**
 * True when an abort-shaped error was thrown while the runner's abort signal
 * (user cancel, session reset, shutdown) was aborted — as opposed to a
 * provider/tool-internal AbortError during a live run. Lets the tool
 * definition adapter rethrow real cancels instead of logging them as tool
 * failures and feeding an error result to a model call the user stopped.
 */
export function isRunnerSignalAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "AbortError" &&
    (err as RunnerMarkedAbortError).openclawRunnerAborted === true
  );
}

/**
 * Checks if an object is a valid AbortSignal using structural typing.
 * This is more reliable than `instanceof` across different realms (VM, iframe, etc.)
 * where the AbortSignal constructor may differ.
 */
function isAbortSignal(obj: unknown): obj is AbortSignal {
  return obj instanceof AbortSignal;
}

function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) {
    return undefined;
  }
  if (a && !b) {
    return a;
  }
  if (b && !a) {
    return b;
  }
  if (a?.aborted) {
    return a;
  }
  if (b?.aborted) {
    return b;
  }
  if (typeof AbortSignal.any === "function" && isAbortSignal(a) && isAbortSignal(b)) {
    return AbortSignal.any([a, b]);
  }

  const controller = new AbortController();
  const onAbort = bindAbortRelay(controller);
  a?.addEventListener("abort", onAbort, { once: true });
  b?.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
): AnyAgentTool {
  if (!abortSignal) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const combined = combineAbortSignals(signal, abortSignal);
      if (combined?.aborted) {
        throwAbortError(abortSignal.aborted);
      }
      try {
        return await execute(toolCallId, params, combined, onUpdate);
      } catch (err) {
        if (abortSignal.aborted && err instanceof Error && err.name === "AbortError") {
          (err as RunnerMarkedAbortError).openclawRunnerAborted = true;
        }
        throw err;
      }
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  return wrappedTool;
}
