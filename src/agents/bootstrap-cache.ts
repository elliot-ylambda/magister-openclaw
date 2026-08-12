import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

type BootstrapSnapshot = {
  workspaceDir: string;
  files: WorkspaceBootstrapFile[];
};

const cache = new Map<string, BootstrapSnapshot>();

function bootstrapFileListEqual(
  previous: WorkspaceBootstrapFile[],
  next: WorkspaceBootstrapFile[],
): boolean {
  if (previous.length !== next.length) {
    return false;
  }

  return previous.every((file, index) => {
    const updated = next[index];
    return (
      updated !== undefined &&
      file.name === updated.name &&
      file.path === updated.path &&
      file.missing === updated.missing
    );
  });
}

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const existing = cache.get(params.sessionKey);
  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  // Pin file CONTENT for the session; refresh only when the file LIST
  // changes (a file appears, disappears, or goes missing — e.g. BOOTSTRAP.md
  // deleted when onboarding completes). Bootstrap content is embedded in the
  // stable prefix of the system prompt, so a mid-session content edit — most
  // commonly the agent's own memory-tool write to MEMORY.md — reshapes the
  // prompt prefix on the very next request and invalidates the provider
  // prompt cache end to end (Anthropic then re-bills the entire context as a
  // cache WRITE at 1.25x input rate; OpenAI re-bills it as fresh input).
  // The agent already sees its own write via the tool result in conversation
  // history; everyone else picks the new content up on session rollover,
  // which clears this snapshot (clearBootstrapSnapshotOnSessionRollover).
  if (
    existing &&
    existing.workspaceDir === params.workspaceDir &&
    bootstrapFileListEqual(existing.files, files)
  ) {
    return existing.files;
  }

  cache.set(params.sessionKey, { workspaceDir: params.workspaceDir, files });
  return files;
}

export function clearBootstrapSnapshot(sessionKey: string): void {
  cache.delete(sessionKey);
}

export function clearBootstrapSnapshotOnSessionRollover(params: {
  sessionKey?: string;
  previousSessionId?: string;
}): void {
  if (!params.sessionKey || !params.previousSessionId) {
    return;
  }

  clearBootstrapSnapshot(params.sessionKey);
}

export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
