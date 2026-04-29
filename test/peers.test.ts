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
} from "../peers.js";

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
  it("returns a per-sender seed when the file is missing (fresh install)", async () => {
    const dir = await mktmp();
    const missing = path.join(dir, "does", "not", "exist.json");
    await expect(loadPeersFile(missing)).resolves.toEqual({
      version: PEERS_FILE_VERSION,
      defaultUnknownPolicy: "per-sender",
      peers: {},
    });
    expect(loadPeersFileSync(missing)).toEqual({
      version: PEERS_FILE_VERSION,
      defaultUnknownPolicy: "per-sender",
      peers: {},
    });
  });

  it("reads a legacy file (no policy field) as owner-policy", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, peers: { "slack:U1": "owner", "slack:U2": "alice" } }),
    );
    await expect(loadPeersFile(file)).resolves.toEqual({
      version: 1,
      defaultUnknownPolicy: "owner",
      peers: { "slack:U1": "owner", "slack:U2": "alice" },
    });
  });

  it("respects an explicit defaultUnknownPolicy field", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, defaultUnknownPolicy: "per-sender", peers: {} }),
    );
    await expect(loadPeersFile(file)).resolves.toEqual({
      version: 1,
      defaultUnknownPolicy: "per-sender",
      peers: {},
    });
  });

  it("treats malformed JSON in an existing file as legacy (owner) — never silently upgrades", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    await fs.writeFile(file, "{ not valid json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(loadPeersFile(file)).resolves.toEqual({
      version: PEERS_FILE_VERSION,
      defaultUnknownPolicy: "owner",
      peers: {},
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(file));
    warn.mockRestore();
  });
});

describe("resolveParticipantPeerId", () => {
  function persister(
    initial: Record<string, string> = {},
    defaultUnknownPolicy: "owner" | "per-sender" = "owner",
  ) {
    return new PeersPersister("/dev/null", {
      version: PEERS_FILE_VERSION,
      defaultUnknownPolicy,
      peers: { ...initial },
    });
  }

  it("returns the mapped peer for a known sender", () => {
    const p = persister({ "slack:U1": "alice" });
    expect(resolveParticipantPeerId("slack:U1", p)).toBe("alice");
  });

  it("returns owner (no enqueue) for a sender already mapped to owner", () => {
    const p = persister({ "slack:U2": "owner" });
    const enqueueSpy = vi.spyOn(p, "enqueue");
    expect(resolveParticipantPeerId("slack:U2", p)).toBe("owner");
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("under owner policy: enqueues unknown senders as owner", () => {
    const p = persister({}, "owner");
    expect(resolveParticipantPeerId("slack:U3", p)).toBe("owner");
    expect(p.peers["slack:U3"]).toBe("owner");
  });

  it("under per-sender policy: derives a sanitized peer ID from the sender_id", () => {
    const p = persister({}, "per-sender");
    expect(resolveParticipantPeerId("slack:U07A.bot@team", p)).toBe("slack_U07A_bot_team");
    expect(p.peers["slack:U07A.bot@team"]).toBe("slack_U07A_bot_team");
  });

  it("under per-sender policy: hand-mapped owner mappings still resolve to owner", () => {
    const p = persister({ "slack:U5": "owner" }, "per-sender");
    expect(resolveParticipantPeerId("slack:U5", p)).toBe("owner");
  });

  it("under per-sender policy: truncates to fit Honcho's 100-char peer ID limit", () => {
    const p = persister({}, "per-sender");
    const long = "x".repeat(200);
    const id = resolveParticipantPeerId(long, p);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(/^[a-zA-Z0-9_-]+$/.test(id)).toBe(true);
  });
});

describe("PeersPersister", () => {
  function emptyFile(defaultUnknownPolicy: "owner" | "per-sender" = "owner") {
    return { version: PEERS_FILE_VERSION, defaultUnknownPolicy, peers: {} } as const;
  }

  it("enqueue is idempotent per sender", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    const p = new PeersPersister(file, emptyFile());
    p.enqueue("slack:U1");
    p.enqueue("slack:U1");
    p.enqueue("slack:U1");
    expect(Object.keys(p.peers)).toEqual(["slack:U1"]);
  });

  it("does not overwrite an existing mapping on enqueue", () => {
    const p = new PeersPersister("/dev/null", {
      version: PEERS_FILE_VERSION,
      defaultUnknownPolicy: "owner",
      peers: { "slack:U1": "alice" },
    });
    p.enqueue("slack:U1");
    expect(p.peers["slack:U1"]).toBe("alice");
  });

  it("coalesces 3 enqueues within the debounce window into one file write", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    const writeSpy = vi.spyOn(fs, "writeFile");
    const p = new PeersPersister(file, emptyFile("owner"), { debounceMs: 50 });

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
      defaultUnknownPolicy: "owner",
      peers: {
        "slack:U1": "owner",
        "slack:U2": "owner",
        "slack:U3": "owner",
      },
    });
  });

  it("creates the peers file on first flush when missing at boot (fresh install → per-sender)", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "nested", "peers.json");
    const loaded = loadPeersFileSync(file);
    expect(loaded).toEqual({
      version: PEERS_FILE_VERSION,
      defaultUnknownPolicy: "per-sender",
      peers: {},
    });

    const p = new PeersPersister(file, loaded, { debounceMs: 10 });
    p.enqueue("slack:Unew", "slack_Unew");
    await p.flushNow();

    const body = JSON.parse(await fs.readFile(file, "utf8"));
    expect(body).toEqual({
      version: 1,
      defaultUnknownPolicy: "per-sender",
      peers: { "slack:Unew": "slack_Unew" },
    });
  });

  it("flushNow is a no-op when nothing is dirty", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    const p = new PeersPersister(file, emptyFile());
    await p.flushNow();
    await expect(fs.access(file)).rejects.toBeTruthy();
  });

  it("merge preserves hand-edited keys on disk not present in memory", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        defaultUnknownPolicy: "owner",
        peers: { "slack:U99": "alice", "slack:U1": "owner" },
      }) + "\n",
    );

    const loaded = loadPeersFileSync(file);
    const p = new PeersPersister(file, loaded, { debounceMs: 10 });
    p.enqueue("slack:Unew", "slack_Unew");
    await p.flushNow();

    const body = JSON.parse(await fs.readFile(file, "utf8"));
    expect(body.peers["slack:U99"]).toBe("alice");
    expect(body.peers["slack:Unew"]).toBe("slack_Unew");
    expect(body.peers["slack:U1"]).toBe("owner");
  });

  it("merge prefers on-disk mapping when the same sender exists in memory", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        defaultUnknownPolicy: "owner",
        peers: { "slack:U1": "from_disk" },
      }) + "\n",
    );

    const loaded = loadPeersFileSync(file);
    const p = new PeersPersister(file, loaded, { debounceMs: 10 });
    expect(p.peers["slack:U1"]).toBe("from_disk");
    (p.peers as Record<string, string>)["slack:U1"] = "stale_memory";
    p.enqueue("slack:U2", "owner");
    await p.flushNow();

    const body = JSON.parse(await fs.readFile(file, "utf8"));
    expect(body.peers["slack:U1"]).toBe("from_disk");
    expect(p.peers["slack:U1"]).toBe("from_disk");
  });

  it("reloads defaultUnknownPolicy from disk on flush", async () => {
    const dir = await mktmp();
    const file = path.join(dir, "peers.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        defaultUnknownPolicy: "owner",
        peers: {},
      }) + "\n",
    );

    const loaded = loadPeersFileSync(file);
    const p = new PeersPersister(file, loaded, { debounceMs: 10 });
    expect(p.defaultUnknownPolicy).toBe("owner");

    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        defaultUnknownPolicy: "per-sender",
        peers: {},
      }) + "\n",
    );

    p.enqueue("slack:Ux", "derived");
    await p.flushNow();

    expect(p.defaultUnknownPolicy).toBe("per-sender");
    const body = JSON.parse(await fs.readFile(file, "utf8"));
    expect(body.defaultUnknownPolicy).toBe("per-sender");
  });
});
