import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PEERS_FILE_VERSION,
  PeersPersister,
  loadPeersFile,
  loadPeersFileSync,
  resolvePeersFilePath,
  resolveParticipantPeerId,
} from "./peers.js";

async function mktmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "openclaw-peers-"));
}

describe("resolvePeersFilePath", () => {
  const originalEnv = process.env.OPENCLAW_HONCHO_PEERS_FILE;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OPENCLAW_HONCHO_PEERS_FILE;
    else process.env.OPENCLAW_HONCHO_PEERS_FILE = originalEnv;
  });

  it("defaults to ~/.honcho/openclaw-peers.json", () => {
    delete process.env.OPENCLAW_HONCHO_PEERS_FILE;
    expect(resolvePeersFilePath()).toBe(path.join(os.homedir(), ".honcho", "openclaw-peers.json"));
  });

  it("respects OPENCLAW_HONCHO_PEERS_FILE override", () => {
    process.env.OPENCLAW_HONCHO_PEERS_FILE = "/tmp/custom-peers.json";
    expect(resolvePeersFilePath()).toBe("/tmp/custom-peers.json");
  });

  it("trims whitespace on the override", () => {
    process.env.OPENCLAW_HONCHO_PEERS_FILE = "  /tmp/ws.json  ";
    expect(resolvePeersFilePath()).toBe("/tmp/ws.json");
  });

  it("ignores empty-string overrides", () => {
    process.env.OPENCLAW_HONCHO_PEERS_FILE = "";
    expect(resolvePeersFilePath()).toBe(path.join(os.homedir(), ".honcho", "openclaw-peers.json"));
  });
});

describe("loadPeersFile", () => {
  it("returns an empty seed when the file is missing", async () => {
    const dir = await mktmp();
    const missing = path.join(dir, "does", "not", "exist.json");
    await expect(loadPeersFile(missing)).resolves.toEqual({
      version: PEERS_FILE_VERSION,
      peers: {},
    });
    expect(loadPeersFileSync(missing)).toEqual({
      version: PEERS_FILE_VERSION,
      peers: {},
    });
  });

  it("reads a well-formed file", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, peers: { "slack:U1": "owner", "slack:U2": "alice" } }),
    );
    await expect(loadPeersFile(file)).resolves.toEqual({
      version: 1,
      peers: { "slack:U1": "owner", "slack:U2": "alice" },
    });
  });

  it("tolerates malformed JSON by returning empty", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    await fs.writeFile(file, "{ not valid json");
    await expect(loadPeersFile(file)).resolves.toEqual({
      version: PEERS_FILE_VERSION,
      peers: {},
    });
  });
});

describe("resolveParticipantPeerId", () => {
  function persister(initial: Record<string, string> = {}) {
    return new PeersPersister("/dev/null", {
      version: PEERS_FILE_VERSION,
      peers: { ...initial },
    });
  }

  it("returns the mapped peer for a known sender", () => {
    const p = persister({ "slack:U1": "alice" });
    expect(resolveParticipantPeerId("slack:U1", p)).toBe("alice");
  });

  it("returns owner (no enqueue) for a sender auto-seeded to owner", () => {
    const p = persister({ "slack:U2": "owner" });
    const enqueueSpy = vi.spyOn(p, "enqueue");
    expect(resolveParticipantPeerId("slack:U2", p)).toBe("owner");
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("enqueues unknown senders and returns owner", () => {
    const p = persister({});
    const enqueueSpy = vi.spyOn(p, "enqueue");
    expect(resolveParticipantPeerId("slack:U3", p)).toBe("owner");
    expect(enqueueSpy).toHaveBeenCalledWith("slack:U3", "owner");
    expect(p.peers["slack:U3"]).toBe("owner");
  });
});

describe("PeersPersister", () => {
  it("enqueue is idempotent per sender", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    const p = new PeersPersister(file, {
      version: PEERS_FILE_VERSION,
      peers: {},
    });
    p.enqueue("slack:U1");
    p.enqueue("slack:U1");
    p.enqueue("slack:U1");
    expect(Object.keys(p.peers)).toEqual(["slack:U1"]);
  });

  it("does not overwrite an existing mapping on enqueue", () => {
    const p = new PeersPersister("/dev/null", {
      version: PEERS_FILE_VERSION,
      peers: { "slack:U1": "alice" },
    });
    p.enqueue("slack:U1");
    expect(p.peers["slack:U1"]).toBe("alice");
  });

  it("coalesces 3 enqueues within the debounce window into one file write", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    const writeSpy = vi.spyOn(fs, "writeFile");
    const p = new PeersPersister(
      file,
      { version: PEERS_FILE_VERSION, peers: {} },
      { debounceMs: 50 },
    );

    p.enqueue("slack:U1");
    p.enqueue("slack:U2");
    p.enqueue("slack:U3");

    expect(writeSpy).not.toHaveBeenCalled();

    await p.flushNow();
    expect(writeSpy).toHaveBeenCalledTimes(1);

    await p.flushNow();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    writeSpy.mockRestore();

    const body = JSON.parse(await fs.readFile(file, "utf8"));
    expect(body).toEqual({
      version: 1,
      peers: {
        "slack:U1": "owner",
        "slack:U2": "owner",
        "slack:U3": "owner",
      },
    });
  });

  it("creates the peers file on first flush when missing at boot", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "nested", "peers.json");
    const loaded = loadPeersFileSync(file);
    expect(loaded).toEqual({ version: PEERS_FILE_VERSION, peers: {} });

    const p = new PeersPersister(file, loaded, { debounceMs: 10 });
    p.enqueue("slack:Unew");
    await p.flushNow();

    const body = JSON.parse(await fs.readFile(file, "utf8"));
    expect(body).toEqual({
      version: 1,
      peers: { "slack:Unew": "owner" },
    });
  });

  it("flushNow is a no-op when nothing is dirty", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    const p = new PeersPersister(file, {
      version: PEERS_FILE_VERSION,
      peers: {},
    });
    await p.flushNow();
    await expect(fs.access(file)).rejects.toBeTruthy();
  });

  it("keeps dirty=true and propagates errors when fs.writeFile fails, then retries on next flush", async () => {
    // Regression test for CodeRabbit comment on #68 (peers.ts:129-158):
    // flush() must not clear dirty before the write succeeds, and write
    // failures must propagate so callers can react / retry.
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    const p = new PeersPersister(
      file,
      { version: PEERS_FILE_VERSION, peers: {} },
      { debounceMs: 10 },
    );

    const writeSpy = vi.spyOn(fs, "writeFile");
    writeSpy.mockRejectedValueOnce(new Error("disk full"));

    p.enqueue("slack:U1");

    // First flush rejects — error must reach the awaiter, not be swallowed.
    await expect(p.flushNow()).rejects.toThrow(/disk full/);

    // Second flush retries (dirty was preserved across the failed write) and
    // this time fs.writeFile is the real implementation, so it succeeds.
    await p.flushNow();
    expect(writeSpy).toHaveBeenCalledTimes(2);

    const body = JSON.parse(await fs.readFile(file, "utf8"));
    expect(body).toEqual({
      version: 1,
      peers: { "slack:U1": "owner" },
    });

    writeSpy.mockRestore();
  });
});
