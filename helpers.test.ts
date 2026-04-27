import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildSessionKey } from "./helpers.js";

describe("buildSessionKey", () => {
  it("returns a normalized key for short inputs unchanged", () => {
    expect(buildSessionKey({ sessionKey: "default", messageProvider: "telegram" })).toBe(
      "default-telegram",
    );
  });

  it("replaces colons and other non-alphanumerics with hyphens", () => {
    expect(
      buildSessionKey({ sessionKey: "agent:main:dashboard:test", messageProvider: "telegram" }),
    ).toBe("agent-main-dashboard-test-telegram");
  });

  it("falls back to defaults when fields are missing", () => {
    expect(buildSessionKey()).toBe("default-unknown");
    expect(buildSessionKey({})).toBe("default-unknown");
  });

  it("truncates and appends a sha1 suffix when the normalized key exceeds 100 chars", () => {
    const longSessionKey =
      "agent:default:cron:e07cc0d8-0182-417b-a80e-db01ac7bc5b0:run:c4b112f2-dcb0-40c2-ba5d-1b512b1cbd17";
    const result = buildSessionKey({ sessionKey: longSessionKey, messageProvider: "unknown" });
    expect(result.length).toBeLessThanOrEqual(100);

    const fullNormalized = `${longSessionKey}-unknown`.replace(/[^a-zA-Z0-9-]/g, "-");
    const expectedHash = createHash("sha1").update(fullNormalized).digest("hex").slice(0, 7);
    expect(result.endsWith(`-${expectedHash}`)).toBe(true);
    expect(result.startsWith(fullNormalized.slice(0, 100 - 8))).toBe(true);
  });

  it("disambiguates two long keys that share a long common prefix", () => {
    const a =
      "agent:default:cron:e07cc0d8-0182-417b-a80e-db01ac7bc5b0:run:c4b112f2-dcb0-40c2-ba5d-1b512b1cbd17";
    const b =
      "agent:default:cron:e07cc0d8-0182-417b-a80e-db01ac7bc5b0:run:af1c9530-94c7-4f08-b66a-576fd492657e";
    const ka = buildSessionKey({ sessionKey: a, messageProvider: "unknown" });
    const kb = buildSessionKey({ sessionKey: b, messageProvider: "unknown" });
    expect(ka).not.toBe(kb);
    expect(ka.length).toBe(100);
    expect(kb.length).toBe(100);
  });

  it("is deterministic — the same input always produces the same key", () => {
    const ctx = {
      sessionKey:
        "agent:default:cron:e07cc0d8-0182-417b-a80e-db01ac7bc5b0:run:c4b112f2-dcb0-40c2-ba5d-1b512b1cbd17",
      messageProvider: "unknown",
    };
    expect(buildSessionKey(ctx)).toBe(buildSessionKey(ctx));
  });
});
