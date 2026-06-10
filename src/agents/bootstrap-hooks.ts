import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentBootstrapHookContext } from "../hooks/internal-hooks.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function bootstrapFileSignature(file: WorkspaceBootstrapFile): string {
  return JSON.stringify({
    name: file.name,
    path: file.path,
    content: file.content,
    missing: file.missing,
  });
}

function buildBootstrapFileSignatureMap(files: WorkspaceBootstrapFile[]): Map<string, string> {
  const signatures = new Map<string, string>();
  for (const file of files) {
    signatures.set(`${file.name}\u0000${file.path}`, bootstrapFileSignature(file));
  }
  return signatures;
}

function markHookProvidedBootstrapFiles(params: {
  originalSignatures: Map<string, string>;
  updated: WorkspaceBootstrapFile[];
}): WorkspaceBootstrapFile[] {
  return params.updated.map((file) => {
    const key = `${file.name}\u0000${file.path}`;
    const unchangedWorkspaceFile =
      params.originalSignatures.get(key) === bootstrapFileSignature(file);
    if (unchangedWorkspaceFile) {
      return file.source === "workspace" ? file : { ...file, source: "workspace" };
    }
    return { ...file, source: "hook" };
  });
}

export async function applyBootstrapHookOverrides(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const originalSignatures = buildBootstrapFileSignatureMap(params.files);
  const sessionKey = params.sessionKey ?? params.sessionId ?? "unknown";
  const agentId =
    params.agentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  const context: AgentBootstrapHookContext = {
    workspaceDir: params.workspaceDir,
    bootstrapFiles: params.files,
    cfg: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId,
  };
  const event = createInternalHookEvent("agent", "bootstrap", sessionKey, context);
  await triggerInternalHook(event);
  const updated = (event.context as AgentBootstrapHookContext).bootstrapFiles;
  return Array.isArray(updated)
    ? markHookProvidedBootstrapFiles({ originalSignatures, updated })
    : params.files;
}
