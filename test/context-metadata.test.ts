import { describe, expect, it, vi } from "vitest";
import { registerContextHook } from "../hooks/context.js";
import { buildSessionKey } from "../helpers.js";
import type { PluginState } from "../state.js";

type Meta = Record<string, unknown>;

/** session() with a metadata argument replaces what capture persisted; the context hook must not pass one. */
describe("context hook preserves session metadata", () => {
  it("opens the session without metadata", async () => {
    const session = {
      metadata: { participantSenderId: "u1", openclawSessionKey: "agent:main:discord:dm:u1" } as Meta,
      getMetadata: vi.fn(async () => session.metadata),
      context: vi.fn(async () => ({ peerCard: [], peerRepresentation: "", summary: undefined })),
    };
    const peer = { id: "owner" };
    const state = {
      cfg: { noisePatterns: [], ownerObserveOthers: false, crossSessionSearch: true, workspaceId: "w", baseUrl: "b", recall: { automatic: "workspace", ask: "workspace" } },
      honcho: {
        session: vi.fn(async (_k: string, opts?: { metadata?: Meta }) => {
          if (opts?.metadata) session.metadata = { ...opts.metadata };
          return session;
        }),
      },
      turnProvenance: new Map(),
      ensureInitialized: vi.fn(async () => undefined),
      getAgentPeer: vi.fn(async () => ({ id: "agent-main" })),
      getParticipantPeer: vi.fn(async () => peer),
      resolveSessionParticipantPeer: vi.fn(async () => peer),
      resolveDefaultAgentId: vi.fn(() => "main"),
    } as unknown as PluginState;

    let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
    registerContextHook(
      { on: (name: string, fn: never) => { if (name === "before_prompt_build") handler = fn; }, logger: { debug: vi.fn(), warn: vi.fn() } } as never,
      state,
    );
    await handler?.({ prompt: "next turn", messages: [] }, { sessionKey: "agent:main:discord:dm:u1", agentId: "main" });

    expect(state.honcho.session).toHaveBeenCalledWith(expect.any(String));
    expect(session.metadata.participantSenderId).toBe("u1");
  });

  it("opens the same per-sender session capture writes for a shared-key DM (#149)", async () => {
    const state = {
      cfg: { captureSystemRuns: false, recall: { automatic: "workspace", ask: "workspace" } },
      honcho: { session: vi.fn(async () => ({ context: vi.fn(async () => ({})) })) },
      turnProvenance: new Map(),
      ensureInitialized: vi.fn(async () => undefined),
      getAgentPeer: vi.fn(async () => ({ id: "agent-main" })),
      getParticipantPeer: vi.fn(async () => ({ id: "111" })),
      resolveDefaultAgentId: vi.fn(() => "main"),
    } as unknown as PluginState;

    let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
    registerContextHook(
      { on: (name: string, fn: never) => { if (name === "before_prompt_build") handler = fn; }, logger: { debug: vi.fn(), warn: vi.fn() } } as never,
      state,
    );
    await handler?.({ prompt: "hello there", messages: [] }, { sessionKey: "agent:main:main", agentId: "main", channel: "telegram", senderId: "111" });

    expect(state.honcho.session).toHaveBeenCalledWith(
      buildSessionKey({ sessionKey: "agent:main:telegram:direct:111", agentId: "main" }),
    );
  });

  it("does not open a session for a cron run", async () => {
    const state = {
      cfg: { captureSystemRuns: false, recall: { automatic: "workspace", ask: "workspace" } },
      honcho: { session: vi.fn() },
      turnProvenance: new Map(),
      ensureInitialized: vi.fn(async () => undefined),
      resolveDefaultAgentId: vi.fn(() => "main"),
    } as unknown as PluginState;

    let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
    registerContextHook(
      { on: (name: string, fn: never) => { if (name === "before_prompt_build") handler = fn; }, logger: { debug: vi.fn(), warn: vi.fn() } } as never,
      state,
    );
    await handler?.({ prompt: "Job ID: abc | Received: Tuesday", messages: [] }, { sessionKey: "agent:main:cron:job-1:run:r-1", agentId: "main" });

    expect(state.honcho.session).not.toHaveBeenCalled();
  });
});
