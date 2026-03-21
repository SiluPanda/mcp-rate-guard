// mcp-rate-guard - Protocol-level rate limiter middleware for MCP
export { createRateLimiter, check } from './rate-limiter';
export { InMemoryStore } from './store';
export * from './types';

import { check } from './rate-limiter';
import { InMemoryStore } from './store';
import type { JSONRPCRequest, RateLimiterOptions, RequestExtra } from './types';

/**
 * Standalone rate-limit check. Creates a shared in-memory store per options
 * reference if no store is provided; suitable for single-process usage.
 *
 * For production multi-call usage, create one InMemoryStore and pass it via
 * options.store so state persists across calls.
 */
export async function checkRateLimit(
  request: JSONRPCRequest,
  options: RateLimiterOptions,
  extra?: RequestExtra,
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const store = options.store ?? new InMemoryStore();
  const result = await check(request, extra, options, store);
  return { allowed: result.allowed, retryAfterMs: result.retryAfterMs };
}
