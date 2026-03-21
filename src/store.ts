import type { RateLimitStore, WindowState } from './types';

export class InMemoryStore implements RateLimitStore {
  private readonly _store: Map<string, WindowState> = new Map();

  async increment(key: string, windowMs: number): Promise<WindowState> {
    const now = Date.now();
    let state = this._store.get(key);

    if (!state) {
      const alignedStart = Math.floor(now / windowMs) * windowMs;
      state = {
        currentCount: 0,
        previousCount: 0,
        currentWindowStart: alignedStart,
        previousWindowStart: alignedStart - windowMs,
      };
    } else {
      // Check if current window has expired
      if (now >= state.currentWindowStart + windowMs) {
        const alignedStart = Math.floor(now / windowMs) * windowMs;
        // Determine if two or more windows have elapsed
        const twoWindowsElapsed = now >= state.currentWindowStart + 2 * windowMs;
        state = {
          currentCount: 0,
          previousCount: twoWindowsElapsed ? 0 : state.currentCount,
          currentWindowStart: alignedStart,
          previousWindowStart: twoWindowsElapsed ? alignedStart - windowMs : state.currentWindowStart,
        };
      }
    }

    state.currentCount++;
    this._store.set(key, state);
    return { ...state };
  }

  async get(key: string, windowMs: number): Promise<WindowState | null> {
    void windowMs;
    const state = this._store.get(key);
    return state ? { ...state } : null;
  }

  async reset(key: string): Promise<void> {
    this._store.delete(key);
  }

  async resetAll(): Promise<void> {
    this._store.clear();
  }

  async close(): Promise<void> {
    this._store.clear();
  }
}
