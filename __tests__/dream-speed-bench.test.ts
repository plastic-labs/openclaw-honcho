/**
 * Benchmark: dream() latency under different workspace/session configurations
 *
 * Tests how long peer card population takes with:
 *   A) Default config   — baseline
 *   B) reasoning off    — skip expensive reasoning step
 *   C) summary off      — skip summary generation
 *   D) reasoning + summary off — minimal pipeline
 *   E) no session scope — dream over all content (no session filter)
 *
 * Results are printed as a table at the end. Not a pass/fail suite —
 * all assertions are "card populated within 5 min" — the useful output
 * is the timing deltas.
 *
 * Run with:
 *   pnpm exec vitest run __tests__/dream-speed-bench.test.ts --reporter=verbose
 *
 * Skip with: HONCHO_SKIP_DREAM_TESTS=1
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Honcho, type Peer, type Session } from '@honcho-ai/sdk';

const API_KEY      = process.env.HONCHO_API_KEY;
const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? 'openclaw-test';
const BASE_URL     = process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev';
const SKIP         = !API_KEY || process.env.HONCHO_SKIP_DREAM_TESTS === '1';

const maybeDescribe = SKIP ? describe.skip : describe;

const TS = Date.now();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Poll peer card until non-empty; return elapsed ms. */
async function timeUntilCard(
  observer: Peer,
  target: Peer,
  label: string,
  maxMs = 300_000,
  intervalMs = 2_000,
): Promise<{ card: string[]; elapsedMs: number }> {
  const start    = Date.now();
  const deadline = start + maxMs;
  let backoffMs  = intervalMs;
  while (Date.now() < deadline) {
    try {
      const ctx = await observer.context({ target });
      if (ctx.peerCard && (ctx.peerCard as string[]).length > 0) {
        const elapsedMs = Date.now() - start;
        console.log(`[bench] ${label} → card in ${(elapsedMs / 1000).toFixed(1)}s:`, ctx.peerCard);
        return { card: ctx.peerCard as string[], elapsedMs };
      }
      backoffMs = intervalMs;
    } catch (err: any) {
      if (err.status === 429) {
        backoffMs = Math.min(backoffMs * 2, 15_000);
        console.log(`[bench] ${label} rate limited (429) — backing off ${backoffMs / 1000}s`);
      } else {
        throw err;
      }
    }
    await new Promise(r => setTimeout(r, backoffMs));
  }
  throw new Error(`[bench] ${label} → card not populated within ${maxMs / 1000}s`);
}

/** Seed a minimal session with two messages and return the session. */
async function seedSession(
  honcho: Honcho,
  key: string,
  observer: Peer,
  observed: Peer,
  content: string,
): Promise<Session> {
  const session = await honcho.session(key);
  await session.addPeers([observer, observed]);
  await session.addMessages([
    observer.message(`Context from observer: ${content}`),
    observed.message(`Acknowledgement from observed: noted — ${content}`),
  ]);
  return session;
}

// ── Results accumulator ───────────────────────────────────────────────────────
const results: Array<{ label: string; elapsedMs: number; cardLen: number }> = [];

// ─────────────────────────────────────────────────────────────────────────────

maybeDescribe('dream() speed benchmark', () => {
  let honcho: Honcho;
  let ownerPeer: Peer;
  let primePeer: Peer;

  beforeAll(async () => {
    honcho = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });

    // Nuke and recreate workspace for a clean slate
    console.log('[bench] Nuking workspace...');
    try {
      await honcho.deleteWorkspace(WORKSPACE_ID);
    } catch {}
    await honcho.setMetadata({});

    ownerPeer = await honcho.peer('owner',      { metadata: {} });
    primePeer = await honcho.peer('agent-prime', { metadata: { agentId: 'prime' } });
    console.log('[bench] Workspace ready.');
  }, 30_000);

  // ── A: Baseline (default config) ────────────────────────────────────────────
  it('A: baseline — default workspace config', async () => {
    // Reset to defaults (no config override)
    await honcho.setConfiguration({});

    const fact   = `${TS}-A: prime primarily builds TypeScript tooling`;
    const [concl] = await primePeer.conclusionsOf(ownerPeer).create({ content: fact });
    const session  = await seedSession(honcho, `bench-A-${TS}`, primePeer, ownerPeer, fact);

    await honcho.scheduleDream({ observer: primePeer, observed: ownerPeer, session });
    const { card, elapsedMs } = await timeUntilCard(primePeer, ownerPeer, 'A:baseline');

    results.push({ label: 'A: baseline', elapsedMs, cardLen: card.length });
    expect(card.length).toBeGreaterThan(0);

    // Reset card for next run
    await primePeer.setCard([], ownerPeer).catch(() => null);
    await primePeer.conclusionsOf(ownerPeer).delete(concl.id).catch(() => null);
  }, 360_000);

  // ── B: Reasoning disabled ───────────────────────────────────────────────────
  it('B: reasoning disabled', async () => {
    await honcho.setConfiguration({ reasoning: { enabled: false } });

    const fact    = `${TS}-B: prime writes in Rust for performance-critical paths`;
    const [concl] = await primePeer.conclusionsOf(ownerPeer).create({ content: fact });
    const session  = await seedSession(honcho, `bench-B-${TS}`, primePeer, ownerPeer, fact);

    await honcho.scheduleDream({ observer: primePeer, observed: ownerPeer, session });
    const { card, elapsedMs } = await timeUntilCard(primePeer, ownerPeer, 'B:no-reasoning');

    results.push({ label: 'B: reasoning=false', elapsedMs, cardLen: card.length });
    expect(card.length).toBeGreaterThan(0);

    await primePeer.setCard([], ownerPeer).catch(() => null);
    await primePeer.conclusionsOf(ownerPeer).delete(concl.id).catch(() => null);
  }, 360_000);

  // ── C: Summary disabled ─────────────────────────────────────────────────────
  it('C: summary disabled', async () => {
    await honcho.setConfiguration({ reasoning: {}, summary: { enabled: false } });

    const fact    = `${TS}-C: prime manages cross-agent memory architecture`;
    const [concl] = await primePeer.conclusionsOf(ownerPeer).create({ content: fact });
    const session  = await seedSession(honcho, `bench-C-${TS}`, primePeer, ownerPeer, fact);

    await honcho.scheduleDream({ observer: primePeer, observed: ownerPeer, session });
    const { card, elapsedMs } = await timeUntilCard(primePeer, ownerPeer, 'C:no-summary');

    results.push({ label: 'C: summary=false', elapsedMs, cardLen: card.length });
    expect(card.length).toBeGreaterThan(0);

    await primePeer.setCard([], ownerPeer).catch(() => null);
    await primePeer.conclusionsOf(ownerPeer).delete(concl.id).catch(() => null);
  }, 360_000);

  // ── D: Reasoning + summary both disabled ────────────────────────────────────
  it('D: reasoning + summary both disabled', async () => {
    await honcho.setConfiguration({
      reasoning: { enabled: false },
      summary:   { enabled: false },
    });

    const fact    = `${TS}-D: prime orchestrates parallel subagent workflows`;
    const [concl] = await primePeer.conclusionsOf(ownerPeer).create({ content: fact });
    const session  = await seedSession(honcho, `bench-D-${TS}`, primePeer, ownerPeer, fact);

    await honcho.scheduleDream({ observer: primePeer, observed: ownerPeer, session });
    const { card, elapsedMs } = await timeUntilCard(primePeer, ownerPeer, 'D:no-reasoning+no-summary');

    results.push({ label: 'D: reasoning+summary=false', elapsedMs, cardLen: card.length });
    expect(card.length).toBeGreaterThan(0);

    await primePeer.setCard([], ownerPeer).catch(() => null);
    await primePeer.conclusionsOf(ownerPeer).delete(concl.id).catch(() => null);
  }, 360_000);

  // ── E: No session scope ──────────────────────────────────────────────────────
  it('E: no session scope (dream over all content)', async () => {
    await honcho.setConfiguration({});

    const fact    = `${TS}-E: prime integrates Linear, GitHub and Todoist`;
    const [concl] = await primePeer.conclusionsOf(ownerPeer).create({ content: fact });
    // Note: no session arg — dream runs over entire workspace history for this peer pair
    await honcho.scheduleDream({ observer: primePeer, observed: ownerPeer });
    const { card, elapsedMs } = await timeUntilCard(primePeer, ownerPeer, 'E:no-session-scope');

    results.push({ label: 'E: no session scope', elapsedMs, cardLen: card.length });
    expect(card.length).toBeGreaterThan(0);

    await primePeer.setCard([], ownerPeer).catch(() => null);
    await primePeer.conclusionsOf(ownerPeer).delete(concl.id).catch(() => null);
  }, 360_000);

  // ── Print results table ──────────────────────────────────────────────────────
  it('prints benchmark results table', () => {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  dream() SPEED BENCHMARK RESULTS');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  ${'Config'.padEnd(30)} ${'Time (s)'.padStart(8)}  ${'Cards'.padStart(5)}`);
    console.log('  ' + '─'.repeat(47));
    for (const r of results) {
      const secs = (r.elapsedMs / 1000).toFixed(1);
      console.log(`  ${r.label.padEnd(30)} ${secs.padStart(8)}s  ${String(r.cardLen).padStart(5)}`);
    }
    if (results.length > 1) {
      const baseline = results[0].elapsedMs;
      const fastest  = Math.min(...results.map(r => r.elapsedMs));
      const winner   = results.find(r => r.elapsedMs === fastest)!;
      console.log('  ' + '─'.repeat(47));
      console.log(`  Fastest: ${winner.label} (${(fastest / 1000).toFixed(1)}s)`);
      console.log(`  Speedup vs baseline: ${((baseline - fastest) / 1000).toFixed(1)}s faster`);
    }
    console.log('═══════════════════════════════════════════════════\n');
    expect(results.length).toBeGreaterThan(0);
  });
});
