# mcp-rate-guard

Protocol-level rate limiter middleware for MCP (Model Context Protocol) servers.

[![npm version](https://img.shields.io/npm/v/mcp-rate-guard.svg)](https://www.npmjs.com/package/mcp-rate-guard)
[![npm downloads](https://img.shields.io/npm/dt/mcp-rate-guard.svg)](https://www.npmjs.com/package/mcp-rate-guard)
[![license](https://img.shields.io/npm/l/mcp-rate-guard.svg)](https://github.com/SiluPanda/mcp-rate-guard/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/mcp-rate-guard.svg)](https://nodejs.org)

---

## Description

`mcp-rate-guard` wraps an existing MCP `Server` instance from `@modelcontextprotocol/sdk` and transparently intercepts all incoming JSON-RPC requests, enforcing configurable rate limits before the server's handlers execute. When a client exceeds its allowed request rate, `mcp-rate-guard` short-circuits the request with a JSON-RPC error response containing a standard error code, a human-readable message, and machine-readable retry metadata. The server's handler is never invoked for rejected requests.

Unlike HTTP-level rate limiters such as `express-rate-limit`, this package operates on deserialized JSON-RPC messages at the protocol layer. It works identically across all MCP transports -- stdio, Streamable HTTP, and custom transports -- because it intercepts messages after they have been extracted from the transport layer and before they reach the server's request handlers. Protocol-level awareness means the rate limiter can distinguish between a `tools/call` request (which may execute expensive operations) and a `tools/list` request (which is cheap), something no HTTP middleware can do without custom parsing.

Key capabilities:

- Sliding window counter algorithm for smooth rate enforcement without burst-at-boundary problems
- Per-method, per-tool, and per-client rate limiting with independent limits
- Global rate limit as an aggregate ceiling across all methods and clients
- In-memory storage for single-process deployments
- Pluggable storage backend interface (`RateLimitStore`) for distributed deployments (e.g., Redis)
- Structured events and counters for observability and monitoring
- Fail-open design: store failures allow requests through rather than blocking traffic
- Zero runtime dependencies beyond Node.js built-ins

---

## Installation

```bash
npm install mcp-rate-guard
```

### Peer Dependency

This package requires `@modelcontextprotocol/sdk` as a peer dependency:

```bash
npm install @modelcontextprotocol/sdk
```

```json
{
  "peerDependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
```

---

## Quick Start

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createRateLimiter } from 'mcp-rate-guard';

const server = new Server(
  { name: 'my-server', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);

// Register tool/resource/prompt handlers on the server as normal...

const limiter = createRateLimiter(server, {
  global: { max: 100, windowMs: 60_000 },
  methods: {
    'tools/call': { max: 30, windowMs: 60_000 },
    'resources/read': { max: 60, windowMs: 60_000 },
  },
  tools: {
    'delete_file': { max: 5, windowMs: 60_000 },
  },
});

// Connect the server to a transport as normal. The rate limiter is already active.
// await server.connect(transport);

// On shutdown:
await limiter.close();
```

---

## Features

### Sliding Window Counter Algorithm

Time is divided into fixed-size windows. For each rate limit key, the store maintains a current window counter and a previous window counter. The effective request count is computed as:

```
effectiveCount = previousWindowCount * overlapFraction + currentWindowCount
```

Where `overlapFraction` is the fraction of the previous window that overlaps with the sliding window. This provides smooth rate enforcement with O(1) memory per key and eliminates the burst-at-boundary problem of fixed windows.

### Hierarchical Rate Limit Keys

Every rate limit check is performed against a key. Keys are hierarchical strings that combine multiple dimensions:

| Key Pattern | Scope |
|---|---|
| `global` | All requests from all clients |
| `method:{methodName}` | Requests by MCP method |
| `tool:{toolName}` | `tools/call` requests by tool name |
| `client:{clientId}` | All requests from a specific client |
| `client:{clientId}:method:{methodName}` | Requests by method from a specific client |
| `client:{clientId}:tool:{toolName}` | `tools/call` requests by tool from a specific client |

When a request arrives, all applicable keys are checked. If any key's limit is exceeded, the request is rejected.

### Rule Evaluation Order

When multiple rules apply to a single request, they are evaluated in this order:

1. Global
2. Per-method
3. Per-tool (only for `tools/call`)
4. Per-client
5. Per-client-method
6. Per-client-tool (only for `tools/call`)

Evaluation short-circuits on the first violation. Counters are incremented optimistically before checking, providing conservative (stricter) rate limiting.

### Transport-Agnostic Client Identification

Client identity is derived from the transport layer by default:

- **Streamable HTTP**: Uses the `Mcp-Session-Id` header (one session per client)
- **stdio**: Uses a fixed key `'stdio'` (single client per process)
- **Custom transports**: Uses the transport's `sessionId` property, falling back to `'unknown'`

For advanced identification, supply a custom `keyExtractor` function.

### Exempt Methods and Initialization Bypass

Methods listed in the `exempt` array bypass all rate limiting. When `skipInitialization` is `true` (the default), the `initialize` request is never rate-limited regardless of other settings.

### Fail-Open Design

When the storage backend fails (e.g., Redis is unreachable), requests are allowed through rather than blocked. Errors are reported via the `onError` callback for alerting and investigation.

---

## API Reference

### `createRateLimiter(server, options)`

Factory function that wraps an MCP `Server` instance and returns a `RateLimiter` handle.

```typescript
function createRateLimiter(
  server: Server,
  options: RateLimiterOptions,
): RateLimiter;
```

**Parameters:**

- `server` -- An MCP `Server` instance from `@modelcontextprotocol/sdk`.
- `options` -- Configuration object. See `RateLimiterOptions` below.

**Returns:** A `RateLimiter` handle for lifecycle management and state inspection.

**Throws:** `TypeError` if the configuration is invalid.

---

### `RateLimiterOptions`

```typescript
interface RateLimiterOptions {
  global?: RateLimitRule;
  methods?: Record<string, RateLimitRule>;
  tools?: Record<string, RateLimitRule>;
  perClient?: RateLimitRule;
  perClientMethods?: Record<string, RateLimitRule>;
  perClientTools?: Record<string, RateLimitRule>;
  keyExtractor?: (request: JSONRPCRequest, extra: RequestExtra) => string;
  store?: RateLimitStore;
  exempt?: string[];
  skipInitialization?: boolean;
  errorCode?: number;
  errorMessage?: string;
  onRateLimited?: (event: RateLimitedEvent) => void;
  onError?: (error: Error) => void;
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `global` | `RateLimitRule` | `undefined` | Global rate limit applied to all requests from all clients. |
| `methods` | `Record<string, RateLimitRule>` | `{}` | Per-method rate limits. Keys are MCP method names (e.g., `'tools/call'`, `'resources/read'`). |
| `tools` | `Record<string, RateLimitRule>` | `{}` | Per-tool rate limits for `tools/call` requests. Keys are tool names. |
| `perClient` | `RateLimitRule` | `undefined` | Per-client rate limit applied to all requests from each individual client. |
| `perClientMethods` | `Record<string, RateLimitRule>` | `{}` | Per-client-per-method rate limits. Keys are MCP method names. |
| `perClientTools` | `Record<string, RateLimitRule>` | `{}` | Per-client-per-tool rate limits for `tools/call` requests. Keys are tool names. |
| `keyExtractor` | `(request, extra) => string` | `undefined` | Custom function to extract a client identifier from a request. Falls back to transport session ID if not provided. |
| `store` | `RateLimitStore` | `new MemoryStore()` | Storage backend for rate limit counters. |
| `exempt` | `string[]` | `[]` | MCP methods exempt from all rate limiting. |
| `skipInitialization` | `boolean` | `true` | Whether to skip rate limiting for the `initialize` request. |
| `errorCode` | `number` | `-32029` | JSON-RPC error code for rate limit responses. |
| `errorMessage` | `string` | `'Rate limit exceeded for {method}. Try again in {retryAfter} seconds.'` | Error message template. Supports placeholders: `{method}`, `{tool}`, `{limit}`, `{windowMs}`, `{retryAfter}`. |
| `onRateLimited` | `(event: RateLimitedEvent) => void` | `undefined` | Callback invoked synchronously when a request is rate-limited. |
| `onError` | `(error: Error) => void` | `console.error` | Callback for internal errors (e.g., store failures). |

At least one of `global`, `methods`, `tools`, `perClient`, `perClientMethods`, or `perClientTools` must be configured. A `TypeError` is thrown otherwise.

---

### `RateLimitRule`

```typescript
interface RateLimitRule {
  max: number;
  windowMs: number;
}
```

| Field | Type | Description |
|---|---|---|
| `max` | `number` | Maximum number of requests allowed within the time window. Must be a positive integer (>= 1). |
| `windowMs` | `number` | Time window duration in milliseconds. Must be a positive integer (>= 1). |

Common `windowMs` values:

- `1_000` -- 1 second
- `10_000` -- 10 seconds
- `60_000` -- 1 minute
- `300_000` -- 5 minutes
- `3_600_000` -- 1 hour

---

### `RateLimiter`

Handle returned by `createRateLimiter`. Provides lifecycle control, state inspection, and event subscription.

```typescript
interface RateLimiter {
  close(): Promise<void>;
  readonly active: boolean;
  readonly rejectedCount: number;
  readonly allowedCount: number;
  getState(key: string): RateLimitState | null;
  reset(): Promise<void>;
  resetKey(key: string): Promise<void>;
  on(event: 'rateLimited', listener: (event: RateLimitedEvent) => void): void;
  on(event: 'requestAllowed', listener: (event: RequestAllowedEvent) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}
```

| Member | Description |
|---|---|
| `close()` | Stop the rate limiter and release resources. After calling, all requests pass through without rate limiting. Idempotent. |
| `active` | Whether the rate limiter is currently active (not closed). |
| `rejectedCount` | Total requests rejected since creation. Monotonically increasing. |
| `allowedCount` | Total requests allowed since creation. Monotonically increasing. |
| `getState(key)` | Get the current rate limit state for a specific key. Returns `null` if the key has no recorded requests. |
| `reset()` | Reset all rate limit counters and clear `rejectedCount`/`allowedCount`. |
| `resetKey(key)` | Reset counters for a specific key. |
| `on(event, listener)` | Subscribe to `rateLimited` or `requestAllowed` events. |
| `off(event, listener)` | Unsubscribe from events. |

---

### `RateLimitState`

Snapshot of the rate limit state for a specific key.

```typescript
interface RateLimitState {
  key: string;
  current: number;
  limit: number;
  windowMs: number;
  resetMs: number;
  remaining: number;
}
```

| Field | Type | Description |
|---|---|---|
| `key` | `string` | The rate limit key (e.g., `'method:tools/call'`). |
| `current` | `number` | Number of requests counted in the current sliding window. |
| `limit` | `number` | Maximum requests allowed in the window. |
| `windowMs` | `number` | Window duration in milliseconds. |
| `resetMs` | `number` | Milliseconds remaining until the current window resets. |
| `remaining` | `number` | Remaining requests allowed before hitting the limit. |

---

### `RateLimitedEvent`

Payload emitted when a request is rate-limited.

```typescript
interface RateLimitedEvent {
  timestamp: string;
  key: string;
  method: string;
  toolName: string | null;
  clientId: string;
  requestId: string | number;
  rule: RateLimitRule;
  currentCount: number;
  retryAfterSeconds: number;
}
```

| Field | Type | Description |
|---|---|---|
| `timestamp` | `string` | ISO 8601 timestamp when the rate limit was triggered. |
| `key` | `string` | The rate limit key that was exceeded. |
| `method` | `string` | The MCP method of the rejected request. |
| `toolName` | `string \| null` | The tool name if the method is `tools/call`, `null` otherwise. |
| `clientId` | `string` | The client identifier. |
| `requestId` | `string \| number` | The JSON-RPC request ID. |
| `rule` | `RateLimitRule` | The rate limit rule that was violated. |
| `currentCount` | `number` | Current request count in the sliding window. |
| `retryAfterSeconds` | `number` | Seconds until the client can retry. |

---

### `RequestAllowedEvent`

Payload emitted when a request passes rate limit checks. Only emitted if at least one listener is registered for the `requestAllowed` event.

```typescript
interface RequestAllowedEvent {
  method: string;
  toolName: string | null;
  clientId: string;
  remaining: number;
}
```

| Field | Type | Description |
|---|---|---|
| `method` | `string` | The MCP method of the allowed request. |
| `toolName` | `string \| null` | The tool name if the method is `tools/call`, `null` otherwise. |
| `clientId` | `string` | The client identifier. |
| `remaining` | `number` | The most restrictive remaining allowance across all applicable keys. |

---

### `RequestExtra`

Metadata available about the incoming request, derived from the transport layer.

```typescript
interface RequestExtra {
  sessionId?: string;
  transportInfo?: Record<string, unknown>;
}
```

---

### `RateLimitStore`

Storage backend interface for rate limit counters. Implement this interface to use an external store (e.g., Redis) for distributed rate limiting.

```typescript
interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<WindowState>;
  get(key: string, windowMs: number): Promise<WindowState | null>;
  reset(key: string): Promise<void>;
  resetAll(): Promise<void>;
  close(): Promise<void>;
}
```

| Method | Description |
|---|---|
| `increment(key, windowMs)` | Increment the counter for a key within a time window. Returns the current `WindowState` after incrementing. Must be atomic. |
| `get(key, windowMs)` | Get the current window state for a key without incrementing. Returns `null` if no data exists. |
| `reset(key)` | Reset the counter for a specific key. |
| `resetAll()` | Reset all counters. |
| `close()` | Close the store and release resources. Must be idempotent and must not throw. |

#### Store Contract Requirements

1. **Atomicity**: `increment()` must atomically read and increment. Concurrent calls must not lose counts.
2. **Expiration**: Counters for expired windows must eventually be cleaned up.
3. **Monotonicity**: `currentCount` from `increment()` must be monotonically increasing within a window.
4. **Performance**: `increment()` should complete in under 1ms for in-memory stores, under 5ms for network-based stores.
5. **Fail-safe close**: `close()` must not throw.

---

### `WindowState`

Internal state of a rate limit window, returned by `RateLimitStore` methods.

```typescript
interface WindowState {
  currentCount: number;
  previousCount: number;
  currentWindowStart: number;
  previousWindowStart: number;
}
```

| Field | Type | Description |
|---|---|---|
| `currentCount` | `number` | Request count in the current fixed window. |
| `previousCount` | `number` | Request count in the previous fixed window. |
| `currentWindowStart` | `number` | Start timestamp (ms since epoch) of the current window. |
| `previousWindowStart` | `number` | Start timestamp (ms since epoch) of the previous window. |

---

### `MemoryStore`

Built-in in-memory implementation of `RateLimitStore`. Suitable for single-process deployments.

```typescript
class MemoryStore implements RateLimitStore {
  constructor(options?: { cleanupIntervalMs?: number });

  increment(key: string, windowMs: number): Promise<WindowState>;
  get(key: string, windowMs: number): Promise<WindowState | null>;
  reset(key: string): Promise<void>;
  resetAll(): Promise<void>;
  close(): Promise<void>;
}
```

| Constructor Option | Type | Default | Description |
|---|---|---|---|
| `cleanupIntervalMs` | `number` | `60000` | Interval in milliseconds between cleanup sweeps for expired entries. The cleanup timer uses `unref()` so it does not prevent process exit. |

---

## Configuration

### Validation Rules

The following validation rules are enforced when `createRateLimiter` is called. Invalid configurations throw a synchronous `TypeError`.

| Rule | Condition |
|---|---|
| At least one limit required | At least one of `global`, `methods`, `tools`, `perClient`, `perClientMethods`, or `perClientTools` must be configured. |
| `max` must be a positive integer | Every `RateLimitRule.max` must be >= 1 and pass `Number.isInteger`. |
| `windowMs` must be a positive integer | Every `RateLimitRule.windowMs` must be >= 1 and pass `Number.isInteger`. |
| `exempt` must be an array of strings | Each element must be a non-empty string. |
| `errorCode` must be a finite number | Must pass `Number.isFinite` if provided. |
| `keyExtractor` must be a function | `typeof keyExtractor === 'function'` if provided. |
| `store` must implement `RateLimitStore` | Must have `increment`, `get`, `reset`, `resetAll`, and `close` methods if provided. |

Unrecognized method names in `methods` or `perClientMethods` produce a warning but do not throw. Tool names in `tools` or `perClientTools` that do not match registered tools produce a warning. In both cases the limit is still installed.

### Configuration Examples

#### Minimal: Global Rate Limit Only

```typescript
const limiter = createRateLimiter(server, {
  global: { max: 200, windowMs: 60_000 },
});
```

#### Per-Tool Protection

```typescript
const limiter = createRateLimiter(server, {
  tools: {
    'execute_query': { max: 10, windowMs: 60_000 },
    'delete_record': { max: 2, windowMs: 60_000 },
    'send_email': { max: 5, windowMs: 300_000 },
  },
  exempt: ['ping'],
});
```

#### Multi-Tenant with Per-Client Limits

```typescript
const limiter = createRateLimiter(server, {
  perClient: { max: 100, windowMs: 60_000 },
  perClientMethods: {
    'tools/call': { max: 30, windowMs: 60_000 },
  },
  perClientTools: {
    'expensive_analysis': { max: 3, windowMs: 300_000 },
  },
  keyExtractor: (request, extra) => {
    return extra.transportInfo?.apiKey as string ?? extra.sessionId ?? 'anonymous';
  },
});
```

#### Complete Default Configuration

```typescript
const defaults = {
  global: undefined,
  methods: {},
  tools: {},
  perClient: undefined,
  perClientMethods: {},
  perClientTools: {},
  keyExtractor: undefined,
  store: new MemoryStore(),
  exempt: [],
  skipInitialization: true,
  errorCode: -32029,
  errorMessage: 'Rate limit exceeded for {method}. Try again in {retryAfter} seconds.',
  onRateLimited: undefined,
  onError: (error) => console.error('[mcp-rate-guard]', error),
};
```

---

## Error Handling

### Rate Limit Error Response

When a request is rate-limited, the following JSON-RPC error response is sent directly to the client via the transport:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32029,
    "message": "Rate limit exceeded for tools/call. Try again in 3 seconds.",
    "data": {
      "retryAfter": 3,
      "limit": 30,
      "windowMs": 60000,
      "key": "method:tools/call",
      "remaining": 0,
      "resetMs": 2847
    }
  }
}
```

#### Error Response Fields

| Field | Type | Description |
|---|---|---|
| `error.code` | `number` | JSON-RPC error code. Defaults to `-32029`. Configurable via `errorCode`. |
| `error.message` | `string` | Human-readable error message. Configurable via `errorMessage` template. |
| `error.data.retryAfter` | `number` | Seconds until the client can retry (rounded up to nearest second, minimum 1). |
| `error.data.limit` | `number` | Maximum requests allowed in the window. |
| `error.data.windowMs` | `number` | Window duration in milliseconds. |
| `error.data.key` | `string` | The rate limit key that was exceeded. |
| `error.data.remaining` | `number` | Always `0` when rate-limited. |
| `error.data.resetMs` | `number` | Milliseconds until the current window resets. |

#### Error Code Rationale

The MCP specification does not define a standard rate limit error code. The JSON-RPC 2.0 specification reserves codes `-32000` to `-32099` for server-defined errors. The code `-32029` is chosen by convention within the MCP ecosystem and does not conflict with any standard JSON-RPC or MCP-defined error codes.

### Fail-Open Behavior

| Failure Mode | Behavior |
|---|---|
| Store `increment()` throws or rejects | Request allowed through. `onError` called. Counters not incremented. |
| Store `get()` throws or rejects | `getState()` returns `null`. `onError` called. |
| `keyExtractor` throws | Request allowed through with fallback key. `onError` called. |
| Transport `send()` fails when sending error response | Rate-limited request may reach the server handler. `onError` called. |
| Server has no tools matching a `tools` key | Warning at creation time. Limit still installed. |

### Graceful Shutdown

When `limiter.close()` is called:

1. The `active` flag is set to `false`.
2. The cleanup timer in `MemoryStore` is cleared.
3. The store's `close()` method is called.
4. Transport interception wrappers become pass-through.
5. All subsequent requests pass through without rate limiting.

---

## Advanced Usage

### McpServer (High-Level API) Integration

When using the high-level `McpServer` class, access the underlying `Server` instance:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRateLimiter } from 'mcp-rate-guard';

const mcpServer = new McpServer(
  { name: 'my-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

mcpServer.tool('get_weather', { location: { type: 'string' } }, async (args) => {
  return { content: [{ type: 'text', text: `Weather for ${args.location}` }] };
});

const limiter = createRateLimiter(mcpServer.server, {
  methods: { 'tools/call': { max: 30, windowMs: 60_000 } },
});
```

### Middleware Ordering

If the server is also wrapped with `mcp-audit-log` or other middleware, the order of wrapping matters. Middleware applied first is outermost (closest to the transport); middleware applied last is innermost (closest to the server's handlers).

**Recommended order** (rate-limited requests are rejected before audit logging):

```typescript
const server = new Server(/* ... */);
server.setRequestHandler(/* ... */);

// 1. Apply rate limiting (outermost)
const limiter = createRateLimiter(server, { /* ... */ });

// 2. Apply audit logging (inner -- only logs requests that passed rate limiting)
const logger = createAuditLogger(server, { /* ... */ });

await server.connect(transport);
```

To audit rate-limited requests for security monitoring, reverse the order so the audit logger wraps the transport first.

### Custom Key Extraction

For advanced client identification beyond transport session IDs:

```typescript
const limiter = createRateLimiter(server, {
  perClient: { max: 50, windowMs: 60_000 },
  keyExtractor: (request, extra) => {
    // Use a custom header passed through transport metadata
    const apiKey = extra.transportInfo?.headers?.['x-api-key'];
    if (apiKey) return `apikey:${apiKey}`;

    // Use the session ID
    if (extra.sessionId) return `session:${extra.sessionId}`;

    // Fallback
    return 'anonymous';
  },
});
```

The `keyExtractor` is called synchronously for every request. It must be fast (no I/O, no async operations). If it throws, the error is caught, reported via `onError`, and the request is allowed through (fail-open).

### Distributed Rate Limiting with Redis

For multi-process deployments where rate limits must be shared, implement a custom `RateLimitStore`:

```typescript
import { RateLimitStore, WindowState } from 'mcp-rate-guard';
import Redis from 'ioredis';

class RedisStore implements RateLimitStore {
  private redis: Redis;
  private prefix: string;

  constructor(redisUrl: string, prefix = 'mcp-rl:') {
    this.redis = new Redis(redisUrl);
    this.prefix = prefix;
  }

  async increment(key: string, windowMs: number): Promise<WindowState> {
    const now = Date.now();
    const currentWindowStart = Math.floor(now / windowMs) * windowMs;
    const previousWindowStart = currentWindowStart - windowMs;

    const currentKey = `${this.prefix}${key}:${currentWindowStart}`;
    const previousKey = `${this.prefix}${key}:${previousWindowStart}`;

    const pipeline = this.redis.pipeline();
    pipeline.incr(currentKey);
    pipeline.pexpire(currentKey, windowMs * 2);
    pipeline.get(previousKey);

    const results = await pipeline.exec();
    const currentCount = results![0][1] as number;
    const previousCount = parseInt(results![2][1] as string || '0', 10);

    return { currentCount, previousCount, currentWindowStart, previousWindowStart };
  }

  async get(key: string, windowMs: number): Promise<WindowState | null> {
    const now = Date.now();
    const currentWindowStart = Math.floor(now / windowMs) * windowMs;
    const previousWindowStart = currentWindowStart - windowMs;

    const currentKey = `${this.prefix}${key}:${currentWindowStart}`;
    const previousKey = `${this.prefix}${key}:${previousWindowStart}`;

    const [currentStr, previousStr] = await this.redis.mget(currentKey, previousKey);
    if (currentStr === null && previousStr === null) return null;

    return {
      currentCount: parseInt(currentStr || '0', 10),
      previousCount: parseInt(previousStr || '0', 10),
      currentWindowStart,
      previousWindowStart,
    };
  }

  async reset(key: string): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}${key}:*`);
    if (keys.length > 0) await this.redis.del(...keys);
  }

  async resetAll(): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}*`);
    if (keys.length > 0) await this.redis.del(...keys);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

const limiter = createRateLimiter(server, {
  store: new RedisStore(process.env.REDIS_URL!),
  perClient: { max: 100, windowMs: 60_000 },
});
```

### Observability and Monitoring

#### Event-Based Metrics

```typescript
// Prometheus-style metrics
limiter.on('rateLimited', (event) => {
  rateLimitedCounter.inc({ method: event.method, client: event.clientId });
});

// Structured logging
limiter.on('rateLimited', (event) => {
  logger.warn({ event }, 'MCP request rate-limited');
});

// Alerting on high-risk tools
limiter.on('rateLimited', (event) => {
  if (event.method === 'tools/call' && event.toolName === 'delete_file') {
    alerting.trigger('high-risk-tool-rate-limited', event);
  }
});
```

#### State Inspection for Health Checks

```typescript
const state = limiter.getState('tool:delete_file');
if (state && state.remaining < 3) {
  console.warn(`delete_file tool is near rate limit: ${state.remaining} remaining`);
}
```

#### Counter Monitoring

```typescript
setInterval(() => {
  metrics.gauge('mcp.rate_limiter.allowed', limiter.allowedCount);
  metrics.gauge('mcp.rate_limiter.rejected', limiter.rejectedCount);
}, 10_000);
```

### Multiple Transports

The rate limiter wraps `server.connect()`, so each transport connection gets its own interception wrapper. Rate limit counters are shared across all transports via the single `RateLimitStore` instance, ensuring consistent enforcement regardless of which transport a client uses.

---

## TypeScript

This package is written in TypeScript and ships with full type declarations. All public interfaces and types are exported from the package entry point:

```typescript
import {
  createRateLimiter,
  MemoryStore,
  type RateLimiterOptions,
  type RateLimitRule,
  type RateLimiter,
  type RateLimitState,
  type RateLimitedEvent,
  type RequestAllowedEvent,
  type RequestExtra,
  type RateLimitStore,
  type WindowState,
} from 'mcp-rate-guard';
```

Compiler settings: TypeScript 5.x, `ES2022` target, `strict` mode, full declaration maps.

---

## License

MIT
