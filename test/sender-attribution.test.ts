import { describe, expect, it, vi } from "vitest";
import { flushMessages } from "../hooks/capture.js";
import { buildSessionKey } from "../helpers.js";
import type { PluginState } from "../state.js";

const SESSION_KEY = "agent:main:telegram:group:test-group";

/** Pre-2026.8 hosts inline the sender in the text; still exact when present. */
function withLegacySender(content: string, senderId: string): Record<string, unknown> {
  const block = [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({ sender_id: senderId }),
    "```",
    content,
  ].join("\n");
  return { role: "user", content: block, timestamp: 1 };
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
  const makePeer = (id: string) => ({ id, message: (text: string) => ({ peerId: id, text }) });

  const state = {
    cfg: { noisePatterns: [], ownerObserveOthers: false, captureSystemRuns: false },
    honcho: { session: vi.fn(async () => session) },
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

describe("sender attribution", () => {
  it("attributes the turn to ctx.senderId", async () => {
    const { state, session, recorded } = createMockState();

    await flushMessages(
      api,
      state,
      [
        { role: "user", content: "test", timestamp: 1 },
        { role: "assistant", content: "hi", timestamp: 2 },
      ],
      { sessionKey: SESSION_KEY, agentId: "main", senderId: "8610325508" },
    );

    expect(recorded.map((r) => r.peerId)).toEqual(["participant-8610325508", "agent-main"]);
    expect(session.metadata.participantSenderId).toBe("8610325508");
  });

  it("keeps identical messages from two senders apart across turns", async () => {
    const { state, recorded } = createMockState();
    const first = { role: "user", content: "test", timestamp: 1 };

    await flushMessages(api, state, [first], { sessionKey: SESSION_KEY, agentId: "main", senderId: "teest" });
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

  it("falls back to owner when the run has no sender", async () => {
    const { state, recorded } = createMockState();

    await flushMessages(api, state, [{ role: "user", content: "from the CLI", timestamp: 1 }], {
      sessionKey: "agent:main:main",
      agentId: "main",
    });

    expect(recorded.map((r) => r.peerId)).toEqual(["owner"]);
  });

  it("still reads the pre-2026.8 inline metadata block", async () => {
    const { state, recorded } = createMockState();

    await flushMessages(api, state, [withLegacySender("hello from an old host", "legacy-sender")], {
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

  it("drops a heartbeat run inside a chat session", async () => {
    const { state, recorded } = createMockState();

    await flushMessages(
      api,
      state,
      [
        { role: "user", content: "real question", timestamp: 1 },
        { role: "assistant", content: "real answer", timestamp: 2 },
        { role: "user", content: "heartbeat check-in", timestamp: 3 },
        { role: "assistant", content: "HEARTBEAT reply", timestamp: 4 },
      ],
      { sessionKey: SESSION_KEY, agentId: "main", trigger: "heartbeat" },
    );

    expect(recorded).toEqual([]);
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
    const key = "agent:main:telegram:group:-1";
    state.turnProvenance.set(buildSessionKey({ sessionKey: key, agentId: "main" }), {
      kind: "inter_session",
      sourceSessionKey: "agent:atlas:discord:channel:c-1",
    });

    await flushMessages(
      api,
      state,
      [
        { role: "user", content: "please summarise the thread", timestamp: 1 },
        { role: "assistant", content: "summary", timestamp: 2 },
      ],
      { sessionKey: key, agentId: "main" },
    );

    expect(recorded.map((r) => r.peerId)).toEqual(["agent-atlas", "agent-main"]);
    expect(session.metadata.participantSenderId).toBeUndefined();
  });
});
