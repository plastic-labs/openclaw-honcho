import { describe, expect, it, vi } from "vitest";
import { registerContextHook } from "../hooks/context.js";
import { registerGatewayHook } from "../hooks/gateway.js";
import { registerSubagentHooks } from "../hooks/subagent.js";
import { resolveWorkspaceRoute, SessionWorkspaceBindingStore } from "../routing.js";
import type { PluginState } from "../state.js";

type Handler = (event: any, ctx: any) => any;

function hookApi() {
  const handlers = new Map<string, Handler[]>();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    api: {
      logger,
      on: vi.fn((name: string, handler: Handler) => {
        const current = handlers.get(name) ?? [];
        current.push(handler);
        handlers.set(name, current);
      }),
    } as any,
    logger,
    handler(name: string, index = 0): Handler {
      const handler = handlers.get(name)?.[index];
      if (!handler) throw new Error(`missing hook: ${name}`);
      return handler;
    },
  };
}

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "legacy",
    baseUrl: "http://127.0.0.1:8000",
    noisePatterns: [],
    disableDefaultNoisePatterns: false,
    ownerObserveOthers: false,
    crossSessionSearch: true,
    workspaceIdByAgent: {},
    workspaceRoutingRules: [],
    strictWorkspaceRouting: false,
    legacyWorkspaceFallback: true,
    ...overrides,
  } as any;
}

function workspace(workspaceId: string) {
  const participant = { id: `participant-${workspaceId}` };
  const agent = { id: `agent-${workspaceId}` };
  const session = {
    context: vi.fn(async () => ({})),
  };
  return {
    cfg: cfg(),
    workspaceId,
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => agent),
    getParticipantPeer: vi.fn(async () => participant),
    resolveSessionParticipantPeer: vi.fn(async () => participant),
    honcho: { session: vi.fn(async () => session) },
    peersPersister: { peers: {} },
  } as any;
}

function pluginState(config: ReturnType<typeof cfg>, workspaces: Record<string, any>): PluginState {
  const defaultWorkspace = workspaces[config.workspaceId] ?? Object.values(workspaces)[0];
  const state = {
    ...defaultWorkspace,
    cfg: config,
    sessionWorkspaceBindings: new SessionWorkspaceBindingStore(),
    subagentRelations: new Map(),
    getWorkspaceState: vi.fn((workspaceId: string) => workspaces[workspaceId]),
    resolveDefaultAgentId: vi.fn(() => "main"),
  };
  return state as unknown as PluginState;
}

describe("context hook routing", () => {
  it("binds from trusted hook fields before touching routed turn state", async () => {
    const legacy = workspace("legacy");
    const routed = workspace("chat-work");
    const state = pluginState(cfg({
      strictWorkspaceRouting: true,
      legacyWorkspaceFallback: false,
      workspaceRoutingRules: [{ workspaceId: "chat-work", channel: "telegram", chatId: "42" }],
    }), { legacy, "chat-work": routed });
    const { api, handler } = hookApi();
    registerContextHook(api, state);

    await handler("before_prompt_build")(
      { prompt: "hello", messages: [{ role: "user" }] },
      { agentId: "main", sessionKey: "session-1", channel: "telegram", chatId: 42 },
    );

    expect(state.sessionWorkspaceBindings.get("session-1")).toBe("chat-work");
    expect(routed.turnStartIndex.size).toBe(1);
    expect(legacy.turnStartIndex.size).toBe(0);
    expect(routed.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(legacy.ensureInitialized).not.toHaveBeenCalled();
  });

  it("denies a strict unknown route before workspace or Honcho access", async () => {
    const legacy = workspace("legacy");
    const state = pluginState(cfg({ strictWorkspaceRouting: true, legacyWorkspaceFallback: false }), { legacy });
    const { api, handler, logger } = hookApi();
    registerContextHook(api, state);

    await handler("before_prompt_build")(
      { prompt: "hello", messages: [] },
      { agentId: "unknown", sessionKey: "strict-unknown" },
    );

    expect(state.getWorkspaceState).not.toHaveBeenCalled();
    expect(legacy.ensureInitialized).not.toHaveBeenCalled();
    expect(legacy.honcho.session).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("[honcho] Context unavailable: workspace routing denied: unknown-route");
  });

  it("denies a missing lifecycle session key even with legacy fallback", async () => {
    const legacy = workspace("legacy");
    const state = pluginState(cfg(), { legacy });
    const { api, handler, logger } = hookApi();
    registerContextHook(api, state);

    await handler("before_prompt_build")(
      { prompt: "hello", messages: [] },
      { agentId: "main" },
    );

    expect(state.getWorkspaceState).not.toHaveBeenCalled();
    expect(legacy.ensureInitialized).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("[honcho] Context unavailable: workspace routing denied: missing-session-key");
  });

  it("preserves explicit legacy default behavior", async () => {
    const legacy = workspace("legacy");
    const state = pluginState(cfg(), { legacy });
    const { api, handler } = hookApi();
    registerContextHook(api, state);

    await handler("before_prompt_build")(
      { prompt: "hello", messages: [] },
      { agentId: "main", sessionKey: "legacy-session" },
    );

    expect(state.sessionWorkspaceBindings.get("legacy-session")).toBe("legacy");
    expect(legacy.ensureInitialized).toHaveBeenCalledTimes(1);
  });
});

describe("subagent route inheritance", () => {
  it("copies the immutable parent binding and retains it after metadata cleanup", async () => {
    const legacy = workspace("legacy");
    const state = pluginState(cfg(), { legacy });
    state.sessionWorkspaceBindings.bind("parent", "workspace-a");
    const { api, handler } = hookApi();
    registerSubagentHooks(api, state);
    handler("before_agent_start")({}, { sessionKey: "parent", agentId: "main" });

    await handler("subagent_spawned")(
      { childSessionKey: "child", agentId: "research", runId: "run", mode: "run", threadRequested: false },
      { childSessionKey: "child", requesterSessionKey: "parent" },
    );

    expect(state.sessionWorkspaceBindings.get("child")).toBe("workspace-a");
    expect(state.subagentRelations.get("child")).toEqual({ parentSessionKey: "parent", parentAgentId: "main" });

    await handler("subagent_ended")(
      { targetSessionKey: "child", targetKind: "subagent", reason: "complete" },
      {},
    );
    expect(state.subagentRelations.has("child")).toBe(false);
    expect(state.sessionWorkspaceBindings.get("child")).toBe("workspace-a");
  });

  it("fails closed on unknown parent and on a conflicting child without rebinding", async () => {
    const legacy = workspace("legacy");
    const state = pluginState(cfg(), { legacy });
    const { api, handler } = hookApi();
    registerSubagentHooks(api, state);

    await handler("subagent_spawned")(
      { childSessionKey: "unknown-child", agentId: "research", runId: "r1", mode: "run", threadRequested: false },
      { childSessionKey: "unknown-child", requesterSessionKey: "missing-parent" },
    );
    expect(resolveWorkspaceRoute(state.cfg, { sessionKey: "unknown-child" }, state.sessionWorkspaceBindings)).toMatchObject({ status: "unknown-route" });

    state.sessionWorkspaceBindings.bind("parent", "workspace-a");
    state.sessionWorkspaceBindings.bind("conflict-child", "workspace-b");
    await handler("subagent_spawned")(
      { childSessionKey: "conflict-child", agentId: "research", runId: "r2", mode: "run", threadRequested: false },
      { childSessionKey: "conflict-child", requesterSessionKey: "parent" },
    );
    expect(state.sessionWorkspaceBindings.get("conflict-child")).toBe("workspace-b");
    expect(state.sessionWorkspaceBindings.isDenied("conflict-child")).toBe(true);
  });
});

describe("gateway initialization", () => {
  it("initializes only the compatibility default and leaves routed workspaces lazy", async () => {
    const legacy = workspace("legacy");
    const routed = workspace("routed");
    const state = pluginState(cfg({ workspaceIdByAgent: { main: "routed" } }), { legacy, routed });
    const { api, handler } = hookApi();
    registerGatewayHook(api, state);

    await handler("gateway_start")({ port: 18789 }, {});

    expect(legacy.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(routed.ensureInitialized).not.toHaveBeenCalled();
  });
});
