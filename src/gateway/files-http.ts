/**
 * POST /v1/files — Upload files to the agent workspace.
 *
 * Accepts base64-encoded files and persists them to the agent's workspace
 * directory so they're accessible across turns.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { sendInvalidRequest, sendJson } from "./http-common.js";
import { resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";

const DEFAULT_BODY_BYTES = 20 * 1024 * 1024; // 20 MB

/** Characters unsafe for filenames — keep only letters, digits, dots, hyphens, underscores. */
function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

/** Replace characters that are problematic in directory names (e.g. colons). */
function sanitizeSessionDir(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

type FileInput = {
  name: string;
  type: string;
  data: string; // base64
};

type FileResult = {
  name: string;
  path: string;
  size: number;
};

export async function handleFilesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const result = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/files",
    auth: opts.auth,
    maxBodyBytes: DEFAULT_BODY_BYTES,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });

  if (result === false) return false; // not our route
  if (result === undefined) return true; // auth/method error already sent

  const body = result.body as Record<string, unknown>;
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) {
    sendInvalidRequest(res, "files must be a non-empty array");
    return true;
  }

  // Resolve agent workspace
  const agentId = resolveAgentIdForRequest({ req, model: undefined });
  const sessionKey =
    (body.session_key as string | undefined) ??
    resolveSessionKey({ req, agentId, prefix: "files" });
  const cfg = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const uploadDir = path.join(workspaceDir, "uploads", sanitizeSessionDir(sessionKey));

  await fs.mkdir(uploadDir, { recursive: true });

  const results: FileResult[] = [];
  for (const file of files as FileInput[]) {
    if (!file.name || !file.data) continue;

    const sanitized = sanitizeFilename(file.name);
    const ext = path.extname(sanitized) || path.extname(file.name) || "";
    const base = sanitized.replace(/\.[^.]+$/, "") || "file";
    const filename = `${base}---${randomUUID()}${ext}`;
    const filePath = path.join(uploadDir, filename);

    const buf = Buffer.from(file.data, "base64");
    await fs.writeFile(filePath, buf);

    const relativePath = path.relative(workspaceDir, filePath);
    results.push({ name: file.name, path: relativePath, size: buf.length });
  }

  sendJson(res, 200, { files: results });
  return true;
}
