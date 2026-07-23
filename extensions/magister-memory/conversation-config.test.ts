import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_CHECKPOINT_CONFIG,
  resolveConversationCheckpointConfig,
} from "./conversation-config.js";

describe("resolveConversationCheckpointConfig", () => {
  it("defaults to off for third-party plugin installs", () => {
    expect(resolveConversationCheckpointConfig({}, undefined)).toEqual(
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG,
    );
  });

  it("accepts bounded configured values", () => {
    const config = resolveConversationCheckpointConfig(
      {
        conversationCheckpoints: {
          mode: "shadow",
          idleMinutes: 15,
          recentDays: 45,
          maxInputChars: 20_000,
          promotionConfidence: 0.98,
        },
      },
      undefined,
    );
    expect(config).toMatchObject({
      mode: "shadow",
      idleMinutes: 15,
      recentDays: 45,
      maxInputChars: 20_000,
      promotionConfidence: 0.98,
    });
  });

  it("lets the environment override mode and fails invalid overrides closed", () => {
    expect(resolveConversationCheckpointConfig({}, "active").mode).toBe("active");
    expect(
      resolveConversationCheckpointConfig(
        { conversationCheckpoints: { mode: "active" } },
        "surprise",
      ).mode,
    ).toBe("off");
  });
});
