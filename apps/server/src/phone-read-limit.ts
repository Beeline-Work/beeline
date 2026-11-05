const WINDOW_MS = 60_000;
/** A flood must not be able to grow process memory without bound. */
const MAX_TRACKED_IDENTITIES = 10_000;

export interface IdentityRateLimitOptions {
  readonly now?: () => number;
  readonly maxRequestsPerWindow?: number;
  readonly windowMs?: number;
  readonly log?: (message: string, ...values: unknown[]) => void;
}

/** A fixed per-window request count for each signed-in identity on one server. */
export class IdentityRateLimit {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly log: (message: string, ...values: unknown[]) => void;

  constructor(
    private readonly name: string,
    maxRequestsPerWindow: number,
    options: IdentityRateLimitOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.maxRequests = options.maxRequestsPerWindow ?? maxRequestsPerWindow;
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.log = options.log ?? ((message, ...values) => console.log(message, ...values));
  }

  admit(identityId: string): boolean {
    if (this.count(identityId)) return true;
    this.log(`[${this.name}] rate-limited`, `identity=${identityId}`);
    return false;
  }

  private count(identityId: string): boolean {
    const now = this.now();
    const current = this.attempts.get(identityId);
    if (current && current.resetAt > now) {
      current.count += 1;
      return current.count <= this.maxRequests;
    }
    if (current) this.attempts.delete(identityId);
    // Scan only at the memory bound, not on every request.
    if (this.attempts.size >= MAX_TRACKED_IDENTITIES) {
      for (const [key, window] of this.attempts)
        if (window.resetAt <= now) this.attempts.delete(key);
      if (this.attempts.size >= MAX_TRACKED_IDENTITIES) return false;
    }
    this.attempts.set(identityId, { count: 1, resetAt: now + this.windowMs });
    return true;
  }
}
