import { describe, expect, it, vi } from "vitest";
import { flushMessages } from "../hooks/capture.js";
import type { PluginState } from "../state.js";

const SESSION_KEY = "agent:main:telegram:group:-5280139968";

function withSender(
  content: string,
  senderId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: "user",
    content,
    timestamp: 1,
    __openclaw: { senderId, senderIsOwner: false, ...extra },
  };
}

type Recorded = { peerId: string; text: string };

function createMockState() {
  const recorded: Recorded[] = [];
  const session = {
    metadata: {} as Record<string, unknown>,
    getMetadata: vi.fn(async () => session.metadata),
    setMetadata: vi.fn(async (next: Record<string, unknown>) => {
      session.metadata = next;
    }),
    addPeers: vi.fn(async () => undefined),
    addMessages: vi.fn(async (msgs: Recorded[]) => {
      recorded.push(...msgs);
    }),
  };

  const makePeer = (id: string) => ({
    id,
    message: (text: string) => ({ peerId: id, text }),
  });

  const state = {
    cfg: { noisePatterns: [], ownerObserveOthers: false, captureSystemRuns: false },
    honcho: { session: vi.fn(async () => session) },
    turnStartIndex: new Map<string, number>(),
    turnProvenance: new Map(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async (agentId?: string) => makePeer(`agent-${agentId ?? "main"}`)),
    getParticipantPeer: vi.fn(async (senderId?: string) =>
      makePeer(senderId ? `participant-${senderId}` : "owner"),
    ),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;

  return { state, session, recorded };
}

const api = { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never;

describe("per-message sender attribution", () => {
  it("keeps two senders in one batch apart", async () => {
    const { state, recorded } = createMockState();

    // Live group-chat batch: account 2 speaks while account 1's messages replay.
    await flushMessages(
      api,
      state,
      [
        withSender("I drive a blue Volvo.", "8461078551"),
        withSender("What car do I drive?", "8461078551"),
        withSender("what do i ride ?", "8610325508"),
      ],
      { sessionKey: SESSION_KEY, agentId: "main", senderId: "8610325508" },
    );

    expect(recorded.map((r) => r.peerId)).toEqual([
      "participant-8461078551",
      "participant-8461078551",
      "participant-8610325508",
    ]);
  });

  it("attributes correctly when a prior watermark makes startIndex non-zero", async () => {
    const { state, session, recorded } = createMockState();

    // Resumed session: only the tail is new, so the sender index must be
    // slice-relative, not absolute.
    const messages = [
      withSender("already saved", "sender-a"),
      { role: "assistant", content: "ack", timestamp: 1 },
      withSender("new from a", "sender-a"),
      withSender("new from b", "sender-b"),
    ];
    session.metadata = { lastSavedIndex: 2 };

    await flushMessages(api, state, messages, {
      sessionKey: SESSION_KEY,
      agentId: "main",
      senderId: "sender-b",
    });

    expect(recorded.map((r) => r.peerId)).toEqual(["participant-sender-a", "participant-sender-b"]);
  });

  it("does not stamp the whole batch with the run's sender", async () => {
    const { state, recorded } = createMockState();

    // Only the trailing message may inherit ctx.senderId.
    await flushMessages(
      api,
      state,
      [
        withSender("earlier speaker", "sender-a"),
        { role: "user", content: "current speaker", timestamp: 2 },
      ],
      { sessionKey: SESSION_KEY, agentId: "main", senderId: "sender-b" },
    );

    expect(recorded.map((r) => r.peerId)).toEqual(["participant-sender-a", "participant-sender-b"]);
  });

  it("keeps identical messages from two senders apart across sequential flushes", async () => {
    const { state, recorded } = createMockState();

    const first = { role: "user", content: "test", timestamp: 1 };
    await flushMessages(api, state, [first], {
      sessionKey: SESSION_KEY, agentId: "main", senderId: "teest",
    });
    await flushMessages(
      api,
      state,
      [first, { role: "assistant", content: "hi", timestamp: 2 }, { role: "user", content: "test", timestamp: 3 }],
      { sessionKey: SESSION_KEY, agentId: "main", senderId: "abigail" },
    );

    expect(recorded.filter((r) => r.peerId !== "agent-main").map((r) => r.peerId)).toEqual([
      "participant-teest",
      "participant-abigail",
    ]);
  });

  it("leaves a non-trailing unattributable message on owner rather than guessing", async () => {
    const { state, recorded } = createMockState();

    await flushMessages(
      api,
      state,
      [
        { role: "user", content: "unknown speaker", timestamp: 1 },
        withSender("known speaker", "sender-a"),
      ],
      { sessionKey: SESSION_KEY, agentId: "main", senderId: "sender-b" },
    );

    expect(recorded.map((r) => r.peerId)).toEqual(["owner", "participant-sender-a"]);
  });

  it("routes an owner-flagged sender to the owner peer", async () => {
    const { state, recorded } = createMockState();

    await flushMessages(
      api,
      state,
      [withSender("hi from the operator", "8461078551", { senderIsOwner: true })],
      { sessionKey: SESSION_KEY, agentId: "main", senderId: "8461078551" },
    );

    expect(recorded.map((r) => r.peerId)).toEqual(["owner"]);
  });

  it("still reads the pre-2026.8 inline metadata block", async () => {
    const { state, recorded } = createMockState();
    const legacy = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ sender_id: "legacy-sender" }),
      "```",
      "hello from an old host",
    ].join("\n");

    await flushMessages(api, state, [{ role: "user", content: legacy, timestamp: 1 }], {
      sessionKey: SESSION_KEY,
      agentId: "main",
    });

    expect(recorded.map((r) => r.peerId)).toEqual(["participant-legacy-sender"]);
  });
});

describe("run provenance", () => {
  it("drops a cron session without touching Honcho", async () => {
    const { state, session, recorded } = createMockState();

    const saved = await flushMessages(
      api,
      state,
      [
        { role: "user", content: "Job ID: abc | Received: Tuesday", timestamp: 1 },
        { role: "assistant", content: "done", timestamp: 2 },
      ],
      { sessionKey: "agent:main:cron:job-1:run:r-1", agentId: "main" },
    );

    expect(saved).toBe(0);
    expect(recorded).toEqual([]);
    expect(state.honcho.session).not.toHaveBeenCalled();
    expect(session.setMetadata).not.toHaveBeenCalled();
  });

  it("drops a heartbeat run but keeps earlier unsaved human messages and the watermark", async () => {
    const { state, session, recorded } = createMockState();

    await flushMessages(
      api,
      state,
      [
        withSender("real question", "sender-a"),
        { role: "user", content: "heartbeat check-in", timestamp: 2 },
        { role: "assistant", content: "HEARTBEAT reply", timestamp: 3 },
      ],
      { sessionKey: SESSION_KEY, agentId: "main", trigger: "heartbeat" },
    );

    expect(recorded.map((r) => r.peerId)).toEqual(["participant-sender-a"]);
    expect(session.metadata.lastSavedIndex).toBe(3);
  });

  it("captures cron runs when captureSystemRuns is on", async () => {
    const { state, recorded } = createMockState();
    (state.cfg as { captureSystemRuns: boolean }).captureSystemRuns = true;

    await flushMessages(
      api,
      state,
      [
        { role: "user", content: "Job ID: abc", timestamp: 1 },
        { role: "assistant", content: "done", timestamp: 2 },
      ],
      { sessionKey: "agent:main:cron:job-1:run:r-1", agentId: "main" },
    );

    expect(recorded.map((r) => r.peerId)).toEqual(["owner", "agent-main"]);
  });

  it("attributes sessions_send input to the sending agent's peer", async () => {
    const { state, session, recorded } = createMockState();
    const honchoKey = "agent:main:telegram:group:-1";
    state.turnProvenance.set(
      // buildSessionKey output for this ctx; mirrors what the context hook records.
      (await import("../helpers.js")).buildSessionKey({ sessionKey: honchoKey, agentId: "main" }),
      { kind: "inter_session", sourceSessionKey: "agent:atlas:discord:channel:c-1" },
    );

    await flushMessages(
      api,
      state,
      [
        { role: "user", content: "please summarise the thread", timestamp: 1 },
        { role: "assistant", content: "summary", timestamp: 2 },
      ],
      { sessionKey: honchoKey, agentId: "main" },
    );

    expect(recorded.map((r) => r.peerId)).toEqual(["agent-atlas", "agent-main"]);
    expect(session.metadata.participantSenderId).toBeUndefined();
  });
});
