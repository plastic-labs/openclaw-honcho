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
      ignoreSessionPatterns: [],
      ownerObserveOthers: false,
      crossSessionSearch: true,
      workspaceId: "openclaw",
      baseUrl: "https://api.honcho.dev",
    },
    honcho: {
      // Mirrors real Honcho SDK: passing `metadata` on session() REPLACES the
      // persisted metadata. Tests that don't want this clobber must call
      // session() without a metadata argument.
      session: vi.fn(async (_key: string, opts?: { metadata?: CapturedMeta }) => {
        if (opts?.metadata) session.metadata = { ...opts.metadata };
        return session;
      }),
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
  it("does not initialize or create a Honcho session for ignored OpenClaw sessions", async () => {
    const { state } = createMockState();
    state.cfg.ignoreSessionPatterns = ["agent:*:explicit:model-run-*"];
    const api = { logger: loggerStub() } as never;

    const saved = await flushMessages(
      api,
      state,
      [
        { role: "user", content: "internal prompt", timestamp: 1 },
        { role: "assistant", content: "internal reply", timestamp: 2 },
      ],
      {
        sessionKey: "agent:main:explicit:model-run-123",
        agentId: "main",
      },
    );

    expect(saved).toBe(0);
    expect(state.ensureInitialized).not.toHaveBeenCalled();
    expect(state.honcho.session).not.toHaveBeenCalled();
  });

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

describe("flushMessages batching", () => {
  it("chunks addMessages into requests of at most 100 messages", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    // 116 messages exceeds Honcho's 100-per-request limit (HTTP 422).
    const messages = Array.from({ length: 116 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      timestamp: i + 1,
    }));

    const saved = await flushMessages(api, state, messages, {
      sessionKey: "agent:main:discord:dm:user-1",
      agentId: "main",
    });

    expect(saved).toBe(116);
    expect(session.addMessages).toHaveBeenCalledTimes(2);
    expect(session.addMessages.mock.calls[0][0]).toHaveLength(100);
    expect(session.addMessages.mock.calls[1][0]).toHaveLength(16);
    // Watermark advances after each chunk: 100 after the first, then the full
    // message count after the last chunk.
    expect(session.setMetadata).toHaveBeenCalledTimes(2);
    expect(session.setMetadata.mock.calls[0][0].lastSavedIndex).toBe(100);
    expect(session.setMetadata.mock.calls[1][0].lastSavedIndex).toBe(116);
    // Each metadata commit happens after its chunk is persisted.
    expect(session.setMetadata.mock.invocationCallOrder[0]).toBeGreaterThan(
      session.addMessages.mock.invocationCallOrder[0],
    );
    expect(session.metadata.lastSavedIndex).toBe(116);
  });

  it("re-flushing the same messages is a no-op (does not duplicate)", async () => {
    // Regression test: passing `metadata` to honcho.session() on an existing
    // session used to REPLACE persisted metadata, wiping `lastSavedIndex`
    // before it was read. The second flush then saw lastSavedIndex=0 and
    // re-sent every message, duplicating them in Honcho.
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;
    const messages = [
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: "hi", timestamp: 2 },
    ];
    const ctx = { sessionKey: "agent:main:discord:dm:user-1", agentId: "main" };

    const first = await flushMessages(api, state, messages, ctx);
    expect(first).toBe(2);

    const second = await flushMessages(api, state, messages, ctx);
    expect(second).toBe(0);
    expect(session.addMessages).toHaveBeenCalledTimes(1);
  });

  it("does not re-send persisted chunks when a later chunk fails mid-batch", async () => {
    const { state, session } = createMockState();
    const api = { logger: loggerStub() } as never;

    const messages = Array.from({ length: 116 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      timestamp: i + 1,
    }));

    // First chunk persists; second chunk fails (e.g. transient network error).
    session.addMessages
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));

    await expect(
      flushMessages(api, state, messages, {
        sessionKey: "agent:main:discord:dm:user-1",
        agentId: "main",
      }),
    ).rejects.toThrow("boom");

    // The watermark was advanced past the first 100 persisted messages, so the
    // next flush resumes at index 100 instead of re-sending (and duplicating)
    // the already-saved chunk.
    expect(session.addMessages).toHaveBeenCalledTimes(2);
    expect(session.setMetadata).toHaveBeenCalledTimes(1);
    expect(session.metadata.lastSavedIndex).toBe(100);
  });
});
