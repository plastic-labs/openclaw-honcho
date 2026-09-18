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
  const state = {
    cfg: { noisePatterns: [], ownerObserveOthers: false, crossSessionSearch: true, workspaceId: "w", baseUrl: "b" },
    honcho: { session: vi.fn(async () => session) },
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => ({ id: "agent-main", message: (text: string) => ({ text }) })),
    getParticipantPeer: vi.fn(async () => ({ id: "owner", message: (text: string) => ({ text }) })),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;

  return { state, session, saved };
}

const api = { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never;
const ctx = { sessionKey: "agent:main:discord:dm:u1", agentId: "main" };

const msg = (role: string, text: string, n: number) => ({
  role,
  content: text,
  timestamp: 1_700_000_000_000 + n,
  idempotencyKey: `idem-${n}`,
});
const turn = (n: number) => [msg("user", `Turn ${n}`, n * 2), msg("assistant", `ACK${n}`, n * 2 + 1)];

describe("capture watermark", () => {
  it("saves a delta batch that the old index math dropped (#134)", async () => {
    const { state, saved } = createMockState();
    expect(await flushMessages(api, state, [...turn(1)], ctx)).toBe(2);

    // before_prompt_build saw the full history; agent_end gets only this turn.
    state.turnStartIndex.set(buildSessionKey(ctx), 10);
    expect(await flushMessages(api, state, [...turn(2)], ctx)).toBe(2);
    expect(saved).toEqual(["Turn 1", "ACK1", "Turn 2", "ACK2"]);
  });

  it("saves a delta where prior history equals the batch length", async () => {
    // A `turnStartIndex > messages.length` heuristic does not fire here.
    const { state, saved } = createMockState();
    expect(await flushMessages(api, state, [...turn(1)], ctx)).toBe(2);

    state.turnStartIndex.set(buildSessionKey(ctx), 2);
    expect(await flushMessages(api, state, [...turn(2)], ctx)).toBe(2);
    expect(saved).toEqual(["Turn 1", "ACK1", "Turn 2", "ACK2"]);
  });

  it("does not re-save when a later flush repeats the transcript", async () => {
    // Covers agent_end followed by before_reset/before_compaction, and a
    // restart that clears the in-memory cursor.
    const { state, saved } = createMockState();
    const transcript = [...turn(1), ...turn(2)];

    expect(await flushMessages(api, state, transcript, ctx)).toBe(4);
    expect(await flushMessages(api, state, transcript, ctx)).toBe(0);

    state.turnStartIndex.clear();
    expect(await flushMessages(api, state, [...transcript, ...turn(3)], ctx)).toBe(2);
    expect(saved).toEqual(["Turn 1", "ACK1", "Turn 2", "ACK2", "Turn 3", "ACK3"]);
  });

  it("migrates a lastSavedIndex-only session without re-saving history", async () => {
    const { state, saved } = createMockState({ agentId: "main", lastSavedIndex: 4 });
    expect(await flushMessages(api, state, [...turn(1), ...turn(2), ...turn(3)], ctx)).toBe(2);
    expect(saved).toEqual(["Turn 3", "ACK3"]);
  });

  it("resumes a failed chunk without duplicating or reordering", async () => {
    const { state, session, saved } = createMockState();
    const messages = Array.from({ length: 116 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `m${i}`, i),
    );

    session.addMessages
      .mockImplementationOnce(async (m: Array<{ text: string }>) => {
        for (const x of m) saved.push(x.text);
      })
      .mockRejectedValueOnce(new Error("boom"));
    await expect(flushMessages(api, state, messages, ctx)).rejects.toThrow("boom");
    expect(saved).toHaveLength(100);

    session.addMessages.mockImplementation(async (m: Array<{ text: string }>) => {
      for (const x of m) saved.push(x.text);
    });
    expect(await flushMessages(api, state, messages, ctx)).toBe(16);
    expect(saved).toEqual(messages.map((m) => m.content));
  });

  it("resumes at the earliest ambiguous match rather than skipping messages", async () => {
    // Same role, timestamp and content collide under the digest fallback.
    const collide = (role: string, text: string) => ({ role, content: text, timestamp: 1 });
    const { state, session, saved } = createMockState();

    const a = collide("user", "A");
    await flushMessages(api, state, [a], ctx);

    // Stale hint forces the scan, where "A" is ambiguous. Resuming after the
    // later "A" would silently drop "B".
    session.metadata = { ...session.metadata, lastSavedIndex: 999 };
    await flushMessages(api, state, [a, collide("assistant", "B"), collide("user", "A"), collide("assistant", "C")], ctx);
    expect(saved).toContain("B");
  });

  it("anchors on the last identifiable message when the tail has no identity", async () => {
    const { state, saved } = createMockState();
    const b = msg("user", "B", 1);

    expect(await flushMessages(api, state, [b, {} as never], ctx)).toBe(1);
    // Without this, the stale anchor is kept and the next flush re-saves B.
    expect(await flushMessages(api, state, [b, {} as never], ctx)).toBe(0);
    expect(saved).toEqual(["B"]);
  });
});

describe("getMessageIdentity", () => {
  it("prefers idempotencyKey, else a stable content-sensitive digest", () => {
    expect(getMessageIdentity({ role: "user", content: "hi", idempotencyKey: "abc" })).toBe("k:abc");

    const a = { role: "user", content: "hi", timestamp: 1 };
    expect(getMessageIdentity(a)).toBe(getMessageIdentity({ ...a }));
    expect(getMessageIdentity(a)).not.toBe(getMessageIdentity({ ...a, content: "bye" }));
    expect(getMessageIdentity(a)).not.toBe(getMessageIdentity({ ...a, role: "assistant" }));
    expect(getMessageIdentity({})).toBeUndefined();
  });
});
