import { isCronSessionKey } from "../routing/session-key.js";

// One rule, stated after the spawn: the child's output cannot reach the reply
// being composed, so either the reply does not depend on it or the spawn was
// wrong and must be undone. The full contract lives in the sessions_spawn
// description; this note only restates the clause the recovery depends on.
export const SUBAGENT_SPAWN_ACCEPTED_NOTE = [
  "Auto-announce is push-based: do NOT poll for children (no sessions_list, sessions_history, exec sleep, or similar).",
  'A child\'s output can never reach the reply you are composing now. If the user\'s current request needs it in THIS reply, you delegated wrongly: call subagents(action="kill", target="last") and do the work inline.',
  "Otherwise state in this reply what is running and that results will follow, then end the turn (sessions_yield).",
  "Completion events arrive later as user messages (track expected child session keys): reply once with a synthesized update after ALL expected completions arrive, and reply ONLY with NO_REPLY to any completion event after that.",
].join(" ");
export const SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound session stays active after this task; continue in-thread for follow-ups.";

export function resolveSubagentSpawnAcceptedNote(params: {
  spawnMode: "run" | "session";
  agentSessionKey?: string;
}): string | undefined {
  if (params.spawnMode === "session") {
    return SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE;
  }
  return isCronSessionKey(params.agentSessionKey) ? undefined : SUBAGENT_SPAWN_ACCEPTED_NOTE;
}
