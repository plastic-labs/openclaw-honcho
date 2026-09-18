import { describe, expect, it, vi } from "vitest";
import { registerContextHook } from "../hooks/context.js";
import { flushMessages } from "../hooks/capture.js";
import { buildSessionKey } from "../helpers.js";
import type { PluginState } from "../state.js";

type Meta = Record<string, unknown>;

/**
 * before_prompt_build runs before agent_end on every turn. If the context hook
 * replaces session metadata, it destroys the watermark capture depends on, and
 * capture silently falls back to the positional cursor (see #134 / #136).
 */
describe("context hook preserves the capture watermark", () => {
  it("leaves lastSavedMessageId intact across a turn boundary", async () => {
    const session = {
      metadata: {} as Meta,
      getMetadata: vi.fn(async () => session.metadata),
      setMetadata: vi.fn(async (n: Meta) => { session.metadata = n; }),
      addPeers: vi.fn(async () => undefined),
      addMessages: vi.fn(async () => undefined),
      context: vi.fn(async () => ({ peerCard: [], peerRepresentation: "", summary: undefined })),
    };
    const peer = { id: "owner", message: (text: string) => ({ text }) };
    const state = {
      cfg: { noisePatterns: [], ownerObserveOthers: false, crossSessionSearch: true, workspaceId: "w", baseUrl: "b" },
      honcho: {
        // Real SDK semantics: metadata on session() REPLACES persisted metadata.
        session: vi.fn(async (_k: string, opts?: { metadata?: Meta }) => {
          if (opts?.metadata) session.metadata = { ...opts.metadata };
          return session;
        }),
      },
      turnStartIndex: new Map<string, number>(),
      ensureInitialized: vi.fn(async () => undefined),
      getAgentPeer: vi.fn(async () => ({ id: "agent-main", message: (text: string) => ({ text }) })),
      getParticipantPeer: vi.fn(async () => peer),
      resolveSessionParticipantPeer: vi.fn(async () => peer),
      resolveDefaultAgentId: vi.fn(() => "main"),
    } as unknown as PluginState;

    const ctx = { sessionKey: "agent:main:discord:dm:u1", agentId: "main" };
    const api = { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never;

    // Turn 1 capture writes the watermark.
    await flushMessages(api, state, [
      { role: "user", content: "hello", timestamp: 1, idempotencyKey: "a" },
      { role: "assistant", content: "hi", timestamp: 2, idempotencyKey: "b" },
    ], ctx);
    const anchor = session.metadata.lastSavedMessageId;
    expect(anchor).toBeTruthy();

    // Turn 2: before_prompt_build fires first.
    let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
    registerContextHook(
      { on: (name: string, fn: never) => { if (name === "before_prompt_build") handler = fn; }, logger: api.logger } as never,
      state,
    );
    await handler?.({ prompt: "next turn", messages: [] }, ctx);

    expect(session.metadata.lastSavedMessageId).toBe(anchor);
    expect(state.turnStartIndex.get(buildSessionKey(ctx))).toBe(0);
  });
});
