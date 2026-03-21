import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRateLimiter, check } from '../rate-limiter';
import type { RateLimiterWithCheck } from '../rate-limiter';
import { InMemoryStore } from '../store';
import type {
  JSONRPCRequest,
  RateLimiterOptions,
  RateLimitedEvent,
  RequestAllowedEvent,
} from '../types';

// Helper: make a basic JSONRPC request
function req(method: string, id: number | string = 1, params?: unknown): JSONRPCRequest {
  return { id, method, params };
}

// Helper: make a tools/call request
function toolsCall(name: string, id = 1): JSONRPCRequest {
  return { id, method: 'tools/call', params: { name } };
}

describe('InMemoryStore', () => {
  it('increments and returns window state', async () => {
    const store = new InMemoryStore();
    const state = await store.increment('key1', 60_000);
    expect(state.currentCount).toBe(1);
  });

  it('get returns null for unseen key', async () => {
    const store = new InMemoryStore();
    const state = await store.get('missing', 60_000);
    expect(state).toBeNull();
  });

  it('reset removes the key', async () => {
    const store = new InMemoryStore();
    await store.increment('k', 60_000);
    await store.reset('k');
    const state = await store.get('k', 60_000);
    expect(state).toBeNull();
  });

  it('resetAll clears everything', async () => {
    const store = new InMemoryStore();
    await store.increment('a', 60_000);
    await store.increment('b', 60_000);
    await store.resetAll();
    expect(await store.get('a', 60_000)).toBeNull();
    expect(await store.get('b', 60_000)).toBeNull();
  });
});

describe('check() — core rate limit logic', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the global limit', async () => {
    const options: RateLimiterOptions = { global: { max: 3, windowMs: 60_000 } };
    for (let i = 0; i < 3; i++) {
      const result = await check(req('initialize', i), undefined, options, store);
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks the request that exceeds the global limit', async () => {
    const options: RateLimiterOptions = { global: { max: 2, windowMs: 60_000 } };
    await check(req('initialize', 1), undefined, options, store);
    await check(req('initialize', 2), undefined, options, store);
    const result = await check(req('initialize', 3), undefined, options, store);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.rule).toEqual({ max: 2, windowMs: 60_000 });
  });

  it('tracks different methods separately with per-method rules', async () => {
    const options: RateLimiterOptions = {
      methods: {
        'tools/list': { max: 1, windowMs: 60_000 },
        'resources/list': { max: 10, windowMs: 60_000 },
      },
    };

    // tools/list: first call allowed, second blocked
    const r1 = await check(req('tools/list', 1), undefined, options, store);
    expect(r1.allowed).toBe(true);
    const r2 = await check(req('tools/list', 2), undefined, options, store);
    expect(r2.allowed).toBe(false);

    // resources/list: still under limit
    const r3 = await check(req('resources/list', 3), undefined, options, store);
    expect(r3.allowed).toBe(true);
  });

  it('enforces per-tool limits on tools/call', async () => {
    const options: RateLimiterOptions = {
      tools: { 'image-gen': { max: 1, windowMs: 60_000 } },
    };

    const r1 = await check(toolsCall('image-gen', 1), undefined, options, store);
    expect(r1.allowed).toBe(true);
    const r2 = await check(toolsCall('image-gen', 2), undefined, options, store);
    expect(r2.allowed).toBe(false);

    // Different tool is unaffected
    const r3 = await check(toolsCall('search', 3), undefined, options, store);
    expect(r3.allowed).toBe(true);
  });

  it('tracks different clients independently with perClient rule', async () => {
    const options: RateLimiterOptions = {
      perClient: { max: 1, windowMs: 60_000 },
    };

    const r1 = await check(req('initialize', 1), { sessionId: 'alice' }, options, store);
    expect(r1.allowed).toBe(true);
    const r2 = await check(req('initialize', 2), { sessionId: 'alice' }, options, store);
    expect(r2.allowed).toBe(false);

    // Bob is tracked separately
    const r3 = await check(req('initialize', 3), { sessionId: 'bob' }, options, store);
    expect(r3.allowed).toBe(true);
  });

  it('exempt methods always pass regardless of limits', async () => {
    const options: RateLimiterOptions = {
      global: { max: 0, windowMs: 60_000 },
      exempt: ['ping', 'initialize'],
    };

    const r1 = await check(req('ping'), undefined, options, store);
    expect(r1.allowed).toBe(true);
    const r2 = await check(req('initialize'), undefined, options, store);
    expect(r2.allowed).toBe(true);

    // Non-exempt is blocked immediately (max 0)
    const r3 = await check(req('tools/list'), undefined, options, store);
    expect(r3.allowed).toBe(false);
  });

  it('sliding window: allows burst at start, then enforces limit over window', async () => {
    const windowMs = 10_000;
    const options: RateLimiterOptions = {
      global: { max: 5, windowMs },
    };

    // Burn through 5 requests in the first window
    for (let i = 0; i < 5; i++) {
      const r = await check(req('ping', i), undefined, options, store);
      expect(r.allowed).toBe(true);
    }

    // 6th request is blocked
    const blocked = await check(req('ping', 99), undefined, options, store);
    expect(blocked.allowed).toBe(false);

    // Advance halfway through the window
    vi.advanceTimersByTime(windowMs / 2);

    // Still blocked — previous window counts still overlap (5 * 0.5 = 2.5 > 0 new)
    const stillBlocked = await check(req('ping', 100), undefined, options, store);
    expect(stillBlocked.allowed).toBe(false);

    // Advance past a full window
    vi.advanceTimersByTime(windowMs);

    // Now allowed — old counts have faded
    const allowed = await check(req('ping', 101), undefined, options, store);
    expect(allowed.allowed).toBe(true);
  });

  it('uses custom keyExtractor for client ID', async () => {
    const options: RateLimiterOptions = {
      perClient: { max: 1, windowMs: 60_000 },
      keyExtractor: (request) => {
        const p = request.params as Record<string, unknown> | undefined;
        return (p?.['apiKey'] as string) ?? 'default';
      },
    };

    const r1 = await check(
      { id: 1, method: 'ping', params: { apiKey: 'key-A' } },
      undefined,
      options,
      store,
    );
    expect(r1.allowed).toBe(true);

    const r2 = await check(
      { id: 2, method: 'ping', params: { apiKey: 'key-A' } },
      undefined,
      options,
      store,
    );
    expect(r2.allowed).toBe(false);

    // Different key is allowed
    const r3 = await check(
      { id: 3, method: 'ping', params: { apiKey: 'key-B' } },
      undefined,
      options,
      store,
    );
    expect(r3.allowed).toBe(true);
  });

  it('perClientTools tracks client+tool independently', async () => {
    const options: RateLimiterOptions = {
      perClientTools: { 'image-gen': { max: 1, windowMs: 60_000 } },
    };

    const r1 = await check(toolsCall('image-gen', 1), { sessionId: 'alice' }, options, store);
    expect(r1.allowed).toBe(true);

    // Second call from alice is blocked
    const r2 = await check(toolsCall('image-gen', 2), { sessionId: 'alice' }, options, store);
    expect(r2.allowed).toBe(false);

    // Same tool, different client — allowed
    const r3 = await check(toolsCall('image-gen', 3), { sessionId: 'bob' }, options, store);
    expect(r3.allowed).toBe(true);
  });

  it('returns retryAfterMs > 0 on rejection', async () => {
    const options: RateLimiterOptions = { global: { max: 1, windowMs: 60_000 } };
    await check(req('ping', 1), undefined, options, store);
    const result = await check(req('ping', 2), undefined, options, store);
    expect(result.allowed).toBe(false);
    expect(typeof result.retryAfterMs).toBe('number');
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('no rules configured: always allows', async () => {
    const options: RateLimiterOptions = {};
    for (let i = 0; i < 100; i++) {
      const r = await check(req('anything', i), undefined, options, store);
      expect(r.allowed).toBe(true);
    }
  });
});

describe('createRateLimiter()', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks rejectedCount and allowedCount', async () => {
    const options: RateLimiterOptions = {
      store,
      global: { max: 2, windowMs: 60_000 },
    };
    const limiter = createRateLimiter(null, options) as RateLimiterWithCheck;

    await limiter._check(req('ping', 1));
    await limiter._check(req('ping', 2));
    await limiter._check(req('ping', 3)); // blocked

    expect(limiter.allowedCount).toBe(2);
    expect(limiter.rejectedCount).toBe(1);
  });

  it('fires onRateLimited callback on rejection', async () => {
    const events: RateLimitedEvent[] = [];
    const options: RateLimiterOptions = {
      store,
      global: { max: 1, windowMs: 60_000 },
      onRateLimited: (e) => events.push(e),
    };
    const limiter = createRateLimiter(null, options) as RateLimiterWithCheck;

    await limiter._check(req('ping', 1));
    await limiter._check(req('ping', 2));

    expect(events).toHaveLength(1);
    expect(events[0].method).toBe('ping');
    expect(events[0].retryAfterSeconds).toBeGreaterThanOrEqual(0);
    expect(events[0].rule).toEqual({ max: 1, windowMs: 60_000 });
  });

  it('fires rateLimited event via on()', async () => {
    const options: RateLimiterOptions = {
      store,
      global: { max: 1, windowMs: 60_000 },
    };
    const limiter = createRateLimiter(null, options) as RateLimiterWithCheck;

    const events: RateLimitedEvent[] = [];
    limiter.on('rateLimited', (e) => events.push(e));

    await limiter._check(req('ping', 1));
    await limiter._check(req('ping', 2));

    expect(events).toHaveLength(1);
    expect(events[0].key).toBe('global');
  });

  it('fires requestAllowed event via on()', async () => {
    const options: RateLimiterOptions = {
      store,
      global: { max: 5, windowMs: 60_000 },
    };
    const limiter = createRateLimiter(null, options) as RateLimiterWithCheck;

    const events: RequestAllowedEvent[] = [];
    limiter.on('requestAllowed', (e) => events.push(e));

    await limiter._check(req('ping', 1));
    expect(events).toHaveLength(1);
    expect(events[0].method).toBe('ping');
  });

  it('off() removes the listener', async () => {
    const options: RateLimiterOptions = {
      store,
      global: { max: 1, windowMs: 60_000 },
    };
    const limiter = createRateLimiter(null, options) as RateLimiterWithCheck;

    const events: RateLimitedEvent[] = [];
    const listener = (e: RateLimitedEvent) => events.push(e);
    limiter.on('rateLimited', listener);
    limiter.off('rateLimited', listener);

    await limiter._check(req('ping', 1));
    await limiter._check(req('ping', 2));

    expect(events).toHaveLength(0);
  });

  it('reset() clears counts', async () => {
    const options: RateLimiterOptions = {
      store,
      global: { max: 1, windowMs: 60_000 },
    };
    const limiter = createRateLimiter(null, options) as RateLimiterWithCheck;

    await limiter._check(req('ping', 1));
    await limiter._check(req('ping', 2)); // rejected

    expect(limiter.allowedCount).toBe(1);
    expect(limiter.rejectedCount).toBe(1);

    await limiter.reset();

    expect(limiter.allowedCount).toBe(0);
    expect(limiter.rejectedCount).toBe(0);

    // After reset, the store is cleared so limit is fresh
    const r = await limiter._check(req('ping', 3));
    expect(r.allowed).toBe(true);
  });

  it('close() sets active to false', async () => {
    const options: RateLimiterOptions = { store, global: { max: 5, windowMs: 60_000 } };
    const limiter = createRateLimiter(null, options);
    expect(limiter.active).toBe(true);
    await limiter.close();
    expect(limiter.active).toBe(false);
  });

  it('includes toolName in rateLimited event for tools/call', async () => {
    const options: RateLimiterOptions = {
      store,
      tools: { 'image-gen': { max: 0, windowMs: 60_000 } },
    };
    const limiter = createRateLimiter(null, options) as RateLimiterWithCheck;

    const events: RateLimitedEvent[] = [];
    limiter.on('rateLimited', (e) => events.push(e));

    await limiter._check(toolsCall('image-gen', 1));

    expect(events).toHaveLength(1);
    expect(events[0].toolName).toBe('image-gen');
  });
});
