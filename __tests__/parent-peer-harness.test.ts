/**
 * Harness test: proves that agent-prime is NOT added to subagent sessions
 *
 * When Prime delegates to Forge (agent:developer:subagent:xxx), the plugin's
 * agent_end hook calls `session.addPeers([owner, agent-developer])` but NEVER
 * adds `agent-prime`. This test proves that gap by querying real Honcho after
 * the hook fires and asserting that `agent-prime` IS present — which will FAIL.
 *
 * Tests that should PASS:
 *   ✓ owner is in session peers
 *   ✓ agent-developer is in session peers
 *
 * Test that should FAIL (proves the bug):
 *   ✗ agent-prime is in session peers
 *
 * Once a fix is implemented (adding agent-prime to addPeers for subagent sessions),
 * all three assertions should pass and this test becomes green.
 *
 * Skipped automatically if HONCHO_API_KEY is missing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Honcho } from '@honcho-ai/sdk';
import honchoPlugin from '../index.js';

// ── Honcho env vars ──────────────────────────────────────────────────────────
const API_KEY = process.env.HONCHO_API_KEY;
const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? 'openclaw';
const BASE_URL = process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev';

const SKIP = !API_KEY;
const describeOrSkip = SKIP ? describe.skip : describe;

// ── Unique session key for this test run ─────────────────────────────────────
const TS = Date.now();
// This is the *openclaw* session key (colon-delimited, matching the subagent pattern)
const OPENCLAW_SESSION_KEY = `agent:developer:subagent:harness-test-${TS}`;

// The plugin's buildSessionKey() transforms the ctx into a Honcho-safe key:
//   `${sessionKey}-${messageProvider}`.replace(/[^a-zA-Z0-9-]/g, '-')
// So: "agent:developer:subagent:harness-test-{ts}-test"
//  → "agent-developer-subagent-harness-test-{ts}-test"
const HONCHO_SESSION_KEY = `agent-developer-subagent-harness-test-${TS}-test`;

// ── Build a minimal mock api that satisfies the plugin's OpenClawPluginApi ───
type HookCallback = (event: unknown, ctx: unknown) => Promise<unknown>;

function buildMockApi() {
  const hooks: Map<string, HookCallback[]> = new Map();

  const api = {
    // Plugin config — empty; config.ts will read env vars
    pluginConfig: {},

    // Logger
    logger: {
      info: (...args: unknown[]) => console.log('[plugin:info]', ...args),
      warn: (...args: unknown[]) => console.warn('[plugin:warn]', ...args),
      error: (...args: unknown[]) => console.error('[plugin:error]', ...args),
      debug: (...args: unknown[]) => {}, // suppress debug noise
    },

    // Overall config — provide agent list with 'developer' as default
    config: {
      agents: {
        list: [
          { id: 'prime', default: false },
          { id: 'developer', default: true },
        ],
      },
    },

    // Hook registration — capture callbacks by event name
    on(eventName: string, callback: HookCallback) {
      if (!hooks.has(eventName)) hooks.set(eventName, []);
      hooks.get(eventName)!.push(callback);
    },

    // Tool registration — no-op (we don't care about tools here)
    registerTool: () => {},

    // CLI registration — no-op
    registerCli: () => {},

    // Runtime tools — return null so the passthrough tool is skipped
    runtime: {
      tools: {
        createMemorySearchTool: () => null,
        createMemoryGetTool: () => null,
      },
    },

    // Helper to fire a hook
    async fire(eventName: string, event: unknown, ctx: unknown) {
      const callbacks = hooks.get(eventName) ?? [];
      for (const cb of callbacks) {
        await cb(event, ctx);
      }
    },
  };

  return api;
}

// ─────────────────────────────────────────────────────────────────────────────

describeOrSkip('parent-peer harness: agent-prime missing from subagent session', () => {
  let mockApi: ReturnType<typeof buildMockApi>;

  beforeAll(async () => {
    mockApi = buildMockApi();

    // Register the plugin — this wires up the hooks on our mock api
    honchoPlugin.register(mockApi as any);

    // Fire gateway_start to initialize Honcho workspace / owner peer
    console.log('[harness] Firing gateway_start...');
    await mockApi.fire('gateway_start', {}, {});
    console.log('[harness] gateway_start done');

    // Fire agent_end with a subagent-style session key
    const event = {
      success: true,
      messages: [
        { role: 'user',      content: 'Hello from the harness test user' },
        { role: 'assistant', content: 'Hello from the harness test agent' },
      ],
    };

    const ctx = {
      sessionKey:      OPENCLAW_SESSION_KEY,  // agent:developer:subagent:harness-test-{ts}
      messageProvider: 'test',
      agentId:         'developer',
    };

    console.log(`[harness] Firing agent_end for session: ${OPENCLAW_SESSION_KEY}`);
    console.log(`[harness] Honcho will create session with key: ${HONCHO_SESSION_KEY}`);
    await mockApi.fire('agent_end', event, ctx);
    console.log('[harness] agent_end done');
  }, 60_000);

  // ── Query Honcho directly after the hook to inspect session peers ────────────
  it('owner IS in session peers (should PASS)', async () => {
    const honcho = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
    const session = await honcho.session(HONCHO_SESSION_KEY);
    const peers = await session.peers();
    const peerIds = peers.map(p => p.id);

    console.log('[harness] session peers:', peerIds);
    expect(peerIds).toContain('owner');
  });

  it('agent-developer IS in session peers (should PASS)', async () => {
    const honcho = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
    const session = await honcho.session(HONCHO_SESSION_KEY);
    const peers = await session.peers();
    const peerIds = peers.map(p => p.id);

    console.log('[harness] session peers:', peerIds);
    expect(peerIds).toContain('agent-developer');
  });

  it('agent-prime IS in session peers (should FAIL — proving the bug)', async () => {
    const honcho = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
    const session = await honcho.session(HONCHO_SESSION_KEY);
    const peers = await session.peers();
    const peerIds = peers.map(p => p.id);

    console.log('[harness] session peers:', peerIds);
    console.log('[harness] ↑ agent-prime is absent → bug confirmed');

    // THIS ASSERTION SHOULD FAIL — the plugin never adds agent-prime
    expect(peerIds).toContain('agent-prime');
  });
});
