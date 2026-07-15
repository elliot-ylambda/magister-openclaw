import { afterEach, describe, expect, it } from "vitest";
import { magisterSlackRelayToken, slackGatewayRelayBearerOk } from "./provider-support.js";

// Magister fork: gateway-relay Slack auth. On gateway-managed machines the
// gateway relays already-verified Slack events over the private network and
// authenticates with the per-machine GATEWAY_TOKEN bearer instead of the
// app-global Slack signing secret (which is no longer shipped to machines).

describe("magisterSlackRelayToken", () => {
  const original = process.env.GATEWAY_TOKEN;
  const originalRelay = process.env.MAGISTER_GATEWAY_RELAY_TOKEN;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.GATEWAY_TOKEN;
    } else {
      process.env.GATEWAY_TOKEN = original;
    }
    if (originalRelay === undefined) {
      delete process.env.MAGISTER_GATEWAY_RELAY_TOKEN;
    } else {
      process.env.MAGISTER_GATEWAY_RELAY_TOKEN = originalRelay;
    }
  });

  it("returns the token when GATEWAY_TOKEN is set (gateway-managed machine)", () => {
    process.env.GATEWAY_TOKEN = "tok-abc";
    expect(magisterSlackRelayToken()).toBe("tok-abc");
  });

  it("returns undefined when GATEWAY_TOKEN is unset (upstream install)", () => {
    delete process.env.GATEWAY_TOKEN;
    expect(magisterSlackRelayToken()).toBeUndefined();
  });

  it("returns undefined when GATEWAY_TOKEN is empty", () => {
    process.env.GATEWAY_TOKEN = "";
    expect(magisterSlackRelayToken()).toBeUndefined();
  });

  it("prefers the broker-safe inbound relay token", () => {
    process.env.GATEWAY_TOKEN = "legacy-broad-token";
    process.env.MAGISTER_GATEWAY_RELAY_TOKEN = "relay-only-token";
    expect(magisterSlackRelayToken()).toBe("relay-only-token");
  });
});

describe("slackGatewayRelayBearerOk", () => {
  const token = "secret-machine-token-1234567890";

  it("accepts a matching Bearer credential", () => {
    expect(slackGatewayRelayBearerOk(`Bearer ${token}`, token)).toBe(true);
  });

  it("accepts a matching credential when the header arrives as an array", () => {
    expect(slackGatewayRelayBearerOk([`Bearer ${token}`], token)).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(slackGatewayRelayBearerOk("Bearer not-the-token", token)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(slackGatewayRelayBearerOk(undefined, token)).toBe(false);
  });

  it("rejects a header without the Bearer prefix", () => {
    expect(slackGatewayRelayBearerOk(token, token)).toBe(false);
  });

  it("rejects an empty bearer value", () => {
    expect(slackGatewayRelayBearerOk("Bearer ", token)).toBe(false);
  });

  it("rejects a token that is a length-mismatched prefix of the expected", () => {
    expect(slackGatewayRelayBearerOk(`Bearer ${token.slice(0, -1)}`, token)).toBe(false);
  });
});
