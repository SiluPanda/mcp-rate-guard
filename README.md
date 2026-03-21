# mcp-rate-guard

Protocol-level sliding-window rate limiter middleware for MCP servers.

## Install

```bash
npm install mcp-rate-guard
```

## Quick Start — Standalone

```typescript
import { checkRateLimit, InMemoryStore } from 'mcp-rate-guard';

const store = new InMemoryStore();

const options = {
  store,
  global: { max: 100, windowMs: 60_000 },          // 100 req/min globally
  methods: { 'tools/call': { max: 20, windowMs: 60_000 } },
  perClient: { max: 10, windowMs: 60_000 },
};

// In your request handler:
const result = await checkRateLimit(request, options, { sessionId: 'client-abc' });
if (!result.allowed) {
  // retryAfterMs tells the client how long to wait
  return jsonRpcError(-32029, 'Too Many Requests', result.retryAfterMs);
}
```

## Quick Start — createRateLimiter

```typescript
import { createRateLimiter } from 'mcp-rate-guard';

const limiter = createRateLimiter(server, {
  global: { max: 200, windowMs: 60_000 },
  tools: { 'image-gen': { max: 5, windowMs: 60_000 } },
  perClient: { max: 30, windowMs: 60_000 },
  onRateLimited: (event) => console.warn('Rate limited', event),
});

// Use limiter._check() inside your request middleware
```

## Options

| Option | Type | Description |
|---|---|---|
| `global` | `RateLimitRule` | Applies to every request |
| `methods` | `Record<string, RateLimitRule>` | Per JSONRPC method |
| `tools` | `Record<string, RateLimitRule>` | Per tool name (tools/call only) |
| `perClient` | `RateLimitRule` | Per client (session) |
| `perClientMethods` | `Record<string, RateLimitRule>` | Per client + method |
| `perClientTools` | `Record<string, RateLimitRule>` | Per client + tool |
| `keyExtractor` | `fn(request, extra) => string` | Custom client ID extractor |
| `store` | `RateLimitStore` | Custom store (default: InMemoryStore) |
| `exempt` | `string[]` | Methods that bypass rate limiting |
| `errorCode` | `number` | JSONRPC error code (default -32029) |
| `errorMessage` | `string` | Custom error message |
| `onRateLimited` | `fn(event)` | Callback on rejection |

## RateLimitRule

```typescript
{ max: number; windowMs: number }
```

## Sliding Window Formula

The effective request count blends the previous and current windows for smooth rate enforcement:

```
overlapFraction = 1 - ((now - currentWindowStart) / windowMs)
effectiveCount  = previousCount * max(0, overlapFraction) + currentCount
```

This prevents burst spikes at window boundaries.

## Key Hierarchy (checked in priority order)

1. `client:{id}:tool:{name}` — perClientTools
2. `client:{id}:method:{method}` — perClientMethods
3. `client:{id}` — perClient
4. `tool:{name}` — tools
5. `method:{method}` — methods
6. `global` — global

## License

MIT
