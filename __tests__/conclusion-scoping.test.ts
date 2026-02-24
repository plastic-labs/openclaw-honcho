/**
 * Unit tests: conclusion scoping (mocked HTTP)
 *
 * Verifies that ConclusionScope sets observer_id / observed_id correctly
 * when listing or creating conclusions, without making real HTTP calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConclusionScope } from '@honcho-ai/sdk';

// ── Mock HTTP client ─────────────────────────────────────────────────────────
function makeMockHttp() {
  return {
    post: vi.fn(),
    delete: vi.fn(),
  };
}

// Minimal valid Page-like API response
function pageResponse(items: unknown[] = []) {
  return { items, total: items.length, page: 1, size: 50, pages: 1 };
}

// ────────────────────────────────────────────────────────────────────────────

describe('ConclusionScope — observer/observed identity', () => {
  it('stores observer and observed from constructor', () => {
    const http = makeMockHttp();
    const scope = new ConclusionScope(http as never, 'ws-test', 'agent-prime', 'owner');
    expect(scope.observer).toBe('agent-prime');
    expect(scope.observed).toBe('owner');
  });

  it('two agents produce scopes with distinct observer IDs', () => {
    const http = makeMockHttp();
    const primeScope = new ConclusionScope(http as never, 'ws-test', 'agent-prime', 'owner');
    const devScope = new ConclusionScope(http as never, 'ws-test', 'agent-developer', 'owner');

    expect(primeScope.observer).not.toBe(devScope.observer);
    expect(primeScope.observer).toBe('agent-prime');
    expect(devScope.observer).toBe('agent-developer');
  });
});

describe('ConclusionScope.list() — sends correct filters', () => {
  let http: ReturnType<typeof makeMockHttp>;

  beforeEach(() => {
    http = makeMockHttp();
    http.post.mockResolvedValue(pageResponse());
  });

  it('includes observer_id and observed_id in filter body', async () => {
    const scope = new ConclusionScope(http as never, 'ws-test', 'agent-prime', 'owner');
    await scope.list();

    expect(http.post).toHaveBeenCalledOnce();
    const [_url, opts] = http.post.mock.calls[0];
    expect(opts.body.filters).toMatchObject({
      observer_id: 'agent-prime',
      observed_id: 'owner',
    });
  });

  it('agent-prime scope does NOT request agent-developer conclusions', async () => {
    const scope = new ConclusionScope(http as never, 'ws-test', 'agent-prime', 'owner');
    await scope.list();

    const [_url, opts] = http.post.mock.calls[0];
    expect(opts.body.filters.observer_id).toBe('agent-prime');
    expect(opts.body.filters.observer_id).not.toBe('agent-developer');
  });

  it('agent-developer scope sends different filter from agent-prime scope', async () => {
    const primeScope = new ConclusionScope(http as never, 'ws-test', 'agent-prime', 'owner');
    const devScope = new ConclusionScope(http as never, 'ws-test', 'agent-developer', 'owner');

    await primeScope.list();
    await devScope.list();

    const calls = http.post.mock.calls;
    const primeFilter = calls[0][1].body.filters;
    const devFilter = calls[1][1].body.filters;

    expect(primeFilter.observer_id).toBe('agent-prime');
    expect(devFilter.observer_id).toBe('agent-developer');
    expect(primeFilter.observer_id).not.toBe(devFilter.observer_id);
  });
});

describe('ConclusionScope.create() — embeds correct observer/observed', () => {
  let http: ReturnType<typeof makeMockHttp>;

  beforeEach(() => {
    http = makeMockHttp();
    http.post.mockResolvedValue([
      {
        id: 'c-001',
        content: 'test fact',
        observer_id: 'agent-prime',
        observed_id: 'owner',
        session_id: null,
        created_at: new Date().toISOString(),
      },
    ]);
  });

  it('sends observer_id = scope.observer in each conclusion', async () => {
    const scope = new ConclusionScope(http as never, 'ws-test', 'agent-prime', 'owner');
    await scope.create({ content: 'test fact' });

    const [_url, opts] = http.post.mock.calls[0];
    const created = opts.body.conclusions[0];
    expect(created.observer_id).toBe('agent-prime');
    expect(created.observed_id).toBe('owner');
  });

  it('agent-developer scope sends different observer_id than agent-prime', async () => {
    const primeScope = new ConclusionScope(http as never, 'ws-test', 'agent-prime', 'owner');
    const devScope = new ConclusionScope(http as never, 'ws-test', 'agent-developer', 'owner');

    await primeScope.create({ content: 'prime fact' });
    await devScope.create({ content: 'dev fact' });

    const calls = http.post.mock.calls;
    expect(calls[0][1].body.conclusions[0].observer_id).toBe('agent-prime');
    expect(calls[1][1].body.conclusions[0].observer_id).toBe('agent-developer');
  });
});

describe('ConclusionScope.query() — includes filters', () => {
  let http: ReturnType<typeof makeMockHttp>;

  beforeEach(() => {
    http = makeMockHttp();
    http.post.mockResolvedValue([]);
  });

  it('sends observer_id and observed_id in query body', async () => {
    const scope = new ConclusionScope(http as never, 'ws-test', 'agent-prime', 'owner');
    await scope.query('programming language');

    const [_url, opts] = http.post.mock.calls[0];
    expect(opts.body.filters).toMatchObject({
      observer_id: 'agent-prime',
      observed_id: 'owner',
    });
    expect(opts.body.query).toBe('programming language');
  });
});
