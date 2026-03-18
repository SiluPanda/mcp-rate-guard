# mcp-rate-guard -- Specification

## 1. Overview

`mcp-rate-guard` is a protocol-level rate limiter middleware for MCP (Model Context Protocol) servers. It wraps an existing MCP `Server` instance from `@modelcontextprotocol/sdk` and transparently intercepts all incoming JSON-RPC requests, enforcing configurable rate limits before the server's handlers execute. When a client exceeds its allowed request rate, `mcp-rate-guard` short-circuits the request with a JSON-RPC error response containing a standard error code, a human-readable message, and machine-readable retry metadata. The server's handler is never invoked for rejected requests.

The gap this package fills is specific and underserved. `express-rate-limit` and similar HTTP-level rate limiters operate at the transport layer -- they count HTTP requests and return `429 Too Many Requests` responses. This works for MCP servers using Streamable HTTP transport, but MCP is explicitly transport-agnostic. The majority of MCP servers today use stdio transport, where there is no HTTP layer at all. A client process writes JSON-RPC messages to the server's stdin and reads responses from stdout. No HTTP middleware can intercept these messages. Even for HTTP-based MCP deployments, HTTP-level rate limiting cannot distinguish between a `tools/call` request (which may execute expensive operations) and a `tools/list` request (which is cheap), because both arrive as HTTP POST bodies containing JSON-RPC payloads. Protocol-level rate limiting operates on the deserialized JSON-RPC message, giving it access to the method name, tool name, request arguments, and client identity -- none of which are visible at the HTTP layer without custom parsing.

`mcp-rate-guard` provides sliding window rate limiting with per-method, per-tool, and per-client controls. It supports in-memory storage for single-process deployments and a pluggable storage backend interface for distributed deployments (e.g., Redis). It emits structured events for observability, exposes counters for monitoring, and is designed to add negligible latency to allowed requests. The package is strictly a gate: it decides whether a request is allowed to proceed, and if not, returns an error. It never modifies request content, reorders messages, or delays allowed requests.

---

## 2. Goals and Non-Goals

### Goals

- Provide a single `createRateLimiter(server, options)` function that wraps an MCP `Server` instance and begins enforcing rate limits on all incoming requests.
- Support rate limiting by MCP method (`tools/call`, `resources/read`, `prompts/get`, `tools/list`, etc.) with independent limits per method.
- Support rate limiting by tool name within `tools/call`, allowing different tools to have different rate limits (e.g., a `delete_file` tool may have a stricter limit than a `get_weather` tool).
- Support per-client rate limiting, where "client" is identified by session ID (Streamable HTTP), a synthetic session token (stdio), or a custom key extraction function.
- Implement a sliding window counter algorithm as the default rate limiting strategy, providing smooth rate enforcement without the burst-at-boundary problem of fixed windows.
- Support a global rate limit that applies across all methods, all tools, and all clients, as a ceiling to prevent aggregate overload.
- Return well-formed JSON-RPC error responses when a request is rate-limited, using error code `-32029` with `retryAfter`, `limit`, and `windowMs` fields in the error `data` object.
- Provide a pluggable storage backend interface (`RateLimitStore`) for distributed deployments, with a built-in in-memory implementation.
- Emit typed events (`rateLimited`, `requestAllowed`) for observability and integration with monitoring systems.
- Expose read-only counters and state inspection methods for dashboards and health checks.
- Never modify, delay, or reorder MCP messages that are within their rate limits. Allowed requests pass through with zero functional side effects.
- Keep runtime dependencies to zero beyond Node.js built-ins and the peer dependency on `@modelcontextprotocol/sdk`.

### Non-Goals

- **Not an HTTP rate limiter.** This package does not inspect HTTP headers, return HTTP status codes, or integrate with HTTP middleware frameworks. Use `express-rate-limit` for HTTP-level rate limiting. This package operates on deserialized JSON-RPC messages at the protocol layer.
- **Not an authentication or authorization system.** This package does not verify client identity, validate tokens, or enforce access control policies. It trusts the client identity provided by the transport layer or a user-supplied key extractor. Use dedicated auth middleware for access control.
- **Not a request queue or throttle.** This package rejects excess requests immediately with an error response. It does not buffer, queue, or delay requests to smooth out traffic. Use `bottleneck` or `p-queue` if you need request queuing.
- **Not a DDoS protection system.** Protocol-level rate limiting assumes the transport layer is already handling connection-level abuse. This package protects against well-behaved clients making too many requests, not against malicious actors flooding the transport.
- **Not a billing or usage metering system.** This package counts requests for rate limiting purposes, not for billing. Counters are ephemeral (in-memory or time-windowed in external stores) and not designed for accurate long-term usage tracking.
- **Not a response rate limiter.** This package limits incoming requests, not outgoing responses. It does not throttle server-initiated notifications or server-to-client requests (e.g., `sampling/createMessage`).
- **Not a content inspector.** This package does not examine request arguments or response content for rate limiting decisions (beyond the tool name). Argument-based rate limiting (e.g., rate-limit by query complexity) is out of scope.

---

## 3. Target Users

### MCP Server Developers

Developers building MCP servers who need to protect their tools from excessive invocation. A tool that calls an external API with its own rate limits needs a protocol-level gate to prevent the MCP client from exceeding those limits. A tool that performs expensive computation (database queries, file system operations, LLM calls) needs protection against rapid-fire invocations that could exhaust resources.

### Platform and Infrastructure Engineers

Teams operating multi-tenant MCP server deployments where multiple clients (Claude Desktop, Cursor, custom agents) connect to shared server instances. Per-client rate limiting prevents any single client from monopolizing server resources. Global rate limits prevent aggregate overload regardless of client count.

### AI Application Architects

Teams building multi-agent systems where autonomous agents interact with MCP servers in tight loops. Without rate limiting, an agent that retries on failure can create a cascading loop of requests that overwhelms the server and any downstream services it depends on. Protocol-level rate limiting provides a safety valve that operates regardless of transport choice.

### Enterprise Security Teams

Organizations deploying MCP servers in production who need defense-in-depth against resource exhaustion. HTTP-level rate limiting is one layer, but stdio-based servers have no HTTP layer at all. Protocol-level rate limiting fills this gap, ensuring that every MCP server -- regardless of transport -- has consistent rate limit enforcement.

### Open-Source MCP Tool Authors

Developers publishing MCP servers as npm packages who want to ship sensible default rate limits. Wrapping the server with `mcp-rate-guard` lets package authors protect downstream APIs and resources without requiring consumers to configure external rate limiting infrastructure.

---

## 4. Core Concepts

### Protocol-Level vs. Transport-Level Rate Limiting

Transport-level rate limiting operates on raw network traffic: HTTP requests, TCP connections, WebSocket frames. It sees bytes and headers but not application semantics. Protocol-level rate limiting operates on deserialized application messages. In MCP, this means operating on JSON-RPC requests after they have been parsed from the transport. The key advantage is semantic awareness: the rate limiter knows that a message is a `tools/call` for the `delete_file` tool, not just an HTTP POST to `/mcp`.

This distinction matters because MCP is transport-agnostic. The same server code can run over stdio (no HTTP at all), Streamable HTTP (HTTP POST with optional SSE), or custom transports. Protocol-level rate limiting works identically across all transports because it intercepts messages after they have been extracted from the transport layer and before they reach the server's request handlers.

### Sliding Window Counter Algorithm

The sliding window counter algorithm divides time into fixed-size windows (e.g., 60 seconds) and tracks the request count in the current window and the previous window. The effective count is computed as:

```
effectiveCount = previousWindowCount * overlapFraction + currentWindowCount
```

Where `overlapFraction` is the fraction of the previous window that overlaps with the sliding window. For example, if the window is 60 seconds, the current time is 45 seconds into the current window, then 15 seconds of the previous window overlap (overlapFraction = 15/60 = 0.25).

This algorithm provides a smooth approximation of a true sliding window with O(1) memory per key (two counters and two timestamps) instead of the O(n) memory required to store every individual request timestamp. It eliminates the burst-at-boundary problem of fixed windows, where a client can make 2x the limit by timing requests at the boundary between two windows.

### Rate Limit Keys

Every rate limit check is performed against a key. The key determines what is being rate-limited. Keys are hierarchical strings that combine multiple dimensions:

- **Global**: `global` -- counts all requests from all clients.
- **Per-method**: `method:{methodName}` -- counts requests by MCP method (e.g., `method:tools/call`).
- **Per-tool**: `tool:{toolName}` -- counts `tools/call` requests by tool name (e.g., `tool:delete_file`).
- **Per-client**: `client:{clientId}` -- counts all requests from a specific client.
- **Per-client-method**: `client:{clientId}:method:{methodName}` -- counts requests by method from a specific client.
- **Per-client-tool**: `client:{clientId}:tool:{toolName}` -- counts `tools/call` requests by tool from a specific client.

When a request arrives, the rate limiter checks all applicable keys. If any key's limit is exceeded, the request is rejected. The most specific applicable limit takes precedence for the error response (e.g., if a per-tool limit is exceeded, the error references that tool's limit, not the global limit).

### Client Identification

Identifying "who" is making a request depends on the transport:

- **Streamable HTTP**: The `Mcp-Session-Id` header identifies a session. Each session corresponds to a single client. The session ID is assigned by the server during the `initialize` handshake and included by the client on all subsequent requests.
- **stdio**: There is exactly one client per server process (the process that spawned the server). All requests share a single implicit client identity. Per-client rate limiting in stdio mode applies to this single client.
- **Custom transports**: The `sessionId` field on the transport's `MessageExtraInfo` or the transport's `sessionId` property identifies the client.

For cases where the transport-provided identity is insufficient (e.g., a reverse proxy fronting multiple users through a single HTTP session), the rate limiter accepts a custom `keyExtractor` function that can derive a client key from any available request metadata.

### MCP Methods Subject to Rate Limiting

All JSON-RPC request methods can be rate-limited. The primary targets are:

| Method | Why Rate-Limit |
|---|---|
| `tools/call` | Tools execute arbitrary code. Each invocation may call external APIs, write to databases, or perform expensive computation. This is the highest-value rate limiting target. |
| `resources/read` | Resource reads may involve file I/O, database queries, or external data fetches. |
| `prompts/get` | Prompt retrieval may involve template expansion with external data. |
| `tools/list` | Repeated listing can be used to probe server capabilities or cause unnecessary work. |
| `resources/list` | Same as `tools/list`. |
| `prompts/list` | Same as `tools/list`. |
| `resources/templates/list` | Same as `tools/list`. |
| `completions/complete` | Completion requests may involve LLM calls. |
| `initialize` | Repeated initialization can be used to exhaust session resources. |
| `ping` | Excessive pings are a nuisance but rarely a real problem. |

The rate limiter does not intercept notifications (`notifications/*`) because notifications are fire-and-forget messages that do not expect a response. There is no way to "reject" a notification at the protocol level -- there is no response to send. Notification flooding is a transport-level concern.

---

## 5. API Design

### Installation

```bash
npm install mcp-rate-guard
```

### Peer Dependency

```json
{
  "peerDependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
```

### Main Export: `createRateLimiter`

The primary API is a factory function that wraps an existing MCP `Server` instance and returns a `RateLimiter` handle.

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
// ...

// On shutdown:
await limiter.close();
```

### Function Signature

```typescript
function createRateLimiter(
  server: Server,
  options: RateLimiterOptions,
): RateLimiter;
```

### `RateLimiterOptions`

```typescript
interface RateLimiterOptions {
  /**
   * Global rate limit applied to all requests from all clients.
   * If not provided, no global limit is enforced.
   */
  global?: RateLimitRule;

  /**
   * Per-method rate limits. Keys are MCP method names
   * (e.g., 'tools/call', 'resources/read').
   * If a method is not listed, it is not rate-limited at the method level
   * (global and per-client limits still apply).
   */
  methods?: Record<string, RateLimitRule>;

  /**
   * Per-tool rate limits for tools/call requests. Keys are tool names.
   * Only applies to requests where the method is 'tools/call' and the
   * tool name matches the key.
   * If a tool is not listed, it is not rate-limited at the tool level
   * (method-level and global limits still apply).
   */
  tools?: Record<string, RateLimitRule>;

  /**
   * Per-client rate limit applied to all requests from each individual client.
   * Client identity is determined by the transport's session ID or
   * the keyExtractor function.
   * If not provided, no per-client limit is enforced.
   */
  perClient?: RateLimitRule;

  /**
   * Per-client-per-method rate limits. Applied in addition to perClient.
   * Keys are MCP method names.
   */
  perClientMethods?: Record<string, RateLimitRule>;

  /**
   * Per-client-per-tool rate limits for tools/call requests.
   * Keys are tool names.
   */
  perClientTools?: Record<string, RateLimitRule>;

  /**
   * Custom function to extract a client identifier from a request.
   * Receives the JSON-RPC request and transport metadata.
   * Returns a string key identifying the client.
   *
   * If not provided, the client key is derived from the transport's
   * session ID. For stdio transports (which have no session ID),
   * a fixed key 'stdio' is used, meaning all requests are treated
   * as coming from the same client.
   *
   * Use this to implement custom client identification, e.g., extracting
   * a user ID from request metadata, using an API key from headers,
   * or deriving identity from the tool arguments.
   */
  keyExtractor?: (
    request: JSONRPCRequest,
    extra: RequestExtra,
  ) => string;

  /**
   * Storage backend for rate limit counters.
   * Defaults to an in-memory store.
   * Provide a custom implementation for distributed deployments (e.g., Redis).
   */
  store?: RateLimitStore;

  /**
   * MCP methods that are exempt from all rate limiting.
   * Defaults to [] (no exemptions).
   *
   * Common exemptions: ['ping', 'initialize'] -- these are protocol
   * housekeeping methods that should generally not be rate-limited.
   */
  exempt?: string[];

  /**
   * Whether to skip rate limiting during the initialization phase
   * (before the client has completed the initialize/initialized handshake).
   * Defaults to true.
   *
   * When true, the 'initialize' request and 'notifications/initialized'
   * notification are never rate-limited, regardless of other settings.
   */
  skipInitialization?: boolean;

  /**
   * JSON-RPC error code to use in rate limit error responses.
   * Defaults to -32029.
   *
   * The MCP specification does not define a standard rate limit error code.
   * -32029 is within the server-defined error range (-32000 to -32099)
   * and is used by convention in the MCP ecosystem.
   */
  errorCode?: number;

  /**
   * Custom error message template. The following placeholders are replaced:
   *   {method} - The MCP method name
   *   {tool} - The tool name (for tools/call requests, empty otherwise)
   *   {limit} - The max requests allowed
   *   {windowMs} - The window duration in milliseconds
   *   {retryAfter} - Seconds until the client can retry
   *
   * Defaults to: 'Rate limit exceeded for {method}. Try again in {retryAfter} seconds.'
   */
  errorMessage?: string;

  /**
   * Called when a request is rate-limited. Receives the request details
   * and the rate limit state. Useful for logging, metrics, and alerting.
   *
   * This callback is invoked synchronously in the message interception path.
   * Keep it fast. For async operations, fire and forget.
   */
  onRateLimited?: (event: RateLimitedEvent) => void;

  /**
   * Called when the rate limiter encounters an internal error
   * (e.g., store failure). The request is allowed through when the
   * store fails, following the fail-open principle.
   * Defaults to console.error.
   */
  onError?: (error: Error) => void;
}
```

### `RateLimitRule`

```typescript
interface RateLimitRule {
  /**
   * Maximum number of requests allowed within the time window.
   * Must be a positive integer.
   */
  max: number;

  /**
   * Time window duration in milliseconds.
   * Must be a positive integer.
   *
   * Common values:
   *   - 1_000 — 1 second
   *   - 10_000 — 10 seconds
   *   - 60_000 — 1 minute
   *   - 300_000 — 5 minutes
   *   - 3_600_000 — 1 hour
   */
  windowMs: number;
}
```

### `RateLimiter` Instance

```typescript
/**
 * Handle returned by createRateLimiter. Provides control over the
 * rate limiter lifecycle and access to state inspection.
 */
interface RateLimiter {
  /**
   * Stop the rate limiter and release resources.
   * After close(), no further rate limiting is performed.
   * Pending cleanup intervals are cleared.
   */
  close(): Promise<void>;

  /**
   * Whether the rate limiter is currently active (not closed).
   */
  readonly active: boolean;

  /**
   * Total number of requests that have been rate-limited (rejected)
   * since the limiter was created.
   */
  readonly rejectedCount: number;

  /**
   * Total number of requests that have been allowed through
   * since the limiter was created.
   */
  readonly allowedCount: number;

  /**
   * Get the current rate limit state for a specific key.
   * Returns the number of requests in the current window, the limit,
   * and the time until the window resets.
   *
   * Returns null if the key has no recorded requests.
   */
  getState(key: string): RateLimitState | null;

  /**
   * Reset all rate limit counters. Useful for testing or manual
   * intervention. Does not change the configuration.
   */
  reset(): Promise<void>;

  /**
   * Reset rate limit counters for a specific key.
   */
  resetKey(key: string): Promise<void>;

  /**
   * EventEmitter-style event subscription.
   */
  on(event: 'rateLimited', listener: (event: RateLimitedEvent) => void): void;
  on(event: 'requestAllowed', listener: (event: RequestAllowedEvent) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}
```

### `RateLimitState`

```typescript
interface RateLimitState {
  /** The rate limit key (e.g., 'method:tools/call', 'client:sess-001'). */
  key: string;

  /** Number of requests counted in the current sliding window. */
  current: number;

  /** Maximum requests allowed in the window. */
  limit: number;

  /** Window duration in milliseconds. */
  windowMs: number;

  /** Milliseconds remaining until the current window resets. */
  resetMs: number;

  /** Number of remaining requests allowed before hitting the limit. */
  remaining: number;
}
```

### Event Types

```typescript
interface RateLimitedEvent {
  /** ISO 8601 timestamp when the rate limit was triggered. */
  timestamp: string;

  /** The rate limit key that was exceeded. */
  key: string;

  /** The MCP method of the rejected request. */
  method: string;

  /** The tool name, if the method is 'tools/call'. Null otherwise. */
  toolName: string | null;

  /** The client identifier. */
  clientId: string;

  /** The JSON-RPC request ID. */
  requestId: string | number;

  /** The rate limit rule that was violated. */
  rule: RateLimitRule;

  /** Current request count in the sliding window. */
  currentCount: number;

  /** Seconds until the client can retry. */
  retryAfterSeconds: number;
}

interface RequestAllowedEvent {
  /** The MCP method of the allowed request. */
  method: string;

  /** The tool name, if the method is 'tools/call'. Null otherwise. */
  toolName: string | null;

  /** The client identifier. */
  clientId: string;

  /** The most restrictive remaining allowance across all applicable keys. */
  remaining: number;
}
```

### `RequestExtra` Type

```typescript
/**
 * Metadata available about the incoming request, derived from the
 * transport layer and the JSON-RPC message.
 */
interface RequestExtra {
  /** The transport's session ID, if available. */
  sessionId?: string;

  /** Additional transport-specific metadata. */
  transportInfo?: Record<string, unknown>;
}
```

### `RateLimitStore` Interface

```typescript
/**
 * Storage backend interface for rate limit counters.
 * Implement this interface to use an external store (e.g., Redis)
 * for distributed rate limiting.
 */
interface RateLimitStore {
  /**
   * Increment the counter for a key within a time window.
   * Returns the current count after incrementing.
   *
   * The store must handle window expiration internally. When a new
   * window begins (the previous window has fully expired), the counter
   * for the key resets to 1.
   *
   * @param key - The rate limit key.
   * @param windowMs - The window duration in milliseconds. The store
   *   uses this to determine when counters expire.
   * @returns An object containing the current count, the count from the
   *   previous window, and the timestamps for both windows.
   */
  increment(key: string, windowMs: number): Promise<WindowState>;

  /**
   * Get the current window state for a key without incrementing.
   * Returns null if the key has no recorded requests.
   */
  get(key: string, windowMs: number): Promise<WindowState | null>;

  /**
   * Reset the counter for a specific key.
   */
  reset(key: string): Promise<void>;

  /**
   * Reset all counters.
   */
  resetAll(): Promise<void>;

  /**
   * Close the store and release resources (e.g., database connections).
   */
  close(): Promise<void>;
}

interface WindowState {
  /** Request count in the current fixed window. */
  currentCount: number;

  /** Request count in the previous fixed window. */
  previousCount: number;

  /** Start timestamp (ms since epoch) of the current window. */
  currentWindowStart: number;

  /** Start timestamp (ms since epoch) of the previous window. */
  previousWindowStart: number;
}
```

---

## 6. Configuration

### Complete Default Configuration

The following shows every configuration option with its default value:

```typescript
const defaults: Required<RateLimiterOptions> = {
  global: undefined,          // no global limit
  methods: {},                // no per-method limits
  tools: {},                  // no per-tool limits
  perClient: undefined,       // no per-client limit
  perClientMethods: {},       // no per-client-method limits
  perClientTools: {},         // no per-client-tool limits
  keyExtractor: undefined,    // use transport session ID
  store: new MemoryStore(),   // in-memory storage
  exempt: [],                 // no exemptions
  skipInitialization: true,   // don't rate-limit initialize
  errorCode: -32029,          // JSON-RPC error code
  errorMessage: 'Rate limit exceeded for {method}. Try again in {retryAfter} seconds.',
  onRateLimited: undefined,   // no callback
  onError: (error) => console.error('[mcp-rate-guard]', error),
};
```

### Configuration Validation Rules

The following validation rules are enforced when `createRateLimiter` is called. Invalid configurations throw a synchronous `TypeError`.

| Rule | Condition |
|---|---|
| At least one limit is required | At least one of `global`, `methods`, `tools`, `perClient`, `perClientMethods`, or `perClientTools` must be configured |
| `max` must be a positive integer | Every `RateLimitRule.max` must be >= 1 and an integer |
| `windowMs` must be a positive integer | Every `RateLimitRule.windowMs` must be >= 1 and an integer |
| `exempt` must be an array of strings | Each element in `exempt` must be a non-empty string |
| `errorCode` must be a number | `errorCode` must be a finite number |
| `keyExtractor` must be a function if provided | `typeof keyExtractor === 'function'` |
| `store` must implement `RateLimitStore` if provided | Must have `increment`, `get`, `reset`, `resetAll`, and `close` methods |
| Tool-level limits reference valid names | Warning logged (not error) if a tool name in `tools` or `perClientTools` does not match any tool registered on the server at the time of creation; the limit is still installed since tools may be registered later |
| Method names must be valid MCP methods | Warning logged if a method name in `methods` or `perClientMethods` is not a recognized MCP method; the limit is still installed to support custom methods |

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
    // Extract API key from request metadata for client identification
    return extra.transportInfo?.apiKey as string ?? extra.sessionId ?? 'anonymous';
  },
});
```

---

## 7. Rate Limiting Algorithm

### Sliding Window Counter

`mcp-rate-guard` uses the sliding window counter algorithm as its sole rate limiting strategy. This is a deliberate choice -- the algorithm provides the best balance of accuracy, memory efficiency, and implementation simplicity for protocol-level rate limiting.

#### How It Works

Time is divided into fixed-size windows of duration `windowMs`. For each rate limit key, the store maintains two counters:

1. **Current window counter**: Number of requests in the current fixed window.
2. **Previous window counter**: Number of requests in the previous fixed window.

When a request arrives at time `t`:

1. Determine the current window: `currentWindowStart = floor(t / windowMs) * windowMs`.
2. Determine the previous window: `previousWindowStart = currentWindowStart - windowMs`.
3. Compute the overlap fraction: `overlap = 1 - ((t - currentWindowStart) / windowMs)`.
4. Compute the effective count: `effectiveCount = previousCount * overlap + currentCount`.
5. If `effectiveCount >= max`, the request is rejected.
6. Otherwise, increment `currentCount` and allow the request.

#### Example

Configuration: `{ max: 10, windowMs: 60_000 }` (10 requests per 60 seconds).

Window boundary at t=0s. At t=45s (75% through the current window):
- Previous window had 8 requests.
- Current window has 6 requests.
- Overlap fraction: `1 - (45/60) = 0.25`.
- Effective count: `8 * 0.25 + 6 = 8`.
- 8 < 10, so the request is allowed.

At t=45s, if the current window had 9 requests:
- Effective count: `8 * 0.25 + 9 = 11`.
- 11 >= 10, so the request is rejected.

#### Why Not Other Algorithms

| Algorithm | Why Not Used |
|---|---|
| **Fixed window** | Allows 2x burst at window boundaries. A client can make `max` requests at the end of one window and `max` at the start of the next, effectively doubling its rate. |
| **Token bucket** | More complex to implement correctly in distributed stores. Requires storing and updating floating-point token counts and last-refill timestamps atomically. Better suited for smoothing bursty traffic, but MCP tool calls are inherently bursty (an agent may call several tools in rapid succession as part of a single task). |
| **Leaky bucket** | Introduces queuing and delays, which violates the non-goal of never delaying allowed requests. Leaky bucket smooths output rate, which is a throttling pattern, not a rate limiting pattern. |
| **Exact sliding window (log)** | Stores the timestamp of every request within the window. Provides perfect accuracy but requires O(n) memory per key where n is the request count. For a key with 1000 requests per window, this is 8KB of timestamps. The counter approximation uses 32 bytes per key regardless of request volume. |

#### Accuracy

The sliding window counter provides an approximation. The maximum error is bounded: the effective count can undercount by at most `max / windowMs * resolution` where resolution is the granularity of time measurement (1ms in JavaScript). In practice, for typical MCP rate limits (10-100 requests per 60 seconds), the error is less than 0.1% and does not meaningfully affect rate limit enforcement.

#### Retry-After Calculation

When a request is rejected, the `retryAfter` value is computed as the number of seconds until enough previous-window requests have aged out of the sliding window to bring the effective count below the limit. This is an estimate -- actual retry timing depends on future request patterns. The value is always rounded up to the nearest second.

```
retryAfterMs = (currentWindowStart + windowMs) - now
retryAfterSeconds = ceil(retryAfterMs / 1000)
```

---

## 8. Protocol Integration

### Message Interception Strategy

The rate limiter intercepts messages by hooking into the MCP SDK `Server` instance at the transport level, using the same pattern established by `mcp-audit-log`. When `createRateLimiter` is called, it performs the following:

1. **Monkey-patches `server.connect()`**: The limiter wraps the server's `connect` method. When the server connects to a transport, the limiter intercepts the transport's message-passing interface to observe and gate all incoming JSON-RPC requests.

2. **Incoming message interception**: The limiter wraps the transport's `onmessage` callback. Before the server's Protocol layer dispatches an incoming message, the limiter checks whether it is a JSON-RPC request (has an `id` and a `method`). If it is, the limiter evaluates all applicable rate limit rules. If any rule is exceeded, the limiter sends a JSON-RPC error response directly via the transport's `send()` method and suppresses the message (does not call the original `onmessage`). If all rules pass, the limiter calls the original `onmessage`, allowing normal dispatch.

3. **Notifications are not intercepted**: JSON-RPC notifications (messages without an `id`) pass through without rate limit checks. Notifications are fire-and-forget; there is no mechanism to "reject" a notification at the JSON-RPC level.

4. **Responses are not intercepted**: Outgoing responses from the server are not rate-limited. The limiter only wraps the transport's `onmessage` (incoming direction), not `send()` (outgoing direction).

### Interception Flow

```
Transport receives JSON-RPC message
  |
  v
mcp-rate-guard onmessage wrapper
  |
  +-- Is it a JSON-RPC request (has 'id' and 'method')?
  |     |
  |     +-- No: Pass through to original onmessage (notification or response)
  |     |
  |     +-- Yes: Is the method exempt?
  |           |
  |           +-- Yes: Pass through to original onmessage
  |           |
  |           +-- No: Is skipInitialization true and method is 'initialize'?
  |                 |
  |                 +-- Yes: Pass through to original onmessage
  |                 |
  |                 +-- No: Extract client key and tool name
  |                       |
  |                       +-- Check all applicable rate limit rules
  |                             |
  |                             +-- All pass: Increment counters, pass through
  |                             |
  |                             +-- Any exceeded: Send JSON-RPC error response,
  |                                               suppress message, emit event
```

### Handling Multiple Transports

The MCP SDK's `Server` class supports connecting to multiple transports (e.g., a server that accepts both stdio and HTTP connections simultaneously). The rate limiter wraps `server.connect()`, so each transport connection gets its own interception wrapper. Rate limit counters are shared across all transports via the single `RateLimitStore` instance, ensuring that limits are enforced consistently regardless of which transport a client uses.

### Integration with McpServer (High-Level API)

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

// Access the underlying Server instance for rate limiting
const limiter = createRateLimiter(mcpServer.server, {
  methods: { 'tools/call': { max: 30, windowMs: 60_000 } },
});

// Connect to transport as normal
```

### Ordering with Other Middleware

If the server is also wrapped with `mcp-audit-log` or other middleware that intercepts transport messages, the order of wrapping matters. Middleware applied first is closest to the transport (outermost layer); middleware applied last is closest to the server's handlers (innermost layer).

**Recommended order**:

```typescript
// 1. Create the server
const server = new Server(/* ... */);

// 2. Register handlers
server.setRequestHandler(/* ... */);

// 3. Apply rate limiting (outermost -- rejects before audit logging)
const limiter = createRateLimiter(server, { /* ... */ });

// 4. Apply audit logging (inner -- only logs requests that passed rate limiting)
const logger = createAuditLogger(server, { /* ... */ });

// 5. Connect to transport
await server.connect(transport);
```

This order ensures that rate-limited requests are rejected before the audit logger records them, reducing audit log noise. If you want to audit rate-limited requests (for security monitoring), reverse the order so the audit logger is outermost.

---

## 9. Client Identification

### Transport-Based Identification

Client identification is derived from the transport layer by default:

#### Streamable HTTP

The `Mcp-Session-Id` header uniquely identifies each client session. The session ID is assigned by the server during the `initialize` handshake and must be included by the client on all subsequent requests. The rate limiter reads the `sessionId` from the transport's metadata or from the `MessageExtraInfo` passed to the `onmessage` callback.

Multiple clients connecting to the same HTTP server receive different session IDs and are rate-limited independently.

#### stdio

In stdio mode, there is exactly one client: the process that spawned the server. The rate limiter uses a fixed key (`'stdio'`) for this single client. Per-client rate limiting in stdio mode is functionally equivalent to global rate limiting, since there is only one client.

#### Custom Transports

Custom transports that implement the MCP `Transport` interface may or may not provide a `sessionId`. If the transport provides a `sessionId`, it is used. If not, the limiter falls back to `'unknown'` as the client key.

### Custom Key Extraction

For advanced client identification, provide a `keyExtractor` function:

```typescript
const limiter = createRateLimiter(server, {
  perClient: { max: 50, windowMs: 60_000 },
  keyExtractor: (request, extra) => {
    // Option 1: Use a custom header passed through transport metadata
    const apiKey = extra.transportInfo?.headers?.['x-api-key'];
    if (apiKey) return `apikey:${apiKey}`;

    // Option 2: Use the session ID
    if (extra.sessionId) return `session:${extra.sessionId}`;

    // Option 3: Fallback
    return 'anonymous';
  },
});
```

The `keyExtractor` is called synchronously for every request. It must be fast (no I/O, no async operations). If the extractor throws, the error is caught, reported via `onError`, and the request is allowed through (fail-open).

### Key Stability

Client keys must be stable across requests from the same client. If the `keyExtractor` returns different keys for the same logical client, rate limits are split across those keys and the effective limit is multiplied. Conversely, if different clients share a key, they share a rate limit pool.

---

## 10. Error Handling

### Rate Limit Error Response

When a request is rate-limited, the limiter sends a JSON-RPC error response directly to the client via the transport. The response format is:

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

#### Error Fields

| Field | Type | Description |
|---|---|---|
| `code` | `number` | JSON-RPC error code. Defaults to `-32029`. Configurable via `errorCode`. |
| `message` | `string` | Human-readable error message. Configurable via `errorMessage` template. |
| `data.retryAfter` | `number` | Seconds until the client can retry (rounded up to nearest second). |
| `data.limit` | `number` | The maximum requests allowed in the window. |
| `data.windowMs` | `number` | The window duration in milliseconds. |
| `data.key` | `string` | The rate limit key that was exceeded. |
| `data.remaining` | `number` | Always 0 when rate-limited. |
| `data.resetMs` | `number` | Milliseconds until the current window resets. |

#### Error Code Rationale

The MCP specification does not define a standard rate limit error code. The JSON-RPC 2.0 specification reserves codes `-32000` to `-32099` for "server-defined errors." The code `-32029` is chosen by convention within the MCP ecosystem. It is within the reserved server error range and does not conflict with any standard JSON-RPC or MCP-defined error codes (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`, `-32002`).

### Fail-Open Principle

When the rate limiter's storage backend fails (e.g., Redis is unreachable, the in-memory store throws an unexpected error), the request is allowed through. The rationale is that a broken rate limiter should not prevent legitimate traffic from being served. The error is reported via the `onError` callback for alerting and investigation.

```
Storage error during rate limit check
  |
  +-- Call onError(error)
  |
  +-- Allow the request through (fail-open)
  |
  +-- Do NOT increment counters (they may be corrupted)
```

### Graceful Degradation

| Failure Mode | Behavior |
|---|---|
| Store `increment()` throws or rejects | Request allowed through. `onError` called. |
| Store `get()` throws or rejects | State inspection returns null. `onError` called. |
| `keyExtractor` throws | Request allowed through with fallback key. `onError` called. |
| Transport `send()` fails when sending error response | The rate-limited request may reach the server handler. `onError` called. |
| Server has no tools registered matching a `tools` key | Warning at creation time. Limit is still installed. |

### Interaction with Server Error Handling

Rate limit error responses are sent directly via the transport's `send()` method, bypassing the server's Protocol layer entirely. The server never sees the rate-limited request. Its handler is not invoked, and no server-side error handling is triggered. The rate limit response is a complete, valid JSON-RPC error response that the client handles like any other error.

---

## 11. Metrics and Observability

### Counters

The `RateLimiter` instance exposes two counters:

- `rejectedCount` -- total requests rejected since creation. Monotonically increasing.
- `allowedCount` -- total requests allowed since creation. Monotonically increasing.

These counters are in-memory and reset when the process restarts.

### Events

The `RateLimiter` emits two event types via Node.js `EventEmitter`:

#### `rateLimited` Event

Emitted every time a request is rejected. The event payload is the `RateLimitedEvent` object described in Section 5. This event is also delivered to the `onRateLimited` callback if configured.

```typescript
limiter.on('rateLimited', (event) => {
  metrics.increment('mcp.rate_limited', {
    method: event.method,
    tool: event.toolName ?? 'none',
    client: event.clientId,
    key: event.key,
  });
});
```

#### `requestAllowed` Event

Emitted for every request that passes rate limit checks. The event payload is the `RequestAllowedEvent` object. This event is opt-in and carries performance overhead (one event per request). It is useful for monitoring dashboards that need to show allowed vs. rejected request ratios.

**Note**: The `requestAllowed` event is only emitted if there is at least one listener registered for it. If no listener is registered, the event construction and emission are skipped entirely to avoid overhead on the hot path.

### State Inspection

The `getState(key)` method returns a `RateLimitState` snapshot for any rate limit key. This enables health check endpoints and dashboard integrations:

```typescript
// Check if a specific tool is near its limit
const state = limiter.getState('tool:delete_file');
if (state && state.remaining < 3) {
  console.warn(`delete_file tool is near rate limit: ${state.remaining} remaining`);
}
```

### Integration with Monitoring Systems

The event-based API is designed to integrate with any monitoring system:

```typescript
// Prometheus-style metrics
limiter.on('rateLimited', (event) => {
  rateLimitedCounter.inc({ method: event.method, client: event.clientId });
});

// Structured logging
limiter.on('rateLimited', (event) => {
  logger.warn({ event }, 'MCP request rate-limited');
});

// Alerting
limiter.on('rateLimited', (event) => {
  if (event.method === 'tools/call' && event.toolName === 'delete_file') {
    alerting.trigger('high-risk-tool-rate-limited', event);
  }
});
```

---

## 12. Storage Backends

### Built-In: MemoryStore

The default storage backend stores counters in a JavaScript `Map` within the Node.js process. It requires no external dependencies and is suitable for single-process deployments.

```typescript
class MemoryStore implements RateLimitStore {
  private windows: Map<string, { current: number; previous: number; currentStart: number; previousStart: number }>;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(options?: { cleanupIntervalMs?: number });

  increment(key: string, windowMs: number): Promise<WindowState>;
  get(key: string, windowMs: number): Promise<WindowState | null>;
  reset(key: string): Promise<void>;
  resetAll(): Promise<void>;
  close(): Promise<void>;
}
```

#### Memory Management

The `MemoryStore` periodically cleans up expired entries to prevent unbounded memory growth. The cleanup interval defaults to 60 seconds and is configurable via `cleanupIntervalMs`. An entry is considered expired when the current time is past the end of its current window (i.e., both the current and previous windows have fully elapsed, so the entry cannot affect any future sliding window calculation).

The cleanup timer uses `unref()` so it does not prevent the Node.js process from exiting.

#### Memory Footprint

Each rate limit key consumes approximately 100 bytes in the `MemoryStore` (key string + two counters + two timestamps + Map overhead). For a deployment with 100 concurrent clients, 10 methods, and 20 tools, the maximum number of active keys is:

- Global: 1
- Per-method: 10
- Per-tool: 20
- Per-client: 100
- Per-client-method: 100 * 10 = 1000
- Per-client-tool: 100 * 20 = 2000

Total: 3131 keys * 100 bytes = ~313 KB. This is negligible for any deployment.

### Custom Store: Redis Example

For distributed deployments where multiple server processes share rate limits, implement the `RateLimitStore` interface with a Redis backend:

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
    pipeline.pexpire(currentKey, windowMs * 2); // Expire after 2 windows
    pipeline.get(previousKey);

    const results = await pipeline.exec();
    const currentCount = results![0][1] as number;
    const previousCount = parseInt(results![2][1] as string || '0', 10);

    return {
      currentCount,
      previousCount,
      currentWindowStart,
      previousWindowStart,
    };
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
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  async resetAll(): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

// Usage
const limiter = createRateLimiter(server, {
  store: new RedisStore(process.env.REDIS_URL!),
  perClient: { max: 100, windowMs: 60_000 },
});
```

### Store Contract Requirements

Custom store implementations must satisfy these requirements:

1. **Atomicity**: `increment()` must atomically read and increment the counter. Two concurrent calls to `increment()` for the same key must not lose counts. For Redis, use `INCR` (atomic). For databases, use transactions or atomic updates.
2. **Expiration**: Counters for expired windows must eventually be cleaned up. Memory leaks from accumulated expired keys are a bug. For Redis, use `PEXPIRE`. For in-memory stores, use periodic cleanup.
3. **Monotonicity**: `currentCount` returned by `increment()` must be monotonically increasing within a window (it never decreases unless `reset()` is called).
4. **Fast path**: `increment()` is called on every non-exempt request. It must complete in under 1ms for the in-memory store and under 5ms for network-based stores.
5. **Fail-safe close**: `close()` must not throw. If the underlying connection is already closed, `close()` should be a no-op.

---

## 13. Architecture

### Internal Components

```
createRateLimiter(server, options)
  |
  +-- ConfigValidator          Validates options, applies defaults
  |
  +-- ServerWrapper            Monkey-patches server.connect()
  |     |
  |     +-- TransportInterceptor   Wraps transport.onmessage per connection
  |           |
  |           +-- RequestClassifier    Determines if message is a request,
  |           |                        extracts method, tool name, client key
  |           |
  |           +-- RuleEvaluator        Finds all applicable rules for a request,
  |           |                        checks each against the store
  |           |
  |           +-- ErrorResponder       Constructs and sends JSON-RPC error responses
  |
  +-- SlidingWindowChecker     Computes effective count from WindowState
  |
  +-- MemoryStore              Default in-memory RateLimitStore implementation
  |     |
  |     +-- CleanupTimer       Periodically prunes expired entries
  |
  +-- EventBus                 Emits rateLimited and requestAllowed events
```

### Request Processing Flow

When a JSON-RPC message arrives at the transport:

```
1. Transport.onmessage(message, extra)
   |
2. TransportInterceptor receives message
   |
3. Is it a JSON-RPC request? (has 'id' field and 'method' field)
   |-- No  --> Forward to original onmessage (unmodified)
   |-- Yes --> Continue
   |
4. Is the method in the exempt list?
   |-- Yes --> Forward to original onmessage
   |-- No  --> Continue
   |
5. Is skipInitialization=true and method='initialize'?
   |-- Yes --> Forward to original onmessage
   |-- No  --> Continue
   |
6. RequestClassifier extracts:
   |   - method: string (e.g., 'tools/call')
   |   - toolName: string | null (e.g., 'delete_file')
   |   - clientId: string (from keyExtractor or session ID)
   |
7. RuleEvaluator collects all applicable rules:
   |   - global (if configured)
   |   - methods[method] (if configured)
   |   - tools[toolName] (if method='tools/call' and configured)
   |   - perClient (if configured)
   |   - perClientMethods[method] (if configured)
   |   - perClientTools[toolName] (if method='tools/call' and configured)
   |
8. For each applicable rule:
   |   a. Compute the rate limit key
   |   b. Call store.increment(key, rule.windowMs)
   |   c. Compute effectiveCount from WindowState
   |   d. If effectiveCount > rule.max:
   |      - Record the violation (most specific rule wins for error message)
   |      - Do NOT check remaining rules (short-circuit)
   |
9. If any rule was violated:
   |   a. Construct JSON-RPC error response
   |   b. Send via transport.send()
   |   c. Emit 'rateLimited' event
   |   d. Increment rejectedCount
   |   e. Do NOT forward to original onmessage
   |
10. If all rules pass:
    |   a. Forward to original onmessage
    |   b. Emit 'requestAllowed' event (if listeners exist)
    |   c. Increment allowedCount
```

### Rule Evaluation Order

When multiple rules apply to a single request, they are evaluated in this order:

1. **Global** -- checked first because it is the broadest limit.
2. **Per-method** -- checked second.
3. **Per-tool** -- checked third (only for `tools/call`).
4. **Per-client** -- checked fourth.
5. **Per-client-method** -- checked fifth.
6. **Per-client-tool** -- checked sixth (only for `tools/call`).

Evaluation short-circuits on the first violation. If the global limit is exceeded, per-method and per-tool limits are not checked (but their counters are not incremented either, since the request is rejected). This means that when a global limit rejects a request, the per-method and per-tool counters remain accurate.

**Counter increment strategy**: Counters are incremented optimistically before checking the limit. If a later rule in the chain rejects the request, the earlier counters have already been incremented. This is intentional -- it provides a conservative (stricter) rate limit. The alternative (checking all rules before incrementing any counter) would require either multi-key atomic operations (complex in distributed stores) or a two-phase protocol (slow). The conservative approach is simpler and safer.

### Tool Name Extraction

For `tools/call` requests, the tool name is extracted from the JSON-RPC request params:

```typescript
// JSON-RPC request for tools/call:
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "tools/call",
  "params": {
    "name": "get_weather",        // <-- tool name
    "arguments": { "location": "NYC" }
  }
}
```

The tool name is read from `request.params.name`. If `params` or `params.name` is missing (malformed request), the tool name is treated as `null` and per-tool rate limits do not apply (the request may still be rejected by method-level or global limits).

### Graceful Shutdown

When `limiter.close()` is called:

1. The `active` flag is set to `false`.
2. The cleanup timer (in `MemoryStore`) is cleared.
3. The store's `close()` method is called.
4. The transport interception wrappers remain in place but become pass-through (they check `active` and skip rate limiting if false).
5. Event listeners are not removed (the caller can remove them explicitly if needed).

After `close()`, all requests pass through unimpeded. The server continues operating normally without rate limiting.

---

## 14. Testing Strategy

### Unit Tests

Unit tests cover each internal component in isolation with mock dependencies.

**ConfigValidator tests:**
- Valid minimal configuration (single global rule) is accepted.
- Missing all rules throws `TypeError`.
- `max: 0` throws `TypeError`.
- `max: -1` throws `TypeError`.
- `max: 1.5` (non-integer) throws `TypeError`.
- `windowMs: 0` throws `TypeError`.
- `exempt` with empty string element throws `TypeError`.
- Invalid `keyExtractor` (non-function) throws `TypeError`.
- Invalid `store` (missing required methods) throws `TypeError`.
- Unrecognized method names in `methods` produce a warning but do not throw.

**SlidingWindowChecker tests:**
- Request at the start of a window with empty previous window: effectiveCount = 1.
- Request at the end of a window: previous window contributes minimally.
- Request exactly at window boundary: previous window overlap is 1.0 (full contribution).
- Effective count exceeding max returns `{ allowed: false, retryAfterMs: ... }`.
- Effective count at exactly max returns `{ allowed: false }` (limit is `>=`, not `>`).
- Effective count at max-1 returns `{ allowed: true, remaining: 1 }`.

**RequestClassifier tests:**
- `tools/call` request extracts method and tool name.
- `resources/read` request extracts method, tool name is null.
- `ping` request extracts method, tool name is null.
- Malformed request (no params) extracts method, tool name is null.
- Custom `keyExtractor` is called with request and extra.
- Default key extraction uses session ID.
- Default key extraction uses `'stdio'` when session ID is absent.

**RuleEvaluator tests:**
- Request matching only global rule: only global rule checked.
- Request matching global + per-method: both checked in order.
- `tools/call` for a tool with a per-tool rule: global + method + tool checked.
- Per-client rules create client-scoped keys.
- Exempt method bypasses all rules.
- `skipInitialization` bypasses `initialize` method.

**ErrorResponder tests:**
- Constructs valid JSON-RPC error with correct `id`, `code`, `message`, and `data`.
- Custom `errorMessage` template replaces `{method}`, `{tool}`, `{limit}`, `{windowMs}`, `{retryAfter}`.
- Custom `errorCode` is used in the response.
- `retryAfter` is always a positive integer (rounded up).

**MemoryStore tests:**
- `increment()` returns count of 1 for first request.
- `increment()` returns incrementing counts for successive requests in same window.
- Counts reset when the window advances.
- Previous window count is preserved and returned.
- `reset(key)` clears a specific key.
- `resetAll()` clears all keys.
- Cleanup timer removes expired entries.
- `close()` clears the cleanup timer.
- Concurrent increments do not lose counts (Promise.all with multiple increments).

### Integration Tests

Integration tests use a real MCP `Server` instance with in-memory transport.

**End-to-end rate limiting test:**
- Create a Server with a tool handler.
- Wrap with `createRateLimiter` with `methods: { 'tools/call': { max: 3, windowMs: 60_000 } }`.
- Connect a Client to the Server.
- Make 3 `tools/call` requests -- all succeed.
- Make a 4th `tools/call` request -- receives JSON-RPC error with code `-32029`.
- Verify the error `data` contains `retryAfter`, `limit`, and `windowMs`.
- Make a `tools/list` request -- succeeds (not rate-limited by method-specific rule).

**Per-tool rate limiting test:**
- Configure `tools: { 'tool_a': { max: 2, windowMs: 60_000 } }`.
- Call `tool_a` twice -- succeeds.
- Call `tool_a` a third time -- rate-limited.
- Call `tool_b` -- succeeds (not limited by tool_a's rule).

**Per-client rate limiting test:**
- Configure `perClient: { max: 5, windowMs: 60_000 }`.
- Connect two clients (two separate transports with different session IDs).
- Client A makes 5 requests -- all succeed.
- Client A makes a 6th request -- rate-limited.
- Client B makes 5 requests -- all succeed (independent limit).

**Exempt method test:**
- Configure `exempt: ['ping']` and `global: { max: 1, windowMs: 60_000 }`.
- Make 1 request -- succeeds and consumes the global limit.
- Make a `ping` request -- succeeds (exempt).
- Make another non-exempt request -- rate-limited.

**Skip initialization test:**
- Configure `global: { max: 1, windowMs: 60_000 }` and `skipInitialization: true`.
- Client connects and initializes -- `initialize` is not rate-limited.
- Client makes 1 request -- succeeds.
- Client makes another request -- rate-limited.

**Fail-open test:**
- Provide a custom store whose `increment()` rejects with an error.
- Make a request -- succeeds (fail-open).
- Verify `onError` was called.

**Event emission test:**
- Register listeners for `rateLimited` and `requestAllowed`.
- Make requests that are allowed and rate-limited.
- Verify events are emitted with correct payloads.

**Multiple middleware test:**
- Wrap server with both `createRateLimiter` and `createAuditLogger`.
- Make requests that pass rate limiting -- verify they are audit-logged.
- Make requests that are rate-limited -- verify they are NOT audit-logged (if rate limiter is outermost).

### Edge Cases to Test

- Request with missing `params.name` for `tools/call` -- tool-level rules do not apply.
- Request with `id: 0` (valid JSON-RPC ID) -- rate limit error response uses `id: 0`.
- Request with string `id` -- rate limit error response uses the string ID.
- `windowMs: 1` (1ms window) -- window advances almost immediately; requests are rarely limited.
- `max: 1` -- strict limit; second request in window is always rejected.
- Concurrent requests (Promise.all) -- all counters are incremented correctly.
- `close()` followed by requests -- requests pass through without rate limiting.
- `reset()` mid-operation -- counters are cleared; requests are allowed again.
- Large number of unique client keys (10,000+) -- memory store handles without issues.
- Clock time at exact window boundary -- correct window is selected.

### Test Framework

Tests use Vitest, matching the project's existing configuration. Mock MCP servers for integration tests are created using the `@modelcontextprotocol/sdk`'s `Server` class with in-memory transports.

---

## 15. Edge Cases and Failure Modes

### Clock Skew

The sliding window algorithm depends on `Date.now()` for time measurement. Clock skew (e.g., NTP adjustments, VM clock drift) can cause unexpected behavior:

- **Clock jumps forward**: The current window advances, effectively resetting counters for the jumped period. Some requests that should have been rate-limited may be allowed.
- **Clock jumps backward**: The current window regresses, potentially double-counting requests that were already counted in a later window.

**Mitigation**: Use `performance.now()` for relative time measurement within a process. However, `performance.now()` is not suitable for distributed stores (it is process-local). For distributed deployments, rely on the store's time source (e.g., Redis `TIME` command). The in-memory store uses `Date.now()` and is susceptible to clock skew, but in practice, NTP adjustments are small (sub-second) and do not meaningfully affect rate limiting at typical window sizes (10+ seconds).

### Store Unavailability

If the store is temporarily unavailable (e.g., Redis is restarting), the fail-open behavior allows all requests through. When the store comes back, counters resume from zero (previous counts are lost). This means a burst of previously blocked requests may be allowed during the recovery period.

**Mitigation**: The `onError` callback should trigger alerts. In critical deployments, consider a circuit breaker pattern in the custom store implementation that switches to a local in-memory fallback during outages.

### Hot Keys

If a single rate limit key receives disproportionately high traffic (e.g., a popular tool called by many clients), the store's performance for that key is critical. The in-memory store handles this trivially (Map lookup is O(1)). Redis-based stores should use pipelining and avoid `KEYS` or `SCAN` on hot paths.

### Memory Leaks

The in-memory store's cleanup timer prevents unbounded memory growth from accumulated expired entries. However, if the cleanup interval is much longer than the window size (e.g., cleanup every 60 seconds with 1-second windows), there can be temporary memory accumulation. The default cleanup interval of 60 seconds is suitable for window sizes of 10 seconds or more.

### Race Conditions in Distributed Stores

In a distributed deployment with multiple server processes sharing a Redis-based store, two processes may concurrently `increment()` the same key. Redis `INCR` is atomic, so the count is correct. However, the effective count computation (combining current and previous window counts) is performed client-side and may see slightly stale data. This can result in a request being allowed that should have been rejected, or vice versa, by at most 1 request. This is an acceptable tradeoff for the simplicity of the sliding window counter algorithm.

### Notification Flooding

The rate limiter does not intercept notifications. A malicious or buggy client can flood the server with notifications (e.g., `notifications/cancelled` or `notifications/roots/list_changed`) without being rate-limited. This is a deliberate design choice -- notifications have no response mechanism, so there is no way to "reject" them at the JSON-RPC level. Notification flooding must be handled at the transport level (e.g., connection-level rate limiting, firewall rules).

### Server Restart

When the server process restarts, all in-memory rate limit counters are lost. Clients that were near their limits can immediately resume at full rate. For distributed stores, counters survive process restarts (assuming the store itself is persistent).

---

## 16. Performance

### Hot Path Overhead

The rate limiter's hot path (the code executed on every non-exempt request) consists of:

1. **Message type check**: One `typeof` check and one property access (~1 microsecond).
2. **Exempt list check**: Array `includes()` check. For a typical exempt list of 1-3 methods, this is a constant-time operation (~1 microsecond).
3. **Request classification**: Property access for method name and tool name (~1 microsecond).
4. **Key extraction**: Default key extractor is a property access. Custom extractors vary (~1-10 microseconds).
5. **Store increment**: In-memory store performs a Map lookup, integer comparison, and increment (~5 microseconds). Redis store performs a network round-trip (~0.5-5 milliseconds).
6. **Sliding window computation**: Two multiplications, one addition, one comparison (~1 microsecond).
7. **Event emission**: Only if listeners are registered. Event object construction (~5 microseconds).

**Total hot-path overhead (in-memory store)**: approximately 10-20 microseconds per request. This is well below the threshold of human perception and negligible compared to typical tool execution times (milliseconds to seconds).

**Total hot-path overhead (Redis store)**: approximately 1-5 milliseconds per request, dominated by the network round-trip to Redis. This is acceptable for most deployments but should be considered when configuring rate limits on latency-sensitive tools.

### Rejection Path Overhead

When a request is rate-limited, the rejection path adds:

1. **Error response construction**: JSON object creation and `JSON.stringify` (~10-50 microseconds).
2. **Transport send**: Depends on transport type. Stdio writes are fast (~10 microseconds). HTTP responses are fast (~100 microseconds).
3. **Event emission**: Same as hot path (~5 microseconds).

**Total rejection overhead**: approximately 25-200 microseconds. This is faster than invoking the server's handler, which is the expected behavior (rejecting early saves work).

### Memory Usage

- **MemoryStore**: ~100 bytes per active key. See Section 12 for the calculation.
- **Event listeners**: Each `rateLimited` or `requestAllowed` event allocates a small event object (~200 bytes) that is garbage-collected after all listeners process it.
- **Configuration**: The `RateLimiterOptions` object is stored once and is typically under 1 KB.
- **Transport wrappers**: One closure per connected transport. Negligible memory.

### Benchmarks to Target

| Scenario | Target |
|---|---|
| In-memory store, allowed request | < 20 microseconds added latency |
| In-memory store, rejected request | < 50 microseconds total (check + error response) |
| 10,000 unique keys in MemoryStore | < 2 MB memory |
| 100,000 requests/second throughput (in-memory) | No dropped requests, no missed rate limits |
| Cleanup cycle for 10,000 expired keys | < 10 milliseconds |

---

## 17. Dependencies

### Runtime Dependencies

None. The package uses only Node.js built-in modules:

| Module | Purpose |
|---|---|
| `node:events` | `EventEmitter` for `rateLimited` and `requestAllowed` events |
| `node:crypto` | `randomUUID()` for generating internal identifiers (if needed) |

### Peer Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.12.0` | Provides the `Server` class, `Transport` interface, and JSON-RPC message types that are wrapped |

### Development Dependencies

| Package | Version | Purpose |
|---|---|---|
| `typescript` | `^5.5.0` | Type checking and compilation |
| `vitest` | `^2.0.0` | Test runner |
| `eslint` | `^9.0.0` | Linting |
| `@modelcontextprotocol/sdk` | `^1.12.0` | Used in integration tests to create real Server and Client instances |

### Dependency Philosophy

Zero runtime dependencies beyond Node.js built-ins. This is a deliberate choice:

- **Rate limiters must be reliable and fast.** External dependencies add startup time, potential supply-chain risk, and version conflict surface. A rate limiter that fails to load because of a transitive dependency conflict defeats its entire purpose.
- **The algorithm is simple.** The sliding window counter requires two integers, two timestamps, and basic arithmetic. No library is needed.
- **The MCP SDK peer dependency is unavoidable.** The primary integration pattern wraps the SDK's `Server` class. Making it a peer dependency ensures the user controls the SDK version and avoids duplicate installations.

---

## 18. File Structure

```
mcp-rate-guard/
  package.json
  tsconfig.json
  SPEC.md
  README.md
  src/
    index.ts                  Main entry point. Exports createRateLimiter and all types.
    create-rate-limiter.ts    Factory function. Validates config, wraps server, returns handle.
    config-validator.ts       Validates RateLimiterOptions, applies defaults, emits warnings.
    transport-interceptor.ts  Wraps transport.onmessage for each server.connect() call.
    request-classifier.ts     Extracts method, tool name, and client key from JSON-RPC messages.
    rule-evaluator.ts         Collects applicable rules for a request, checks each against store.
    sliding-window.ts         Computes effective count from WindowState, determines allow/reject.
    error-responder.ts        Constructs JSON-RPC error response objects for rate-limited requests.
    memory-store.ts           Built-in in-memory RateLimitStore implementation.
    types.ts                  All TypeScript interfaces and type definitions.
  src/__tests__/
    config-validator.test.ts
    transport-interceptor.test.ts
    request-classifier.test.ts
    rule-evaluator.test.ts
    sliding-window.test.ts
    error-responder.test.ts
    memory-store.test.ts
    integration.test.ts       End-to-end tests with real MCP Server and Client.
```

---

## 19. Implementation Roadmap

### Phase 1: Core (v0.1.0)

Deliver the minimum viable rate limiter.

- `createRateLimiter(server, options)` factory function.
- `RateLimiterOptions` with `global`, `methods`, `tools`, and `exempt` configuration.
- Sliding window counter algorithm.
- `MemoryStore` as default and only storage backend.
- JSON-RPC error response construction with `-32029` error code.
- Transport interception via `server.connect()` monkey-patching.
- `RateLimiter` handle with `close()`, `active`, `rejectedCount`, `allowedCount`.
- Full unit and integration test suite.
- README with usage examples.

### Phase 2: Per-Client and Events (v0.2.0)

Add client-aware rate limiting and observability.

- `perClient`, `perClientMethods`, and `perClientTools` configuration.
- Client identification from transport session ID.
- Custom `keyExtractor` function.
- `skipInitialization` option.
- `RateLimitedEvent` and `RequestAllowedEvent` types.
- `on()` / `off()` event subscription on `RateLimiter`.
- `onRateLimited` callback in options.
- `getState(key)` for state inspection.
- `reset()` and `resetKey()` methods.

### Phase 3: Pluggable Storage and Polish (v0.3.0)

Add support for distributed deployments and production hardening.

- `RateLimitStore` interface as public API.
- `store` option in `RateLimiterOptions`.
- Redis store example in documentation (not bundled -- users bring their own Redis client).
- Custom `errorCode` and `errorMessage` options.
- `onError` callback with fail-open behavior.
- `cleanupIntervalMs` option for `MemoryStore`.
- Performance benchmarks and optimization.
- Comprehensive edge case tests (clock skew, concurrent access, store failures).

---

## 20. Example Use Cases

### Example 1: Basic Tool Rate Limiting

Protect a tool that calls an external API with its own rate limits.

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRateLimiter } from 'mcp-rate-guard';

const server = new Server(
  { name: 'api-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'search_web') {
    const result = await callExternalSearchAPI(request.params.arguments);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

// The external API allows 10 requests per minute.
// Set a slightly stricter limit to leave headroom.
const limiter = createRateLimiter(server, {
  tools: {
    'search_web': { max: 8, windowMs: 60_000 },
  },
  exempt: ['ping'],
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.on('SIGTERM', async () => {
  await limiter.close();
  await server.close();
});
```

When a client exceeds the limit:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32029,
    "message": "Rate limit exceeded for tools/call. Try again in 12 seconds.",
    "data": {
      "retryAfter": 12,
      "limit": 8,
      "windowMs": 60000,
      "key": "tool:search_web",
      "remaining": 0,
      "resetMs": 11482
    }
  }
}
```

### Example 2: Multi-Tenant HTTP Server

A shared MCP server that enforces per-client limits.

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createRateLimiter } from 'mcp-rate-guard';

const server = new Server(
  { name: 'shared-server', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);

// Register handlers...

const limiter = createRateLimiter(server, {
  // Each client gets 100 requests per minute
  perClient: { max: 100, windowMs: 60_000 },

  // Per-client tool calls are limited more strictly
  perClientMethods: {
    'tools/call': { max: 30, windowMs: 60_000 },
  },

  // Dangerous tools have per-client limits
  perClientTools: {
    'delete_record': { max: 5, windowMs: 300_000 },
    'execute_sql': { max: 10, windowMs: 60_000 },
  },

  // Global ceiling to prevent aggregate overload
  global: { max: 1000, windowMs: 60_000 },

  // Log rate-limited requests for monitoring
  onRateLimited: (event) => {
    console.warn(
      `Rate limited: client=${event.clientId} method=${event.method} ` +
      `tool=${event.toolName} key=${event.key} retryAfter=${event.retryAfterSeconds}s`,
    );
  },
});
```

### Example 3: Distributed Rate Limiting with Redis

Multiple server processes sharing rate limits via Redis.

```typescript
import { createRateLimiter } from 'mcp-rate-guard';
import { RedisStore } from './redis-store.js'; // User-implemented

const limiter = createRateLimiter(server, {
  store: new RedisStore(process.env.REDIS_URL!, 'mcp-rl:prod:'),
  perClient: { max: 50, windowMs: 60_000 },
  methods: {
    'tools/call': { max: 200, windowMs: 60_000 },
  },
  onError: (error) => {
    // Alert on store failures -- requests will be allowed through (fail-open)
    alerting.trigger('rate-limiter-store-error', { error: error.message });
  },
});
```

### Example 4: Integration with mcp-audit-log

Rate limiting and audit logging working together.

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createRateLimiter } from 'mcp-rate-guard';
import { createAuditLogger } from 'mcp-audit-log';

const server = new Server(
  { name: 'secure-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// Register handlers...

// Rate limiter is outermost: rejects happen before audit logging
const limiter = createRateLimiter(server, {
  global: { max: 100, windowMs: 60_000 },
  tools: {
    'delete_user': { max: 1, windowMs: 300_000 },
  },
});

// Audit logger only sees requests that passed rate limiting
const logger = createAuditLogger(server, {
  sink: { type: 'file', path: '/var/log/mcp/audit.log' },
});

// Separately log rate-limited requests for security monitoring
limiter.on('rateLimited', (event) => {
  securityLog.warn({
    type: 'rate_limited',
    client: event.clientId,
    method: event.method,
    tool: event.toolName,
    timestamp: event.timestamp,
  });
});
```

### Example 5: Health Check Integration

Using rate limiter state in a health check.

```typescript
import { createRateLimiter } from 'mcp-rate-guard';

const limiter = createRateLimiter(server, {
  global: { max: 500, windowMs: 60_000 },
});

// Expose rate limiter state in a health endpoint
function getRateLimiterHealth() {
  const globalState = limiter.getState('global');
  return {
    active: limiter.active,
    totalAllowed: limiter.allowedCount,
    totalRejected: limiter.rejectedCount,
    rejectionRate: limiter.rejectedCount / (limiter.allowedCount + limiter.rejectedCount) || 0,
    global: globalState ? {
      current: globalState.current,
      limit: globalState.limit,
      remaining: globalState.remaining,
      resetMs: globalState.resetMs,
    } : null,
  };
}
```
