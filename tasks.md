# mcp-rate-guard — Task Breakdown

This file tracks all tasks required to implement `mcp-rate-guard` per the specification in SPEC.md.

---

## Phase 1: Project Setup and Scaffolding

- [ ] **Install peer and dev dependencies** — Add `@modelcontextprotocol/sdk` as a peer dependency (`^1.12.0`) and dev dependency. Add `typescript` (`^5.5.0`), `vitest` (`^2.0.0`), and `eslint` (`^9.0.0`) as dev dependencies. Run `npm install`. | Status: not_done
- [ ] **Update package.json metadata** — Add `peerDependencies` section for `@modelcontextprotocol/sdk`. Add `keywords` (e.g., `mcp`, `rate-limit`, `json-rpc`, `middleware`). Set `author` and `description` fields. Verify `engines`, `files`, `main`, `types`, and `scripts` are correct. | Status: not_done
- [ ] **Configure ESLint** — Create an ESLint config file compatible with ESLint v9 flat config. Configure for TypeScript. Ensure `npm run lint` works against `src/`. | Status: not_done
- [ ] **Verify build toolchain** — Run `npm run build` and confirm TypeScript compiles with current `tsconfig.json` settings (target ES2022, commonjs module, strict mode, declaration files). Fix any config issues. | Status: not_done
- [ ] **Create source file skeleton** — Create all source files specified in the file structure (Section 18): `src/index.ts`, `src/types.ts`, `src/create-rate-limiter.ts`, `src/config-validator.ts`, `src/transport-interceptor.ts`, `src/request-classifier.ts`, `src/rule-evaluator.ts`, `src/sliding-window.ts`, `src/error-responder.ts`, `src/memory-store.ts`. Each file should have a placeholder export and a module-level comment. | Status: not_done
- [ ] **Create test file skeleton** — Create all test files: `src/__tests__/config-validator.test.ts`, `src/__tests__/transport-interceptor.test.ts`, `src/__tests__/request-classifier.test.ts`, `src/__tests__/rule-evaluator.test.ts`, `src/__tests__/sliding-window.test.ts`, `src/__tests__/error-responder.test.ts`, `src/__tests__/memory-store.test.ts`, `src/__tests__/integration.test.ts`. Each file should import vitest and have a placeholder `describe` block. | Status: not_done
- [ ] **Verify test runner** — Run `npm run test` and confirm vitest discovers and runs the placeholder test files without errors. | Status: not_done

---

## Phase 2: Type Definitions (`src/types.ts`)

- [ ] **Define `RateLimitRule` interface** — Interface with `max: number` and `windowMs: number` fields, including JSDoc comments as specified in Section 5. | Status: not_done
- [ ] **Define `RateLimiterOptions` interface** — Full interface with all fields: `global`, `methods`, `tools`, `perClient`, `perClientMethods`, `perClientTools`, `keyExtractor`, `store`, `exempt`, `skipInitialization`, `errorCode`, `errorMessage`, `onRateLimited`, `onError`. All fields optional. Include JSDoc comments matching the spec. | Status: not_done
- [ ] **Define `RateLimiter` interface** — Interface for the handle returned by `createRateLimiter`: `close(): Promise<void>`, `readonly active: boolean`, `readonly rejectedCount: number`, `readonly allowedCount: number`, `getState(key: string): RateLimitState | null`, `reset(): Promise<void>`, `resetKey(key: string): Promise<void>`, `on()` / `off()` event methods. | Status: not_done
- [ ] **Define `RateLimitState` interface** — Interface with fields: `key`, `current`, `limit`, `windowMs`, `resetMs`, `remaining`. | Status: not_done
- [ ] **Define `RateLimitedEvent` interface** — Interface with fields: `timestamp`, `key`, `method`, `toolName`, `clientId`, `requestId`, `rule`, `currentCount`, `retryAfterSeconds`. | Status: not_done
- [ ] **Define `RequestAllowedEvent` interface** — Interface with fields: `method`, `toolName`, `clientId`, `remaining`. | Status: not_done
- [ ] **Define `RequestExtra` interface** — Interface with optional `sessionId` and `transportInfo` fields. | Status: not_done
- [ ] **Define `RateLimitStore` interface** — Interface with methods: `increment(key, windowMs): Promise<WindowState>`, `get(key, windowMs): Promise<WindowState | null>`, `reset(key): Promise<void>`, `resetAll(): Promise<void>`, `close(): Promise<void>`. | Status: not_done
- [ ] **Define `WindowState` interface** — Interface with fields: `currentCount`, `previousCount`, `currentWindowStart`, `previousWindowStart`. | Status: not_done
- [ ] **Define `JSONRPCRequest` type alias or import** — Either import the JSON-RPC request type from `@modelcontextprotocol/sdk` or define a compatible type for use in `keyExtractor` and internal components. | Status: not_done

---

## Phase 3: Sliding Window Algorithm (`src/sliding-window.ts`)

- [ ] **Implement `computeEffectiveCount` function** — Given a `WindowState`, `windowMs`, and current timestamp, compute the effective count using the sliding window formula: `effectiveCount = previousCount * overlapFraction + currentCount`, where `overlapFraction = 1 - ((now - currentWindowStart) / windowMs)`. | Status: not_done
- [ ] **Implement `isAllowed` function** — Given a `WindowState`, `RateLimitRule`, and current timestamp, return whether the request is allowed (effectiveCount < max) and the remaining allowance. | Status: not_done
- [ ] **Implement `computeRetryAfter` function** — When a request is rejected, compute the `retryAfterMs` value: `(currentWindowStart + windowMs) - now`. Round up to the nearest second for `retryAfterSeconds`. Ensure it is always a positive integer (minimum 1). | Status: not_done
- [ ] **Handle window boundary edge case** — When the current time is exactly at a window boundary, the overlap fraction should be 1.0 (full previous window contribution). Verify this is handled correctly. | Status: not_done
- [ ] **Handle empty previous window** — When there is no previous window data (first request ever), the previous count is 0 and the effective count equals the current count. | Status: not_done
- [ ] **Write `sliding-window.test.ts` tests** — Test: request at start of window with empty previous window (effectiveCount = 1); request at end of window (minimal previous contribution); request exactly at boundary (overlapFraction = 1.0); effectiveCount >= max returns not allowed; effectiveCount == max-1 returns allowed with remaining=1; retryAfter is always a positive integer rounded up. | Status: not_done

---

## Phase 4: In-Memory Store (`src/memory-store.ts`)

- [ ] **Implement `MemoryStore` class** — Class implementing `RateLimitStore` interface. Use a `Map<string, { current: number; previous: number; currentStart: number; previousStart: number }>` for storage. | Status: not_done
- [ ] **Implement `increment()` method** — Determine the current window start via `Math.floor(now / windowMs) * windowMs`. If the stored entry's `currentStart` matches, increment `current`. If the window has advanced, rotate: move `current` to `previous`, reset `current` to 1, update timestamps. If no entry exists, create one with `current=1, previous=0`. Return the `WindowState`. | Status: not_done
- [ ] **Implement `get()` method** — Return the `WindowState` for a key without incrementing. Return `null` if the key does not exist. Handle window advancement (return correct counts even if the stored window is stale). | Status: not_done
- [ ] **Implement `reset()` method** — Delete a specific key from the map. | Status: not_done
- [ ] **Implement `resetAll()` method** — Clear the entire map. | Status: not_done
- [ ] **Implement cleanup timer** — On construction, start a `setInterval` that iterates the map and removes entries where both the current and previous windows have fully elapsed. Default interval: 60 seconds. Configurable via `cleanupIntervalMs` constructor option. Use `unref()` on the timer so it does not prevent process exit. | Status: not_done
- [ ] **Implement `close()` method** — Clear the cleanup interval timer. Make `close()` idempotent (safe to call multiple times). | Status: not_done
- [ ] **Write `memory-store.test.ts` tests** — Test: `increment()` returns count 1 for first request; successive increments in same window return incrementing counts; counts reset when window advances; previous window count is preserved; `reset(key)` clears a specific key; `resetAll()` clears all keys; cleanup timer removes expired entries; `close()` clears the cleanup timer; concurrent increments via `Promise.all` do not lose counts. | Status: not_done

---

## Phase 5: Configuration Validation (`src/config-validator.ts`)

- [ ] **Implement `validateOptions` function** — Accept `RateLimiterOptions`, validate all fields, and return a normalized/defaulted config object. Throw `TypeError` on invalid input. | Status: not_done
- [ ] **Validate at least one limit is configured** — Throw `TypeError` if none of `global`, `methods`, `tools`, `perClient`, `perClientMethods`, or `perClientTools` is provided. | Status: not_done
- [ ] **Validate `RateLimitRule` fields** — For every `RateLimitRule` in the config: `max` must be a positive integer (>= 1, `Number.isInteger`); `windowMs` must be a positive integer (>= 1, `Number.isInteger`). Throw `TypeError` with descriptive message on violation. | Status: not_done
- [ ] **Validate `exempt` array** — Each element must be a non-empty string. Throw `TypeError` if any element is empty or non-string. | Status: not_done
- [ ] **Validate `errorCode`** — Must be a finite number if provided. Throw `TypeError` otherwise. | Status: not_done
- [ ] **Validate `keyExtractor`** — Must be a function if provided (`typeof keyExtractor === 'function'`). Throw `TypeError` otherwise. | Status: not_done
- [ ] **Validate `store`** — If provided, must have `increment`, `get`, `reset`, `resetAll`, and `close` methods (duck-type check). Throw `TypeError` if any method is missing. | Status: not_done
- [ ] **Warn on unrecognized method names** — If `methods` or `perClientMethods` contains keys that are not recognized MCP methods (e.g., `tools/call`, `resources/read`, `prompts/get`, `tools/list`, `resources/list`, `prompts/list`, `resources/templates/list`, `completions/complete`, `initialize`, `ping`), log a warning but do not throw. The limit is still installed. | Status: not_done
- [ ] **Warn on unrecognized tool names** — If `tools` or `perClientTools` contains keys that do not match any tool registered on the server, log a warning. The limit is still installed (tools may be registered later). | Status: not_done
- [ ] **Apply default values** — Set defaults for: `exempt` (empty array), `skipInitialization` (true), `errorCode` (-32029), `errorMessage` (template string from spec), `onError` (`console.error`), `store` (new `MemoryStore()`). | Status: not_done
- [ ] **Write `config-validator.test.ts` tests** — Test: valid minimal config (single global rule) accepted; missing all rules throws TypeError; `max: 0` throws; `max: -1` throws; `max: 1.5` throws; `windowMs: 0` throws; `exempt` with empty string throws; invalid `keyExtractor` throws; invalid `store` throws; unrecognized method names produce warning but no throw; defaults are applied correctly. | Status: not_done

---

## Phase 6: Request Classifier (`src/request-classifier.ts`)

- [ ] **Implement `classifyRequest` function** — Given a JSON-RPC message and `RequestExtra`, extract: `method` (string), `toolName` (string or null), and `clientId` (string). | Status: not_done
- [ ] **Determine if message is a JSON-RPC request** — A request has both an `id` field and a `method` field. Notifications (no `id`) and responses (no `method`) are not requests. | Status: not_done
- [ ] **Extract tool name from `tools/call` requests** — Read `request.params.name` for the tool name. If `params` or `params.name` is missing (malformed), treat tool name as `null`. | Status: not_done
- [ ] **Extract client ID with default logic** — Use the transport's `sessionId` from `RequestExtra`. If no session ID, use `'stdio'` as fallback. If session ID is missing and transport is not stdio, use `'unknown'`. | Status: not_done
- [ ] **Support custom `keyExtractor`** — If a `keyExtractor` function is provided, call it with the request and extra. If it throws, catch the error, call `onError`, and fall back to default key extraction (fail-open). | Status: not_done
- [ ] **Write `request-classifier.test.ts` tests** — Test: `tools/call` extracts method and tool name; `resources/read` extracts method with null tool name; `ping` extracts method with null tool name; malformed request (no params) has null tool name; custom `keyExtractor` is called; default extraction uses session ID; default extraction uses `'stdio'` when session ID is absent; `keyExtractor` that throws falls back to default. | Status: not_done

---

## Phase 7: Rule Evaluator (`src/rule-evaluator.ts`)

- [ ] **Implement `collectApplicableRules` function** — Given a classified request (method, toolName, clientId) and the validated config, return an ordered list of `{ key: string, rule: RateLimitRule }` tuples representing all applicable rate limit rules. | Status: not_done
- [ ] **Build rate limit keys** — Construct keys following the key hierarchy: `global` for global rule; `method:{methodName}` for per-method; `tool:{toolName}` for per-tool; `client:{clientId}` for per-client; `client:{clientId}:method:{methodName}` for per-client-method; `client:{clientId}:tool:{toolName}` for per-client-tool. | Status: not_done
- [ ] **Enforce evaluation order** — Rules must be evaluated in order: global, per-method, per-tool, per-client, per-client-method, per-client-tool. Per-tool and per-client-tool rules only apply when method is `tools/call` and tool name is non-null. | Status: not_done
- [ ] **Implement `evaluateRules` function** — For each applicable rule, call `store.increment(key, windowMs)`, compute effective count via sliding window checker, and short-circuit on first violation. Return the violation details (key, rule, state) or null if all pass. | Status: not_done
- [ ] **Handle exempt methods** — If the method is in the `exempt` list, return immediately with no rules to evaluate. | Status: not_done
- [ ] **Handle `skipInitialization`** — If `skipInitialization` is true and the method is `'initialize'`, return immediately with no rules to evaluate. | Status: not_done
- [ ] **Counter increment strategy** — Counters are incremented optimistically (before checking). If a later rule rejects the request, earlier counters have already been incremented. This is intentional per the spec (conservative/stricter). | Status: not_done
- [ ] **Short-circuit on first violation** — When a rule's effective count exceeds max, stop evaluating remaining rules. The most specific violated rule is used for the error response. | Status: not_done
- [ ] **Compute remaining allowance for allowed requests** — When all rules pass, compute the minimum remaining allowance across all checked rules for the `RequestAllowedEvent`. | Status: not_done
- [ ] **Write `rule-evaluator.test.ts` tests** — Test: request matching only global rule; request matching global + per-method (both checked in order); `tools/call` with per-tool rule (global + method + tool checked); per-client rules create client-scoped keys; exempt method bypasses all rules; `skipInitialization` bypasses `initialize`; short-circuit on first violation; remaining is computed as minimum across rules. | Status: not_done

---

## Phase 8: Error Responder (`src/error-responder.ts`)

- [ ] **Implement `createErrorResponse` function** — Given a JSON-RPC request ID, the violated rule, the rate limit key, and the sliding window state, construct a complete JSON-RPC error response object matching the format in Section 10. | Status: not_done
- [ ] **Set JSON-RPC error fields** — Set `jsonrpc: "2.0"`, `id` (from the original request), `error.code` (from config `errorCode`, default -32029), `error.message` (from template), `error.data` (object with `retryAfter`, `limit`, `windowMs`, `key`, `remaining: 0`, `resetMs`). | Status: not_done
- [ ] **Implement error message template substitution** — Replace placeholders in `errorMessage` template: `{method}` with the MCP method name, `{tool}` with the tool name (empty string if null), `{limit}` with `rule.max`, `{windowMs}` with `rule.windowMs`, `{retryAfter}` with the computed retry-after seconds. | Status: not_done
- [ ] **Compute `retryAfter` and `resetMs`** — `retryAfterMs = (currentWindowStart + windowMs) - now`. `retryAfterSeconds = Math.ceil(retryAfterMs / 1000)`. Ensure `retryAfterSeconds` is always >= 1. `resetMs` is the raw milliseconds value. | Status: not_done
- [ ] **Write `error-responder.test.ts` tests** — Test: valid JSON-RPC error response structure; correct `id` from original request; custom `errorMessage` template with all placeholders replaced; custom `errorCode` used; `retryAfter` is always a positive integer (rounded up); `id: 0` works; string `id` works. | Status: not_done

---

## Phase 9: Transport Interceptor (`src/transport-interceptor.ts`)

- [ ] **Implement `wrapServerConnect` function** — Monkey-patch the `server.connect()` method. When `connect(transport)` is called, wrap the transport's `onmessage` callback before delegating to the original `connect`. | Status: not_done
- [ ] **Implement `onmessage` wrapper** — The wrapper receives every incoming JSON-RPC message. It checks if the message is a request (has `id` and `method`). If not a request (notification or response), pass through to original `onmessage`. If it is a request, run it through the rate limiting pipeline. | Status: not_done
- [ ] **Integrate request classifier** — Call the request classifier to extract method, tool name, and client ID from the intercepted message. | Status: not_done
- [ ] **Integrate rule evaluator** — Call the rule evaluator to check all applicable rate limit rules against the store. | Status: not_done
- [ ] **Handle rate-limited requests** — If any rule is violated: construct the JSON-RPC error response via the error responder, send it directly via `transport.send()`, suppress the message (do not call original `onmessage`), emit `rateLimited` event, increment `rejectedCount`. | Status: not_done
- [ ] **Handle allowed requests** — If all rules pass: call original `onmessage`, emit `requestAllowed` event (only if listeners exist), increment `allowedCount`. | Status: not_done
- [ ] **Handle store errors (fail-open)** — If the store throws during `increment()`, catch the error, call `onError`, and allow the request through. Do not increment counters on failure. | Status: not_done
- [ ] **Handle `keyExtractor` errors (fail-open)** — If the `keyExtractor` throws, catch the error, call `onError`, fall back to default key extraction, and allow the request through. | Status: not_done
- [ ] **Handle transport `send()` errors** — If `transport.send()` fails when sending the rate limit error response, catch the error and call `onError`. The rate-limited request may reach the server handler in this case. | Status: not_done
- [ ] **Check `active` flag** — Before performing rate limit checks, verify `limiter.active` is true. If false (after `close()`), pass through without rate limiting. | Status: not_done
- [ ] **Support multiple transports** — Since `server.connect()` is wrapped, each call to `connect()` with a different transport gets its own `onmessage` wrapper. All wrappers share the same store and config. | Status: not_done
- [ ] **Write `transport-interceptor.test.ts` tests** — Test: notifications pass through without rate limiting; responses pass through; requests are checked; rate-limited requests get error response via `transport.send()`; allowed requests reach original `onmessage`; `active=false` skips rate limiting; store errors trigger fail-open; multiple transports each get wrapped. | Status: not_done

---

## Phase 10: Factory Function (`src/create-rate-limiter.ts`)

- [ ] **Implement `createRateLimiter` function** — Accept `Server` and `RateLimiterOptions`. Validate options via config validator. Create the `MemoryStore` if no store provided. Set up the transport interceptor. Return the `RateLimiter` handle. | Status: not_done
- [ ] **Create `RateLimiter` handle object** — Implement all properties and methods: `close()`, `active`, `rejectedCount`, `allowedCount`, `getState(key)`, `reset()`, `resetKey(key)`, `on()`, `off()`. | Status: not_done
- [ ] **Implement `close()` method** — Set `active` to false, clear cleanup timer, call `store.close()`. After `close()`, all requests pass through unimpeded. Make idempotent. | Status: not_done
- [ ] **Implement `getState(key)` method** — Call `store.get(key, windowMs)` for the appropriate rule. Compute `current` (effective count), `limit`, `remaining`, `resetMs` from the `WindowState`. Return null if no data. | Status: not_done
- [ ] **Implement `reset()` method** — Call `store.resetAll()`. Reset `rejectedCount` and `allowedCount` to 0. | Status: not_done
- [ ] **Implement `resetKey(key)` method** — Call `store.reset(key)`. | Status: not_done
- [ ] **Implement EventEmitter for events** — Use Node.js `EventEmitter` from `node:events` for `rateLimited` and `requestAllowed` events. Expose `on()` and `off()` methods on the handle. | Status: not_done
- [ ] **Optimize `requestAllowed` event emission** — Only construct and emit the `requestAllowed` event if there is at least one listener registered for it (check `listenerCount`). | Status: not_done
- [ ] **Wire up `onRateLimited` callback** — If `onRateLimited` is provided in options, register it as a listener for the `rateLimited` event. | Status: not_done

---

## Phase 11: Main Entry Point (`src/index.ts`)

- [ ] **Export `createRateLimiter` function** — The primary API export. | Status: not_done
- [ ] **Export all type interfaces** — Export: `RateLimiterOptions`, `RateLimitRule`, `RateLimiter`, `RateLimitState`, `RateLimitedEvent`, `RequestAllowedEvent`, `RequestExtra`, `RateLimitStore`, `WindowState`. | Status: not_done
- [ ] **Export `MemoryStore` class** — Allow users to instantiate `MemoryStore` directly with custom `cleanupIntervalMs`. | Status: not_done
- [ ] **Verify no unintended exports** — Ensure internal implementation details (config validator, transport interceptor, etc.) are not exported from the package entry point. | Status: not_done

---

## Phase 12: Unit Tests

- [ ] **Complete `config-validator.test.ts`** — All validation tests from Section 14: valid minimal config accepted; missing all rules throws; `max: 0` throws; `max: -1` throws; `max: 1.5` throws; `windowMs: 0` throws; `exempt` with empty string throws; invalid `keyExtractor` throws; invalid `store` throws; unrecognized method names warn but don't throw; defaults applied. | Status: not_done
- [ ] **Complete `sliding-window.test.ts`** — All algorithm tests: start-of-window with empty previous; end-of-window; exact boundary; effective >= max rejected; effective == max-1 allowed; retryAfter positive integer. | Status: not_done
- [ ] **Complete `memory-store.test.ts`** — All store tests: first increment returns 1; successive increments; window advancement; previous count preserved; reset(key); resetAll(); cleanup timer; close(); concurrent increments. | Status: not_done
- [ ] **Complete `request-classifier.test.ts`** — All classifier tests: tools/call with tool name; resources/read with null tool; ping; malformed request; custom keyExtractor; default session ID; default stdio fallback; keyExtractor throws. | Status: not_done
- [ ] **Complete `rule-evaluator.test.ts`** — All evaluator tests: global only; global + method; tools/call with tool rule; per-client keys; exempt; skipInitialization; short-circuit; remaining calculation. | Status: not_done
- [ ] **Complete `error-responder.test.ts`** — All responder tests: valid structure; correct id; custom template; custom errorCode; retryAfter rounding; id:0; string id. | Status: not_done
- [ ] **Complete `transport-interceptor.test.ts`** — All interceptor tests: notification pass-through; response pass-through; request checked; rate-limited sends error; allowed reaches handler; active=false bypass; store error fail-open; multiple transports. | Status: not_done

---

## Phase 13: Integration Tests (`src/__tests__/integration.test.ts`)

- [ ] **End-to-end rate limiting test** — Create Server with tool handler, wrap with `createRateLimiter` (methods: `tools/call` max 3), connect Client, make 3 requests (succeed), make 4th (get error -32029 with retryAfter/limit/windowMs), make `tools/list` request (succeeds). | Status: not_done
- [ ] **Per-tool rate limiting test** — Configure `tools: { 'tool_a': { max: 2 } }`. Call tool_a twice (succeed), call tool_a third time (rate-limited), call tool_b (succeeds). | Status: not_done
- [ ] **Per-client rate limiting test** — Configure `perClient: { max: 5 }`. Connect two clients with different session IDs. Client A makes 5 requests (succeed), 6th (rate-limited). Client B makes 5 requests (succeed, independent limit). | Status: not_done
- [ ] **Exempt method test** — Configure `exempt: ['ping']` and `global: { max: 1 }`. Make 1 request (succeeds, consumes limit). Make ping (succeeds, exempt). Make another non-exempt request (rate-limited). | Status: not_done
- [ ] **Skip initialization test** — Configure `global: { max: 1 }` and `skipInitialization: true`. Client initializes (not rate-limited). Client makes 1 request (succeeds). Client makes another (rate-limited). | Status: not_done
- [ ] **Fail-open test** — Provide custom store whose `increment()` rejects. Make request (succeeds, fail-open). Verify `onError` was called with the store error. | Status: not_done
- [ ] **Event emission test** — Register listeners for `rateLimited` and `requestAllowed`. Make allowed and rate-limited requests. Verify events emitted with correct payloads (method, toolName, clientId, key, retryAfterSeconds, remaining, etc.). | Status: not_done
- [ ] **Counter verification test** — After a mix of allowed and rejected requests, verify `limiter.allowedCount` and `limiter.rejectedCount` match expected values. | Status: not_done
- [ ] **State inspection test** — After making requests, call `limiter.getState('method:tools/call')` and verify it returns correct `current`, `limit`, `remaining`, `resetMs` values. | Status: not_done
- [ ] **Reset test** — Make requests to hit a limit, then call `limiter.reset()`, verify requests are allowed again. Also test `limiter.resetKey()` for a specific key. | Status: not_done
- [ ] **Close test** — Call `limiter.close()`, verify `limiter.active` is false, verify subsequent requests pass through without rate limiting. | Status: not_done
- [ ] **Custom errorCode and errorMessage test** — Configure custom `errorCode: -32050` and `errorMessage: 'Slow down! {method} limit hit.'`. Verify rate limit error responses use the custom code and message. | Status: not_done
- [ ] **Custom keyExtractor test** — Provide a `keyExtractor` that returns a custom key from request metadata. Verify per-client limits use the custom key. | Status: not_done
- [ ] **Global + per-method + per-tool combined test** — Configure global, per-method, and per-tool limits. Verify that the most specific violated rule is reported in the error response. | Status: not_done

---

## Phase 14: Edge Case Tests

- [ ] **Malformed `tools/call` request (missing `params.name`)** — Verify tool-level rules do not apply, but method-level and global rules still apply. | Status: not_done
- [ ] **Request with `id: 0`** — Verify rate limit error response uses `id: 0` (valid JSON-RPC ID). | Status: not_done
- [ ] **Request with string `id`** — Verify rate limit error response uses the string ID. | Status: not_done
- [ ] **`windowMs: 1` (1ms window)** — Verify window advances almost immediately; requests in different windows are not limited. | Status: not_done
- [ ] **`max: 1` strict limit** — Verify second request in the same window is always rejected. | Status: not_done
- [ ] **Concurrent requests (`Promise.all`)** — Verify all counters are incremented correctly and limits are enforced under concurrent access. | Status: not_done
- [ ] **`close()` followed by requests** — Verify requests pass through without rate limiting after close. | Status: not_done
- [ ] **`reset()` mid-operation** — Verify counters are cleared and requests are allowed again after reset. | Status: not_done
- [ ] **Large number of unique client keys (1000+)** — Verify memory store handles many keys without issues and cleanup works. | Status: not_done
- [ ] **Clock time at exact window boundary** — Verify the correct window is selected and overlap fraction is calculated correctly (overlapFraction = 1.0). | Status: not_done
- [ ] **`keyExtractor` that throws** — Verify fail-open behavior: request is allowed, `onError` is called, fallback key is used. | Status: not_done
- [ ] **Store `increment()` that rejects** — Verify fail-open: request is allowed, `onError` is called. | Status: not_done
- [ ] **Store `get()` that rejects** — Verify `getState()` returns null, `onError` is called. | Status: not_done
- [ ] **Transport `send()` that fails** — Verify `onError` is called when the error response cannot be sent. | Status: not_done

---

## Phase 15: Documentation

- [ ] **Create README.md** — Write a comprehensive README covering: overview/purpose, installation (`npm install mcp-rate-guard`), peer dependency note, quick start example, API reference for `createRateLimiter`, `RateLimiterOptions`, `RateLimitRule`, `RateLimiter` handle, `RateLimitStore` interface, `MemoryStore`, event types. | Status: not_done
- [ ] **Add usage examples to README** — Include examples from Section 20 of the spec: basic tool rate limiting, multi-tenant HTTP server, distributed rate limiting with Redis, integration with mcp-audit-log, health check integration. | Status: not_done
- [ ] **Document configuration options** — In README, list every option in `RateLimiterOptions` with description, type, and default value. Show the complete default configuration. | Status: not_done
- [ ] **Document error response format** — In README, show the JSON-RPC error response format with all `data` fields explained. Document the error code rationale (-32029). | Status: not_done
- [ ] **Document custom store implementation** — In README, explain the `RateLimitStore` interface contract, the five methods, atomicity/expiration/monotonicity requirements, and provide the Redis example from the spec. | Status: not_done
- [ ] **Document middleware ordering** — In README, explain how to order `mcp-rate-guard` with other middleware like `mcp-audit-log`. Show recommended ordering. | Status: not_done
- [ ] **Document fail-open behavior** — In README, explain that store failures allow requests through and that `onError` should be used for alerting. | Status: not_done
- [ ] **Document client identification** — In README, explain transport-based identification (Streamable HTTP session ID, stdio fixed key, custom transports) and the `keyExtractor` option. | Status: not_done
- [ ] **Add JSDoc comments to all public exports** — Ensure every exported function, interface, and type has JSDoc comments matching the spec descriptions. | Status: not_done

---

## Phase 16: Build, Lint, and CI Verification

- [ ] **Verify `npm run build` passes** — TypeScript compilation succeeds with no errors. Output goes to `dist/` with `.js`, `.d.ts`, and `.d.ts.map` files. | Status: not_done
- [ ] **Verify `npm run lint` passes** — ESLint runs on `src/` with no errors or warnings. | Status: not_done
- [ ] **Verify `npm run test` passes** — All unit and integration tests pass via vitest. | Status: not_done
- [ ] **Verify package exports** — Import `mcp-rate-guard` from the built `dist/index.js` and verify `createRateLimiter`, `MemoryStore`, and all type exports are accessible. | Status: not_done
- [ ] **Verify `dist/` output is clean** — Only compiled output in `dist/`, no source files, no test files, no spec files. `files` field in `package.json` restricts published files to `dist`. | Status: not_done

---

## Phase 17: Version Bump and Publishing Preparation

- [ ] **Bump version in package.json** — Set version to `0.1.0` for initial release (already set, verify it is correct for the scope of changes). | Status: not_done
- [ ] **Verify `prepublishOnly` script** — Confirm `npm run build` runs automatically before `npm publish`. | Status: not_done
- [ ] **Verify `publishConfig`** — Confirm `"access": "public"` is set for scoped/unscoped package publishing. | Status: not_done
- [ ] **Dry-run `npm publish`** — Run `npm publish --dry-run` to verify the package contents, file list, and metadata are correct. | Status: not_done
