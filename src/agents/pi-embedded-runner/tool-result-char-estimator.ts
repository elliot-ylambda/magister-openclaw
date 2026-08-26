import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2;
const IMAGE_CHAR_ESTIMATE = 8_000;

export type MessageCharEstimateCache = {
  cache: WeakMap<AgentMessage, number>;
  includeToolResultDetails: boolean;
};

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function isImageBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function estimateUnknownChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined) {
    return 0;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 256;
  }
}

export function isToolResultMessage(msg: AgentMessage): boolean {
  const role = (msg as { role?: unknown }).role;
  const type = (msg as { type?: unknown }).type;
  return role === "toolResult" || role === "tool" || type === "toolResult";
}

function getToolResultContent(msg: AgentMessage): unknown[] {
  if (!isToolResultMessage(msg)) {
    return [];
  }
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function estimateContentBlockChars(content: unknown[]): number {
  let chars = 0;
  for (const block of content) {
    if (isTextBlock(block)) {
      chars += block.text.length;
    } else if (isImageBlock(block)) {
      chars += IMAGE_CHAR_ESTIMATE;
    } else {
      chars += estimateUnknownChars(block);
    }
  }
  return chars;
}

export function getToolResultText(msg: AgentMessage): string {
  const content = getToolResultContent(msg);
  const chunks: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      chunks.push(block.text);
    }
  }
  return chunks.join("\n");
}

function estimateMessageChars(msg: AgentMessage, includeToolResultDetails: boolean): number {
  if (!msg || typeof msg !== "object") {
    return 0;
  }

  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      return content.length;
    }
    if (Array.isArray(content)) {
      return estimateContentBlockChars(content);
    }
    return 0;
  }

  if (msg.role === "assistant") {
    let chars = 0;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const typed = block as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          arguments?: unknown;
        };
        if (typed.type === "text" && typeof typed.text === "string") {
          chars += typed.text.length;
        } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
          chars += typed.thinking.length;
        } else if (typed.type === "toolCall") {
          try {
            chars += JSON.stringify(typed.arguments ?? {}).length;
          } catch {
            chars += 128;
          }
        } else {
          chars += estimateUnknownChars(block);
        }
      }
    }
    return chars;
  }

  if (isToolResultMessage(msg)) {
    const content = getToolResultContent(msg);
    let chars = estimateContentBlockChars(content);
    if (includeToolResultDetails) {
      // Retained-size view: counts `details` payloads (e.g. untruncated
      // originals kept by tool-result truncation). Provider converters never
      // serialize `details`, so this mode must never be used to estimate what
      // the model is actually sent.
      const details = (msg as { details?: unknown }).details;
      chars += estimateUnknownChars(details);
    }
    const weightedChars = Math.ceil(
      chars * (CHARS_PER_TOKEN_ESTIMATE / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE),
    );
    return Math.max(chars, weightedChars);
  }

  return 256;
}

export function createMessageCharEstimateCache(
  options: { includeToolResultDetails?: boolean } = {},
): MessageCharEstimateCache {
  // Default is the sent-size view: `details` are excluded because provider
  // converters never serialize them, so they cost no model context.
  return {
    cache: new WeakMap<AgentMessage, number>(),
    includeToolResultDetails: options.includeToolResultDetails ?? false,
  };
}

export function estimateMessageCharsCached(
  msg: AgentMessage,
  cache: MessageCharEstimateCache,
): number {
  const hit = cache.cache.get(msg);
  if (hit !== undefined) {
    return hit;
  }
  const estimated = estimateMessageChars(msg, cache.includeToolResultDetails);
  cache.cache.set(msg, estimated);
  return estimated;
}

export function estimateContextChars(
  messages: AgentMessage[],
  cache: MessageCharEstimateCache,
): number {
  return messages.reduce((sum, msg) => sum + estimateMessageCharsCached(msg, cache), 0);
}

export function invalidateMessageCharsCacheEntry(
  cache: MessageCharEstimateCache,
  msg: AgentMessage,
): void {
  cache.cache.delete(msg);
}
