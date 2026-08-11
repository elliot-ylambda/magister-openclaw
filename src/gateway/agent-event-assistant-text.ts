import type { AgentEventPayload } from "../infra/agent-events.js";

const MAX_ASSISTANT_MEDIA_URLS = 20;
const MAX_ASSISTANT_MEDIA_URL_LENGTH = 8_192;

export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  const delta = evt.data.delta;
  const text = evt.data.text;
  return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}

export function resolveAssistantMediaUrls(evt: AgentEventPayload): string[] {
  const mediaUrls = evt.data.mediaUrls;
  if (!Array.isArray(mediaUrls)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of mediaUrls) {
    if (typeof value !== "string") {
      continue;
    }
    const url = value.trim();
    if (!url || url.length > MAX_ASSISTANT_MEDIA_URL_LENGTH || seen.has(url)) {
      continue;
    }
    seen.add(url);
    normalized.push(url);
    if (normalized.length >= MAX_ASSISTANT_MEDIA_URLS) {
      break;
    }
  }
  return normalized;
}
