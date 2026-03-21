export interface RateLimitRule { max: number; windowMs: number }

export interface RateLimiterOptions {
  global?: RateLimitRule
  methods?: Record<string, RateLimitRule>
  tools?: Record<string, RateLimitRule>
  perClient?: RateLimitRule
  perClientMethods?: Record<string, RateLimitRule>
  perClientTools?: Record<string, RateLimitRule>
  keyExtractor?: (request: JSONRPCRequest, extra?: RequestExtra) => string
  store?: RateLimitStore
  exempt?: string[]
  errorCode?: number
  errorMessage?: string
  onRateLimited?: (event: RateLimitedEvent) => void
}

export interface RateLimiter {
  close(): Promise<void>
  readonly active: boolean
  readonly rejectedCount: number
  readonly allowedCount: number
  getState(key: string): RateLimitState | null
  reset(): Promise<void>
  resetKey(key: string): Promise<void>
  on(event: 'rateLimited', fn: (e: RateLimitedEvent) => void): void
  on(event: 'requestAllowed', fn: (e: RequestAllowedEvent) => void): void
  off(event: string, fn: Function): void
}

export interface RateLimitState {
  key: string
  current: number
  limit: number
  windowMs: number
  resetMs: number
  remaining: number
}

export interface RateLimitedEvent {
  timestamp: string
  key: string
  method: string
  toolName: string | null
  clientId: string
  requestId: string | number
  rule: RateLimitRule
  currentCount: number
  retryAfterSeconds: number
}

export interface RequestAllowedEvent {
  method: string
  toolName: string | null
  clientId: string
  remaining: number
}

export interface JSONRPCRequest {
  id?: string | number
  method: string
  params?: unknown
  [k: string]: unknown
}

export interface RequestExtra {
  sessionId?: string
  transportInfo?: Record<string, unknown>
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<WindowState>
  get(key: string, windowMs: number): Promise<WindowState | null>
  reset(key: string): Promise<void>
  resetAll(): Promise<void>
  close(): Promise<void>
}

export interface WindowState {
  currentCount: number
  previousCount: number
  currentWindowStart: number
  previousWindowStart: number
}
