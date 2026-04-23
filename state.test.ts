import { describe, expect, it, vi } from "vitest";

vi.mock("@honcho-ai/sdk", () => {
  class Honcho {
    workspaceId: string;
    apiKey?: string;
    baseURL?: string;
    timeout?: number;
    constructor(opts: { workspaceId: string; apiKey?: string; baseURL?: string; timeout?: number }) {
      this.workspaceId = opts.workspaceId;
      this.apiKey = opts.apiKey;
      this.baseURL = opts.baseURL;
      this.timeout = opts.timeout;
    }
    getMetadata = vi.fn(async () => ({}));
    setMetadata = vi.fn(async () => undefined);
    peer = vi.fn(async (peerId: string) => ({
      id: peerId,
      getMetadata: vi.fn(async () => ({})),
      setMetadata: vi.fn(async () => undefined),
    }));
    peers = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        // no pre-existing peers
      },
    }));
    session = vi.fn();
    search = vi.fn();
  }
  return { Honcho };
});

import { createPluginState } from "./state.js";

function createFakeApi(pluginConfig: Record<string, unknown>, agentsList?: Array<Record<string, unknown>>) {
  return {
    pluginConfig,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: agentsList ? { agents: { list: agentsList } } : { agents: { list: [] } },
  } as never;
}

describe("per-agent workspace routing", () => {
  it("resolveWorkspaceIdForAgent returns the mapped workspace or falls back to workspaceId", () => {
    const state = createPluginState(
      createFakeApi({
        apiKey: "test",
        workspaceId: "openclaw",
        agentWorkspaces: {
          personal: "personal_workspace",
          manager: "ops_workspace",
        },
      }),
    );

    expect(state.resolveWorkspaceIdForAgent("personal")).toBe("personal_workspace");
    expect(state.resolveWorkspaceIdForAgent("Personal")).toBe("personal_workspace");
    expect(state.resolveWorkspaceIdForAgent("manager")).toBe("ops_workspace");
    expect(state.resolveWorkspaceIdForAgent("unmapped-agent")).toBe("openclaw");
    expect(state.resolveWorkspaceIdForAgent(undefined)).toBe("openclaw");
  });

  it("getHonchoFor memoizes per-workspace Honcho client instances", () => {
    const state = createPluginState(
      createFakeApi({
        apiKey: "test",
        workspaceId: "openclaw",
        agentWorkspaces: {
          personal: "personal_workspace",
          developer: "personal_workspace",
        },
      }),
    );

    const personal1 = state.getHonchoFor("personal");
    const personal2 = state.getHonchoFor("personal");
    const developer = state.getHonchoFor("developer");
    const unmapped = state.getHonchoFor("phone");

    expect(personal1).toBe(personal2); // same workspace, cached
    expect(personal1).toBe(developer); // two agents share a workspace → share a client
    expect(personal1).not.toBe(unmapped); // unmapped fallback has its own client
    expect((unmapped as unknown as { workspaceId: string }).workspaceId).toBe("openclaw");
    expect((personal1 as unknown as { workspaceId: string }).workspaceId).toBe("personal_workspace");
  });

  it("two agents routed to different workspaces do not share state", async () => {
    const state = createPluginState(
      createFakeApi({
        apiKey: "test",
        workspaceId: "openclaw",
        agentWorkspaces: {
          personal: "personal_workspace",
          manager: "ops_workspace",
        },
      }),
    );

    const personalWs = await state.ensureInitializedFor("personal");
    const managerWs = await state.ensureInitializedFor("manager");

    expect(personalWs.workspaceId).toBe("personal_workspace");
    expect(managerWs.workspaceId).toBe("ops_workspace");
    expect(personalWs.honcho).not.toBe(managerWs.honcho);
    expect(personalWs.ownerPeer).not.toBe(managerWs.ownerPeer);
    expect(personalWs.agentPeers).not.toBe(managerWs.agentPeers);
  });

  it("unmapped agents still initialize against the default workspace end-to-end", async () => {
    const state = createPluginState(
      createFakeApi({
        apiKey: "test",
        workspaceId: "openclaw",
        agentWorkspaces: { personal: "personal_workspace" },
      }),
    );

    const fallbackWs = await state.ensureInitializedFor("someRandomAgent");
    expect(fallbackWs.workspaceId).toBe("openclaw");
    expect(fallbackWs.initialized).toBe(true);
    expect(fallbackWs.ownerPeer).not.toBeNull();
  });

  it("backward compatibility: config without agentWorkspaces routes every agent to workspaceId", async () => {
    const state = createPluginState(
      createFakeApi({ apiKey: "test", workspaceId: "OnlyWorkspace" }),
    );

    expect(state.resolveWorkspaceIdForAgent("personal")).toBe("OnlyWorkspace");
    expect(state.resolveWorkspaceIdForAgent("developer")).toBe("OnlyWorkspace");
    const ws1 = await state.ensureInitializedFor("personal");
    const ws2 = await state.ensureInitializedFor("developer");
    expect(ws1).toBe(ws2); // single workspace shared by all agents
    expect(state.workspaces.size).toBe(1);
  });
});
