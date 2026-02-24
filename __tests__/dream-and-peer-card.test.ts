/**
 * Integration tests: prime ↔ developer relationship and dream() consolidation
 *
 * Suite 1 — Workspace nuke + conclusion persistence (fast, no dream)
 *   - Nukes openclaw-test before each run for a clean slate
 *   - Verifies prime→developer and developer→owner conclusions persist
 *     with correct observer/observed attribution and no cross-scope bleed
 *
 * Suite 2 — Dream consolidation + peer card
 *   - reasoning=false (46% faster per benchmark; also yields more card entries)
 *   - Seeds enough messages to trigger inductive pattern detection for both pairs
 *     (peer_card only populates when the dream emits inductive observations)
 *   - Polls peer.context({target}) directly — no fragile global queue drain
 *   - 429 rate-limit errors retried with exponential backoff
 *
 * Skip Suite 2: HONCHO_SKIP_DREAM_TESTS=1
 * Skip all:     unset HONCHO_API_KEY
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Honcho, type Peer } from '@honcho-ai/sdk';

const API_KEY      = process.env.HONCHO_API_KEY;
const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? 'openclaw-test';
const BASE_URL     = process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev';
const SKIP_DREAM   = process.env.HONCHO_SKIP_DREAM_TESTS === '1';

const maybeDescribe      = !API_KEY ? describe.skip : describe;
const maybeDreamDescribe = (!API_KEY || SKIP_DREAM) ? describe.skip : describe;

const RUN_ID = `dream-test-${Date.now()}`;

// ── Shared state ──────────────────────────────────────────────────────────────
let honcho:    Honcho;
let ownerPeer: Peer;
let primePeer: Peer;
let devPeer:   Peer;

// Explicit conclusion IDs written in Suite 1 — verified in its tests
let primeAboutDevId:  string;
let devAboutOwnerId:  string;

// ── Facts seeded as explicit conclusions ──────────────────────────────────────
const PRIME_ABOUT_DEV = `${RUN_ID}: agent-developer primarily works on TypeScript infrastructure`;
const DEV_ABOUT_OWNER = `${RUN_ID}: owner prefers short, direct code reviews with inline comments`;

// ── Workspace helpers ─────────────────────────────────────────────────────────
async function nukeAndRecreate(h: Honcho, wsId: string): Promise<void> {
  try {
    await h.deleteWorkspace(wsId);
    console.log('[test] Workspace deleted.');
  } catch (err: any) {
    const s = err.status ?? err.statusCode ?? 0;
    if (s !== 404 && s !== 405) throw err;
    console.log('[test] Workspace did not exist — skipping delete.');
  }
  await h.setMetadata({});
}

// ── Poll helper ───────────────────────────────────────────────────────────────
// peer_card is only populated after inductive patterns are detected by the dream
// worker — not from deductive conclusions alone. Poll until non-empty or timeout.
async function waitForPeerCard(
  observer:   Peer,
  target:     Peer,
  label:      string,
  maxMs     = 300_000,  // 5 min
  intervalMs = 5_000,
): Promise<string[]> {
  const deadline = Date.now() + maxMs;
  let   backoff  = intervalMs;
  while (Date.now() < deadline) {
    try {
      const ctx = await observer.context({ target });
      if (ctx.peerCard && (ctx.peerCard as string[]).length > 0) {
        console.log(`[test] ${label} card:`, ctx.peerCard);
        return ctx.peerCard as string[];
      }
      console.log(`[test] ${label} card empty — waiting ${backoff / 1000}s…`);
      backoff = intervalMs;
    } catch (err: any) {
      if (err.status === 429) {
        backoff = Math.min(backoff * 2, 30_000);
        console.log(`[test] ${label} 429 — backing off ${backoff / 1000}s`);
      } else {
        throw err;
      }
    }
    await new Promise(r => setTimeout(r, backoff));
  }
  throw new Error(
    `${label}: peer_card not populated within ${maxMs / 1000}s. ` +
    `Set HONCHO_SKIP_DREAM_TESTS=1 to skip.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — workspace nuke + conclusion persistence
// ─────────────────────────────────────────────────────────────────────────────
maybeDescribe('suite 1: workspace nuke + prime ↔ developer conclusion persistence', () => {
  beforeAll(async () => {
    honcho = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
    console.log(`[test] Nuking ${WORKSPACE_ID}…`);
    await nukeAndRecreate(honcho, WORKSPACE_ID);

    ownerPeer = await honcho.peer('owner',          { metadata: {} });
    primePeer = await honcho.peer('agent-prime',     { metadata: { agentId: 'prime' } });
    devPeer   = await honcho.peer('agent-developer', { metadata: { agentId: 'developer' } });

    const [c1] = await primePeer.conclusionsOf(devPeer).create({ content: PRIME_ABOUT_DEV });
    const [c2] = await devPeer.conclusionsOf(ownerPeer).create({ content: DEV_ABOUT_OWNER });
    primeAboutDevId = c1.id;
    devAboutOwnerId = c2.id;
    console.log('[test] Setup done.');
  }, 60_000);

  it('only the three expected peers exist after nuke', async () => {
    const all = await (await honcho.peers()).toArray();
    expect(all.map(p => p.id).sort()).toEqual(['agent-developer', 'agent-prime', 'owner']);
  });

  it('prime→developer conclusion: correct observer + observed', async () => {
    const items = await (await primePeer.conclusionsOf(devPeer).list({ size: 50 })).toArray();
    const m = items.find(c => c.id === primeAboutDevId);
    expect(m).toBeDefined();
    expect(m!.observerId).toBe('agent-prime');
    expect(m!.observedId).toBe('agent-developer');
    expect(m!.content).toContain(PRIME_ABOUT_DEV);
  });

  it('developer→owner conclusion: correct observer + observed', async () => {
    const items = await (await devPeer.conclusionsOf(ownerPeer).list({ size: 50 })).toArray();
    const m = items.find(c => c.id === devAboutOwnerId);
    expect(m).toBeDefined();
    expect(m!.observerId).toBe('agent-developer');
    expect(m!.observedId).toBe('owner');
    expect(m!.content).toContain(DEV_ABOUT_OWNER);
  });

  it('prime→developer conclusion absent from prime→owner scope', async () => {
    const items = await (await primePeer.conclusionsOf(ownerPeer).list({ size: 50 })).toArray();
    expect(items.map(c => c.id)).not.toContain(primeAboutDevId);
  });

  it('developer→owner conclusion absent from prime→developer scope', async () => {
    const items = await (await primePeer.conclusionsOf(devPeer).list({ size: 50 })).toArray();
    expect(items.map(c => c.id)).not.toContain(devAboutOwnerId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — dream() + peer card
// ─────────────────────────────────────────────────────────────────────────────
maybeDreamDescribe('suite 2: dream() → peer card (HONCHO_SKIP_DREAM_TESTS=1 to skip)', () => {
  beforeAll(async () => {
    // Re-init if Suite 1 didn't run (e.g. isolated run of this suite)
    if (!honcho) {
      honcho    = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
      ownerPeer = await honcho.peer('owner',          { metadata: {} });
      primePeer = await honcho.peer('agent-prime',     { metadata: { agentId: 'prime' } });
      devPeer   = await honcho.peer('agent-developer', { metadata: { agentId: 'developer' } });
    }

    // reasoning=false: 46% faster card population, more card entries (see dream-speed-bench.test.ts)
    await honcho.setConfiguration({ reasoning: { enabled: false } });

    // Seed enough messages to produce inductive patterns for BOTH pairs.
    // peer_card is only generated from inductive observations (patterns detected
    // across multiple messages) — deductive conclusions alone are insufficient.
    // Minimum ~3 repeated behavioural signals per pair to reliably trigger patterns.
    const session = await honcho.session(`${RUN_ID}-session`);
    await session.addPeers([ownerPeer, primePeer, devPeer]);
    await session.addMessages([
      // prime observing developer — TypeScript expertise + consistent delivery style
      primePeer.message('Refactor the cache module into a standalone TypeScript package'),
      devPeer.message('Done — full TypeScript types, strict mode, zero runtime deps'),
      primePeer.message('Now extract the retry logic into a typed TypeScript utility'),
      devPeer.message('Complete — generics-first design, 100% type-safe, tree-shakeable'),
      primePeer.message('Add TypeScript declarations for the event emitter module'),
      devPeer.message('Shipped — .d.ts generated from source, JSDoc annotations included'),

      // developer observing owner — consistent preference for short inline reviews
      ownerPeer.message('Keep reviews short — inline comments only, no separate docs'),
      devPeer.message('Understood'),
      ownerPeer.message('Reminder: inline comments, no review summaries'),
      devPeer.message('Got it'),
      ownerPeer.message('Same rule for the next PR — inline only, keep it brief'),
      devPeer.message('Will do'),
    ]);

    await honcho.scheduleDream({ observer: primePeer, observed: devPeer,   session });
    await honcho.scheduleDream({ observer: devPeer,   observed: ownerPeer, session });
    console.log('[test] Dreams scheduled (reasoning=false). Tests poll their own peer card.');
  }, 30_000);

  it('prime→developer peer card populated + reflects TypeScript expertise', async () => {
    const card = await waitForPeerCard(primePeer, devPeer, 'prime→developer');
    const text = card.join(' ').toLowerCase();
    expect(text.includes('typescript') || text.includes('infrastructure') || text.includes('developer')).toBe(true);
  }, 360_000);

  it('developer→owner peer card populated + reflects review preference', async () => {
    const card = await waitForPeerCard(devPeer, ownerPeer, 'developer→owner');
    const text = card.join(' ').toLowerCase();
    expect(text.includes('review') || text.includes('inline') || text.includes('prefer') || text.includes('short')).toBe(true);
  }, 360_000);

  it('prime→developer and developer→owner cards are distinct', async () => {
    const [a, b] = await Promise.all([
      waitForPeerCard(primePeer, devPeer,   'prime→developer (distinct)'),
      waitForPeerCard(devPeer,   ownerPeer, 'developer→owner (distinct)'),
    ]);
    expect(a.join('|')).not.toBe(b.join('|'));
  }, 360_000);
});
