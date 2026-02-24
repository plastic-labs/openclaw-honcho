/**
 * Unit tests: peer naming convention
 *
 * Verifies that distinct agent IDs produce distinct, predictable peer IDs.
 * Imports the real functions from index.ts so any change to the implementation
 * is immediately caught here rather than silently diverging from a local copy.
 */
import { describe, it, expect } from 'vitest';
import { derivePeerId, buildSessionKey } from '../index.js';

// ────────────────────────────────────────────────────────────────────────────

describe('peer naming — distinct IDs per agent', () => {
  it('agent-prime and agent-developer get different peer IDs', () => {
    expect(derivePeerId('prime')).not.toBe(derivePeerId('developer'));
  });

  it('follows the agent-{id} pattern', () => {
    expect(derivePeerId('prime')).toBe('agent-prime');
    expect(derivePeerId('developer')).toBe('agent-developer');
    expect(derivePeerId('main')).toBe('agent-main');
  });

  it('normalises case and whitespace', () => {
    expect(derivePeerId('PRIME')).toBe('agent-prime');
    expect(derivePeerId('  prime  ')).toBe('agent-prime');
  });

  it('falls back to "main" for empty/blank agent IDs', () => {
    expect(derivePeerId('')).toBe('agent-main');
    expect(derivePeerId('   ')).toBe('agent-main');
  });
});

describe('session key building', () => {
  it('combines sessionKey + messageProvider with a hyphen', () => {
    expect(buildSessionKey({ sessionKey: 'abc', messageProvider: 'telegram' })).toBe('abc-telegram');
  });

  it('replaces non-alphanumeric chars with hyphens', () => {
    const key = buildSessionKey({ sessionKey: 'agent:prime:main', messageProvider: 'telegram' });
    expect(key).toBe('agent-prime-main-telegram');
    expect(key).toMatch(/^[a-zA-Z0-9-]+$/);
  });

  it('uses defaults when ctx is undefined', () => {
    expect(buildSessionKey()).toBe('default-unknown');
  });

  it('two different providers produce different session keys for the same base key', () => {
    const a = buildSessionKey({ sessionKey: 'test', messageProvider: 'telegram' });
    const b = buildSessionKey({ sessionKey: 'test', messageProvider: 'discord' });
    expect(a).not.toBe(b);
  });
});
