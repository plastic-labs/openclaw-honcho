import { describe, expect, it, vi } from "vitest";
import { flushMessages } from "../hooks/capture.js";
import type { PluginState } from "../state.js";

const SENTINEL = "Conversation info (untrusted metadata):";

function metadataBlock(payload: Record<string, unknown>): string {
  return [SENTINEL, "```json", JSON.stringify(payload, null, 2), "```"].join("\n");
}

type CapturedMeta = Record<string, unknown>;

type SessionStub = {
  metadata: CapturedMeta;
  setMetadata: ReturnType<typeof vi.fn>;
  getMetadata: ReturnType<typeof vi.fn>;
  addPeers: ReturnType<typeof vi.fn>;
  addMessages: ReturnType<typeof vi.fn>;
};

function createMockState(): { state: PluginState; session: SessionStub } {
  const session: SessionStub = {
    metadata: {},
    getMetadata: vi.fn(async () => session.metadata),
    setMetadata: vi.fn(async (next: CapturedMeta) => {
      session.metadata = next;
    }),
    addPeers: vi.fn(async () => undefined),
    addMessages: vi.fn(async () => undefined),
  };

  const agentPeer = { id: "agent-main", message: vi.fn((text: string) => ({ text })) };
  const ownerPeer = { id: "owner", message: vi.fn((text: string) => ({ text })) };

  const state = {
    cfg: {
      noisePatterns: [],
      ownerObserveOthers: false,
      crossSessionSearch: true,
      workspaceId: "openclaw",
      baseUrl: "https://api.honcho.dev",
    },
    honcho: {
      session: vi.fn(async () => session),
    },
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => agentPeer),
    getParticipantPeer: vi.fn(async () => ownerPeer),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;

  return { state, session };
}

function loggerStub() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("flushMessages metadata", () => {
  it("writes openclawSessionKey, sessionClass, messageProvider, and lastSessionId", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    const saved = await flushMessages(
      api,
      state,
      [
        { role: "user", content: "hello", timestamp: 1 },
        { role: "assistant", content: "hi there", timestamp: 2 },
      ],
      {
        sessionKey: "agent:main:discord:dm:user-1",
        agentId: "main",
        sessionId: "uuid-current",
        messageProvider: "discord",
      },
    );

    expect(saved).toBe(2);
    expect(session.setMetadata).toHaveBeenCalled();
    const meta = session.metadata;
    expect(meta.openclawSessionKey).toBe("agent:main:discord:dm:user-1");
    expect(meta.sessionClass).toBe("chat");
    expect(meta.messageProvider).toBe("discord");
    expect(meta.lastSessionId).toBe("uuid-current");
    expect(meta.agentId).toBe("main");
  });

  it("records participantSenderId from the latest user message in the batch", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    await flushMessages(
      api,
      state,
      [
        {
          role: "user",
          content: `${metadataBlock({ sender_id: "U-alice" })}\n\nhi`,
          timestamp: 1,
        },
        {
          role: "user",
          content: `${metadataBlock({ sender_id: "U-bob" })}\n\nhello`,
          timestamp: 2,
        },
        { role: "assistant", content: "reply", timestamp: 3 },
      ],
      {
        sessionKey: "agent:main:discord:group:c-1",
        agentId: "main",
      },
    );

    expect(session.metadata.participantSenderId).toBe("U-bob");
  });

  it("classifies cron and subagent sessions in the metadata block", async () => {
    {
      const { state, session } = createMockState();
      const api = { logger: loggerStub() } as never;
      await flushMessages(
        api,
        state,
        [{ role: "user", content: "tick", timestamp: 1 }],
        { sessionKey: "agent:main:cron:nightly:run:7", agentId: "main" },
      );
      expect(session.metadata.sessionClass).toBe("cron");
    }
    {
      const { state, session } = createMockState();
      const api = { logger: loggerStub() } as never;
      await flushMessages(
        api,
        state,
        [{ role: "user", content: "spawn", timestamp: 1 }],
        { sessionKey: "agent:main:subagent:research-1", agentId: "main" },
      );
      expect(session.metadata.sessionClass).toBe("subagent");
      expect(session.metadata.isSubagent).toBe(true);
    }
  });

  it("omits messageProvider and lastSessionId when not provided", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    await flushMessages(
      api,
      state,
      [{ role: "user", content: "hello", timestamp: 1 }],
      { sessionKey: "agent:main:discord:dm:user-1", agentId: "main" },
    );

    expect(session.metadata).not.toHaveProperty("messageProvider");
    expect(session.metadata).not.toHaveProperty("lastSessionId");
  });
});
