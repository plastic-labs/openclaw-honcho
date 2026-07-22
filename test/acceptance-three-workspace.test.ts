import { describe, expect, it, vi } from "vitest";
import { honchoConfigSchema } from "../config.js";
import { registerContextHook } from "../hooks/context.js";
import { registerCaptureHook } from "../hooks/capture.js";
import { SessionWorkspaceBindingStore } from "../routing.js";
import { registerMessageSearchTool } from "../tools/message-search.js";

type Handler = (event: any, ctx: any) => Promise<any> | any;

function metadata(senderId: string): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({ sender_id: senderId }),
    "```",
  ].join("\n");
}

function workspace(workspaceId: string) {
  const session = {
    metadata: {} as Record<string, unknown>,
    context: vi.fn(async () => ({ peerCard: [`context-${workspaceId}`] })),
    getMetadata: vi.fn(async () => session.metadata),
    setMetadata: vi.fn(async (next: Record<string, unknown>) => { session.metadata = next; }),
    addPeers: vi.fn(async () => undefined),
    addMessages: vi.fn(async () => undefined),
  };
  const participant = {
    id: `participant-${workspaceId}`,
    message: vi.fn((text: string) => ({ text })),
    search: vi.fn(async () => []),
  };
  const agent = {
    id: `agent-${workspaceId}`,
    message: vi.fn((text: string) => ({ text })),
    search: vi.fn(async () => []),
  };
  return {
    workspaceId,
    cfg: { noisePatterns: [], ownerObserveOthers: false },
    participantPeers: new Map(),
    agentPeers: new Map(),
    agentPeerMap: {} as Record<string, string>,
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    resolveDefaultAgentId: vi.fn(() => "main"),
    getAgentPeer: vi.fn(async () => agent),
    getParticipantPeer: vi.fn(async () => participant),
    resolveSessionParticipantPeer: vi.fn(async () => participant),
    isParticipantPeerId: vi.fn((id: string) => id === participant.id),
    withSessionLock: vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation()),
    honcho: {
      session: vi.fn(async () => session),
      search: vi.fn(async () => []),
    },
    peersPersister: { filePath: `/isolated/${workspaceId}/peers.json`, peers: {} },
    session,
  } as any;
}

describe("post-phase-6 three-workspace acceptance", () => {
  it("runs personal, routed work, and agent-wide sessions in parallel without cross-workspace access", async () => {
    const workspaces = {
      legacy: workspace("legacy"),
      personal: workspace("personal"),
      work: workspace("work"),
      masha: workspace("masha"),
    };
    const cfg = honchoConfigSchema.parse({
      workspaceId: "legacy",
      workspaceIdByAgent: { main: "personal", masha: "masha" },
      workspaceRoutingRules: [{
        workspaceId: "work",
        agentId: "main",
        channel: "telegram",
        conversationTarget: "work-group",
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
      getWorkspaceState: vi.fn((id: keyof typeof workspaces) => workspaces[id]),
    } as any;

    registerContextHook(api, state);
    registerCaptureHook(api, state);
    registerMessageSearchTool(api, state);

    const visibleText = "Одинаковый видимый текст во всех трёх workspace.";
    const routes = [
      {
        workspace: "personal" as const,
        hook: { agentId: "main", sessionKey: "same-looking:personal", channel: "telegram", chatId: "private" },
        tool: { agentId: "main", sessionKey: "same-looking:personal", messageChannel: "telegram", deliveryContext: { channel: "telegram", to: "telegram:private" } },
      },
      {
        workspace: "work" as const,
        hook: { agentId: "main", sessionKey: "same-looking:work", channel: "telegram", chatId: "work-group" },
        tool: { agentId: "main", sessionKey: "same-looking:work", messageChannel: "telegram", deliveryContext: { channel: "telegram", to: "telegram:work-group" } },
      },
      {
        workspace: "masha" as const,
        hook: { agentId: "masha", sessionKey: "same-looking:masha", channel: "telegram", chatId: "anya" },
        tool: { agentId: "masha", sessionKey: "same-looking:masha", messageChannel: "telegram", deliveryContext: { channel: "telegram", to: "telegram:anya" } },
      },
    ];

    await Promise.all(routes.map(async (route, index) => {
      const prompt = `[Wed 2026-07-22 17:00 MSK] ${metadata(`sender-${index}`)}\n\n${visibleText}`;
      await handlers.get("before_prompt_build")!({ prompt, messages: [] }, route.hook);
      await handlers.get("agent_end")!({
        success: true,
        messages: [{ role: "user", content: prompt, timestamp: index + 1 }],
      }, route.hook);
      const tool = searchFactory(route.tool);
      await tool.execute(`call-${index}`, { query: "видимый", from: "all" });
    }));

    for (const route of routes) {
      const selected = workspaces[route.workspace];
      expect(state.sessionWorkspaceBindings.get(route.hook.sessionKey)).toBe(route.workspace);
      expect(selected.session.addMessages).toHaveBeenCalledWith([{ text: visibleText }]);
      expect(selected.honcho.search).toHaveBeenCalledTimes(1);
      expect(selected.withSessionLock).toHaveBeenCalledTimes(1);
    }

    expect(workspaces.legacy.ensureInitialized).not.toHaveBeenCalled();
    expect(workspaces.legacy.honcho.session).not.toHaveBeenCalled();
    expect(workspaces.legacy.honcho.search).not.toHaveBeenCalled();
    expect(new Set(routes.map((route) => workspaces[route.workspace].peersPersister.filePath)).size).toBe(3);
    expect(workspaces.personal.participantPeers).not.toBe(workspaces.work.participantPeers);
    expect(workspaces.personal.turnStartIndex).not.toBe(workspaces.masha.turnStartIndex);
  });
});
