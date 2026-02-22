export type ChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "chunk"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type AgentStatus = {
  status:
    | "provisioning"
    | "running"
    | "suspending"
    | "suspended"
    | "failed"
    | "destroying"
    | "destroyed";
  fly_state: string | null;
  region: string;
  last_activity: string | null;
  plan: string;
  llm_spend_cents: number;
};

const ERROR_MESSAGES: Record<number, string> = {
  401: "Session expired. Please sign in again.",
  404: "No agent found. Please set up your subscription.",
  409: "Another request is already in progress. Please wait.",
  410: "Your agent has been deactivated. Please contact support.",
  503: "Your agent is waking up. Please try again in a moment.",
};

/**
 * Stream chat messages from the gateway via SSE.
 * Uses fetch + ReadableStream (not EventSource) because the gateway requires POST.
 *
 * sse-starlette sends events as separate lines:
 *   event: <type>\n
 *   data: <payload>\n
 *   \n
 */
export async function* streamChat(
  gatewayUrl: string,
  jwt: string,
  message: string,
  sessionId?: string
): AsyncGenerator<ChatEvent> {
  const body: Record<string, unknown> = { message, stream: true };
  if (sessionId) body.session_id = sessionId;

  const res = await fetch(`${gatewayUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorMessage =
      ERROR_MESSAGES[res.status] ?? `Gateway error (${res.status})`;
    yield { type: "error", message: errorMessage };
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: "error", message: "No response stream available." };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          const event = currentEvent || "chunk";

          if (event === "session") {
            yield { type: "session", sessionId: data };
          } else if (event === "chunk") {
            yield { type: "chunk", content: data };
          } else if (event === "done") {
            yield { type: "done" };
          } else if (event === "error") {
            yield { type: "error", message: data };
          }

          currentEvent = "";
          continue;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function getAgentStatus(
  gatewayUrl: string,
  jwt: string
): Promise<AgentStatus | null> {
  try {
    const res = await fetch(`${gatewayUrl}/api/status`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as AgentStatus;
  } catch {
    return null;
  }
}
