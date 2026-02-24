/**
 * Integration: parent peer is added to subagent sessions
 *
 * Fires the agent_end hook with a subagent-style session key and asserts
 * that the resulting Honcho session contains owner, subagent, and parent.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Honcho } from '@honcho-ai/sdk';
import honchoPlugin from '../index.js';

const API_KEY      = process.env.HONCHO_API_KEY;
const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? 'openclaw-test';
const BASE_URL     = process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev';

const maybe = !API_KEY ? describe.skip : describe;

const TS                 = Date.now();
const OPENCLAW_SESSION   = `agent:developer:subagent:harness-${TS}`;
const HONCHO_SESSION     = `agent-developer-subagent-harness-${TS}-test`;

type HookCallback = (event: unknown, ctx: unknown) => Promise<unknown>;

function buildMockApi() {
  const hooks = new Map<string, HookCallback[]>();
  return {
    pluginConfig: {},
    logger: {
      info:  (...a: unknown[]) => {},
      warn:  (...a: unknown[]) => {},
      error: (...a: unknown[]) => {},
      debug: (...a: unknown[]) => {},
    },
    config: {
      agents: { list: [{ id: 'prime', default: true }, { id: 'developer', default: false }] },
    },
    on(name: string, cb: HookCallback) {
      hooks.set(name, [...(hooks.get(name) ?? []), cb]);
    },
    registerTool: () => {},
    registerCli:  () => {},
    runtime: {
      tools: { createMemorySearchTool: () => null, createMemoryGetTool: () => null },
    },
    async fire(name: string, event: unknown, ctx: unknown) {
      for (const cb of hooks.get(name) ?? []) await cb(event, ctx);
    },
  };
}

maybe('subagent session peers', () => {
  let peerIds: string[];

  beforeAll(async () => {
    const api = buildMockApi();
    honchoPlugin.register(api as any);
    await api.fire('gateway_start', {}, {});
    await api.fire('agent_end', {
      success:  true,
      messages: [
        { role: 'user',      content: 'ping' },
        { role: 'assistant', content: 'pong' },
      ],
    }, {
      sessionKey:      OPENCLAW_SESSION,
      messageProvider: 'test',
      agentId:         'developer',
    });

    const honcho  = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
    const session = await honcho.session(HONCHO_SESSION);
    peerIds = (await session.peers()).map(p => p.id);
  }, 60_000);

  it('contains owner',          () => expect(peerIds).toContain('owner'));
  it('contains agent-developer', () => expect(peerIds.some(id => id.includes('developer'))).toBe(true));
  it('contains agent-prime',     () => expect(peerIds).toContain('agent-prime'));
});
