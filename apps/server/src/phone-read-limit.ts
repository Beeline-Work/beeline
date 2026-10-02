const WINDOW_MS = 60_000;
/**
 * The phone pages history one request at a time, 30 messages per page. On a
 * local server with a 19,199-message Room, a client paging the whole Room back
 * to back made 640 requests at about 80 per second (12 ms median). This limit
 * is half that loopback ceiling: a deep scroll of up to 72,000 messages fits in
 * one window at any speed, and a reader whose page round trip is 25 ms or more
 * (server time plus network and render) can never reach it at all. A parallel
 * loop on one token gets no more than that sequential reader.
 */
export const HISTORY_REQUESTS_PER_WINDOW = 2_400;
/** The phone reads the outline once per Room visit; two visits a second is not a person. */
export const OUTLINE_REQUESTS_PER_WINDOW = 120;
/**
 * The Room list searches about 250 ms after typing stops, so even steady
 * typing for a whole minute asks fewer than this; more is a loop, not a person.
 */
export const SEARCH_REQUESTS_PER_WINDOW = 240;
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

export interface PhoneReadLimits {
  readonly history: IdentityRateLimit;
  readonly outline: IdentityRateLimit;
  readonly search: IdentityRateLimit;
}

export function phoneReadLimits(
  options: {
    history?: IdentityRateLimitOptions;
    outline?: IdentityRateLimitOptions;
    search?: IdentityRateLimitOptions;
  } = {},
): PhoneReadLimits {
  return {
    history: new IdentityRateLimit('phone-history', HISTORY_REQUESTS_PER_WINDOW, options.history),
    outline: new IdentityRateLimit('phone-outline', OUTLINE_REQUESTS_PER_WINDOW, options.outline),
    search: new IdentityRateLimit('phone-search', SEARCH_REQUESTS_PER_WINDOW, options.search),
  };
}
