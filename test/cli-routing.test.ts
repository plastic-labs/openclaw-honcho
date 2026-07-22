import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { honchoConfigSchema } from "../config.js";
import {
  ensureHonchoCapturePermission,
  pruneStaleUploadManifestEntries,
  registerCli,
  resolveCliWorkspace,
  uploadManifestKey,
} from "../commands/cli.js";

describe("capture permission configuration", () => {
  it("adds only the required entry-level conversation permission and preserves existing policy", () => {
    const input = {
      plugins: {
        entries: {
          "openclaw-honcho": {
            enabled: true,
            hooks: { allowPromptInjection: false, timeoutMs: 45000 },
            config: { workspaceId: "work" },
          },
          other: { enabled: false },
        },
      },
    };
    const result = ensureHonchoCapturePermission(input);
    expect(result.changed).toBe(true);
    expect(result.config).toMatchObject({
      plugins: {
        entries: {
          "openclaw-honcho": {
            enabled: true,
            hooks: {
              allowPromptInjection: false,
              allowConversationAccess: true,
              timeoutMs: 45000,
            },
            config: { workspaceId: "work" },
          },
          other: { enabled: false },
        },
      },
    });
    expect(ensureHonchoCapturePermission(result.config)).toEqual({
      config: result.config,
      changed: false,
    });
  });
});

describe("CLI workspace selection", () => {
  it("selects an unambiguous agent-wide route for read/query commands", () => {
    const cfg = honchoConfigSchema.parse({
      workspaceId: "legacy",
      workspaceIdByAgent: { main: "personal", silva: "work" },
      strictWorkspaceRouting: true,
    });

    expect(resolveCliWorkspace(cfg, { agent: " SILVA " })).toEqual({
      workspaceId: "work",
      agentId: "silva",
      source: "agent",
    });
    expect(() => resolveCliWorkspace(cfg)).toThrow("workspace routing denied: cli-agent-required");
  });

  it("denies an agent whose chat rules make its CLI route ambiguous", () => {
    const cfg = honchoConfigSchema.parse({
      workspaceIdByAgent: { main: "personal" },
      workspaceRoutingRules: [
        { agentId: "main", channel: "telegram", chatId: "42", workspaceId: "work" },
      ],
      strictWorkspaceRouting: true,
    });

    expect(() => resolveCliWorkspace(cfg, { agent: "main" }))
      .toThrow("workspace routing denied: cli-agent-route-unavailable");
  });

  it("allows an explicit operator workspace only for migration and gives it precedence", () => {
    const cfg = honchoConfigSchema.parse({
      workspaceIdByAgent: { main: "mapped" },
      strictWorkspaceRouting: true,
    });

    expect(resolveCliWorkspace(cfg, {
      agent: "main",
      workspace: "migration-target",
      allowWorkspaceOverride: true,
    })).toEqual({ workspaceId: "migration-target", agentId: "main", source: "operator" });
    expect(() => resolveCliWorkspace(cfg, { workspace: "migration-target" }))
      .toThrow("workspace routing denied: cli-workspace-override-not-allowed");
  });

  it("preserves no-agent CLI behavior only for the safe legacy configuration", () => {
    const legacy = honchoConfigSchema.parse({ workspaceId: "legacy" });
    const optedIn = honchoConfigSchema.parse({
      workspaceId: "legacy",
      workspaceIdByAgent: { main: "mapped" },
      strictWorkspaceRouting: false,
    });

    expect(resolveCliWorkspace(legacy)).toEqual({ workspaceId: "legacy", source: "legacy" });
    expect(() => resolveCliWorkspace(optedIn)).toThrow("workspace routing denied: cli-agent-required");
  });

  it("rejects invalid operator input", () => {
    const cfg = honchoConfigSchema.parse({ workspaceId: "legacy" });
    expect(() => resolveCliWorkspace(cfg, { agent: "   " })).toThrow("invalid-agent");
    expect(() => resolveCliWorkspace(cfg, { workspace: "bad\nvalue", allowWorkspaceOverride: true }))
      .toThrow("invalid-workspace");
  });
});

describe("upload resume identity", () => {
  it("scopes manifest keys by workspace, endpoint, peer, and path", () => {
    const base = uploadManifestKey("https://example.test/", "one", "/tmp/MEMORY.md", "agent-main");
    expect(uploadManifestKey("https://example.test", "one", "/tmp/MEMORY.md", "agent-main")).toBe(base);
    expect(uploadManifestKey("https://example.test", "two", "/tmp/MEMORY.md", "agent-main")).not.toBe(base);
    expect(uploadManifestKey("https://other.test", "one", "/tmp/MEMORY.md", "agent-main")).not.toBe(base);
    expect(uploadManifestKey("https://example.test", "one", "/tmp/MEMORY.md", "owner")).not.toBe(base);
  });

  it("preserves live legacy path keys during routed cleanup and removes only stale legacy keys", () => {
    const existingLegacyPath = path.join(process.cwd(), "README.md");
    const staleLegacyPath = path.join(process.cwd(), ".missing-legacy-upload-entry");
    const manifest = {
      [existingLegacyPath]: {
        sha256: "live",
        uploadedAt: "2026-07-22T00:00:00.000Z",
        baseUrl: "https://example.test",
        workspaceId: "legacy",
      },
      [staleLegacyPath]: {
        sha256: "stale",
        uploadedAt: "2026-07-22T00:00:00.000Z",
        baseUrl: "https://example.test",
        workspaceId: "legacy",
      },
    } as any;

    pruneStaleUploadManifestEntries(manifest);

    expect(manifest[existingLegacyPath]).toBeDefined();
    expect(manifest[staleLegacyPath]).toBeUndefined();
  });
});

class FakeCommand {
  readonly children = new Map<string, FakeCommand>();
  readonly optionFlags: string[] = [];
  handler?: (...args: any[]) => unknown;

  command(spec: string): FakeCommand {
    const name = spec.split(/\s+/)[0]!;
    const child = new FakeCommand();
    this.children.set(name, child);
    return child;
  }
  description(): this { return this; }
  option(flags: string): this { this.optionFlags.push(flags); return this; }
  action(handler: (...args: any[]) => unknown): this { this.handler = handler; return this; }
}

describe("registered CLI commands", () => {
  afterEach(() => vi.restoreAllMocks());

  function registration(cfg: ReturnType<typeof honchoConfigSchema.parse>) {
    const program = new FakeCommand();
    const getWorkspaceState = vi.fn();
    const api = {
      registerCli: (factory: (ctx: unknown) => void) => factory({ program, workspaceDir: "/tmp/workspace" }),
    };
    registerCli(api as any, { cfg, getWorkspaceState } as any);
    return { honcho: program.children.get("honcho")!, getWorkspaceState };
  }

  it("exposes --agent on every query command and --workspace only on setup", () => {
    const { honcho } = registration(honchoConfigSchema.parse({ workspaceId: "legacy" }));
    for (const name of ["status", "ask", "search"]) {
      expect(honcho.children.get(name)?.optionFlags.some((flag) => flag.includes("--agent"))).toBe(true);
      expect(honcho.children.get(name)?.optionFlags.some((flag) => flag.includes("--workspace"))).toBe(false);
    }
    expect(honcho.children.get("setup")?.optionFlags.some((flag) => flag.includes("--workspace"))).toBe(true);
  });

  it("strictly denies a query before workspace initialization or Honcho access", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cfg = honchoConfigSchema.parse({
      workspaceIdByAgent: { main: "personal" },
      strictWorkspaceRouting: true,
    });
    const { honcho, getWorkspaceState } = registration(cfg);

    await honcho.children.get("status")!.handler!({ agent: "unknown" });

    expect(getWorkspaceState).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Failed to connect: WorkspaceRoutingError: workspace routing denied: cli-agent-route-unavailable",
    );
  });

  it("rejects invalid search limits before selecting workspace state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { honcho, getWorkspaceState } = registration(
      honchoConfigSchema.parse({ workspaceId: "legacy" }),
    );

    await honcho.children.get("search")!.handler!("query", {
      topK: "0",
      maxDistance: "0.5",
    });

    expect(getWorkspaceState).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Search failed: Error: Invalid top-k: expected a positive integer",
    );
  });
});
