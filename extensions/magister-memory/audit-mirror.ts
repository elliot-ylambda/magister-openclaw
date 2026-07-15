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
   * The local gateway credential. In enforced mode this is the broker-local
   * sentinel and the loopback broker injects a scoped runtime:write token.
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
 * only; enforced machines reach this path through the loopback broker.
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
    const response = await fetch(opts.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.gatewayToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!response.ok) {
      throw new Error(`audit mirror rejected: HTTP ${response.status}`);
    }
  } catch (err) {
    console.error("[magister-memory] audit mirror failed:", err);
  }
}
