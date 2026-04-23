import { describe, expect, it } from "vitest";
import { honchoConfigSchema } from "./config.js";

describe("honchoConfigSchema.parse", () => {
  it("accepts an agentWorkspaces mapping and normalizes agent IDs to lowercase", () => {
    const cfg = honchoConfigSchema.parse({
      workspaceId: "openclaw",
      agentWorkspaces: {
        Personal: "personal_workspace",
        developer: "personal_workspace",
        MANAGER: "ops_workspace",
      },
    });

    expect(cfg.workspaceId).toBe("openclaw");
    expect(cfg.agentWorkspaces).toEqual({
      personal: "personal_workspace",
      developer: "personal_workspace",
      manager: "ops_workspace",
    });
  });

  it("leaves agentWorkspaces undefined when missing", () => {
    const cfg = honchoConfigSchema.parse({ workspaceId: "openclaw" });
    expect(cfg.agentWorkspaces).toBeUndefined();
  });

  it("leaves agentWorkspaces undefined when given an empty object", () => {
    const cfg = honchoConfigSchema.parse({ workspaceId: "openclaw", agentWorkspaces: {} });
    expect(cfg.agentWorkspaces).toBeUndefined();
  });

  it("rejects non-string workspace mappings", () => {
    expect(() =>
      honchoConfigSchema.parse({
        workspaceId: "openclaw",
        agentWorkspaces: { personal: 42 },
      }),
    ).toThrow(/non-empty string/);
  });

  it("rejects an array-shaped agentWorkspaces value", () => {
    expect(() =>
      honchoConfigSchema.parse({
        workspaceId: "openclaw",
        agentWorkspaces: ["personal_workspace"] as unknown as Record<string, string>,
      }),
    ).toThrow(/must be an object/);
  });

  it("rejects empty-string workspace IDs in the mapping", () => {
    expect(() =>
      honchoConfigSchema.parse({
        workspaceId: "openclaw",
        agentWorkspaces: { personal: "" },
      }),
    ).toThrow(/non-empty string/);
  });
});
