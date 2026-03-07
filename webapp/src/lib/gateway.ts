export type Attachment = {
  name: string;
  type: string; // MIME type
  data: string; // base64-encoded content (no data URI prefix)
};

export type ToolUseEvent = {
  phase: "start" | "result";
  name: string;
  toolCallId: string;
  isError?: boolean;
  args?: Record<string, unknown>;
};

export type ChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "chunk"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_use"; data: ToolUseEvent }
  | { type: "done" }
  | { type: "error"; message: string };

export type AgentStatus = {
  status:
    | "provisioning"
    | "running"
    | "suspending"
    | "suspended"
    | "stopping"
    | "stopped"
    | "failed"
    | "destroying"
    | "destroyed";
  fly_state: string | null;
  region: string;
  last_activity: string | null;
  plan: string;
  llm_spend_cents: number;
  provisioning_step?: number;
  preferred_model?: string;
};

export type ModelInfo = {
  id: string;
  name: string;
  allowed: boolean;
};

export type AvailableModelsResponse = {
  models: ModelInfo[];
  current: string;
};

const ERROR_MESSAGES: Record<number, string> = {
  401: "Session expired. Please sign in again.",
  404: "No agent found. Please set up your subscription.",
  409: "Another request is already in progress. Please wait.",
  410: "Your agent has been deactivated. Please contact support.",
  423: "Your agent is stopped. Start it to resume.",
  503: "Your agent is waking up. Please try again in a moment.",
};

function dispatchSseEvent(event: string, data: string): ChatEvent | null {
  if (event === "session") return { type: "session", sessionId: data };
  if (event === "chunk") return { type: "chunk", content: data };
  if (event === "done") return { type: "done" };
  if (event === "error") return { type: "error", message: data };
  if (event === "thinking") return { type: "thinking", content: data };
  if (event === "tool_use") {
    try {
      return { type: "tool_use", data: JSON.parse(data) as ToolUseEvent };
    } catch {
      return null;
    }
  }
  return null; // Unknown event types are silently ignored
}

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
  sessionId?: string,
  attachments?: Attachment[]
): AsyncGenerator<ChatEvent> {
  const body: Record<string, unknown> = { message, stream: true };
  if (sessionId) body.session_id = sessionId;
  if (attachments?.length) body.attachments = attachments;

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
  let dataBuffer: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any buffered data on stream end
        if (dataBuffer.length > 0) {
          const data = dataBuffer.join("\n");
          const event = currentEvent || "chunk";
          const parsed = dispatchSseEvent(event, data);
          if (parsed) yield parsed;
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");

        if (line === "") {
          // Blank line = event boundary — dispatch buffered data
          if (dataBuffer.length > 0) {
            const data = dataBuffer.join("\n");
            const event = currentEvent || "chunk";
            const parsed = dispatchSseEvent(event, data);
            if (parsed) yield parsed;
            dataBuffer = [];
            currentEvent = "";
          }
          continue;
        }

        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          const raw = line.slice(5);
          const field = raw.startsWith(" ") ? raw.slice(1) : raw;
          dataBuffer.push(field);
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

async function machineAction(
  gatewayUrl: string,
  jwt: string,
  action: "stop" | "start" | "restart"
): Promise<{ status: string }> {
  const res = await fetch(`${gatewayUrl}/api/machine/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? `Failed to ${action} agent`);
  }
  return res.json();
}

export function stopAgent(gatewayUrl: string, jwt: string) {
  return machineAction(gatewayUrl, jwt, "stop");
}

export function startAgent(gatewayUrl: string, jwt: string) {
  return machineAction(gatewayUrl, jwt, "start");
}

export function restartAgent(gatewayUrl: string, jwt: string) {
  return machineAction(gatewayUrl, jwt, "restart");
}

// ── Model selection ────────────────────────────────────────

export async function getAvailableModels(
  gatewayUrl: string,
  jwt: string
): Promise<AvailableModelsResponse | null> {
  try {
    const res = await fetch(`${gatewayUrl}/api/models`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as AvailableModelsResponse;
  } catch {
    return null;
  }
}

export async function setModel(
  gatewayUrl: string,
  jwt: string,
  model: string
): Promise<{ status: string; model: string }> {
  const res = await fetch(`${gatewayUrl}/api/models`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? "Failed to set model");
  }
  return res.json();
}

// ── Feedback ──────────────────────────────────────────────

export async function submitFeedback(
  gatewayUrl: string,
  jwt: string,
  data: {
    sessionId: string;
    category: string;
    description?: string;
    messages: { role: string; content: string }[];
  }
): Promise<{ status: string }> {
  const res = await fetch(`${gatewayUrl}/api/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      session_id: data.sessionId,
      category: data.category,
      description: data.description ?? "",
      messages: data.messages,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? "Failed to submit feedback");
  }
  return res.json();
}

export async function submitContactSupport(
  gatewayUrl: string,
  jwt: string,
  message: string,
): Promise<{ status: string }> {
  const res = await fetch(`${gatewayUrl}/api/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      category: "contact_support",
      description: message,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? "Failed to submit message");
  }
  return res.json();
}

// ── File operations ────────────────────────────────────────

export type FileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modified: string;
};

export type FileListResponse = { path: string; entries: FileEntry[] };
export type FileReadResponse = { path: string; content: string; size: number };

async function fileRequest<T>(
  gatewayUrl: string,
  jwt: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${gatewayUrl}/api${path}`, opts);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? `File operation failed (${res.status})`);
  }
  return res.json();
}

export function listFiles(gatewayUrl: string, jwt: string, dirPath: string) {
  return fileRequest<FileListResponse>(
    gatewayUrl, jwt, "GET",
    `/files/list?path=${encodeURIComponent(dirPath)}`
  );
}

export function readFile(gatewayUrl: string, jwt: string, filePath: string) {
  return fileRequest<FileReadResponse>(
    gatewayUrl, jwt, "GET",
    `/files/read?path=${encodeURIComponent(filePath)}`
  );
}

export function writeFile(
  gatewayUrl: string, jwt: string, filePath: string, content: string
) {
  return fileRequest<{ status: string; path: string }>(
    gatewayUrl, jwt, "PUT", "/files/write",
    { path: filePath, content }
  );
}

export function createFile(
  gatewayUrl: string, jwt: string, filePath: string,
  opts?: { content?: string; is_directory?: boolean }
) {
  return fileRequest<{ status: string; path: string }>(
    gatewayUrl, jwt, "POST", "/files/create",
    { path: filePath, content: opts?.content ?? "", is_directory: opts?.is_directory ?? false }
  );
}

export function deleteFile(gatewayUrl: string, jwt: string, filePath: string) {
  return fileRequest<{ status: string; path: string }>(
    gatewayUrl, jwt, "DELETE",
    `/files/delete?path=${encodeURIComponent(filePath)}`
  );
}

// ── Skills management ─────────────────────────────────────

export type SkillEntry = {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  emoji: string;
  homepage: string;
};

export type SkillListResponse = { skills: SkillEntry[] };

async function skillRequest<T>(
  gatewayUrl: string,
  jwt: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${gatewayUrl}/api${path}`, opts);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? `Skill operation failed (${res.status})`);
  }
  return res.json();
}

export function listSkills(gatewayUrl: string, jwt: string) {
  return skillRequest<SkillListResponse>(gatewayUrl, jwt, "GET", "/skills");
}

export function installSkill(gatewayUrl: string, jwt: string, slug: string) {
  return skillRequest<{ status: string; slug: string }>(
    gatewayUrl, jwt, "POST", "/skills/install",
    { slug }
  );
}

export function removeSkill(gatewayUrl: string, jwt: string, skillName: string) {
  return skillRequest<{ status: string; skill: string }>(
    gatewayUrl, jwt, "DELETE", `/skills/${encodeURIComponent(skillName)}`
  );
}

export function toggleSkill(
  gatewayUrl: string, jwt: string, skillName: string, enabled: boolean
) {
  return skillRequest<{ status: string; skill: string; enabled: boolean }>(
    gatewayUrl, jwt, "PATCH", `/skills/${encodeURIComponent(skillName)}`,
    { enabled }
  );
}

export function createCustomSkill(
  gatewayUrl: string, jwt: string, name: string, content: string
) {
  return skillRequest<{ status: string; skill: string }>(
    gatewayUrl, jwt, "POST", "/skills/custom",
    { name, content }
  );
}

// ── Email operations ────────────────────────────────────────

export type AgentEmail = {
  id: string;
  user_id: string;
  machine_id: string;
  direction: "inbound" | "outbound";
  status: "pending" | "approved" | "sent" | "rejected" | "received" | "quarantined" | "failed" | "rewrite_requested";
  from_address: string;
  to_address: string;
  cc: string[] | null;
  bcc: string[] | null;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  thread_id: string | null;
  attachments: Record<string, unknown>[] | null;
  rewrite_note: string | null;
  scan_result: Record<string, unknown> | null;
  created_at: string;
  sent_at: string | null;
  received_at: string | null;
};

async function emailRequest<T>(
  gatewayUrl: string,
  jwt: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${gatewayUrl}/api${path}`, opts);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? `Email operation failed (${res.status})`);
  }
  return res.json();
}

export function getPendingEmails(gatewayUrl: string, jwt: string) {
  return emailRequest<{ emails: AgentEmail[] }>(gatewayUrl, jwt, "GET", "/email/pending");
}

export function getEmailInbox(gatewayUrl: string, jwt: string) {
  return emailRequest<{ emails: AgentEmail[] }>(gatewayUrl, jwt, "GET", "/email/inbox");
}

export function getSentEmails(gatewayUrl: string, jwt: string) {
  return emailRequest<{ emails: AgentEmail[] }>(gatewayUrl, jwt, "GET", "/email/sent");
}

export function approveEmail(gatewayUrl: string, jwt: string, emailId: string) {
  return emailRequest<{ status: string }>(gatewayUrl, jwt, "POST", "/email/approve", {
    email_id: emailId,
    action: "approve",
  });
}

export function rejectEmail(gatewayUrl: string, jwt: string, emailId: string) {
  return emailRequest<{ status: string }>(gatewayUrl, jwt, "POST", "/email/approve", {
    email_id: emailId,
    action: "reject",
  });
}

export function rewriteEmail(gatewayUrl: string, jwt: string, emailId: string, note: string) {
  return emailRequest<{ status: string }>(gatewayUrl, jwt, "POST", "/email/approve", {
    email_id: emailId,
    action: "rewrite",
    rewrite_note: note,
  });
}

export function editAndSendEmail(
  gatewayUrl: string,
  jwt: string,
  emailId: string,
  edits: { subject?: string; body_html?: string; body_text?: string }
) {
  return emailRequest<{ status: string }>(gatewayUrl, jwt, "POST", "/email/approve", {
    email_id: emailId,
    action: "edit",
    edited_subject: edits.subject,
    edited_body_html: edits.body_html,
    edited_body_text: edits.body_text,
  });
}
