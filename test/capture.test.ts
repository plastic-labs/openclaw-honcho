import { describe, expect, it, vi } from "vitest";
import type { PluginState } from "../state.js";

type HookMap = Map<string, (event: any, ctx: any) => Promise<void> | void>;
type SavedMessage = { peerId: string; content: string; opts?: unknown };

const DISCORD_SENDER_ID = "425084004937760780";

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

async function createHarness() {
  vi.resetModules();
  const { registerCaptureHook } = await import("../hooks/capture.js");

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

function ctx(sessionKey: string) {
  return {
    sessionKey,
    messageProvider: "discord",
    agentId: "main",
  };
}

function conversationInfo(data: Record<string, unknown>, body = "") {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify(data),
    "```",
    body ? "" : undefined,
    body || undefined,
  ].filter((line): line is string => typeof line === "string").join("\n");
}

async function receive(
  hooks: HookMap,
  context: ReturnType<typeof ctx>,
  event: Record<string, unknown> = {},
) {
  await hooks.get("message_received")?.({
    senderId: DISCORD_SENDER_ID,
    sessionKey: context.sessionKey,
    messageId: "discord-message-1",
    metadata: { provider: "discord" },
    ...event,
  }, context);
}

async function endTurn(hooks: HookMap, context: ReturnType<typeof ctx>, messages: unknown[]) {
  await hooks.get("agent_end")?.({ success: true, messages }, context);
}

function expectSaved(saved: SavedMessage[], peerId: string, content: string) {
  expect(saved).toEqual([
    expect.objectContaining({ peerId, content }),
  ]);
}

describe("capture sender attribution", () => {
  it("uses structured message_received senderId when text metadata was stripped", async () => {
    const { hooks, saved } = await createHarness();
    const context = ctx("agent-main-discord-channel-123");

    await receive(hooks, context);
    await endTurn(hooks, context, [
      { role: "user", content: "stripped hello", messageId: "discord-message-1" },
    ]);

    expectSaved(saved, DISCORD_SENDER_ID, "stripped hello");
  });

  it("does not guess attribution when no structured key matches", async () => {
    const { hooks, saved } = await createHarness();
    const context = ctx("agent-main-discord-channel-456");

    await receive(hooks, context);
    await endTurn(hooks, context, [
      { role: "user", content: "no matching key", messageId: "different-message" },
    ]);

    expectSaved(saved, "owner", "no matching key");
  });

  it("uses structured senderId by exact content when transcript has no message id", async () => {
    const { hooks, saved } = await createHarness();
    const context = ctx("agent-main-discord-channel-content");

    await receive(hooks, context, {
      content: "live discord text",
    });
    await endTurn(hooks, context, [
      { role: "user", content: "live discord text" },
    ]);

    expectSaved(saved, DISCORD_SENDER_ID, "live discord text");
  });

  it("uses adjacent OpenClaw runtime-context sender_id when user message has no metadata", async () => {
    const { hooks, saved } = await createHarness();
    const context = ctx("agent-main-discord-channel-runtime-context");

    await endTurn(hooks, context, [
      {
        role: "user",
        content: [{ type: "text", text: "hello from discord" }],
        timestamp: 1778182777904,
      },
      {
        role: "custom",
        customType: "openclaw.runtime-context",
        content: conversationInfo({
          sender_id: DISCORD_SENDER_ID,
          sender: "rendrag",
          message_id: "1502032066576122047",
        }),
        timestamp: 1778182777919,
      },
    ]);

    expectSaved(saved, DISCORD_SENDER_ID, "hello from discord");
  });

  it("does not use content attribution when duplicate text has conflicting senders", async () => {
    const { hooks, saved } = await createHarness();
    const context = ctx("agent-main-discord-channel-duplicate-content");

    await receive(hooks, context, {
      senderId: "sender-one",
      messageId: "discord-message-1",
      content: "same text",
    });
    await receive(hooks, context, {
      senderId: "sender-two",
      messageId: "discord-message-2",
      content: "same text",
    });
    await endTurn(hooks, context, [
      { role: "user", content: "same text" },
    ]);

    expectSaved(saved, "owner", "same text");
  });

  it("keeps textual Conversation info sender_id authoritative when present", async () => {
    const { hooks, saved } = await createHarness();
    const context = ctx("agent-main-discord-channel-789");

    await receive(hooks, context, {
      senderId: "wrong-sender",
    });
    await endTurn(hooks, context, [
      {
        role: "user",
        messageId: "discord-message-1",
        content: conversationInfo({ sender_id: "right-sender" }, "metadata hello"),
      },
    ]);

    expectSaved(saved, "right-sender", "metadata hello");
  });
});
