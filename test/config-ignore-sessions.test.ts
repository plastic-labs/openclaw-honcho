import { describe, expect, it } from "vitest";
import { honchoConfigSchema } from "../config.js";

describe("Honcho ignored session configuration", () => {
  it("defaults to no ignored sessions", () => {
    const cfg = honchoConfigSchema.parse({ baseUrl: "http://127.0.0.1:8000" });

    expect(cfg.ignoreSessionPatterns).toEqual([]);
  });

  it("trims, filters, and deduplicates configured patterns", () => {
    const cfg = honchoConfigSchema.parse({
      baseUrl: "http://127.0.0.1:8000",
      ignoreSessionPatterns: [
        " agent:*:cron:** ",
        "agent:*:cron:**",
        "",
        42,
        null,
      ],
    });

    expect(cfg.ignoreSessionPatterns).toEqual(["agent:*:cron:**"]);
  });
});
