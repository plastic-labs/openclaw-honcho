import { describe, expect, it, vi } from "vitest";
import { honchoConfigSchema } from "../config.js";
import { registerContextHook } from "../hooks/context.js";
import { registerCaptureHook } from "../hooks/capture.js";
import { SessionWorkspaceBindingStore } from "../routing.js";
import { registerMessageSearchTool } from "../tools/message-search.js";

type Handler = (event: any, ctx: any) => Promise<any> | any;

function workspace(workspaceId: string) {
  const session = {
    metadata: {} as Record<string, unknown>,
    context: vi.fn(async () => ({})),
    getMetadata: vi.fn(async () => session.metadata),
    setMetadata: vi.fn(async (next: Record<string, unknown>) => { session.metadata = next; }),
    addPeers: vi.fn(async () => undefined),
    addMessages: vi.fn(async () => undefined),
  };
  const participant = {
    id: `participant-${workspaceId}`,
    message: vi.fn((text: string) => ({ text })),
  };
  const agent = {
    id: `agent-${workspaceId}`,
    message: vi.fn((text: string) => ({ text })),
  };
  return {
    workspaceId,
    cfg: { noisePatterns: [], ownerObserveOthers: false },
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    resolveDefaultAgentId: vi.fn(() => "main"),
    getAgentPeer: vi.fn(async () => agent),
    getParticipantPeer: vi.fn(async () => participant),
    resolveSessionParticipantPeer: vi.fn(async () => participant),
    withSessionLock: vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation()),
    honcho: {
      session: vi.fn(async () => session),
      search: vi.fn(async () => []),
    },
    session,
  } as any;
}

describe("cross-surface route identity", () => {
  it("keeps hook context, agent_end capture, and tool access in the same explicit workspace", async () => {
    const legacy = workspace("legacy");
    const personal = workspace("personal");
    const work = workspace("work");
    const cfg = honchoConfigSchema.parse({
      workspaceId: "legacy",
      workspaceIdByAgent: { main: "personal" },
      workspaceRoutingRules: [{
        workspaceId: "work",
        agentId: "main",
        channel: "telegram",
        conversationTarget: "group-42",
      }],
      strictWorkspaceRouting: true,
    });
    const handlers = new Map<string, Handler>();
    let searchFactory!: (ctx: Record<string, unknown>) => any;
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
      registerTool: vi.fn((factory: typeof searchFactory, options: { name: string }) => {
        if (options.name === "honcho_search_messages") searchFactory = factory;
      }),
    } as any;
    const state = {
      cfg,
      sessionWorkspaceBindings: new SessionWorkspaceBindingStore(),
      honchoSessionWorkspaceBindings: new SessionWorkspaceBindingStore(),
      subagentRelations: new Map(),
      resolveDefaultAgentId: vi.fn(() => "main"),
      getWorkspaceState: vi.fn((id: string) => ({ legacy, personal, work })[id as "legacy" | "personal" | "work"]),
    } as any;

    registerContextHook(api, state);
    registerCaptureHook(api, state);
    registerMessageSearchTool(api, state);

    const hookContext = {
      agentId: "main",
      sessionKey: "one-session",
      channel: "telegram",
      chatId: "group-42",
    };
    await handlers.get("before_prompt_build")!(
      { prompt: "visible user text", messages: [] },
      hookContext,
    );
    await handlers.get("agent_end")!(
      {
        success: true,
        messages: [
          { role: "user", content: "visible user text", timestamp: 1 },
          { role: "assistant", content: "visible assistant text", timestamp: 2 },
        ],
      },
      hookContext,
    );
    const tool = searchFactory({
      agentId: "main",
      sessionKey: "one-session",
      messageChannel: "telegram",
      deliveryContext: { channel: "telegram", to: "telegram:group-42" },
    });
    await tool.execute("call", { query: "visible", from: "all" });

    expect(state.sessionWorkspaceBindings.get("one-session")).toBe("work");
    expect(work.session.addMessages).toHaveBeenCalledWith([
      { text: "visible user text" },
      { text: "visible assistant text" },
    ]);
    expect(work.honcho.search).toHaveBeenCalledTimes(1);
    expect(personal.ensureInitialized).not.toHaveBeenCalled();
    expect(personal.honcho.session).not.toHaveBeenCalled();
    expect(personal.honcho.search).not.toHaveBeenCalled();
    expect(legacy.ensureInitialized).not.toHaveBeenCalled();
    expect(legacy.honcho.session).not.toHaveBeenCalled();
    expect(legacy.honcho.search).not.toHaveBeenCalled();
  });
});
