import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginState, type PluginState } from "../state.js";
import { registerAskTool } from "../tools/ask.js";
import { registerContextTool } from "../tools/context.js";
import { registerMessageSearchTool } from "../tools/message-search.js";
import { registerSearchTool } from "../tools/search.js";
import { registerSessionTool } from "../tools/session.js";

/**
 * Real plugin state over a fake Honcho, so participant resolution runs the
 * same code the gateway does. Every honcho.peer() call is a get-or-create
 * POST /peers on the real client; `created` records them.
 */
const fake = vi.hoisted(() => ({ honcho: undefined as unknown }));
vi.mock("../honcho-client.js", () => ({ createHonchoClient: () => fake.honcho }));

const GROUP_KEY = "agent:main:telegram:group:-100123456";

type FakePeer = {
  id: string;
  metadata: Record<string, unknown>;
  card: ReturnType<typeof vi.fn>;
  representation: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  chat: ReturnType<typeof vi.fn>;
  getMetadata: ReturnType<typeof vi.fn>;
  setMetadata: ReturnType<typeof vi.fn>;
};

function makePeer(id: string, metadata: Record<string, unknown> = {}): FakePeer {
  const peer: FakePeer = {
    id,
    metadata,
    card: vi.fn(async () => ["fact"]),
    representation: vi.fn(async () => "rep"),
    search: vi.fn(async () => []),
    chat: vi.fn(async () => "answer"),
    getMetadata: vi.fn(async () => peer.metadata),
    setMetadata: vi.fn(async (next: Record<string, unknown>) => {
      peer.metadata = next;
    }),
  };
  return peer;
}

type Msg = { peerId: string; content: string; createdAt?: string };

function setup(opts: {
  /** Peers already in the Honcho workspace. */
  existing?: FakePeer[];
  /** Who capture saw last in the shared session. */
  lastSender?: string;
  messages?: Msg[];
  peersFile?: Record<string, string>;
}) {
  const peers = new Map<string, FakePeer>();
  for (const p of opts.existing ?? []) peers.set(p.id, p);
  const created: string[] = [];
  const session = {
    getMetadata: vi.fn(async () =>
      opts.lastSender ? { participantSenderId: opts.lastSender } : {},
    ),
    setMetadata: vi.fn(async () => undefined),
    context: vi.fn(async () => ({
      summary: undefined,
      peerCard: undefined,
      peerRepresentation: undefined,
      messages: opts.messages ?? [],
    })),
  };
  let wsMeta: Record<string, unknown> = {};
  fake.honcho = {
    getMetadata: vi.fn(async () => wsMeta),
    setMetadata: vi.fn(async (m: Record<string, unknown>) => {
      wsMeta = m;
    }),
    peer: vi.fn(async (id: string, o?: { metadata?: Record<string, unknown> }) => {
      created.push(id);
      let p = peers.get(id);
      if (!p) peers.set(id, (p = makePeer(id, o?.metadata ?? {})));
      return p;
    }),
    peers: vi.fn(async () => [...peers.values()]),
    session: vi.fn(async () => session),
    search: vi.fn(async () => []),
  };

  writeFileSync(
    process.env.OPENCLAW_HONCHO_PEERS_FILE!,
    JSON.stringify({ version: 1, defaultUnknownPolicy: "per-sender", peers: opts.peersFile ?? {} }),
  );
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const state = createPluginState({
    pluginConfig: { baseUrl: "http://x" },
    logger,
    config: {},
  } as never);
  return { state, session, peers, created };
}

/** Register a tool against the given OpenClaw tool context and return it. */
function tool(
  register: (api: never, state: PluginState) => void,
  state: PluginState,
  toolCtx: Record<string, unknown>,
): { execute: (id: string, params: Record<string, unknown>) => Promise<any> } {
  let t: any;
  register({ registerTool: (factory: (ctx: unknown) => unknown) => { t = factory(toolCtx); } } as never, state);
  return t;
}

const telegramPeers = { "111": "111", "222": "222" };
const groupPeers = () => [makePeer("111", { channelPeerId: "111" }), makePeer("222", { channelPeerId: "222" })];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "oc-honcho-peers-"));
  process.env.OPENCLAW_HONCHO_PEERS_FILE = path.join(dir, "openclaw-peers.json");
});
afterEach(() => {
  delete process.env.OPENCLAW_HONCHO_PEERS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("tools target the requester, not the last captured sender", () => {
  // Bob (222) spoke last in the group, so session metadata names him; Alice
  // (111) is the one calling the tool.
  const aliceTurn = { sessionKey: GROUP_KEY, agentId: "main", requesterSenderId: "111" };

  it("honcho_session sends peer_target for the requester", async () => {
    const { state, session } = setup({ existing: groupPeers(), lastSender: "222", peersFile: telegramPeers });
    await tool(registerSessionTool, state, aliceTurn).execute("id", {});
    expect(session.context.mock.calls[0][0].peerTarget.id).toBe("111");
  });

  it("honcho_ask asks about the requester", async () => {
    const { state, peers } = setup({ existing: groupPeers(), lastSender: "222", peersFile: telegramPeers });
    await tool(registerAskTool, state, aliceTurn).execute("id", { query: "q" });
    const agent = peers.get("agent-main")!;
    expect(agent.chat.mock.calls[0][1].target.id).toBe("111");
  });

  it("honcho_context, honcho_search_conclusions and honcho_search_messages read the requester", async () => {
    const { state, peers } = setup({ existing: groupPeers(), lastSender: "222", peersFile: telegramPeers });
    await tool(registerContextTool, state, aliceTurn).execute("id", {});
    await tool(registerSearchTool, state, aliceTurn).execute("id", { query: "hike" });
    await tool(registerMessageSearchTool, state, aliceTurn).execute("id", { query: "hike", from: "user" });
    const alice = peers.get("111")!;
    const bob = peers.get("222")!;
    expect(alice.card).toHaveBeenCalled();
    expect(alice.representation).toHaveBeenCalled();
    expect(alice.search).toHaveBeenCalled();
    expect(bob.card).not.toHaveBeenCalled();
    expect(bob.representation).not.toHaveBeenCalled();
    expect(bob.search).not.toHaveBeenCalled();
  });

  it("an operator turn from the TUI targets owner, where capture files it", async () => {
    // Operator UI clients carry no sender id but are owner-trusted.
    const { state, session } = setup({ existing: groupPeers(), lastSender: "111", peersFile: telegramPeers });
    await tool(registerSessionTool, state, { sessionKey: GROUP_KEY, agentId: "main", senderIsOwner: true })
      .execute("id", {});
    expect(session.context.mock.calls[0][0].peerTarget.id).toBe("owner");
  });

  it("falls back to the last captured sender on hosts that report no requester", async () => {
    const { state, session } = setup({ existing: groupPeers(), lastSender: "222", peersFile: telegramPeers });
    await tool(registerSessionTool, state, { sessionKey: GROUP_KEY, agentId: "main" }).execute("id", {});
    expect(session.context.mock.calls[0][0].peerTarget.id).toBe("222");
  });

});

describe("honcho_session output", () => {
  it("labels each speaker by peer, so participants in a shared session can be told apart", async () => {
    const { state } = setup({
      existing: groupPeers(),
      peersFile: telegramPeers,
      messages: [
        { peerId: "111", content: "Planning a hike this weekend." },
        { peerId: "222", content: "I'll bring snacks." },
        { peerId: "agent-main", content: "Sounds fun!" },
      ],
    });
    const res = await tool(registerSessionTool, state, { sessionKey: GROUP_KEY, agentId: "main", requesterSenderId: "111" })
      .execute("id", {});
    const text: string = res.content[0].text;
    expect(text).toContain("**111**:\nPlanning a hike");
    expect(text).toContain("**222**:\nI'll bring snacks.");
    expect(text).toContain("**OpenClaw**:\nSounds fun!");
    expect(text).not.toContain("**User**");
  });

  it("does not claim a session with messages has no history when includeMessages is false", async () => {
    const { state } = setup({
      existing: groupPeers(),
      peersFile: telegramPeers,
      messages: [{ peerId: "111", content: "hi" }, { peerId: "agent-main", content: "hello" }],
    });
    const res = await tool(registerSessionTool, state, { sessionKey: GROUP_KEY, agentId: "main", requesterSenderId: "111" })
      .execute("id", { includeMessages: false });
    expect(res.content[0].text).not.toContain("No conversation history");
    expect(res.content[0].text).toContain("includeMessages: true");
    expect(res.details.messageCount).toBe(2);
  });

  it("still reports no history for an empty session", async () => {
    const { state } = setup({ existing: groupPeers(), peersFile: telegramPeers });
    const res = await tool(registerSessionTool, state, { sessionKey: GROUP_KEY, agentId: "main", requesterSenderId: "111" })
      .execute("id", { includeMessages: false });
    expect(res.content[0].text).toBe("No conversation history available for this session yet.");
    expect(res.details.messageCount).toBe(0);
  });
});
