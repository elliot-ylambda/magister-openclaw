import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { getToolParamsRecord } from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { resolveSandboxInputPath } from "./sandbox-paths.js";

/**
 * The agent's own transcript store — `<state>/agents/<id>/sessions/` — holds
 * every session transcript, the deleted-transcript archive, trajectory
 * recordings, and the sessions.json index. No file tool has a legitimate use
 * for it: the agent's own transcript is already its context, and reading it
 * page by page copies each page into the transcript that the next page then
 * contains. On 2026-08-31 and 2026-09-01 an agent hunting for a CSV it had
 * been given inline did exactly that (47 and 75 self-reads), growing one turn
 * from 150k to 520k tokens and ending in the context-overflow terminal.
 * Another session's history has a tool with sane limits (sessions_history);
 * a write here would corrupt the store.
 */
function isUnderSessionsDir(agentsRoot: string, candidate: string): boolean {
  const relative = path.relative(agentsRoot, path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const segments = relative.split(path.sep);
  return segments.length >= 2 && segments[1] === "sessions";
}

export function isAgentSessionStorePath(
  absolutePath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isUnderSessionsDir(path.resolve(resolveStateDir(env), "agents"), absolutePath);
}

async function realpathOrSelf(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    // Not existing yet (a write) or unreadable: the lexical path is all there is.
    return candidate;
  }
}

export async function assertNotAgentSessionStorePath(params: {
  filePath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const resolved = resolveSandboxInputPath(params.filePath, params.cwd);
  // Compare real paths on both sides: a symlink planted in a writable
  // directory would otherwise name the store by a path the lexical check
  // cannot see, and the state root itself may sit behind a symlink.
  const lexicalRoot = path.resolve(resolveStateDir(params.env), "agents");
  const roots = new Set([lexicalRoot, await realpathOrSelf(lexicalRoot)]);
  const candidates = new Set([resolved, await realpathOrSelf(resolved)]);
  for (const root of roots) {
    for (const candidate of candidates) {
      if (isUnderSessionsDir(root, candidate)) {
        throw new Error(
          `${params.filePath} is inside the agent session store, which the file tools never ` +
            "read or write: your own transcript is already your context, and another " +
            "session's history is available through sessions_history.",
        );
      }
    }
  }
}

export function wrapToolSessionStoreGuard(
  tool: AnyAgentTool,
  root: string,
  options?: { pathParamKeys?: readonly string[]; env?: NodeJS.ProcessEnv },
): AnyAgentTool {
  const pathParamKeys =
    options?.pathParamKeys && options.pathParamKeys.length > 0 ? options.pathParamKeys : ["path"];
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const record = getToolParamsRecord(args);
      for (const key of pathParamKeys) {
        const filePath = record?.[key];
        if (typeof filePath !== "string" || !filePath.trim()) {
          continue;
        }
        await assertNotAgentSessionStorePath({ filePath, cwd: root, env: options?.env });
      }
      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}
