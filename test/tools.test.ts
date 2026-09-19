import { describe, expect, it, vi } from "vitest";
import { registerAskTool } from "../tools/ask.js";
import { registerSearchTool } from "../tools/search.js";
import { registerContextTool } from "../tools/context.js";
import type { PluginState } from "../state.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

function captureRegistrations() {
  const registrations: Array<{
    factory: (ctx: Record<string, unknown>) => ToolDef;
    opts?: Record<string, unknown>;
  }> = [];
  return {
    registrations,
    api: {
      registerTool: (
        factory: (ctx: Record<string, unknown>) => ToolDef,
        opts?: Record<string, unknown>,
      ) => {
        registrations.push({ factory, opts });
      },
    },
  };
}

function makeParticipantPeer() {
  return {
    id: "owner",
    representation: vi.fn(async (opts?: Record<string, unknown>) => {
      if (opts && !("session" in opts)) {
        throw new Error("representation() received unexpected options");
      }
      return "Full representation text";
    }),
    card: vi.fn(async () => ["Fact 1", "Fact 2"]),
  };
}

function makeAgentPeer() {
  return {
    id: "agent-main",
    chat: vi.fn(async (_query: string, opts?: Record<string, unknown>) => {
      if (opts && !("session" in opts)) {
        throw new Error("chat() received unexpected options");
      }
      return "Honcho answer";
    }),
  };
}

function createMockState(
  participantPeer = makeParticipantPeer(),
  agentPeer = makeAgentPeer(),
) {
  return {
    state: {
      ensureInitialized: vi.fn(async () => undefined),
      getAgentPeer: vi.fn(async () => agentPeer),
      getParticipantPeer: vi.fn(async () => participantPeer),
      resolveSessionParticipantPeer: vi.fn(async () => participantPeer),
    } as unknown as PluginState,
    participantPeer,
    agentPeer,
  };
}

const TOOL_CTX = {
  sessionKey: "agent:main:dashboard:test",
  agentId: "main",
};

describe("honcho_ask session_id", () => {
  it("passes session to agentPeer.chat when session_id is provided", async () => {
    const { api, registrations } = captureRegistrations();
    const { state, agentPeer } = createMockState();

    registerAskTool(api as never, state);
    const tool = registrations[0]!.factory(TOOL_CTX);

    await tool.execute("call-1", { query: "What's their name?", session_id: "sess-123" });

    const [, opts] = agentPeer.chat.mock.calls[0] as [string, Record<string, unknown>];
    expect(opts.session).toBe("sess-123");
  });

  it("passes undefined session when session_id is omitted", async () => {
    const { api, registrations } = captureRegistrations();
    const { state, agentPeer } = createMockState();

    registerAskTool(api as never, state);
    const tool = registrations[0]!.factory(TOOL_CTX);

    await tool.execute("call-1", { query: "What's their name?" });

    const [, opts] = agentPeer.chat.mock.calls[0] as [string, Record<string, unknown>];
    expect(opts.session).toBeUndefined();
  });
});

describe("honcho_search_conclusions session_id", () => {
  it("passes session to participantPeer.representation when session_id is provided", async () => {
    const { api, registrations } = captureRegistrations();
    const { state, participantPeer } = createMockState();

    registerSearchTool(api as never, state);
    const tool = registrations[0]!.factory(TOOL_CTX);

    await tool.execute("call-1", { query: "preferences", session_id: "sess-456" });

    const [opts] = participantPeer.representation.mock.calls[0] as [Record<string, unknown>];
    expect(opts.session).toBe("sess-456");
    expect(opts.searchQuery).toBe("preferences");
  });

  it("passes undefined session when session_id is omitted", async () => {
    const { api, registrations } = captureRegistrations();
    const { state, participantPeer } = createMockState();

    registerSearchTool(api as never, state);
    const tool = registrations[0]!.factory(TOOL_CTX);

    await tool.execute("call-1", { query: "preferences" });

    const [opts] = participantPeer.representation.mock.calls[0] as [Record<string, unknown>];
    expect(opts.session).toBeUndefined();
  });
});

describe("honcho_context session_id", () => {
  it("passes session to representation in 'full' mode when session_id is provided", async () => {
    const { api, registrations } = captureRegistrations();
    const { state, participantPeer } = createMockState();

    registerContextTool(api as never, state);
    const tool = registrations[0]!.factory(TOOL_CTX);

    await tool.execute("call-1", { detail: "full", session_id: "sess-789" });

    const [opts] = participantPeer.representation.mock.calls[0] as [Record<string, unknown>];
    expect(opts.session).toBe("sess-789");
    expect(opts.includeMostFrequent).toBe(true);
  });

  it("passes undefined session in 'full' mode when session_id is omitted", async () => {
    const { api, registrations } = captureRegistrations();
    const { state, participantPeer } = createMockState();

    registerContextTool(api as never, state);
    const tool = registrations[0]!.factory(TOOL_CTX);

    await tool.execute("call-1", { detail: "full" });

    const [opts] = participantPeer.representation.mock.calls[0] as [Record<string, unknown>];
    expect(opts.session).toBeUndefined();
  });

  it("ignores session_id in 'card' mode — card() receives no session arg", async () => {
    const { api, registrations } = captureRegistrations();
    const { state, participantPeer } = createMockState();

    registerContextTool(api as never, state);
    const tool = registrations[0]!.factory(TOOL_CTX);

    await tool.execute("call-1", { detail: "card", session_id: "sess-789" });

    expect(participantPeer.card).toHaveBeenCalled();
    expect(participantPeer.representation).not.toHaveBeenCalled();
  });
});
