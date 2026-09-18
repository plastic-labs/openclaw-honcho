import { describe, expect, it } from "vitest";
import { honchoConfigSchema } from "../config.js";

describe("Honcho automatic context character limit", () => {
  it("is disabled by default", () => {
    expect(honchoConfigSchema.parse({}).contextMaxChars).toBeUndefined();
  });

  it("accepts the documented inclusive bounds", () => {
    expect(honchoConfigSchema.parse({ contextMaxChars: 512 }).contextMaxChars).toBe(512);
    expect(honchoConfigSchema.parse({ contextMaxChars: 100_000 }).contextMaxChars).toBe(100_000);
  });

  it("ignores non-integer and out-of-range values", () => {
    for (const value of [511, 100_001, 1024.5, "6000"]) {
      expect(honchoConfigSchema.parse({ contextMaxChars: value }).contextMaxChars).toBeUndefined();
    }
  });
});
