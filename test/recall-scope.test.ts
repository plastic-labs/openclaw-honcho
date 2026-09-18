import { describe, expect, it, vi } from "vitest";
import { honchoConfigSchema } from "../config.js";
import { sessionRecallOptions, peerRecallOptions, buildSessionKey } from "../helpers.js";
import { registerContextHook } from "../hooks/context.js";
import { registerAskTool } from "../tools/ask.js";
import type { PluginState } from "../state.js";

const ctx = { sessionKey: "agent:main:discord:dm:u1", agentId: "main" };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function mkState(recall: Record<string, unknown>) {
  const session = {
    context: vi.fn(async () => ({ peerCard: ["fact"], peerRepresentation: "rep", summary: undefined })),
    getMetadata: vi.fn(async () => ({})),
    setMetadata: vi.fn(async () => undefined),
  };
  const agentPeer = { id: "agent-main", chat: vi.fn(async () => "answer") };
  const peer = { id: "owner" };
  const state = {
    cfg: honchoConfigSchema.parse({ baseUrl: "http://x", recall }),
    honcho: { session: vi.fn(async () => session) },
    turnStartIndex: new Map<string, number>(),
    ensureInitialized: vi.fn(async () => undefined),
    getAgentPeer: vi.fn(async () => agentPeer),
    getParticipantPeer: vi.fn(async () => peer),
    resolveSessionParticipantPeer: vi.fn(async () => peer),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as PluginState;
  return { state, session, agentPeer };
}

/** Run the before_prompt_build hook and return the session.context() arguments. */
async function contextArgs(recall: Record<string, unknown>) {
  const { state, session } = mkState(recall);
  let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
  registerContextHook(
    { on: (n: string, fn: never) => { if (n === "before_prompt_build") handler = fn; }, logger } as never,
    state,
  );
  await handler?.({ prompt: "a real prompt", messages: [] }, ctx);
  return session.context.mock.calls[0]?.[0] ?? {};
}

/** Run honcho_ask and return the peer.chat() options. */
async function askArgs(recall: Record<string, unknown>) {
  const { state, agentPeer } = mkState(recall);
  let tool: any;
  registerAskTool({ registerTool: (factory: any) => { tool = factory(ctx); } } as never, state);
  await tool.execute("id", { query: "q" });
  return agentPeer.chat.mock.calls[0]?.[1] ?? {};
}

describe("recall boundaries are applied per path", () => {
  it("reaches across the workspace by default, which is what a workspace is for", async () => {
    const args = await contextArgs({});
    expect(args.limitToSession).toBeUndefined();
    expect(args.scope).toBeUndefined();
    expect(args.peerPerspective).toBeDefined();
    expect((await askArgs({})).session).toBeUndefined();
  });

  it("narrows to the session when asked", async () => {
    expect((await contextArgs({ automatic: "session" })).limitToSession).toBe(true);
    expect((await askArgs({ ask: "session" })).session).toBe(buildSessionKey(ctx));
  });

  it("uses the scope and drops peerPerspective, which the SDK rejects alongside scope", async () => {
    const args = await contextArgs({ automatic: "scope", scopeName: "client-a" });
    expect(args.scope).toBe("client-a");
    expect(args.peerPerspective).toBeUndefined();
    expect(args.limitToSession).toBeUndefined();
    expect((await askArgs({ ask: "scope", scopeName: "client-a" })).scope).toBe("client-a");
  });

  it("falls back to the session when scope is selected without a name", () => {
    // Narrower than intended beats wider than intended.
    const cfg = honchoConfigSchema.parse({ baseUrl: "http://x", recall: { automatic: "scope" } });
    expect(cfg.recall.automatic).toBe("session");
  });

  it("ignores unknown values rather than passing them through", () => {
    const cfg = honchoConfigSchema.parse({ baseUrl: "http://x", recall: { automatic: "everything" } });
    expect(cfg.recall.automatic).toBe("workspace");
  });
});

describe("recall option builders", () => {
  it("maps each boundary to the right SDK options", () => {
    expect(sessionRecallOptions("session")).toEqual({ limitToSession: true });
    expect(sessionRecallOptions("scope", "s")).toEqual({ scope: "s" });
    expect(sessionRecallOptions("workspace")).toEqual({});
    expect(peerRecallOptions("session", undefined, "sid")).toEqual({ session: "sid" });
    expect(peerRecallOptions("scope", "s", "sid")).toEqual({ scope: "s" });
    expect(peerRecallOptions("workspace", undefined, "sid")).toEqual({});
  });
});
