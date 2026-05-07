import { describe, expect, it, vi } from "vitest";
import { registerCaptureHook } from "../hooks/capture.js";
import type { PluginState } from "../state.js";

type HookMap = Map<string, (event: any, ctx: any) => Promise<void> | void>;
type SavedMessage = { peerId: string; content: string; opts?: unknown };

function createPeer(id: string, saved: SavedMessage[]) {
  return {
    id,
    message(content: string, opts?: unknown) {
      return { peerId: id, content, opts };
    },
    getMetadata: vi.fn(async () => ({})),
    setMetadata: vi.fn(async () => {}),
  } as never;
}

function createHarness() {
  const hooks: HookMap = new Map();
  const saved: SavedMessage[] = [];
  const metadataBySession = new Map<string, Record<string, unknown>>();
  const peers = new Map<string, ReturnType<typeof createPeer>>();

  function peer(id: string) {
    if (!peers.has(id)) peers.set(id, createPeer(id, saved));
    return peers.get(id)!;
  }

  const sessions = new Map<string, Record<string, unknown>>();
  function session(name: string) {
    if (!sessions.has(name)) {
      sessions.set(name, {
        getMetadata: vi.fn(async () => metadataBySession.get(name) ?? {}),
        setMetadata: vi.fn(async (meta: Record<string, unknown>) => {
          metadataBySession.set(name, meta);
        }),
        addPeers: vi.fn(async () => {}),
        addMessages: vi.fn(async (messages: SavedMessage[]) => {
          saved.push(...messages);
        }),
      });
    }
    return sessions.get(name)!;
  }

  const api = {
    on(name: string, handler: HookMap extends Map<string, infer H> ? H : never) {
      hooks.set(name, handler);
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };

  const state = {
    cfg: {
      workspaceId: "openclaw",
      baseUrl: "http://localhost:8000",
      noisePatterns: [],
      disableDefaultNoisePatterns: false,
      ownerObserveOthers: false,
      crossSessionSearch: true,
    },
    honcho: { session: vi.fn(async (name: string) => session(name)) },
    participantPeers: new Map(),
    agentPeers: new Map(),
    agentPeerMap: {},
    turnStartIndex: new Map<string, number>(),
    initialized: true,
    api: api as never,
    ensureInitialized: vi.fn(async () => {}),
    getAgentPeer: vi.fn(async (agentId = "main") => peer(`agent-${agentId}`)),
    getParticipantPeer: vi.fn(async (senderId = "owner") => peer(senderId)),
    resolveSessionParticipantPeer: vi.fn(async () => peer("owner")),
    isParticipantPeerId: vi.fn((peerId: string) => peerId === "owner"),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;

  registerCaptureHook(api as never, state);
  return { hooks, saved };
}

describe("capture sender attribution", () => {
  it("uses structured message_received senderId when text metadata was stripped", async () => {
    const { hooks, saved } = createHarness();
    const ctx = {
      sessionKey: "agent-main-discord-channel-123",
      messageProvider: "discord",
      agentId: "main",
    };

    await hooks.get("message_received")?.({
      senderId: "425084004937760780",
      sessionKey: ctx.sessionKey,
      messageId: "discord-message-1",
      metadata: { provider: "discord" },
    }, ctx);

    await hooks.get("agent_end")?.({
      success: true,
      messages: [
        { role: "user", content: "stripped hello", messageId: "discord-message-1" },
      ],
    }, ctx);

    expect(saved).toEqual([
      expect.objectContaining({
        peerId: "425084004937760780",
        content: "stripped hello",
      }),
    ]);
  });

  it("does not guess attribution when no structured key matches", async () => {
    const { hooks, saved } = createHarness();
    const ctx = {
      sessionKey: "agent-main-discord-channel-456",
      messageProvider: "discord",
      agentId: "main",
    };

    await hooks.get("message_received")?.({
      senderId: "425084004937760780",
      sessionKey: ctx.sessionKey,
      messageId: "discord-message-1",
      metadata: { provider: "discord" },
    }, ctx);

    await hooks.get("agent_end")?.({
      success: true,
      messages: [
        { role: "user", content: "no matching key", messageId: "different-message" },
      ],
    }, ctx);

    expect(saved).toEqual([
      expect.objectContaining({
        peerId: "owner",
        content: "no matching key",
      }),
    ]);
  });

  it("keeps textual Conversation info sender_id authoritative when present", async () => {
    const { hooks, saved } = createHarness();
    const ctx = {
      sessionKey: "agent-main-discord-channel-789",
      messageProvider: "discord",
      agentId: "main",
    };

    await hooks.get("message_received")?.({
      senderId: "wrong-sender",
      sessionKey: ctx.sessionKey,
      messageId: "discord-message-1",
      metadata: { provider: "discord" },
    }, ctx);

    await hooks.get("agent_end")?.({
      success: true,
      messages: [
        {
          role: "user",
          messageId: "discord-message-1",
          content: [
            "Conversation info (untrusted metadata):",
            "```json",
            JSON.stringify({ sender_id: "right-sender" }),
            "```",
            "",
            "metadata hello",
          ].join("\n"),
        },
      ],
    }, ctx);

    expect(saved).toEqual([
      expect.objectContaining({
        peerId: "right-sender",
        content: "metadata hello",
      }),
    ]);
  });
});
