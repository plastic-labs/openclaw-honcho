import { describe, expect, it, vi } from "vitest";

import { registerSessionTool } from "./session.js";

type Registration = {
  factory: (ctx: Record<string, unknown>) => Record<string, unknown>;
  opts?: Record<string, unknown>;
};

function buildState(opts: { contextResponse: any; workspaceId?: string }) {
  const ownerPeer = { id: "owner" };
  const agentPeer = { id: "agent-developer" };
  const ws = {
    workspaceId: opts.workspaceId ?? "personal_workspace",
    ownerPeer,
    honcho: {
      session: vi.fn(async () => ({
        context: vi.fn(async () => opts.contextResponse),
      })),
    },
  };
  return {
    state: {
      ensureInitializedFor: vi.fn(async () => ws),
      getAgentPeerFor: vi.fn(async () => agentPeer),
    },
    ws,
  };
}

function registerAndGet(stateLike: any) {
  const registrations: Registration[] = [];
  const api = {
    registerTool: (
      factory: (ctx: Record<string, unknown>) => Record<string, unknown>,
      opts?: Record<string, unknown>
    ) => {
      registrations.push({ factory, opts });
    },
  };
  registerSessionTool(api as never, stateLike as never);
  expect(registrations).toHaveLength(1);
  expect(registrations[0]?.opts).toEqual({ name: "honcho_session" });
  return registrations[0]!;
}

describe("honcho_session tool", () => {
  it("includes workspaceId in details when no history is available", async () => {
    const { state, ws } = buildState({
      contextResponse: {
        summary: { content: "" },
        peerCard: [],
        peerRepresentation: "",
        messages: [],
      },
    });
    const reg = registerAndGet(state);
    const tool = reg.factory({
      agentId: "developer",
      sessionKey: "agent-developer-discord-channel-1234567890123456789",
      messageProvider: "discord",
    }) as { execute: (id: string, params: unknown) => Promise<any> };

    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toBe(
      "No conversation history available for this session yet."
    );
    expect(result.details).toEqual({
      messageCount: 0,
      hasSummary: false,
      sessionKey: "agent-developer-discord-channel-1234567890123456789-discord",
      workspaceId: ws.workspaceId,
    });
  });

  it("includes workspaceId in details when context returns messages", async () => {
    const { state, ws } = buildState({
      contextResponse: {
        summary: { content: "earlier summary" },
        peerCard: ["fact"],
        peerRepresentation: "rep",
        messages: [
          { peerId: "owner", content: "hi", createdAt: new Date().toISOString() },
        ],
      },
    });
    const reg = registerAndGet(state);
    const tool = reg.factory({
      agentId: "developer",
      sessionKey: "agent-developer-discord-channel-1234567890123456789",
      messageProvider: "discord",
    }) as { execute: (id: string, params: unknown) => Promise<any> };

    const result = await tool.execute("call-1", {});

    expect(result.details.messageCount).toBe(1);
    expect(result.details.workspaceId).toBe(ws.workspaceId);
    expect(result.details.sessionKey).toBe(
      "agent-developer-discord-channel-1234567890123456789-discord"
    );
  });

  it("resolves session key from messageChannel when tool ctx omits messageProvider", async () => {
    // Real OpenClaw tool ctx exposes messageChannel, not messageProvider. The tool
    // must still build a `…-discord` session key so it reads the slot the capture
    // hook wrote to — never fall back to `-unknown`.
    const { state, ws } = buildState({
      contextResponse: {
        summary: { content: "earlier summary" },
        peerCard: [],
        peerRepresentation: "",
        messages: [
          { peerId: "owner", content: "hi", createdAt: new Date().toISOString() },
        ],
      },
    });
    const reg = registerAndGet(state);
    const tool = reg.factory({
      agentId: "developer",
      sessionKey: "agent:developer:discord:channel:1234567890123456789",
      messageChannel: "discord",
    }) as { execute: (id: string, params: unknown) => Promise<any> };

    const result = await tool.execute("call-1", {});

    expect(result.details.sessionKey).toBe(
      "agent-developer-discord-channel-1234567890123456789-discord"
    );
    expect(result.details.sessionKey).not.toContain("-unknown");
    expect(result.details.workspaceId).toBe(ws.workspaceId);
    expect(result.details.messageCount).toBe(1);
  });

  it("includes workspaceId on NotFound short-circuit", async () => {
    const ownerPeer = { id: "owner" };
    const agentPeer = { id: "agent-developer" };
    const notFound = Object.assign(new Error("Session not found"), {
      name: "NotFoundError",
    });
    const ws = {
      workspaceId: "personal_workspace",
      ownerPeer,
      honcho: {
        session: vi.fn(async () => {
          throw notFound;
        }),
      },
    };
    const state = {
      ensureInitializedFor: vi.fn(async () => ws),
      getAgentPeerFor: vi.fn(async () => agentPeer),
    };

    const reg = registerAndGet(state);
    const tool = reg.factory({
      agentId: "developer",
      sessionKey: "agent-developer-discord-channel-1234567890123456789",
      messageProvider: "discord",
    }) as { execute: (id: string, params: unknown) => Promise<any> };

    const result = await tool.execute("call-1", {});
    expect(result.details).toEqual({
      messageCount: 0,
      hasSummary: false,
      sessionKey: "agent-developer-discord-channel-1234567890123456789-discord",
      workspaceId: "personal_workspace",
    });
  });
});
