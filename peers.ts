/**
 * Sender_id → Honcho peer_id map, persisted at ~/.honcho/openclaw-peers.json.
 *
 * Plugin auto-seeds unknown senders per `defaultUnknownPolicy`:
 *   "owner"      → strangers merge into the OWNER_ID peer (legacy contract).
 *   "per-sender" → each stranger gets a peer derived from its sender_id
 *                  (sanitized + truncated to satisfy Honcho's RESOURCE_NAME_PATTERN).
 * Fresh installs (file missing) default to "per-sender"; pre-existing files
 * (no policy field) keep "owner" so legacy users see no behavior change.
 *
 * Restart reloads from disk. Flush merges disk before write (disk wins conflicts)
 * so concurrent file edits are not overwritten. OPENCLAW_HONCHO_PEERS_FILE overrides path.
 */

import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PEERS_FILE_VERSION = 1;
/** Honcho enforces RESOURCE_NAME_PATTERN = ^[a-zA-Z0-9_-]+$ with 1..100 length on peer IDs. */
const HONCHO_PEER_ID_MAX_LEN = 100;

export type DefaultUnknownPolicy = "owner" | "per-sender";

export type PeersFile = {
  version: typeof PEERS_FILE_VERSION;
  defaultUnknownPolicy: DefaultUnknownPolicy;
  peers: Record<string, string>;
};

export function resolvePeersFilePath(): string {
  const envPath = process.env.OPENCLAW_HONCHO_PEERS_FILE;
  if (envPath && envPath.trim().length > 0) return envPath.trim();
  return path.join(os.homedir(), ".honcho", "openclaw-peers.json");
}

function parsePeersJson(raw: string, filePath: string): PeersFile {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const peers =
        obj.peers && typeof obj.peers === "object" && !Array.isArray(obj.peers)
          ? coerceStringMap(obj.peers as Record<string, unknown>)
          : {};
      return {
        version: PEERS_FILE_VERSION,
        defaultUnknownPolicy: obj.defaultUnknownPolicy === "per-sender" ? "per-sender" : "owner",
        peers,
      };
    }
    console.warn(
      `peers file ${filePath}: top-level value is not an object; falling back to legacy owner policy with empty map`,
    );
  } catch (err) {
    console.warn(
      `peers file ${filePath}: ${(err as Error).message}; falling back to legacy owner policy with empty map`,
    );
  }
  // Existing-but-malformed file → preserve legacy contract.
  return { version: PEERS_FILE_VERSION, defaultUnknownPolicy: "owner", peers: {} };
}

/** Read the peers file. Missing → per-sender (fresh install); anything else → owner (legacy). */
export async function loadPeersFile(filePath: string): Promise<PeersFile> {
  try {
    return parsePeersJson(await fs.readFile(filePath, "utf8"), filePath);
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { version: PEERS_FILE_VERSION, defaultUnknownPolicy: "per-sender", peers: {} }
      : { version: PEERS_FILE_VERSION, defaultUnknownPolicy: "owner", peers: {} };
  }
}

export function loadPeersFileSync(filePath: string): PeersFile {
  try {
    return parsePeersJson(readFileSync(filePath, "utf8"), filePath);
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { version: PEERS_FILE_VERSION, defaultUnknownPolicy: "per-sender", peers: {} }
      : { version: PEERS_FILE_VERSION, defaultUnknownPolicy: "owner", peers: {} };
  }
}

function coerceStringMap(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Resolve an inbound sender_id to a Honcho peer ID. Known senders return their
 * mapping; unknown senders auto-seed under the persister's policy and enqueue
 * for persistence. Per-sender peer IDs are derived from the sender_id —
 * sanitized to satisfy Honcho's RESOURCE_NAME_PATTERN and truncated to its
 * 100-char limit.
 */
export function resolveParticipantPeerId(
  senderId: string,
  persister: PeersPersister,
  ownerPeerId = "owner",
): string {
  const mapped = persister.peers[senderId];
  if (mapped !== undefined) return mapped;
  const seedPeerId =
    persister.defaultUnknownPolicy === "per-sender"
      ? senderId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, HONCHO_PEER_ID_MAX_LEN)
      : ownerPeerId;
  persister.enqueue(senderId, seedPeerId);
  return seedPeerId;
}

export type PeersPersisterOptions = {
  /** Flush debounce window in milliseconds. Default 1000. */
  debounceMs?: number;
};

/**
 * Debounced, serialized writer for the peers file.
 *
 * enqueue() is synchronous — it mutates the in-memory map and schedules a
 * background flush. Multiple enqueues within the debounce window coalesce
 * into a single write. Flushes are chained via a single promise so writes
 * cannot interleave.
 *
 * Each flush() re-reads the file and merges `{ ...memory, ...disk }` so disk
 * wins on conflicting sender_ids; keys only on disk or only in memory are
 * kept. enqueue() never overwrites an existing mapping.
 */
export class PeersPersister {
  public readonly peers: Record<string, string>;
  public readonly filePath: string;
  public defaultUnknownPolicy: DefaultUnknownPolicy;
  private readonly debounceMs: number;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(filePath: string, initial: PeersFile, opts: PeersPersisterOptions = {}) {
    this.filePath = filePath;
    this.peers = { ...initial.peers };
    this.defaultUnknownPolicy = initial.defaultUnknownPolicy;
    this.debounceMs = opts.debounceMs ?? 1000;
  }

  /** Record a sender_id → peer_id mapping if absent. Schedules a debounced flush. */
  enqueue(senderId: string, peerId = "owner"): void {
    if (!senderId) return;
    if (this.peers[senderId] !== undefined) return;
    this.peers[senderId] = peerId;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.chain = this.chain.then(() => this.flush()).catch(() => undefined);
    }, this.debounceMs);
    // unref so the timer doesn't block process exit in short-lived runs.
    this.timer.unref?.();
  }

  /** Flush any pending changes immediately. Safe to call concurrently with enqueue(). */
  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const flushed = this.chain.then(() => this.flush());
    this.chain = flushed.catch(() => undefined);
    await flushed;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    while (this.dirty) {
      this.dirty = false;
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const onDisk = await loadPeersFileForMerge(this.filePath, this.defaultUnknownPolicy);
        const mergedPeers = { ...this.peers, ...onDisk.peers };
        this.defaultUnknownPolicy = onDisk.defaultUnknownPolicy;
        replaceRecordInPlace(this.peers, mergedPeers);

        const body: PeersFile = {
          version: PEERS_FILE_VERSION,
          defaultUnknownPolicy: this.defaultUnknownPolicy,
          peers: mergedPeers,
        };
        await fs.writeFile(this.filePath, JSON.stringify(body, null, 2) + "\n");
      } catch (err) {
        this.dirty = true;
        throw err;
      }
    }
  }
}

/** Sync `target` to equal `source` (same keys and values). */
function replaceRecordInPlace(target: Record<string, string>, source: Record<string, string>): void {
  for (const k of Object.keys(target)) {
    if (!(k in source)) delete target[k];
  }
  Object.assign(target, source);
}

/**
 * Same as reading the peers file for parsing, except a missing file uses
 * `memoryPolicy` instead of the fresh-install default (`per-sender`), so the
 * first write does not clobber the policy loaded at boot from an in-memory-only state.
 */
async function loadPeersFileForMerge(filePath: string, memoryPolicy: DefaultUnknownPolicy): Promise<PeersFile> {
  try {
    return parsePeersJson(await fs.readFile(filePath, "utf8"), filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { version: PEERS_FILE_VERSION, defaultUnknownPolicy: memoryPolicy, peers: {} };
    }
    return { version: PEERS_FILE_VERSION, defaultUnknownPolicy: "owner", peers: {} };
  }
}
