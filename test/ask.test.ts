import { describe, expect, it, vi } from "vitest";
import { registerAskTool } from "../tools/ask.js";

function createRegistration() {
  const registrations: Array<{
    factory: (ctx: Record<string, unknown>) => Record<string, unknown>;
    opts?: Record<string, unknown>;
  }> = [];
  const api = {
    registerTool: (
      factory: (ctx: Record<string, unknown>) => Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => registrations.push({ factory, opts }),
  };
  return { api, registrations };
}

describe("honcho_ask tool", () => {
  it("registers the tool contract and returns chat answers", async () => {
    const { api, registrations } = createRegistration();
    const participantPeer = { id: "owner" };
    const agentPeer = {
      id: "agent-main",
      chat: vi.fn(async () => "dialect answer"),
    };
    const state = {
      api: { logger: { debug: vi.fn(), warn: vi.fn() } },
      ensureInitialized: vi.fn(async () => {}),
      getAgentPeer: vi.fn(async () => agentPeer),
      resolveSessionParticipantPeer: vi.fn(async () => participantPeer),
      getParticipantPeer: vi.fn(),
    };

    registerAskTool(api as never, state as never);

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.opts).toEqual({ name: "honcho_ask" });

    const tool = registrations[0]!.factory({
      agentId: "main",
      sessionKey: "agent:main:discord:dm:user-1",
    }) as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute("call-1", {
      query: "Can dialect calls answer?",
      depth: "quick",
    });

    expect(agentPeer.chat).toHaveBeenCalledWith("Can dialect calls answer?", {
      target: participantPeer,
      reasoningLevel: "low",
    });
    expect(result.content).toEqual([{ type: "text", text: "dialect answer" }]);
    expect(result.details).toMatchObject({ query: "Can dialect calls answer?", depth: "quick" });
    expect(result.details.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("returns structured tool errors instead of throwing raw SDK failures", async () => {
    const { api, registrations } = createRegistration();
    const agentPeer = {
      id: "agent-main",
      chat: vi.fn(async () => {
        throw new Error("Request timed out after 30000ms");
      }),
    };
    const state = {
      api: { logger: { debug: vi.fn(), warn: vi.fn() } },
      ensureInitialized: vi.fn(async () => {}),
      getAgentPeer: vi.fn(async () => agentPeer),
      resolveSessionParticipantPeer: vi.fn(async () => ({ id: "owner" })),
      getParticipantPeer: vi.fn(),
    };

    registerAskTool(api as never, state as never);
    const tool = registrations[0]!.factory({
      agentId: "main",
      sessionKey: "agent:main:discord:dm:user-1",
    }) as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
        content: Array<{ text: string }>;
        isError?: boolean;
        details?: Record<string, unknown>;
      }>;
    };

    const result = await tool.execute("call-1", {
      query: "Will this fail?",
      depth: "thorough",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Honcho dialect call failed");
    expect(result.content[0]?.text).toContain("Request timed out after 30000ms");
    expect(result.content[0]?.text).toContain("honcho_context");
    expect(result.details).toMatchObject({
      query: "Will this fail?",
      depth: "thorough",
      error: "Request timed out after 30000ms",
    });
    expect(state.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[honcho_ask] Dialect call failed"),
    );
  });

  it("uses explicit participant peers and maps thorough depth to high reasoning", async () => {
    const { api, registrations } = createRegistration();
    const participantPeer = { id: "participant-other" };
    const agentPeer = {
      id: "agent-main",
      chat: vi.fn(async () => null),
    };
    const state = {
      api: { logger: { debug: vi.fn(), warn: vi.fn() } },
      ensureInitialized: vi.fn(async () => {}),
      getAgentPeer: vi.fn(async () => agentPeer),
      resolveSessionParticipantPeer: vi.fn(),
      getParticipantPeer: vi.fn(async () => participantPeer),
    };

    registerAskTool(api as never, state as never);
    const tool = registrations[0]!.factory({ agentId: "main" }) as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
        content: Array<{ text: string }>;
      }>;
    };

    const result = await tool.execute("call-1", {
      query: "Summarize",
      depth: "thorough",
      about: "other",
    });

    expect(state.getParticipantPeer).toHaveBeenCalledWith("other");
    expect(state.resolveSessionParticipantPeer).not.toHaveBeenCalled();
    expect(agentPeer.chat).toHaveBeenCalledWith("Summarize", {
      target: participantPeer,
      reasoningLevel: "high",
    });
    expect(result.content[0]?.text).toBe("No information available.");
  });
});
