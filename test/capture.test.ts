import { describe, expect, it, vi } from "vitest";
import {
  addMessagesInBatches,
  dedupeAgainstRecentTail,
  flushMessages,
  HONCHO_MESSAGES_CREATE_MAX_SIZE,
  HONCHO_MESSAGES_LIST_MAX_SIZE,
} from "../hooks/capture.js";
import type { MessageInput, MessageResponse, PageResponse } from "@honcho-ai/sdk";
import type { PluginState } from "../state.js";


type FakeMessage = { peerId: string; createdAt?: string; content: string };

function apiMessage(message: FakeMessage): MessageResponse {
  return {
    id: `msg-${message.createdAt ?? message.content}`,
    content: message.content,
    peer_id: message.peerId,
    session_id: "session-1",
    workspace_id: "workspace-1",
    metadata: {},
    created_at: message.createdAt ?? "2026-04-30T00:00:00Z",
    token_count: 1,
  };
}

function response(items: FakeMessage[], page: number, pages: number, size = HONCHO_MESSAGES_LIST_MAX_SIZE): PageResponse<MessageResponse> {
  return {
    items: items.map(apiMessage),
    page,
    size,
    total: items.length,
    pages,
  };
}

function fakeSession(responses: PageResponse<MessageResponse>[]) {
  const post = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra page request");
    return next;
  });

  return {
    id: "session-1",
    workspaceId: "workspace-1",
    _ensureWorkspace: vi.fn(async () => undefined),
    _http: { post },
    messages: vi.fn(async () => {
      throw new Error("Session.messages() treats pagination options as filters in @honcho-ai/sdk@2");
    }),
  };
}

describe("dedupeAgainstRecentTail", () => {
  it("dedupes within the current batch without fetching the recent tail when disabled", async () => {
    const session = {
      messages: vi.fn(),
    };
    const extracted: MessageInput[] = [
      { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "same" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "same" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:01Z", content: "new" },
    ];

    const result = await dedupeAgainstRecentTail(session as never, extracted, 0);

    expect(session.messages).not.toHaveBeenCalled();
    expect(result).toEqual([
      { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "same" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:01Z", content: "new" },
    ]);
  });

  it("passes pagination as query params instead of Honcho message filters", async () => {
    const session = fakeSession([
      response([
        { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "already saved" },
      ], 1, 1),
    ]);
    const extracted: MessageInput[] = [
      { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "already saved" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:01Z", content: "new" },
    ];

    const result = await dedupeAgainstRecentTail(session as never, extracted, 200);

    expect(session.messages).not.toHaveBeenCalled();
    expect(session._http.post).toHaveBeenCalledWith(
      "/v3/workspaces/workspace-1/sessions/session-1/messages/list",
      {
        body: { filters: undefined },
        query: {
          size: HONCHO_MESSAGES_LIST_MAX_SIZE,
          reverse: true,
        },
      },
    );
    expect(result).toEqual([
      { peerId: "owner", createdAt: "2026-04-30T00:00:01Z", content: "new" },
    ]);
  });

  it("walks additional pages when the configured tail is larger than one Honcho page", async () => {
    const session = fakeSession([
      response([], 1, 2),
      response(
        [{ peerId: "owner", createdAt: "2026-04-30T00:00:42Z", content: "older duplicate" }],
        2,
        2,
      ),
    ]);
    const extracted: MessageInput[] = [
      { peerId: "owner", createdAt: "2026-04-30T00:00:42Z", content: "older duplicate" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:43Z", content: "new" },
    ];

    const result = await dedupeAgainstRecentTail(session as never, extracted, 200);

    expect(session._http.post).toHaveBeenCalledTimes(2);
    expect(session._http.post).toHaveBeenLastCalledWith(
      "/v3/workspaces/workspace-1/sessions/session-1/messages/list",
      {
        body: { filters: undefined },
        query: {
          page: 2,
          size: HONCHO_MESSAGES_LIST_MAX_SIZE,
          reverse: true,
        },
      },
    );
    expect(result).toEqual([
      { peerId: "owner", createdAt: "2026-04-30T00:00:43Z", content: "new" },
    ]);
  });
});


describe("addMessagesInBatches", () => {
  it("splits message creation into Honcho's 100-message API limit", async () => {
    const addMessages = vi.fn(async () => []);
    const session = { addMessages };
    const messages: MessageInput[] = Array.from({ length: 205 }, (_, i) => ({
      peerId: "owner",
      createdAt: `2026-04-30T00:00:${String(i % 60).padStart(2, "0")}Z`,
      content: `message ${i}`,
    }));

    await addMessagesInBatches(session as never, messages);

    expect(addMessages).toHaveBeenCalledTimes(3);
    expect(addMessages.mock.calls[0][0]).toHaveLength(HONCHO_MESSAGES_CREATE_MAX_SIZE);
    expect(addMessages.mock.calls[1][0]).toHaveLength(HONCHO_MESSAGES_CREATE_MAX_SIZE);
    expect(addMessages.mock.calls[2][0]).toHaveLength(5);
  });
});

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

  const agentPeer = { id: "agent-main", message: vi.fn((content: string, opts?: { createdAt?: Date }) => ({ peerId: "agent-main", content, createdAt: opts?.createdAt?.toISOString() })) };
  const ownerPeer = { id: "owner", message: vi.fn((content: string, opts?: { createdAt?: Date }) => ({ peerId: "owner", content, createdAt: opts?.createdAt?.toISOString() })) };

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
