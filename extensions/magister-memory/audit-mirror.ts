import { createHash } from "node:crypto";

export type AuditPayload = {
  action: "add" | "replace" | "remove" | "blocked";
  target: "memory" | "user";
  content: string;
  blockedReason?: string;
};

export type AuditMirrorOptions = {
  /** Audit endpoint, e.g. "http://magister-gateway.internal:8081/api/memory/audit". */
  endpoint: string;
  /**
   * The machine's GATEWAY_TOKEN. The gateway derives project_id + team_id from
   * the token hash — there is no X-Project-Id header (the machine doesn't know
   * its project_id; that mapping lives server-side).
   */
  gatewayToken: string;
  timeoutMs?: number;
};

/**
 * Fire-and-forget audit. Never throws — failures are logged and dropped, because
 * the local memory write has already succeeded by the time this runs and we do
 * NOT want a flaky gateway POST to surface as a tool error.
 *
 * Auth model: same as every other machine→gateway call. Bearer GATEWAY_TOKEN
 * only. The gateway derives project_id + team_id from the token hash.
 */
export async function mirrorAudit(opts: AuditMirrorOptions, payload: AuditPayload): Promise<void> {
  const body = {
    action: payload.action,
    target: payload.target,
    content: payload.content,
    content_sha256: createHash("sha256").update(payload.content).digest("hex"),
    blocked_reason: payload.blockedReason ?? null,
  };

  try {
    await fetch(opts.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.gatewayToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
  } catch (err) {
    console.error("[magister-memory] audit mirror failed:", err);
  }
}
