import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const mockSdk = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock("@honcho-ai/sdk", () => {
  class MockPeer {
    metadata: Record<string, unknown> = {};
    getMetadata = vi.fn(async () => ({ ...this.metadata }));
    setMetadata = vi.fn(async (next: Record<string, unknown>) => {
      this.metadata = { ...next };
    });

    constructor(public id: string, initial?: Record<string, unknown>) {
      this.metadata = { ...(initial ?? {}) };
    }
  }

  class Honcho {
    metadata: Record<string, unknown> = {};
    peerById = new Map<string, MockPeer>();
    options: Record<string, unknown>;
    getMetadata = vi.fn(async () => ({ ...this.metadata }));
    setMetadata = vi.fn(async (next: Record<string, unknown>) => {
      this.metadata = { ...next };
    });
    peer = vi.fn(async (id: string, opts?: { metadata?: Record<string, unknown> }) => {
      let peer = this.peerById.get(id);
      if (!peer) {
        peer = new MockPeer(id, opts?.metadata);
        this.peerById.set(id, peer);
      }
      return peer;
    });
    peers = vi.fn(async () => this.peerById.values());
    session = vi.fn(async () => ({
      getMetadata: vi.fn(async () => ({})),
    }));

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mockSdk.instances.push(this);
    }
  }

  return { Honcho };
});

import { buildWorkspaceKey, createPluginState } from "../state.js";

function loggerStub() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function api(pluginConfig: Record<string, unknown> = {}) {
  return {
    pluginConfig: {
      workspaceId: "legacy",
      baseUrl: "http://127.0.0.1:8000",
      ...pluginConfig,
    },
    config: { agents: { list: [{ id: "main", default: true }] } },
    logger: loggerStub(),
  } as any;
}

const originalPeersFile = process.env.OPENCLAW_HONCHO_PEERS_FILE;
let tmpDirs: string[] = [];

beforeEach(() => {
  mockSdk.instances.length = 0;
});

afterEach(async () => {
  if (originalPeersFile === undefined) delete process.env.OPENCLAW_HONCHO_PEERS_FILE;
  else process.env.OPENCLAW_HONCHO_PEERS_FILE = originalPeersFile;
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function isolatedPeersFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "honcho-workspace-state-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "openclaw-peers.json");
  process.env.OPENCLAW_HONCHO_PEERS_FILE = file;
  return file;
}

describe("workspace state registry", () => {
  it("memoizes one Honcho client per workspace and preserves the legacy facade", async () => {
    await isolatedPeersFile();
    const state = createPluginState(api());
    const legacy = state.getWorkspaceState("legacy");
    const work = state.getWorkspaceState("work");

    expect(state.honcho).toBe(legacy.honcho);
    expect(state.getWorkspaceState("work")).toBe(work);
    expect(work).not.toBe(legacy);
    expect(work.honcho).not.toBe(legacy.honcho);
    expect(mockSdk.instances.map((instance) => instance.options.workspaceId)).toEqual(["legacy", "work"]);
    expect(state.workspaces.size).toBe(2);
  });

  it("isolates peer maps, participant caches, and turn cursors", async () => {
    await isolatedPeersFile();
    const state = createPluginState(api());
    const a = state.getWorkspaceState("a");
    const b = state.getWorkspaceState("b");

    a.agentPeerMap.main = "agent-a";
    a.participantPeers.set("sender", { id: "participant-a" } as any);
    a.turnStartIndex.set("same-session", 42);

    expect(b.agentPeerMap).toEqual({});
    expect(b.participantPeers.has("sender")).toBe(false);
    expect(b.turnStartIndex.has("same-session")).toBe(false);
  });

  it("uses the historical peers file only for the configured default workspace", async () => {
    const file = await isolatedPeersFile();
    await fs.writeFile(file, JSON.stringify({ version: 1, peers: { alice: "owner" } }));

    const state = createPluginState(api());
    const legacy = state.getWorkspaceState("legacy");
    const routed = state.getWorkspaceState("../unsafe/workspace");

    expect(legacy.peersPersister.filePath).toBe(file);
    expect(legacy.peersPersister.peers).toEqual({ alice: "owner" });
    expect(routed.peersPersister.filePath).not.toBe(file);
    expect(path.dirname(routed.peersPersister.filePath)).toBe(path.dirname(file));
    expect(routed.peersPersister.filePath).not.toContain("unsafe");
    expect(routed.peersPersister.peers).toEqual({});
  });

  it("does not expose API key material in the registry key", () => {
    const apiKey = "super-secret-key";
    const a = buildWorkspaceKey({ baseUrl: "https://example.test/", apiKey }, "workspace");
    const b = buildWorkspaceKey({ baseUrl: "https://example.test", apiKey: "different" }, "workspace");

    expect(a).not.toContain(apiKey);
    expect(a).not.toBe(b);
    expect(a).toBe(buildWorkspaceKey({ baseUrl: "https://example.test", apiKey }, "workspace"));
  });

  it("keeps non-default peers persistence stable across API key rotation", async () => {
    await isolatedPeersFile();
    const before = createPluginState(api({ apiKey: "old-key" })).getWorkspaceState("work");
    const after = createPluginState(api({ apiKey: "rotated-key" })).getWorkspaceState("work");

    expect(before.workspaceKey).not.toBe(after.workspaceKey);
    expect(before.honcho).not.toBe(after.honcho);
    expect(before.peersPersister.filePath).toBe(after.peersPersister.filePath);
  });
});

describe("workspace initialization and metadata serialization", () => {
  it("coalesces concurrent initialization per workspace but initializes workspaces independently", async () => {
    await isolatedPeersFile();
    const state = createPluginState(api());
    const a = state.getWorkspaceState("a");
    const b = state.getWorkspaceState("b");

    await Promise.all([a.ensureInitialized(), a.ensureInitialized(), b.ensureInitialized()]);

    expect((a.honcho as any).getMetadata).toHaveBeenCalledTimes(1);
    expect((b.honcho as any).getMetadata).toHaveBeenCalledTimes(1);
    expect((a.honcho as any).setMetadata).toHaveBeenCalledTimes(1);
    expect((b.honcho as any).setMetadata).toHaveBeenCalledTimes(1);
    expect(a.initialized).toBe(true);
    expect(b.initialized).toBe(true);
  });

  it("retries a failed initialization without poisoning another workspace", async () => {
    await isolatedPeersFile();
    const state = createPluginState(api());
    const broken = state.getWorkspaceState("broken");
    const healthy = state.getWorkspaceState("healthy");
    (broken.honcho as any).getMetadata
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({});

    await expect(broken.ensureInitialized()).rejects.toThrow("temporary outage");
    await expect(healthy.ensureInitialized()).resolves.toBeUndefined();
    await expect(broken.ensureInitialized()).resolves.toBeUndefined();

    expect((broken.honcho as any).getMetadata).toHaveBeenCalledTimes(2);
    expect((healthy.honcho as any).getMetadata).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent agent-map creation within one workspace", async () => {
    await isolatedPeersFile();
    const state = createPluginState(api());
    const workspace = state.getWorkspaceState("work");
    await workspace.ensureInitialized();

    const [first, second] = await Promise.all([
      workspace.getAgentPeer("silva"),
      workspace.getAgentPeer("silva"),
    ]);

    expect(first).toBe(second);
    expect((workspace.honcho as any).peers).toHaveBeenCalledTimes(1);
    expect(workspace.agentPeerMap.silva).toBe("agent-silva");
  });
});

describe("workspace/session locks", () => {
  it("serializes the same session locally while allowing the same key in another workspace", async () => {
    await isolatedPeersFile();
    const state = createPluginState(api());
    const a = state.getWorkspaceState("a");
    const b = state.getWorkspaceState("b");
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = a.withSessionLock("same", async () => {
      events.push("a:first:start");
      await gate;
      events.push("a:first:end");
    });
    await Promise.resolve();
    const second = a.withSessionLock("same", async () => {
      events.push("a:second:start");
    });
    const otherWorkspace = b.withSessionLock("same", async () => {
      events.push("b:start");
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["a:first:start", "b:start"]);
    release();
    await Promise.all([first, second, otherWorkspace]);
    expect(events).toEqual(["a:first:start", "b:start", "a:first:end", "a:second:start"]);
  });

  it("continues a session queue after a rejected operation", async () => {
    await isolatedPeersFile();
    const workspace = createPluginState(api()).getWorkspaceState("work");

    await expect(
      workspace.withSessionLock("session", async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    await expect(
      workspace.withSessionLock("session", async () => "recovered"),
    ).resolves.toBe("recovered");
  });
});
