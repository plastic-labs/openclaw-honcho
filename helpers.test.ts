import { describe, expect, it } from "vitest";

import { buildSessionKey } from "./helpers.js";

describe("buildSessionKey", () => {
  it("prefers messageProvider over messageChannel when both are present", () => {
    const key = buildSessionKey({
      sessionKey: "agent:developer:discord:channel:1234567890123456789",
      messageProvider: "discord",
      messageChannel: "other",
    });
    expect(key).toBe("agent-developer-discord-channel-1234567890123456789-discord");
  });

  it("falls back to messageChannel when messageProvider is missing (tool ctx shape)", () => {
    const key = buildSessionKey({
      sessionKey: "agent:developer:discord:channel:1234567890123456789",
      messageChannel: "discord",
    });
    expect(key).toBe("agent-developer-discord-channel-1234567890123456789-discord");
    expect(key).not.toContain("-unknown");
  });

  it("uses messageProvider when messageChannel is missing (hook ctx shape)", () => {
    const key = buildSessionKey({
      sessionKey: "agent:developer:discord:channel:1234567890123456789",
      messageProvider: "discord",
    });
    expect(key).toBe("agent-developer-discord-channel-1234567890123456789-discord");
  });

  it("falls back to 'unknown' when neither field is present", () => {
    const key = buildSessionKey({ sessionKey: "agent:developer:cli:session" });
    expect(key).toBe("agent-developer-cli-session-unknown");
  });

  it("defaults baseKey to 'default' when sessionKey is missing", () => {
    expect(buildSessionKey({})).toBe("default-unknown");
    expect(buildSessionKey()).toBe("default-unknown");
  });

  it("collapses non-alphanumerics to '-'", () => {
    const key = buildSessionKey({
      sessionKey: "agent:main:slack:team_abc/channel@xyz",
      messageProvider: "slack",
    });
    expect(key).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(key).toContain("-slack");
  });
});
