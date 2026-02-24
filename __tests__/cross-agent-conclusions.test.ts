/**
 * Integration: cross-agent memory consolidation via dream()
 *
 * Demonstrates the behaviour this fix enables: once the parent peer is present
 * in subagent sessions, Honcho's dream process can consolidate cross-agent
 * interactions into per-pair peer cards.
 *
 * Without the fix, subagent sessions only contain owner + subagent. The parent
 * is absent, so dreaming produces no cross-agent conclusions and peer cards for
 * agent pairs remain null forever.
 *
 * HONCHO_SKIP_DREAM_TESTS=1  — skip Suite 2 (dream worker required, ~60s)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Honcho, type Peer } from '@honcho-ai/sdk';

const API_KEY      = process.env.HONCHO_API_KEY;
const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? 'openclaw-test';
const BASE_URL     = process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev';

const maybe      = !API_KEY ? describe.skip : describe;
const maybeDream = (!API_KEY || process.env.HONCHO_SKIP_DREAM_TESTS === '1') ? describe.skip : describe;

const RUN_ID = `${Date.now()}`;

let honcho:    Honcho;
let ownerPeer: Peer;
let primePeer: Peer;
let devPeer:   Peer;

// Poll peer.context({target}) until peer_card is populated.
// peer_card requires inductive pattern detection — deductive conclusions alone
// are insufficient. 429s are retried with backoff.
async function pollPeerCard(observer: Peer, target: Peer, label: string): Promise<string[]> {
  const deadline = Date.now() + 300_000;
  let   wait     = 5_000;
  while (Date.now() < deadline) {
    try {
      const ctx = await observer.context({ target });
      if (ctx.peerCard && (ctx.peerCard as string[]).length > 0) return ctx.peerCard as string[];
    } catch (e: any) {
      if (e.status !== 429) throw e;
      wait = Math.min(wait * 2, 30_000);
    }
    await new Promise(r => setTimeout(r, wait));
    wait = 5_000;
  }
  throw new Error(`${label}: peer_card not populated within 5 min`);
}

// ── Suite 1: clean workspace + conclusion scoping ─────────────────────────────
maybe('suite 1: workspace + conclusion persistence', () => {
  beforeAll(async () => {
    honcho = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });

    try { await honcho.deleteWorkspace(WORKSPACE_ID); } catch {}
    await honcho.setMetadata({});

    ownerPeer = await honcho.peer('owner',          { metadata: {} });
    primePeer = await honcho.peer('agent-prime',     { metadata: { agentId: 'prime' } });
    devPeer   = await honcho.peer('agent-developer', { metadata: { agentId: 'developer' } });
  }, 30_000);

  it('workspace contains the expected peers after nuke', async () => {
    const peers = await (await honcho.peers()).toArray();
    const ids = peers.map(p => p.id);
    expect(ids).toContain('owner');
    expect(ids).toContain('agent-prime');
    expect(ids).toContain('agent-developer');
  });

  it('prime→developer conclusion persists with correct attribution', async () => {
    const [c] = await primePeer.conclusionsOf(devPeer).create({
      content: `${RUN_ID}: agent-developer works on TypeScript infrastructure`,
    });
    const items = await (await primePeer.conclusionsOf(devPeer).list({ size: 50 })).toArray();
    const match = items.find(i => i.id === c.id);

    expect(match?.observerId).toBe('agent-prime');
    expect(match?.observedId).toBe('agent-developer');
  });

  it('developer→owner conclusion is not visible in prime→developer scope', async () => {
    const [c] = await devPeer.conclusionsOf(ownerPeer).create({
      content: `${RUN_ID}: owner prefers inline code review comments`,
    });
    const items = await (await primePeer.conclusionsOf(devPeer).list({ size: 50 })).toArray();
    expect(items.map(i => i.id)).not.toContain(c.id);
  });
});

// ── Suite 2: dream() produces peer cards for both agent pairs ─────────────────
maybeDream('suite 2: dream() → peer cards (HONCHO_SKIP_DREAM_TESTS=1 to skip)', () => {
  beforeAll(async () => {
    if (!honcho) {
      honcho    = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
      ownerPeer = await honcho.peer('owner',          { metadata: {} });
      primePeer = await honcho.peer('agent-prime',     { metadata: { agentId: 'prime' } });
      devPeer   = await honcho.peer('agent-developer', { metadata: { agentId: 'developer' } });
    }

    // reasoning=false: ~46% faster card population with more card entries
    await honcho.setConfiguration({ reasoning: { enabled: false } });

    // Seed enough messages for the dream worker to detect inductive patterns
    // on both pairs (peer_card requires patterns, not just deductive conclusions)
    const session = await honcho.session(`session-${RUN_ID}`);
    await session.addPeers([ownerPeer, primePeer, devPeer]);
    await session.addMessages([
      primePeer.message('Refactor the cache module into a standalone TypeScript package'),
      devPeer.message('Done — strict mode, full types, zero runtime deps'),
      primePeer.message('Extract the retry logic into a typed TypeScript utility'),
      devPeer.message('Complete — generics-first, 100% type-safe, tree-shakeable'),
      primePeer.message('Add TypeScript declarations for the event emitter'),
      devPeer.message('Shipped — .d.ts from source, JSDoc included'),
      ownerPeer.message('Keep reviews short — inline comments only'),
      devPeer.message('Understood'),
      ownerPeer.message('Reminder: inline only, no separate review docs'),
      devPeer.message('Got it'),
      ownerPeer.message('Same for the next PR — inline, keep it brief'),
      devPeer.message('Will do'),
    ]);

    await honcho.scheduleDream({ observer: primePeer, observed: devPeer,   session });
    await honcho.scheduleDream({ observer: devPeer,   observed: ownerPeer, session });
  }, 30_000);

  it('prime→developer peer card is populated after dream()', async () => {
    const card = await pollPeerCard(primePeer, devPeer, 'prime→developer');
    expect(card.join(' ').toLowerCase()).toMatch(/typescript|infrastructure|developer/);
  }, 360_000);

  it('developer→owner peer card is populated after dream()', async () => {
    const card = await pollPeerCard(devPeer, ownerPeer, 'developer→owner');
    expect(card.join(' ').toLowerCase()).toMatch(/review|inline|prefer|short/);
  }, 360_000);
});
