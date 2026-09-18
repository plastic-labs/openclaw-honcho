import { describe, expect, it, vi } from "vitest";
import { flushMessages } from "../hooks/capture.js";
import { getMessageIdentity, buildSessionKey } from "../helpers.js";
import type { PluginState } from "../state.js";

type Meta = Record<string, unknown>;

function createMockState(initialMeta: Meta = {}) {
  const saved: string[] = [];
  const session = {
    metadata: { ...initialMeta } as Meta,
    getMetadata: vi.fn(async () => session.metadata),
    setMetadata: vi.fn(async (next: Meta) => {
      session.metadata = next;
    }),
    addPeers: vi.fn(async () => undefined),
    addMessages: vi.fn(async (msgs: Array<{ text: string }>) => {
      for (const m of msgs) saved.push(m.text);
    }),
  };
  const agentPeer = { id: "agent-main", message: (text: string) => ({ text }) };
  const ownerPeer = { id: "owner", message: (text: string) => ({ text }) };

  const state = {
    cfg: { noisePatterns: [], ownerObserveOthers: false, crossSessionSearch: true, workspaceId: "w", baseUrl: "b" },
    honcho: { session: vi.fn(async () => session) },
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => agentPeer),
    getParticipantPeer: vi.fn(async () => ownerPeer),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;

  return { state, session, saved };
}

const api = { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never;
const ctx = { sessionKey: "agent:main:discord:dm:u1", agentId: "main" };

/** Message carrying OpenClaw's own idempotencyKey, as the gateway emits. */
const msg = (role: string, text: string, n: number) => ({
  role,
  content: text,
  timestamp: 1_700_000_000_000 + n,
  idempotencyKey: `idem-${n}`,
});

const turn = (n: number) => [msg("user", `Turn ${n}`, n * 2), msg("assistant", `ACK${n}`, n * 2 + 1)];

describe("#134 capture watermark", () => {
  it("saves the new turn when agent_end repeats the full transcript (gateway shape)", async () => {
    const { state, session, saved } = createMockState();

    expect(await flushMessages(api, state, [...turn(1)], ctx)).toBe(2);
    expect(saved).toEqual(["Turn 1", "ACK1"]);

    // Second turn: full transcript including turn 1, as OpenClaw 2026.9.4 sends.
    expect(await flushMessages(api, state, [...turn(1), ...turn(2)], ctx)).toBe(2);
    expect(saved).toEqual(["Turn 1", "ACK1", "Turn 2", "ACK2"]);
    expect(session.metadata.lastSavedMessageId).toBe(getMessageIdentity(turn(2)[1]));
  });

  it("saves the new turn when agent_end delivers only the delta (issue #134)", async () => {
    const { state, saved } = createMockState();

    expect(await flushMessages(api, state, [...turn(1)], ctx)).toBe(2);

    // before_prompt_build saw the full history; agent_end gets only this turn.
    state.turnStartIndex.set(buildSessionKey(ctx), 10);
    expect(await flushMessages(api, state, [...turn(2)], ctx)).toBe(2);
    expect(saved).toEqual(["Turn 1", "ACK1", "Turn 2", "ACK2"]);
  });

  it("saves the delta at the boundary where a length heuristic fails", async () => {
    // prior history == batch length: `turnStartIndex > messages.length` is false,
    // so a length-comparison heuristic does not detect the delta shape.
    const { state, saved } = createMockState();

    expect(await flushMessages(api, state, [...turn(1)], ctx)).toBe(2);
    state.turnStartIndex.set(buildSessionKey(ctx), 2);
    expect(await flushMessages(api, state, [...turn(2)], ctx)).toBe(2);
    expect(saved).toEqual(["Turn 1", "ACK1", "Turn 2", "ACK2"]);
  });

  it("does not re-save when the same transcript is flushed twice", async () => {
    const { state, saved } = createMockState();
    const transcript = [...turn(1), ...turn(2)];

    expect(await flushMessages(api, state, transcript, ctx)).toBe(4);
    expect(await flushMessages(api, state, transcript, ctx)).toBe(0);
    expect(saved).toEqual(["Turn 1", "ACK1", "Turn 2", "ACK2"]);
  });

  it("does not re-save after turnStartIndex is lost (gateway restart)", async () => {
    const { state, saved } = createMockState();
    const transcript = [...turn(1), ...turn(2)];
    expect(await flushMessages(api, state, transcript, ctx)).toBe(4);

    // A restart clears the in-memory cursor; the anchor still holds the line.
    state.turnStartIndex.clear();
    expect(await flushMessages(api, state, [...transcript, ...turn(3)], ctx)).toBe(2);
    expect(saved).toEqual(["Turn 1", "ACK1", "Turn 2", "ACK2", "Turn 3", "ACK3"]);
  });

  it("migrates a session that only has lastSavedIndex without re-saving history", async () => {
    // Written by a build that predates the anchor.
    const { state, saved } = createMockState({ agentId: "main", lastSavedIndex: 4 });

    expect(await flushMessages(api, state, [...turn(1), ...turn(2), ...turn(3)], ctx)).toBe(2);
    expect(saved).toEqual(["Turn 3", "ACK3"]);
  });

  it("advances the anchor past trailing filtered noise", async () => {
    const { state, session } = createMockState();
    (state as unknown as { cfg: { noisePatterns: string[] } }).cfg.noisePatterns = ["HEARTBEAT_OK"];
    const batch = [...turn(1), msg("user", "HEARTBEAT_OK", 99)];

    expect(await flushMessages(api, state, batch, ctx)).toBe(2);
    expect(session.metadata.lastSavedMessageId).toBe(getMessageIdentity(batch[2]));
    // The noise message is not rescanned on the next flush.
    expect(await flushMessages(api, state, batch, ctx)).toBe(0);
  });
});

describe("getMessageIdentity", () => {
  it("prefers OpenClaw's idempotencyKey", () => {
    expect(getMessageIdentity({ role: "user", content: "hi", idempotencyKey: "abc" })).toBe("k:abc");
  });

  it("falls back to a digest that is stable and content-sensitive", () => {
    const a = { role: "user", content: "hi", timestamp: 1 };
    expect(getMessageIdentity(a)).toBe(getMessageIdentity({ ...a }));
    expect(getMessageIdentity(a)).not.toBe(getMessageIdentity({ ...a, content: "bye" }));
    expect(getMessageIdentity(a)).not.toBe(getMessageIdentity({ ...a, role: "assistant" }));
    expect(getMessageIdentity(a)?.startsWith("h:")).toBe(true);
  });

  it("returns undefined for non-messages", () => {
    expect(getMessageIdentity(null)).toBeUndefined();
    expect(getMessageIdentity({})).toBeUndefined();
  });
});

describe("anchor resolution cost", () => {
  it("resolves the anchor without hashing the whole transcript", async () => {
    const { state, saved } = createMockState();
    // 400 messages with no idempotencyKey, so identity must be derived by hash.
    const plain = (n: number) => ({
      role: n % 2 ? "assistant" : "user",
      content: `m${n}`,
      timestamp: 1_700_000_000_000 + n,
    });
    const history = Array.from({ length: 400 }, (_, n) => plain(n));

    expect(await flushMessages(api, state, history, ctx)).toBe(400);

    // Next turn: full transcript plus two new messages. The hint should land
    // directly on the anchor rather than scanning back through the history.
    const next = [...history, plain(400), plain(401)];
    expect(await flushMessages(api, state, next, ctx)).toBe(2);
    expect(saved.slice(-2)).toEqual(["m400", "m401"]);
  });
});

describe("chunked flush resume", () => {
  const bulk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      timestamp: 1_700_000_000_000 + i,
    }));

  it("resumes after a mid-batch chunk failure without duplicating the persisted chunk", async () => {
    const { state, session, saved } = createMockState();
    const messages = bulk(116);

    // First chunk persists, second fails.
    session.addMessages
      .mockImplementationOnce(async (msgs: Array<{ text: string }>) => {
        for (const m of msgs) saved.push(m.text);
      })
      .mockRejectedValueOnce(new Error("boom"));

    await expect(flushMessages(api, state, messages, ctx)).rejects.toThrow("boom");
    expect(saved).toHaveLength(100);
    // The anchor points at the last raw message the persisted chunk covered.
    expect(session.metadata.lastSavedMessageId).toBe(getMessageIdentity(messages[99]));

    // Retry the identical batch: only the unsaved remainder should be sent.
    session.addMessages.mockImplementation(async (msgs: Array<{ text: string }>) => {
      for (const m of msgs) saved.push(m.text);
    });
    expect(await flushMessages(api, state, messages, ctx)).toBe(16);
    expect(saved).toHaveLength(116);
    expect(new Set(saved).size).toBe(116); // no duplicates
    expect(saved[100]).toBe("message 100");
  });

  it("keeps ordering intact across a chunked flush", async () => {
    const { state, saved } = createMockState();
    const messages = bulk(250);

    expect(await flushMessages(api, state, messages, ctx)).toBe(250);
    expect(saved).toEqual(messages.map((m) => m.content));
  });
});

describe("flush paths share one watermark", () => {
  it("does not duplicate when before_reset flushes a transcript agent_end already saved", async () => {
    const { state, saved } = createMockState();
    const transcript = [...turn(1), ...turn(2)];

    // agent_end
    expect(await flushMessages(api, state, transcript, ctx)).toBe(4);
    // before_reset fires with the same in-memory transcript
    expect(await flushMessages(api, state, transcript, ctx)).toBe(0);
    // before_compaction fires with a transcript that grew by one turn
    expect(await flushMessages(api, state, [...transcript, ...turn(3)], ctx)).toBe(2);

    expect(saved).toEqual(["Turn 1", "ACK1", "Turn 2", "ACK2", "Turn 3", "ACK3"]);
  });
});
