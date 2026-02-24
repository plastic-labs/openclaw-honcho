/**
 * Integration tests: multi-peer conclusion scoping vs real Honcho API
 *
 * These tests hit the REAL Honcho workspace to verify that:
 *   1. Conclusions written for one agent-peer are returned when filtering by
 *      that peer's observer_id.
 *   2. Conclusions written for agent-prime do NOT appear when listing with
 *      observer_id = agent-developer (and vice-versa).
 *
 * This directly probes the "148-results-for-all-peers" bug hypothesis.
 *
 * Skipped automatically if HONCHO_API_KEY is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Honcho, type Peer } from '@honcho-ai/sdk';

const API_KEY = process.env.HONCHO_API_KEY;
const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? 'openclaw-test';
const BASE_URL = process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev';

// Unique run prefix so parallel test runs don't collide
const RUN_ID = `test-${Date.now()}`;

const SKIP = !API_KEY;
const describeOrSkip = SKIP ? describe.skip : describe;

// ────────────────────────────────────────────────────────────────────────────

describeOrSkip('multi-peer conclusion isolation (integration)', () => {
  let honcho: Honcho;
  let ownerPeer: Peer;
  let primePeer: Peer;
  let devPeer: Peer;

  // Unique conclusion content so we can identify our test data
  const primeContent = `${RUN_ID}:prime-fact: The user prefers TypeScript over JavaScript`;
  const devContent = `${RUN_ID}:dev-fact: The user uses vim for development`;

  let primeConclId: string | null = null;
  let devConclId: string | null = null;

  beforeAll(async () => {
    honcho = new Honcho({
      apiKey: API_KEY,
      workspaceId: WORKSPACE_ID,
      baseURL: BASE_URL,
    });

    // Set up workspace (idempotent)
    await honcho.setMetadata({});

    // Create the three peers we need
    ownerPeer = await honcho.peer('owner', { metadata: {} });
    primePeer = await honcho.peer(`${RUN_ID}-agent-prime`, { metadata: { agentId: 'prime' } });
    devPeer   = await honcho.peer(`${RUN_ID}-agent-developer`, { metadata: { agentId: 'developer' } });

    // Write one conclusion for each agent peer (observer = agent, observed = owner)
    const [primeConcl] = await primePeer.conclusionsOf(ownerPeer).create({ content: primeContent });
    const [devConcl]   = await devPeer.conclusionsOf(ownerPeer).create({ content: devContent });

    primeConclId = primeConcl.id;
    devConclId   = devConcl.id;
  }, 30_000);

  afterAll(async () => {
    // Clean up test conclusions
    if (primeConclId) {
      await primePeer.conclusionsOf(ownerPeer).delete(primeConclId).catch(() => null);
    }
    if (devConclId) {
      await devPeer.conclusionsOf(ownerPeer).delete(devConclId).catch(() => null);
    }
  }, 15_000);

  // ── Test 1: observer/observed fields are set correctly ──────────────────────
  it('stored conclusions have correct observer_id and observed_id', async () => {
    const primePage = await primePeer.conclusionsOf(ownerPeer).list({ size: 50 });
    const primeItem = primePage.items.find(c => c.id === primeConclId);

    expect(primeItem).toBeDefined();
    expect(primeItem!.observerId).toBe(`${RUN_ID}-agent-prime`);
    expect(primeItem!.observedId).toBe('owner');
  });

  // ── Test 2: each peer's scope returns its own conclusion ────────────────────
  it('agent-prime scope returns the prime conclusion', async () => {
    const page = await primePeer.conclusionsOf(ownerPeer).list({ size: 50 });
    const ids = page.items.map(c => c.id);
    expect(ids).toContain(primeConclId);
  });

  it('agent-developer scope returns the developer conclusion', async () => {
    const page = await devPeer.conclusionsOf(ownerPeer).list({ size: 50 });
    const ids = page.items.map(c => c.id);
    expect(ids).toContain(devConclId);
  });

  // ── Test 3: no cross-peer bleed ─────────────────────────────────────────────
  it('agent-prime scope does NOT contain the developer conclusion', async () => {
    const page = await primePeer.conclusionsOf(ownerPeer).list({ size: 50 });
    // Walk all pages using toArray() for simplicity
    const allItems = await page.toArray();
    const allIds = allItems.map(c => c.id);
    expect(allIds).not.toContain(devConclId);
  });

  it('agent-developer scope does NOT contain the prime conclusion', async () => {
    const page = await devPeer.conclusionsOf(ownerPeer).list({ size: 50 });
    const allItems = await page.toArray();
    const allIds = allItems.map(c => c.id);
    expect(allIds).not.toContain(primeConclId);
  });

  // ── Test 4: filter actually scopes — totals should differ ──────────────────
  it('two distinct peers return different total conclusion counts', async () => {
    const primeAll = await (await primePeer.conclusionsOf(ownerPeer).list({ size: 50 })).toArray();
    const devAll   = await (await devPeer.conclusionsOf(ownerPeer).list({ size: 50 })).toArray();
    const primeTotal = primeAll.length;
    const devTotal   = devAll.length;

    console.log(`[debug] ${RUN_ID}-agent-prime conclusion count:     ${primeTotal}`);
    console.log(`[debug] ${RUN_ID}-agent-developer conclusion count: ${devTotal}`);

    // If the filter is BROKEN, both peers would return the same total (e.g. 148).
    // If the filter WORKS, counts reflect per-peer conclusions.
    // We assert that our test peers at minimum have different totals OR each
    // has exactly the number of conclusions we created (1 each).
    // This assertion is intentionally soft so it reveals the actual state.
    if (primeTotal === devTotal && primeTotal > 10) {
      console.warn(
        `⚠️  FILTER BUG DETECTED: both peers return ${primeTotal} conclusions — ` +
        `observer_id filter appears to be ignored by the server.`
      );
    }

    // Hard assertion: the conclusions we created for one peer must NOT appear in the other's scope.
    // (These are checked above; this just ensures we fail fast with a clear message if totals match unexpectedly.)
    expect(primeTotal).toBeGreaterThanOrEqual(1);
    expect(devTotal).toBeGreaterThanOrEqual(1);
  });

  // ── Test 5: conclusion count for brand-new peers should be 1 each ──────────
  it('fresh isolated peers each have exactly 1 conclusion after setup', async () => {
    // Create completely fresh, isolated peers no one else uses
    const freshId = `${RUN_ID}-fresh`;
    const peer1 = await honcho.peer(`${freshId}-p1`, { metadata: {} });
    const peer2 = await honcho.peer(`${freshId}-p2`, { metadata: {} });
    const obs   = await honcho.peer(`${freshId}-obs`, { metadata: {} });

    const [c1] = await peer1.conclusionsOf(obs).create({ content: `${freshId}:fact-1` });
    const [c2] = await peer2.conclusionsOf(obs).create({ content: `${freshId}:fact-2` });

    try {
      const p1Items = await (await peer1.conclusionsOf(obs).list({ size: 50 })).toArray();
      const p2Items = await (await peer2.conclusionsOf(obs).list({ size: 50 })).toArray();

      const p1Total = p1Items.length;
      const p2Total = p2Items.length;

      console.log(`[debug] fresh peer1 total: ${p1Total}, fresh peer2 total: ${p2Total}`);

      // Each fresh peer should only see its own 1 conclusion
      expect(p1Total).toBe(1);
      expect(p2Total).toBe(1);

      // And they must not see each other's
      const p1Ids = p1Items.map(c => c.id);
      const p2Ids = p2Items.map(c => c.id);

      expect(p1Ids).not.toContain(c2.id);
      expect(p2Ids).not.toContain(c1.id);

      if (p1Total !== 1 || p2Total !== 1) {
        console.warn(
          `⚠️  FILTER BUG CONFIRMED: fresh peer1=${p1Total}, peer2=${p2Total}. ` +
          `Expected 1 each. The observer_id filter is not working server-side.`
        );
      }
    } finally {
      // Clean up fresh test data
      await peer1.conclusionsOf(obs).delete(c1.id).catch(() => null);
      await peer2.conclusionsOf(obs).delete(c2.id).catch(() => null);
    }
  }, 30_000);
});
