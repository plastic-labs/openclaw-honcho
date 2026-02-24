/**
 * Integration tests: prime ↔ developer relationship and dream() consolidation
 *
 * Suite 1 — Workspace nuke + conclusion persistence (fast, no dream dependency)
 *   1. Delete + recreate openclaw-test before the suite — clean slate.
 *   2. prime writes conclusions about developer (bidirectional relationship seed).
 *   3. developer writes conclusions about owner.
 *   4. Both sets persist with correct observer/observed attribution.
 *   5. No cross-scope bleed between the two pairs.
 *
 * Suite 2 — Dream consolidation + peer card (slow; requires Honcho dream worker)
 *   6. After scheduleDream() + queue drain, primePeer.context({target: devPeer})
 *      returns a non-empty peerCard that reflects the seeded TypeScript fact.
 *   7. After scheduleDream(), devPeer.context({target: ownerPeer}) returns a
 *      peerCard that reflects the seeded review-preference fact.
 *   8. The two peer cards are distinct (different observer/observed perspectives).
 *
 * Suite 2 is skipped if HONCHO_SKIP_DREAM_TESTS=1 is set, allowing fast CI
 * runs without waiting for the Honcho dream worker (which can take >3 min).
 *
 * Skipped entirely if HONCHO_API_KEY is missing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Honcho, type Peer } from '@honcho-ai/sdk';

const API_KEY      = process.env.HONCHO_API_KEY;
const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? 'openclaw-test';
const BASE_URL     = process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev';
const SKIP_DREAM   = process.env.HONCHO_SKIP_DREAM_TESTS === '1';

const SKIP_ALL = !API_KEY;
const maybeDescribe      = SKIP_ALL ? describe.skip : describe;
const maybeDreamDescribe = (SKIP_ALL || SKIP_DREAM) ? describe.skip : describe;

// ── Unique run ID keeps fact content distinguishable across runs ──────────────
const RUN_ID = `dream-test-${Date.now()}`;

// ── Facts we seed ─────────────────────────────────────────────────────────────
const PRIME_ABOUT_DEV_FACT =
  `${RUN_ID}: agent-developer primarily works on TypeScript infrastructure`;
const DEV_ABOUT_OWNER_FACT =
  `${RUN_ID}: owner prefers short, direct code reviews with inline comments`;

// ── Shared state populated by Suite 1's beforeAll ────────────────────────────
let honcho: Honcho;
let ownerPeer: Peer;
let primePeer: Peer;
let devPeer: Peer;
let primeAboutDevId: string;
let devAboutOwnerId: string;

// ── Poll helper: waits until a peer card becomes non-empty ───────────────────
// Dream processing is async server-side. Rather than waiting for the global
// queue to drain (which can remain non-zero for unrelated inflight items), we
// poll the specific peer card we care about. Once non-empty we know the dream
// for that pair has completed.
async function waitForPeerCard(
  observer: Peer,
  target: Peer,
  label: string,
  maxMs = 360_000,   // 6 min ceiling
  intervalMs = 5_000,
): Promise<string[]> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const ctx = await observer.context({ target });
    if (ctx.peerCard && (ctx.peerCard as string[]).length > 0) {
      console.log(`[dream-test] ${label} peer card populated:`, ctx.peerCard);
      return ctx.peerCard as string[];
    }
    console.log(`[dream-test] ${label} peer card still empty — waiting ${intervalMs / 1000}s…`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(
    `${label} peer card did not populate within ${maxMs / 1000}s after scheduleDream(). ` +
    `The Honcho dream worker may be slow or the workspace config may not support dreaming. ` +
    `Set HONCHO_SKIP_DREAM_TESTS=1 to skip dream-dependent tests.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: workspace nuke + conclusion persistence
// ─────────────────────────────────────────────────────────────────────────────

maybeDescribe('suite 1: workspace nuke + prime ↔ developer conclusion persistence', () => {
  beforeAll(async () => {
    honcho = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });

    // 1. Nuke the test workspace so this run starts from a clean slate.
    //    All peers, sessions, and conclusions are destroyed.
    //    setMetadata({}) immediately after recreates the workspace.
    console.log(`[dream-test] Nuking workspace: ${WORKSPACE_ID}`);
    try {
      await honcho.deleteWorkspace(WORKSPACE_ID);
      console.log('[dream-test] Workspace deleted.');
    } catch (err: any) {
      const status = err.status ?? err.statusCode ?? 0;
      if (status !== 404 && status !== 405) throw err;
      console.log('[dream-test] Workspace did not exist — skipping delete.');
    }
    await honcho.setMetadata({});
    console.log('[dream-test] Workspace recreated.');

    // 2. Create peers (idempotent get-or-create).
    ownerPeer = await honcho.peer('owner',          { metadata: {} });
    primePeer = await honcho.peer('agent-prime',     { metadata: { agentId: 'prime' } });
    devPeer   = await honcho.peer('agent-developer', { metadata: { agentId: 'developer' } });
    console.log('[dream-test] Peers ready: owner, agent-prime, agent-developer');

    // 3. Seed explicit conclusions.
    const [primeAboutDev] = await primePeer.conclusionsOf(devPeer).create({
      content: PRIME_ABOUT_DEV_FACT,
    });
    primeAboutDevId = primeAboutDev.id;

    const [devAboutOwner] = await devPeer.conclusionsOf(ownerPeer).create({
      content: DEV_ABOUT_OWNER_FACT,
    });
    devAboutOwnerId = devAboutOwner.id;
    console.log('[dream-test] Conclusions seeded.');
  }, 60_000); // 1 min is plenty — no dream in this suite

  // 1. Workspace is empty after nuke — only peers we created exist
  it('workspace contains only the three peers created after nuke', async () => {
    const page = await honcho.peers();
    const all  = await page.toArray();
    const ids  = all.map(p => p.id).sort();
    console.log('[dream-test] peers after nuke:', ids);
    expect(ids).toEqual(['agent-developer', 'agent-prime', 'owner']);
  });

  // 2a. prime → developer: conclusion persists with correct attribution
  it('prime conclusion about developer has correct observer / observed', async () => {
    const page  = await primePeer.conclusionsOf(devPeer).list({ size: 50 });
    const items = await page.toArray();
    const match = items.find(c => c.id === primeAboutDevId);

    expect(match).toBeDefined();
    expect(match!.observerId).toBe('agent-prime');
    expect(match!.observedId).toBe('agent-developer');
    expect(match!.content).toContain(PRIME_ABOUT_DEV_FACT);
  });

  // 2b. developer → owner: conclusion persists with correct attribution
  it('developer conclusion about owner has correct observer / observed', async () => {
    const page  = await devPeer.conclusionsOf(ownerPeer).list({ size: 50 });
    const items = await page.toArray();
    const match = items.find(c => c.id === devAboutOwnerId);

    expect(match).toBeDefined();
    expect(match!.observerId).toBe('agent-developer');
    expect(match!.observedId).toBe('owner');
    expect(match!.content).toContain(DEV_ABOUT_OWNER_FACT);
  });

  // 3. No cross-scope bleed: prime→dev conclusion does not appear in prime→owner scope
  it('prime→developer conclusion does not appear in prime→owner scope', async () => {
    const page  = await primePeer.conclusionsOf(ownerPeer).list({ size: 50 });
    const items = await page.toArray();
    expect(items.map(c => c.id)).not.toContain(primeAboutDevId);
  });

  // 4. No cross-scope bleed: dev→owner conclusion does not appear in prime→dev scope
  it('developer→owner conclusion does not appear in prime→developer scope', async () => {
    const page  = await primePeer.conclusionsOf(devPeer).list({ size: 50 });
    const items = await page.toArray();
    expect(items.map(c => c.id)).not.toContain(devAboutOwnerId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: dream consolidation + peer card
// Skip with: HONCHO_SKIP_DREAM_TESTS=1
// ─────────────────────────────────────────────────────────────────────────────

maybeDreamDescribe('suite 2: dream() consolidation → peer card (slow; set HONCHO_SKIP_DREAM_TESTS=1 to skip)', () => {
  beforeAll(async () => {
    // Suite 1 must have run first to populate honcho / peers / conclusions.
    // If running Suite 2 in isolation, re-initialise here.
    if (!honcho) {
      honcho    = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
      ownerPeer = await honcho.peer('owner',          { metadata: {} });
      primePeer = await honcho.peer('agent-prime',     { metadata: { agentId: 'prime' } });
      devPeer   = await honcho.peer('agent-developer', { metadata: { agentId: 'developer' } });
    }

    // Seed a session with messages so the dreamer has raw material.
    const sessionKey = `${RUN_ID}-dream-session`;
    const session = await honcho.session(sessionKey);
    await session.addPeers([ownerPeer, primePeer, devPeer]);
    await session.addMessages([
      primePeer.message('I need you (developer) to refactor the caching layer into a TypeScript package'),
      devPeer.message('Sure — full TypeScript coverage, standalone package'),
      ownerPeer.message('Keep the reviews short — just inline comments'),
      devPeer.message('Understood — short reviews, inline only'),
    ]);
    console.log('[dream-test] Session messages seeded.');

    // Schedule dreams for both observer/observed pairs.
    // Processing is async server-side — each test polls its own peer card.
    await honcho.scheduleDream({ observer: primePeer, observed: devPeer,   session });
    await honcho.scheduleDream({ observer: devPeer,   observed: ownerPeer, session });
    console.log('[dream-test] Dreams scheduled. Each test will poll until its peer card populates.');
  }, 30_000); // beforeAll is now fast — no queue wait here

  // 5. After dream, prime's peer card for developer reflects the TypeScript fact
  it('prime→developer peer card is populated after dream()', async () => {
    const card = await waitForPeerCard(primePeer, devPeer, 'prime→developer');

    const text = card.join(' ').toLowerCase();
    // Dream should have distilled something about TypeScript / infrastructure / developer
    expect(
      text.includes('typescript') || text.includes('infrastructure') || text.includes('developer'),
    ).toBe(true);
  }, 420_000);

  // 6. After dream, developer's peer card for owner reflects the review preference
  it('developer→owner peer card is populated after dream()', async () => {
    const card = await waitForPeerCard(devPeer, ownerPeer, 'developer→owner');

    const text = card.join(' ').toLowerCase();
    // Dream should have distilled something about reviews / inline / preferences
    expect(
      text.includes('review') || text.includes('inline') || text.includes('prefer') || text.includes('short'),
    ).toBe(true);
  }, 420_000);

  // 7. The two peer cards are distinct — different perspectives produce different facts
  it('prime→developer and developer→owner peer cards are not identical', async () => {
    // Both cards should already be populated from tests 5 & 6 (or will poll again)
    const [primeCard, devCard] = await Promise.all([
      waitForPeerCard(primePeer, devPeer,   'prime→developer (distinctness check)'),
      waitForPeerCard(devPeer,   ownerPeer, 'developer→owner (distinctness check)'),
    ]);

    expect(primeCard.length).toBeGreaterThan(0);
    expect(devCard.length).toBeGreaterThan(0);
    expect(primeCard.join('|')).not.toBe(devCard.join('|'));
  }, 420_000);
});
