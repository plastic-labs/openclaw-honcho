import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpenClawConfigPath } from "../openclaw-config-path.js";

describe("resolveOpenClawConfigPath", () => {
  it("uses OPENCLAW_CONFIG_PATH verbatim as the file path", () => {
    expect(resolveOpenClawConfigPath({ OPENCLAW_CONFIG_PATH: "/tmp/x/a.json", OPENCLAW_STATE_DIR: "/tmp/y" })).toBe("/tmp/x/a.json");
  });
  it("falls back to openclaw.json inside OPENCLAW_STATE_DIR", () => {
    expect(resolveOpenClawConfigPath({ OPENCLAW_STATE_DIR: "/tmp/y" })).toBe("/tmp/y/openclaw.json");
  });
  it("defaults to ~/.openclaw/openclaw.json", () => {
    expect(resolveOpenClawConfigPath({})).toBe(join(homedir(), ".openclaw", "openclaw.json"));
  });
});
