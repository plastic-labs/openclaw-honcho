import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("keeps workspace chat off unless explicitly enabled", () => {
    expect(honchoConfigSchema.parse({}).enableWorkspaceChat).toBe(false);
    expect(honchoConfigSchema.parse({ enableWorkspaceChat: true }).enableWorkspaceChat).toBe(true);
  });
});

describe("API key from ~/.honcho/config.json", () => {
  const vars = ["HONCHO_API_KEY", "HONCHO_BASE_URL", "HONCHO_URL", "HONCHO_ENDPOINT", "HONCHO_CONFIG_PATH"];
  const saved: Record<string, string | undefined> = {};
  let dir = "";

  beforeEach(() => {
    for (const v of vars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    dir = mkdtempSync(join(tmpdir(), "honcho-config-"));
    const path = join(dir, "config.json");
    // the shape honcho-cli writes
    writeFileSync(path, JSON.stringify({ apiKey: "hch-shared", environmentUrl: "http://localhost:8000" }));
    process.env.HONCHO_CONFIG_PATH = path;
  });

  afterEach(() => {
    for (const v of vars) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the shared key, with its server, when the plugin config has none", () => {
    const cfg = honchoConfigSchema.parse({});

    expect(cfg.apiKey).toBe("hch-shared");
    expect(cfg.baseUrl).toBe("http://localhost:8000");
  });

  it("ignores the shared file when the plugin config sets a key", () => {
    const cfg = honchoConfigSchema.parse({ apiKey: "hch-plugin" });

    expect(cfg.apiKey).toBe("hch-plugin");
    expect(cfg.baseUrl).toBe("https://api.honcho.dev");
  });
});
