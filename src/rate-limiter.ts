import type {
  RateLimiterOptions,
  RateLimiter,
  RateLimitStore,
  RateLimitState,
  RateLimitedEvent,
  RequestAllowedEvent,
  JSONRPCRequest,
  RequestExtra,
  RateLimitRule,
  WindowState,
} from './types';
import { InMemoryStore } from './store';

function applyWindowShift(state: WindowState, now: number, windowMs: number): WindowState {
  if (now < state.currentWindowStart + windowMs) {
    return state;
  }
  const alignedStart = Math.floor(now / windowMs) * windowMs;
  const twoWindowsElapsed = now >= state.currentWindowStart + 2 * windowMs;
  return {
    currentCount: 0,
    previousCount: twoWindowsElapsed ? 0 : state.currentCount,
    currentWindowStart: alignedStart,
    previousWindowStart: twoWindowsElapsed ? alignedStart - windowMs : state.currentWindowStart,
  };
}

function slidingWindowEffectiveCount(state: WindowState, now: number, windowMs: number): number {
  const shifted = applyWindowShift(state, now, windowMs);
  const overlapFraction = 1 - (now - shifted.currentWindowStart) / windowMs;
  return shifted.previousCount * Math.min(1, Math.max(0, overlapFraction)) + shifted.currentCount;
}

export async function check(
  request: JSONRPCRequest,
  extra: RequestExtra | undefined,
  options: RateLimiterOptions,
  store: RateLimitStore,
): Promise<{ allowed: boolean; retryAfterMs?: number; rule?: RateLimitRule; key?: string; remaining?: number; currentCount?: number }> {
  const { method } = request;
  const exempt = options.exempt ?? [];

  if (exempt.includes(method)) {
    return { allowed: true };
  }

  const clientId = options.keyExtractor
    ? options.keyExtractor(request, extra)
    : (extra?.sessionId ?? 'default');

  let toolName: string | null = null;
  if (method === 'tools/call' && request.params != null && typeof request.params === 'object') {
    const p = request.params as Record<string, unknown>;
    if (typeof p['name'] === 'string') {
      toolName = p['name'];
    }
  }

  // Build list of (storeKey, rule) pairs to check, in priority order
  const pairs: Array<{ storeKey: string; rule: RateLimitRule }> = [];

  if (toolName !== null && options.perClientTools?.[toolName]) {
    pairs.push({ storeKey: `client:${clientId}:tool:${toolName}`, rule: options.perClientTools[toolName] });
  }
  if (options.perClientMethods?.[method]) {
    pairs.push({ storeKey: `client:${clientId}:method:${method}`, rule: options.perClientMethods[method] });
  }
  if (options.perClient) {
    pairs.push({ storeKey: `client:${clientId}`, rule: options.perClient });
  }
  if (toolName !== null && options.tools?.[toolName]) {
    pairs.push({ storeKey: `tool:${toolName}`, rule: options.tools[toolName] });
  }
  if (options.methods?.[method]) {
    pairs.push({ storeKey: `method:${method}`, rule: options.methods[method] });
  }
  if (options.global) {
    pairs.push({ storeKey: 'global', rule: options.global });
  }

  if (pairs.length === 0) {
    return { allowed: true };
  }

  const now = Date.now();

  // Check all pairs before incrementing — if current effective count is already at or
  // above the limit, the next increment would exceed it, so we block now.
  for (const { storeKey, rule } of pairs) {
    const existing = await store.get(storeKey, rule.windowMs);
    if (existing) {
      const effective = slidingWindowEffectiveCount(existing, now, rule.windowMs);
      if (effective >= rule.max) {
        const shifted = applyWindowShift(existing, now, rule.windowMs);
        const resetMs = shifted.currentWindowStart + rule.windowMs - now;
        return {
          allowed: false,
          retryAfterMs: Math.max(0, resetMs),
          rule,
          key: storeKey,
          currentCount: effective,
        };
      }
    } else if (rule.max <= 0) {
      // max of 0 means no requests allowed at all — block immediately
      return {
        allowed: false,
        retryAfterMs: rule.windowMs,
        rule,
        key: storeKey,
      };
    }
  }

  // All checks passed — increment all keys and compute remaining for primary key
  let remaining: number | undefined;
  for (let i = 0; i < pairs.length; i++) {
    const { storeKey, rule } = pairs[i];
    const updated = await store.increment(storeKey, rule.windowMs);
    const effective = slidingWindowEffectiveCount(updated, now, rule.windowMs);
    const ruleRemaining = Math.max(0, rule.max - effective);
    remaining = remaining === undefined ? ruleRemaining : Math.min(remaining, ruleRemaining);
  }

  return { allowed: true, remaining };
}

export interface RateLimiterWithCheck extends RateLimiter {
  _check(request: JSONRPCRequest, extra?: RequestExtra): Promise<{ allowed: boolean; retryAfterMs?: number }>;
}

export function createRateLimiter(_server: unknown, options: RateLimiterOptions): RateLimiterWithCheck {
  const store: RateLimitStore = options.store ?? new InMemoryStore();
  let _active = true;
  let _rejectedCount = 0;
  let _allowedCount = 0;

  type Listener<T> = (e: T) => void;

  const listeners: {
    rateLimited: Array<Listener<RateLimitedEvent>>;
    requestAllowed: Array<Listener<RequestAllowedEvent>>;
  } = {
    rateLimited: [],
    requestAllowed: [],
  };

  function emitRateLimited(e: RateLimitedEvent): void {
    for (const fn of listeners.rateLimited) fn(e);
  }

  function emitRequestAllowed(e: RequestAllowedEvent): void {
    for (const fn of listeners.requestAllowed) fn(e);
  }

  const limiter: RateLimiterWithCheck = {
    get active() { return _active; },
    get rejectedCount() { return _rejectedCount; },
    get allowedCount() { return _allowedCount; },

    async close(): Promise<void> {
      _active = false;
      await store.close();
    },

    getState(key: string): RateLimitState | null {
      // Synchronous snapshot not available from async store; callers use checkRateLimit for state.
      void key;
      return null;
    },

    async reset(): Promise<void> {
      await store.resetAll();
      _rejectedCount = 0;
      _allowedCount = 0;
    },

    async resetKey(key: string): Promise<void> {
      await store.reset(key);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: any, fn: any): void {
      if (event === 'rateLimited') {
        listeners.rateLimited.push(fn as Listener<RateLimitedEvent>);
      } else if (event === 'requestAllowed') {
        listeners.requestAllowed.push(fn as Listener<RequestAllowedEvent>);
      }
    },

    off(event: string, fn: Function): void {
      if (event === 'rateLimited') {
        const idx = (listeners.rateLimited as Function[]).indexOf(fn);
        if (idx !== -1) listeners.rateLimited.splice(idx, 1);
      } else if (event === 'requestAllowed') {
        const idx = (listeners.requestAllowed as Function[]).indexOf(fn);
        if (idx !== -1) listeners.requestAllowed.splice(idx, 1);
      }
    },

    async _check(request: JSONRPCRequest, extra?: RequestExtra): Promise<{ allowed: boolean; retryAfterMs?: number }> {
      const result = await check(request, extra, options, store);
      const toolName = extractToolName(request);
      const clientId = options.keyExtractor
        ? options.keyExtractor(request, extra)
        : (extra?.sessionId ?? 'default');

      if (!result.allowed) {
        _rejectedCount++;
        const event: RateLimitedEvent = {
          timestamp: new Date().toISOString(),
          key: result.key ?? '',
          method: request.method,
          toolName,
          clientId,
          requestId: request.id ?? '',
          rule: result.rule!,
          currentCount: result.currentCount ?? result.rule!.max,
          retryAfterSeconds: (result.retryAfterMs ?? 0) / 1000,
        };
        emitRateLimited(event);
        if (options.onRateLimited) options.onRateLimited(event);
      } else {
        _allowedCount++;
        const event: RequestAllowedEvent = {
          method: request.method,
          toolName,
          clientId,
          remaining: result.remaining ?? 0,
        };
        emitRequestAllowed(event);
      }

      return { allowed: result.allowed, retryAfterMs: result.retryAfterMs };
    },
  };

  return limiter;
}

function extractToolName(request: JSONRPCRequest): string | null {
  if (request.method === 'tools/call' && request.params != null && typeof request.params === 'object') {
    const p = request.params as Record<string, unknown>;
    if (typeof p['name'] === 'string') return p['name'];
  }
  return null;
}
