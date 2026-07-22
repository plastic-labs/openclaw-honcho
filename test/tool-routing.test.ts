import { describe, expect, it, vi } from "vitest";
import { SessionWorkspaceBindingStore } from "../routing.js";
import { registerAskTool } from "../tools/ask.js";
import { registerContextTool } from "../tools/context.js";
import { registerMessageSearchTool } from "../tools/message-search.js";
import { registerSearchTool } from "../tools/search.js";
import { registerSessionTool } from "../tools/session.js";

type Tool = {
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<any>;
};

function toolApi() {
  const factories = new Map<string, (ctx: Record<string, unknown>) => Tool>();
  return {
    api: {
      registerTool(factory: (ctx: Record<string, unknown>) => Tool, opts: { name: string }) {
        factories.set(opts.name, factory);
      },
    } as any,
    build(name: string, ctx: Record<string, unknown>): Tool {
      const factory = factories.get(name);
      if (!factory) throw new Error(`missing tool ${name}`);
      return factory(ctx);
    },
  };
}

function workspace(workspaceId: string) {
  const participant = {
    id: `participant-${workspaceId}`,
    search: vi.fn(async () => []),
    card: vi.fn(async () => [`fact-${workspaceId}`]),
    representation: vi.fn(async () => `representation-${workspaceId}`),
  };
  const agent = {
    id: `agent-${workspaceId}`,
    search: vi.fn(async () => []),
    chat: vi.fn(async () => `answer-${workspaceId}`),
  };
  const session = {
    context: vi.fn(async () => ({ messages: [] })),
  };
  return {
    workspaceId,
    ensureInitialized: vi.fn(async () => undefined),
    resolveDefaultAgentId: vi.fn(() => "main"),
    getParticipantPeer: vi.fn(async () => participant),
    resolveSessionParticipantPeer: vi.fn(async () => participant),
    getAgentPeer: vi.fn(async () => agent),
    isParticipantPeerId: vi.fn(() => false),
    honcho: {
      search: vi.fn(async () => []),
      session: vi.fn(async () => session),
    },
  } as any;
}

function pluginState(config: Record<string, unknown>, workspaces: Record<string, any>) {
  return {
    cfg: config,
    sessionWorkspaceBindings: new SessionWorkspaceBindingStore(),
    honchoSessionWorkspaceBindings: new SessionWorkspaceBindingStore(),
    getWorkspaceState: vi.fn((workspaceId: string) => workspaces[workspaceId]),
  } as any;
}

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "legacy",
    workspaceIdByAgent: { main: "personal" },
    workspaceRoutingRules: [],
    strictWorkspaceRouting: true,
    legacyWorkspaceFallback: false,
    crossSessionSearch: true,
    ...overrides,
  };
}

describe("trusted tool routing", () => {
  it("routes from host delivery context and keeps from=all inside that workspace", async () => {
    const legacy = workspace("legacy");
    const personal = workspace("personal");
    const work = workspace("work");
    const state = pluginState(cfg({
      workspaceRoutingRules: [{ workspaceId: "work", channel: "telegram", destination: "group-42" }],
    }), { legacy, personal, work });
    const { api, build } = toolApi();
    registerMessageSearchTool(api, state);

    const tool = build("honcho_search_messages", {
      agentId: "main",
      sessionKey: "agent:main:telegram:group:42",
      messageChannel: "telegram",
      deliveryContext: { channel: "telegram", to: "group-42", accountId: "bot" },
    });
    await tool.execute("call", { query: "decision", from: "all" });

    expect(work.honcho.search).toHaveBeenCalledWith("decision", expect.any(Object));
    expect(personal.honcho.search).not.toHaveBeenCalled();
    expect(legacy.honcho.search).not.toHaveBeenCalled();
    expect(state.sessionWorkspaceBindings.get("agent:main:telegram:group:42")).toBe("work");
  });

  it("uses the same immutable route for every core tool", async () => {
    const personal = workspace("personal");
    const work = workspace("work");
    const state = pluginState(cfg({
      workspaceRoutingRules: [{ workspaceId: "work", channel: "telegram", destination: "group-42" }],
    }), { personal, work });
    const { api, build } = toolApi();
    registerSessionTool(api, state);
    registerContextTool(api, state);
    registerSearchTool(api, state);
    registerAskTool(api, state);
    registerMessageSearchTool(api, state);
    const trustedContext = {
      agentId: "main",
      sessionKey: "shared-session",
      deliveryContext: { channel: "telegram", to: "group-42" },
    };

    await build("honcho_session", trustedContext).execute("session", {});
    await build("honcho_context", trustedContext).execute("context", { detail: "card" });
    await build("honcho_search_conclusions", trustedContext).execute("search", { query: "q" });
    await build("honcho_ask", trustedContext).execute("ask", { query: "q" });
    await build("honcho_search_messages", trustedContext).execute("messages", { query: "q", from: "all" });

    expect(work.ensureInitialized).toHaveBeenCalledTimes(5);
    expect(work.honcho.session).toHaveBeenCalled();
    expect(work.honcho.search).toHaveBeenCalled();
    expect(work.getAgentPeer).toHaveBeenCalled();
    expect(personal.ensureInitialized).not.toHaveBeenCalled();
    expect(state.sessionWorkspaceBindings.get("shared-session")).toBe("work");
  });

  it("denies unknown and conflicting routes before workspace or Honcho access", async () => {
    const legacy = workspace("legacy");
    const state = pluginState(cfg({ workspaceIdByAgent: {} }), { legacy });
    const { api, build } = toolApi();
    registerAskTool(api, state);

    const unknown = build("honcho_ask", { agentId: "unknown", sessionKey: "unknown-session" });
    await expect(unknown.execute("call", { query: "who?" }))
      .rejects.toThrow(/workspace routing denied: unknown-route/);
    expect(state.getWorkspaceState).not.toHaveBeenCalled();
    expect(legacy.ensureInitialized).not.toHaveBeenCalled();

    const personal = workspace("personal");
    const work = workspace("work");
    const conflictState = pluginState(cfg({
      workspaceRoutingRules: [{ workspaceId: "work", channel: "telegram" }],
    }), { personal, work });
    conflictState.sessionWorkspaceBindings.bind("bound", "personal");
    const registered = toolApi();
    registerAskTool(registered.api, conflictState);
    const conflict = registered.build("honcho_ask", {
      agentId: "main",
      sessionKey: "bound",
      messageChannel: "telegram",
    });
    await expect(conflict.execute("call", { query: "who?" }))
      .rejects.toThrow(/workspace routing denied: binding-conflict/);
    expect(conflictState.getWorkspaceState).not.toHaveBeenCalled();
    expect(personal.ensureInitialized).not.toHaveBeenCalled();
    expect(work.ensureInitialized).not.toHaveBeenCalled();
  });

  it("preserves explicit legacy behavior for a valid session tool call", async () => {
    const legacy = workspace("legacy");
    const state = pluginState(cfg({
      workspaceIdByAgent: {},
      strictWorkspaceRouting: false,
      legacyWorkspaceFallback: true,
    }), { legacy });
    const { api, build } = toolApi();
    registerSessionTool(api, state);

    const tool = build("honcho_session", { agentId: "main", sessionKey: "legacy-session" });
    const result = await tool.execute("call", {});

    expect(legacy.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(legacy.honcho.session).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toMatch(/No conversation history/);
  });
});
