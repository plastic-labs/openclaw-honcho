import { describe, expect, it } from "vitest";
import { honchoConfigSchema } from "../config.js";

describe("Honcho configuration", () => {
  it("keeps legacy memory tool aliases disabled by default", () => {
    const cfg = honchoConfigSchema.parse({ baseUrl: "http://127.0.0.1:8000" });

    expect(cfg.enableMemoryCompatibilityTools).toBe(false);
  });

  it("allows legacy memory tool aliases to be explicitly enabled", () => {
    const cfg = honchoConfigSchema.parse({
      baseUrl: "http://127.0.0.1:8000",
      enableMemoryCompatibilityTools: true,
    });

    expect(cfg.enableMemoryCompatibilityTools).toBe(true);
  });
});
