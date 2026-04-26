/**
 * Sender_id → Honcho peer_id map, persisted at ~/.honcho/openclaw-peers.json.
 *
 * Shared artifact:
 *   - Plugin auto-seeds unknown senders to OWNER_ID on first sight.
 *   - User hand-edits to split specific senders off to their own peer IDs.
 *
 * Re-read on gateway restart. Path override: OPENCLAW_HONCHO_PEERS_FILE.
 */

import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PEERS_FILE_VERSION = 1;

export type PeersFile = {
  version: typeof PEERS_FILE_VERSION;
  peers: Record<string, string>;
};

export function resolvePeersFilePath(): string {
  const envPath = process.env.OPENCLAW_HONCHO_PEERS_FILE;
  if (envPath && envPath.trim().length > 0) return envPath.trim();
  return path.join(os.homedir(), ".honcho", "openclaw-peers.json");
}

function parsePeersJson(raw: string): PeersFile {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const peers =
      obj.peers && typeof obj.peers === "object" && !Array.isArray(obj.peers)
        ? coerceStringMap(obj.peers as Record<string, unknown>)
        : {};
    return { version: PEERS_FILE_VERSION, peers };
  }
  return { version: PEERS_FILE_VERSION, peers: {} };
}

/**
 * Read the peers file; return an empty seed if missing or malformed.
 * Does not create the file — that happens on the first flush.
 */
export async function loadPeersFile(filePath: string): Promise<PeersFile> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parsePeersJson(raw);
  } catch {
    return { version: PEERS_FILE_VERSION, peers: {} };
  }
}

/** Synchronous variant for bootstrapping at plugin-state construction time. */
export function loadPeersFileSync(filePath: string): PeersFile {
  try {
    const raw = readFileSync(filePath, "utf8");
    return parsePeersJson(raw);
  } catch {
    return { version: PEERS_FILE_VERSION, peers: {} };
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
 * Resolve an inbound sender_id to a Honcho peer ID. If the sender is already
 * known (hand-mapped or previously auto-seeded), return its mapping; otherwise
 * enqueue it as OWNER_ID and return OWNER_ID.
 */
export function resolveParticipantPeerId(
  senderId: string,
  persister: PeersPersister,
  defaultPeerId = "owner",
): string {
  const mapped = persister.peers[senderId];
  if (mapped !== undefined) return mapped;
  persister.enqueue(senderId, defaultPeerId);
  return defaultPeerId;
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
 * Note: the file is user-editable, but edits made at runtime are not picked
 * up until the gateway restarts. Existing entries are never overwritten by
 * enqueue(), so hand-edits to known senders survive; new senders added by
 * hand could be clobbered if the plugin sees them before the restart.
 */
export class PeersPersister {
  public readonly peers: Record<string, string>;
  public readonly filePath: string;
  private readonly debounceMs: number;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(filePath: string, initial: PeersFile, opts: PeersPersisterOptions = {}) {
    this.filePath = filePath;
    this.peers = { ...initial.peers };
    this.debounceMs = opts.debounceMs ?? 1000;
  }

  /**
   * Record a sender_id → peer_id mapping if absent. Schedules a debounced flush.
   */
  enqueue(senderId: string, peerId = "owner"): void {
    if (!senderId) return;
    if (this.peers[senderId] !== undefined) return;
    this.peers[senderId] = peerId;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Chain so writes serialize, but do NOT swallow errors here — keep them
      // visible on the chain so subsequent flushes / flushNow await callers see
      // the failure. dirty stays true on failure (set inside flush()) so the
      // next enqueue/flushNow retries the write.
      this.chain = this.chain.then(() => this.flush());
      // Detach a non-throwing observer so an unhandled-rejection warning isn't
      // emitted when no flushNow() is awaited; the underlying chain still
      // carries the rejection for any future awaiter.
      this.chain.catch(() => undefined);
    }, this.debounceMs);
    // unref so the timer doesn't block process exit in short-lived runs.
    this.timer.unref?.();
  }

  /**
   * Flush any pending changes immediately, awaiting completion. Safe to call
   * concurrently with enqueue(). Throws if the underlying write fails so
   * callers can react (and dirty stays true for the next retry).
   */
  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const next = this.chain.then(() => this.flush());
    // Reset chain to a resolved state regardless of this flush's outcome so a
    // single failure doesn't poison every subsequent flush attempt.
    this.chain = next.catch(() => undefined);
    await next;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const body: PeersFile = {
        version: PEERS_FILE_VERSION,
        peers: this.peers,
      };
      await fs.writeFile(this.filePath, JSON.stringify(body, null, 2) + "\n");
      // Only clear dirty after the write succeeds — a failed write must leave
      // dirty=true so the next flush retries and we don't lose mappings.
      this.dirty = false;
    } catch (err) {
      // Make the retry intent explicit; dirty was never cleared but be defensive.
      this.dirty = true;
      throw err;
    }
  }
}
