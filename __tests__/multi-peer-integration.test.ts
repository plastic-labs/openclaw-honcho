/**
 * Integration: multi-peer conclusion scoping
 *
 * Verifies that conclusions written for one peer are not visible from another
 * peer's scope, and that observer/observed attribution is correct.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Honcho } from '@honcho-ai/sdk';
const API_KEY = process.env.HONCHO_API_KEY;
const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? 'openclaw-test';
const BASE_URL = process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev';
const maybe = !API_KEY ? describe.skip : describe;
const RUN_ID = `test-${Date.now()}`;
maybe('multi-peer conclusion isolation', () => {
    let honcho;
    let ownerPeer;
    let primePeer;
    let devPeer;
    let primeConclId;
    let devConclId;
    beforeAll(async () => {
        honcho = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
        await honcho.setMetadata({});
        ownerPeer = await honcho.peer('owner', { metadata: {} });
        primePeer = await honcho.peer(`${RUN_ID}-agent-prime`, { metadata: { agentId: 'prime' } });
        devPeer = await honcho.peer(`${RUN_ID}-agent-developer`, { metadata: { agentId: 'developer' } });
        const [pc] = await primePeer.conclusionsOf(ownerPeer).create({ content: `${RUN_ID}:prime-fact` });
        const [dc] = await devPeer.conclusionsOf(ownerPeer).create({ content: `${RUN_ID}:dev-fact` });
        primeConclId = pc.id;
        devConclId = dc.id;
    }, 30_000);
    afterAll(async () => {
        await primePeer.conclusionsOf(ownerPeer).delete(primeConclId).catch(() => null);
        await devPeer.conclusionsOf(ownerPeer).delete(devConclId).catch(() => null);
    }, 15_000);
    it('conclusions carry correct observer and observed', async () => {
        const items = await (await primePeer.conclusionsOf(ownerPeer).list({ size: 50 })).toArray();
        const c = items.find(i => i.id === primeConclId);
        expect(c?.observerId).toBe(`${RUN_ID}-agent-prime`);
        expect(c?.observedId).toBe('owner');
    });
    it('prime scope contains its own conclusion', async () => {
        const items = await (await primePeer.conclusionsOf(ownerPeer).list({ size: 50 })).toArray();
        expect(items.map(i => i.id)).toContain(primeConclId);
    });
    it('developer scope contains its own conclusion', async () => {
        const items = await (await devPeer.conclusionsOf(ownerPeer).list({ size: 50 })).toArray();
        expect(items.map(i => i.id)).toContain(devConclId);
    });
    it('prime scope does not contain developer conclusion', async () => {
        const items = await (await primePeer.conclusionsOf(ownerPeer).list({ size: 50 })).toArray();
        expect(items.map(i => i.id)).not.toContain(devConclId);
    });
    it('developer scope does not contain prime conclusion', async () => {
        const items = await (await devPeer.conclusionsOf(ownerPeer).list({ size: 50 })).toArray();
        expect(items.map(i => i.id)).not.toContain(primeConclId);
    });
    it('two fresh peers each see exactly their own conclusions', async () => {
        const id = `${RUN_ID}-fresh`;
        const p1 = await honcho.peer(`${id}-p1`, { metadata: {} });
        const p2 = await honcho.peer(`${id}-p2`, { metadata: {} });
        const obs = await honcho.peer(`${id}-obs`, { metadata: {} });
        const [c1] = await p1.conclusionsOf(obs).create({ content: `${id}:fact-1` });
        const [c2] = await p2.conclusionsOf(obs).create({ content: `${id}:fact-2` });
        try {
            const p1Items = await (await p1.conclusionsOf(obs).list({ size: 50 })).toArray();
            const p2Items = await (await p2.conclusionsOf(obs).list({ size: 50 })).toArray();
            expect(p1Items).toHaveLength(1);
            expect(p2Items).toHaveLength(1);
            expect(p1Items.map(i => i.id)).not.toContain(c2.id);
            expect(p2Items.map(i => i.id)).not.toContain(c1.id);
        }
        finally {
            await p1.conclusionsOf(obs).delete(c1.id).catch(() => null);
            await p2.conclusionsOf(obs).delete(c2.id).catch(() => null);
        }
    }, 30_000);
});
