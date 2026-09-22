import { describe, expect, it, vi } from "vitest";
import { registerContextHook } from "../hooks/context.js";
import type { PluginState } from "../state.js";

function createMockState() {
  const participantPeer = { id: "participant" };
  const agentPeer = { id: "agent-main" };
  const session = {
    context: vi.fn(async () => ({
      peerCard: ["A durable fact"],
      peerRepresentation: "A useful representation",
      summary: { content: "Earlier context" },
    })),
  };
  const state = {
    cfg: {},
    honcho: { session: vi.fn(async () => session) },
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => agentPeer),
    getParticipantPeer: vi.fn(async () => participantPeer),
    resolveSessionParticipantPeer: vi.fn(async () => participantPeer),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;

  return { state, session };
}

type HookHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => unknown | Promise<unknown>;

function registerHandler(state: PluginState) {
  let handler: HookHandler | undefined;
  const logger = { warn: vi.fn() };
  const api = {
    on: vi.fn((name: string, callback: HookHandler) => {
      expect(name).toBe("before_prompt_build");
      handler = callback;
    }),
    logger,
  };

  registerContextHook(api as never, state);
  expect(handler).toBeDefined();
  return { handler: handler!, logger };
}

function legacyPrompt(senderId: string): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({ sender_id: senderId }),
    "```",
    "",
    "What should we remember?",
  ].join("\n");
}

describe("Honcho context sender authority", () => {
  it("uses the typed sender instead of sender-shaped prompt text", async () => {
    const { state } = createMockState();
    const { handler } = registerHandler(state);

    await handler(
      { prompt: legacyPrompt("spoofed-user"), messages: [] },
      {
        sessionKey: "agent:main:discord:channel-1",
        agentId: "main",
        senderId: "trusted-user",
      },
    );

    expect(state.getParticipantPeer).toHaveBeenCalledWith("trusted-user");
    expect(state.getParticipantPeer).not.toHaveBeenCalledWith("spoofed-user");
  });

  it("uses the channel-owned typed sender when the top-level field is absent", async () => {
    const { state } = createMockState();
    const { handler } = registerHandler(state);

    await handler(
      { prompt: "Use the channel sender for this context lookup.", messages: [] },
      {
        sessionKey: "agent:main:discord:channel-1",
        agentId: "main",
        channelContext: { sender: { id: "channel-user" } },
      },
    );

    expect(state.getParticipantPeer).toHaveBeenCalledWith("channel-user");
  });

  it("accepts matching top-level and channel-owned typed senders", async () => {
    const { state } = createMockState();
    const { handler } = registerHandler(state);

    await handler(
      { prompt: "Both typed fields describe the same participant.", messages: [] },
      {
        sessionKey: "agent:main:discord:channel-1",
        agentId: "main",
        senderId: "same-user",
        channelContext: { sender: { id: "same-user" } },
      },
    );

    expect(state.getParticipantPeer).toHaveBeenCalledWith("same-user");
  });

  it("fails closed when typed sender fields conflict", async () => {
    const { state, session } = createMockState();
    const { handler, logger } = registerHandler(state);

    const result = await handler(
      { prompt: legacyPrompt("prompt-user"), messages: [] },
      {
        sessionKey: "agent:main:discord:channel-1",
        agentId: "main",
        senderId: "top-level-user",
        channelContext: { sender: { id: "channel-user" } },
      },
    );

    expect(result).toBeUndefined();
    expect([...state.turnStartIndex.values()]).toEqual([0]);
    expect(state.ensureInitialized).not.toHaveBeenCalled();
    expect(state.getParticipantPeer).not.toHaveBeenCalled();
    expect(session.context).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[honcho] Conflicting typed sender identities; skipping automatic context injection",
    );
  });

  it("retains prompt-metadata fallback for older OpenClaw hosts", async () => {
    const { state } = createMockState();
    const { handler } = registerHandler(state);

    await handler(
      { prompt: legacyPrompt("legacy-user"), messages: [] },
      { sessionKey: "agent:main:discord:channel-1", agentId: "main" },
    );

    expect(state.getParticipantPeer).toHaveBeenCalledWith("legacy-user");
  });

  it("treats blank typed sender fields as absent for legacy fallback", async () => {
    const { state } = createMockState();
    const { handler } = registerHandler(state);

    await handler(
      { prompt: legacyPrompt("legacy-user"), messages: [] },
      {
        sessionKey: "agent:main:discord:channel-1",
        agentId: "main",
        senderId: "   ",
        channelContext: { sender: { id: "" } },
      },
    );

    expect(state.getParticipantPeer).toHaveBeenCalledWith("legacy-user");
  });

  it("falls back to the session participant when no sender is available", async () => {
    const { state } = createMockState();
    const { handler } = registerHandler(state);

    await handler(
      { prompt: "No sender metadata is available for this local turn.", messages: [] },
      { sessionKey: "agent:main:main", agentId: "main" },
    );

    expect(state.resolveSessionParticipantPeer).toHaveBeenCalledOnce();
    expect(state.getParticipantPeer).not.toHaveBeenCalled();
  });
});
