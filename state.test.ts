import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const { HonchoMock, peerCtor, sessionCtor } = vi.hoisted(() => {
  const peerCtor = vi.fn();
  const sessionCtor = vi.fn();
  class HonchoMock {
    workspaceId: string | undefined;
    constructor(opts: { workspaceId?: string } = {}) {
      this.workspaceId = opts.workspaceId;
    }
    async getMetadata() {
      return {};
    }
    async setMetadata(_meta: Record<string, unknown>) {
      return undefined;
    }
    async peer(id: string, opts?: Record<string, unknown>) {
      return peerCtor(id, opts);
    }
    async session(key: string) {
      return sessionCtor(key);
    }
    async *peers() {
      // empty iterator
    }
  }
  return { HonchoMock, peerCtor, sessionCtor };
});

vi.mock("@honcho-ai/sdk", () => ({
  Honcho: HonchoMock,
}));

// Import after vi.mock so the mocked SDK is used.
const { OWNER_ID, createPluginState } = await import("./state.js");

function makeApi(extra: Partial<{ pluginConfig: Record<string, unknown> }> = {}) {
  return {
    pluginConfig: extra.pluginConfig ?? { workspaceId: "test", baseUrl: "http://localhost:8000" },
    config: { agents: { list: [{ id: "main", default: true }] } },
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as Parameters<typeof createPluginState>[0];
}

describe("createPluginState.getParticipantPeer", () => {
  let peersFile: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    peersFile = path.join(dir, "peers.json");
    process.env.OPENCLAW_HONCHO_PEERS_FILE = peersFile;
    peerCtor.mockReset();
    sessionCtor.mockReset();
    peerCtor.mockImplementation(async (id: string, opts?: Record<string, unknown>) => ({
      id,
      metadata: opts?.metadata ?? {},
      async getMetadata() {
        return {};
      },
      async setMetadata() {
        return undefined;
      },
    }));
  });

  afterEach(() => {
    delete process.env.OPENCLAW_HONCHO_PEERS_FILE;
  });

  it("creates a distinct transient peer for first-seen senders instead of caching owner", async () => {
    // Regression for CodeRabbit comment on #68 (state.ts:165-179): an
    // auto-seeded sender must NOT be cached as the owner peer.
    const state = createPluginState(makeApi());
    await state.ensureInitialized();

    const peer = await state.getParticipantPeer("slack:Ualice");
    expect(peer.id).toBe("participant-slack:Ualice");
    expect(peer.id).not.toBe(OWNER_ID);

    // The owner peer cache entry must be unaffected.
    const ownerPeer = await state.getParticipantPeer();
    expect(ownerPeer.id).toBe(OWNER_ID);

    // A second resolution for the same channelPeerId returns the same
    // transient peer (not owner) — the cache holds the participant entry.
    const again = await state.getParticipantPeer("slack:Ualice");
    expect(again.id).toBe("participant-slack:Ualice");

    // The auto-seeded mapping was enqueued to the persister with the
    // transient peer id, not OWNER_ID.
    expect(state.peersPersister.peers["slack:Ualice"]).toBe("participant-slack:Ualice");
  });

  it("honors explicit owner mapping in the peers file", async () => {
    // When the user has hand-edited peers.json to map a channel id to
    // OWNER_ID, that explicit mapping should resolve to the owner peer.
    await fs.mkdir(path.dirname(peersFile), { recursive: true });
    await fs.writeFile(
      peersFile,
      JSON.stringify({ version: 1, peers: { "slack:Ubob": "owner" } }),
    );

    const state = createPluginState(makeApi());
    await state.ensureInitialized();

    const peer = await state.getParticipantPeer("slack:Ubob");
    expect(peer.id).toBe(OWNER_ID);
  });
});

describe("createPluginState.resolveSessionParticipantPeer", () => {
  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    process.env.OPENCLAW_HONCHO_PEERS_FILE = path.join(dir, "peers.json");
    peerCtor.mockReset();
    sessionCtor.mockReset();
    peerCtor.mockImplementation(async (id: string) => ({
      id,
      async getMetadata() {
        return {};
      },
      async setMetadata() {
        return undefined;
      },
    }));
  });

  afterEach(() => {
    delete process.env.OPENCLAW_HONCHO_PEERS_FILE;
  });

  it("propagates honcho.session() errors instead of falling back to owner", async () => {
    // Regression for CodeRabbit comment on #68 (state.ts:182-196): SDK/read
    // failures must surface, not silently route to the owner peer.
    sessionCtor.mockRejectedValueOnce(new Error("network down"));

    const state = createPluginState(makeApi());
    await state.ensureInitialized();

    await expect(state.resolveSessionParticipantPeer("session-X")).rejects.toThrow(
      /network down/,
    );
  });

  it("falls back to owner only when metadata exists but has no senderId", async () => {
    sessionCtor.mockResolvedValueOnce({
      async getMetadata() {
        return { agentId: "main" }; // no participantSenderId
      },
    });

    const state = createPluginState(makeApi());
    await state.ensureInitialized();

    const peer = await state.resolveSessionParticipantPeer("session-Y");
    expect(peer.id).toBe(OWNER_ID);
  });
});
