import { describe, expect, it, vi } from "vitest";
import { registerContextHook } from "../hooks/context.js";
import type { PluginState } from "../state.js";

function createMockState({
  contextMaxConclusions,
}: {
  contextMaxConclusions?: number;
} = {}) {
  const participantPeer = { id: "user-1" };
  const agentPeer = { id: "agent-main", context: vi.fn() };
  const session = {
    context: vi.fn(async () => ({
      peerCard: ["IDENTITY: Name: Renaud"],
      peerRepresentation: "## Explicit Observations\n\nlarge representation",
      summary: { content: "Earlier summary" },
    })),
  };

  const state = {
    cfg: {
      workspaceId: "openclaw",
      baseUrl: "https://api.honcho.dev",
      noisePatterns: [],
      disableDefaultNoisePatterns: false,
      ownerObserveOthers: false,
      crossSessionSearch: true,
      contextMaxConclusions,
    },
    honcho: {
      session: vi.fn(async () => session),
    },
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => agentPeer),
    getParticipantPeer: vi.fn(async () => participantPeer),
    resolveSessionParticipantPeer: vi.fn(async () => participantPeer),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;

  return { state, session, agentPeer };
}

function registerHandler(state: PluginState) {
  const handlers: Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>> = [];
  const api = {
    on: vi.fn((name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>) => {
      expect(name).toBe("before_prompt_build");
      handlers.push(handler);
    }),
    logger: { warn: vi.fn() },
  };

  registerContextHook(api as never, state);
  expect(handlers).toHaveLength(1);
  return handlers[0]!;
}

describe("Honcho context injection", () => {
  it("passes contextMaxConclusions to session.context representation options", async () => {
    const { state, session } = createMockState({ contextMaxConclusions: 25 });
    const handler = registerHandler(state);

    const result = await handler(
      {
        prompt: "hello from user",
        messages: [{ role: "user", content: "hello" }],
      },
      { sessionKey: "agent:main:telegram:user-1", agentId: "main" },
    ) as { appendSystemContext: string };

    expect(session.context).toHaveBeenCalledWith(expect.objectContaining({
      representationOptions: { maxConclusions: 25 },
    }));
    expect(result.appendSystemContext).toContain("User context:");
    expect(result.appendSystemContext).toContain("large representation");
  });

  it("passes contextMaxConclusions directly to agentPeer.context for subagent sessions", async () => {
    const { state, agentPeer } = createMockState({ contextMaxConclusions: 25 });
    agentPeer.context.mockResolvedValue({
      peerCard: ["IDENTITY: Name: Renaud"],
      representation: "Subagent user context data",
    });
    const handler = registerHandler(state);

    const result = await handler(
      {
        prompt: "hello from user",
        messages: [{ role: "user", content: "hello" }],
      },
      { sessionKey: "agent:main:subagent:research-1", agentId: "main" },
    ) as { appendSystemContext: string };

    expect(agentPeer.context).toHaveBeenCalledWith(expect.objectContaining({
      maxConclusions: 25,
    }));
    expect(agentPeer.context).not.toHaveBeenCalledWith(expect.objectContaining({
      representationOptions: expect.anything(),
    }));
    expect(result.appendSystemContext).toContain("User context:");
    expect(result.appendSystemContext).toContain("Subagent user context data");
  });
});
