import { createHash, timingSafeEqual } from 'node:crypto';
import type { PhoneTokens } from './auth.js';

/**
 * The Google Play reviewer's way in.
 *
 * Play's review policy needs a credential that works from any location with no
 * one-time code, and no GitHub account can give one: with 2FA off GitHub mails
 * a device-verification code to every unfamiliar device, with 2FA on it demands
 * an authenticator code. So one link — `https://usebeeline.app/review/<secret>`
 * — signs the device in as ONE fixed identity that never touches GitHub.
 *
 * The secret is a server-side environment value (`BEELINE_REVIEW_SECRET`); it
 * is never in the repository and is revoked by rotating it. Nothing about a
 * refusal is a hint: an unknown secret, a malformed one, and an unconfigured
 * server all answer exactly alike, and the comparison is constant time over
 * digests so neither the value nor its length leaks. Every attempt is rate
 * limited per client and logged.
 *
 * The identity itself is ordinary except for what it lacks: no GitHub subject,
 * no external link, so it holds no GitHub user token and `PhoneService` refuses
 * it every repository-linking and identity-binding operation (REVIEW_LOCKED_
 * OPERATIONS). It lands in the same welcome Workspace every new sign-in lands
 * in — the reviewer sees the product, not a special build.
 */
export const REVIEW_IDENTITY_ID = createHash('sha256')
  .update('beeline:play-review-identity')
  .digest('hex');
export const REVIEW_IDENTITY_NAME = 'Play Review';
export const REVIEW_IDENTITY_HANDLE = 'play-review';

/** A secret is opaque; only its shape is checked before the constant-time compare. */
const SECRET_SHAPE = /^[A-Za-z0-9_-]{24,128}$/;
const WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 10;
/** A bound on remembered clients so a flood cannot grow the window map without end. */
const MAX_TRACKED_CLIENTS = 10_000;

export type ReviewRedemption =
  | { readonly status: 'redeemed'; readonly tokens: PhoneTokens }
  | { readonly status: 'refused' }
  | { readonly status: 'rate_limited' };

/** Constant time over fixed-width digests, so neither the value nor its length leaks. */
function secretMatches(candidate: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

export interface ReviewAccessOptions {
  /** Absent (or blank) disables the link entirely; every request is then an ordinary refusal. */
  readonly secret?: string;
  readonly mint: () => Promise<PhoneTokens>;
  readonly now?: () => number;
  readonly log?: (message: string, ...values: unknown[]) => void;
  readonly maxAttemptsPerWindow?: number;
  readonly windowMs?: number;
}

export class ReviewAccess {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly secret?: string;
  private readonly mint: () => Promise<PhoneTokens>;
  private readonly now: () => number;
  private readonly log: (message: string, ...values: unknown[]) => void;
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(options: ReviewAccessOptions) {
    const secret = options.secret?.trim();
    this.secret = secret ? secret : undefined;
    this.mint = options.mint;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message, ...values) => console.log(message, ...values));
    this.maxAttempts = options.maxAttemptsPerWindow ?? MAX_ATTEMPTS_PER_WINDOW;
    this.windowMs = options.windowMs ?? WINDOW_MS;
  }

  /** True when a secret is configured; a caller must still not reveal this to a client. */
  get configured(): boolean {
    return this.secret !== undefined;
  }

  async redeem(candidate: unknown, client: string): Promise<ReviewRedemption> {
    if (!this.admit(client)) {
      this.log('[review-access] rate-limited', `client=${client}`);
      return { status: 'rate_limited' };
    }
    if (
      this.secret === undefined ||
      typeof candidate !== 'string' ||
      !SECRET_SHAPE.test(candidate) ||
      !secretMatches(candidate, this.secret)
    ) {
      this.log('[review-access] refused', `client=${client}`);
      return { status: 'refused' };
    }
    const tokens = await this.mint();
    this.log('[review-access] redeemed', `client=${client}`, `identity=${tokens.identityId}`);
    return { status: 'redeemed', tokens };
  }

  /** Fixed window per client. Counting every attempt, not only failures, keeps it simple. */
  private admit(client: string): boolean {
    const now = this.now();
    for (const [key, window] of this.attempts)
      if (window.resetAt <= now) this.attempts.delete(key);
    const current = this.attempts.get(client);
    if (!current) {
      if (this.attempts.size >= MAX_TRACKED_CLIENTS) return false;
      this.attempts.set(client, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= this.maxAttempts;
  }
}
