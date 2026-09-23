import { describe, expect, it, vi } from "vitest";
import { flushMessages } from "../hooks/capture.js";
import type { PluginState } from "../state.js";

/**
 * #148: an established session with no anchor whose runtime hands `agent_end`
 * only the current turn. The no-anchor fallback returned 0 forever; capture now
 * derives the turn from the array and needs no anchor.
 */
function mockState(metadata: Record<string, unknown>) {
  const session = {
    metadata,
    getMetadata: vi.fn(async () => session.metadata),
    setMetadata: vi.fn(async (n: Record<string, unknown>) => { session.metadata = n; }),
    addPeers: vi.fn(async () => undefined),
    addMessages: vi.fn(async () => undefined),
  };
  const peer = (id: string) => ({ id, message: (text: string) => ({ text }) });
  const state = {
    cfg: { noisePatterns: [], ownerObserveOthers: false, captureSystemRuns: false },
    honcho: { session: vi.fn(async () => session) },
    turnProvenance: new Map(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => peer("agent-main")),
    getParticipantPeer: vi.fn(async () => peer("owner")),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;
  return { state, session };
}

const api = { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never;
const ctx = { sessionKey: "agent:main:discord:dm:u1", agentId: "main" };
const turn = [
  { role: "user", content: "current question", timestamp: 11 },
  { role: "assistant", content: "current answer", timestamp: 12 },
];

describe("#148 unanchored established session", () => {
  it("saves a current-turn snapshot with empty metadata", async () => {
    const { state, session } = mockState({});
    expect(await flushMessages(api, state, turn, ctx)).toBe(2);
    expect(session.addMessages).toHaveBeenCalledTimes(1);
  });

  it("saves only the current turn when a stale 1.5.6 anchor is present", async () => {
    const { state, session } = mockState({ lastSavedIndex: 10, lastSavedMessageId: "h:stale" });
    const full = [
      ...Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `old ${i}`,
        timestamp: i + 1,
      })),
      ...turn,
    ];
    expect(await flushMessages(api, state, full, ctx)).toBe(2);
    expect(session.addMessages.mock.calls[0][0].map((m: { text: string }) => m.text)).toEqual([
      "current question",
      "current answer",
    ]);
  });
});
