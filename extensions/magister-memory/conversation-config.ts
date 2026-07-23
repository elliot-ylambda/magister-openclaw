import type { ConversationCheckpointConfig, ConversationMemoryMode } from "./conversation-types.js";
import { isRecord } from "./file-utils.js";

export const DEFAULT_CONVERSATION_CHECKPOINT_CONFIG: ConversationCheckpointConfig = {
  mode: "off",
  model: "magister-gateway/anthropic/claude-haiku-4-5",
  idleMinutes: 10,
  recentDays: 30,
  maxInputChars: 16_000,
  maxCheckpointChars: 1_200,
  maxHeaderChars: 800,
  maxRecallChars: 1_200,
  promotionConfidence: 0.95,
};

export function resolveConversationCheckpointConfig(
  pluginConfig: unknown,
  environmentMode = process.env.MAGISTER_CONVERSATION_MEMORY_MODE,
): ConversationCheckpointConfig {
  const root = isRecord(pluginConfig) ? pluginConfig : {};
  const configured = isRecord(root.conversationCheckpoints) ? root.conversationCheckpoints : {};
  const configuredMode = readMode(configured.mode) ?? DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.mode;
  const mode =
    environmentMode === undefined ? configuredMode : (readMode(environmentMode) ?? "off");
  return {
    mode,
    model: readString(configured.model) ?? DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.model,
    idleMinutes:
      readNumber(configured.idleMinutes, 1, 1_440) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.idleMinutes,
    recentDays:
      readNumber(configured.recentDays, 1, 365) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.recentDays,
    maxInputChars:
      readNumber(configured.maxInputChars, 2_000, 100_000) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.maxInputChars,
    maxCheckpointChars:
      readNumber(configured.maxCheckpointChars, 200, 5_000) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.maxCheckpointChars,
    maxHeaderChars:
      readNumber(configured.maxHeaderChars, 100, 2_000) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.maxHeaderChars,
    maxRecallChars:
      readNumber(configured.maxRecallChars, 100, 4_000) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.maxRecallChars,
    promotionConfidence:
      readNumber(configured.promotionConfidence, 0, 1, false) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.promotionConfidence,
  };
}

function readMode(value: unknown): ConversationMemoryMode | undefined {
  return value === "off" || value === "shadow" || value === "active" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  integer = true,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return undefined;
  }
  return integer ? Math.floor(value) : value;
}
