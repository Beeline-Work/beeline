import { createHash } from 'node:crypto';
import { isCommunityInviteToken } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
/** A flood must not be able to grow process memory without bound. */
const MAX_TRACKED_CLIENTS = 10_000;

export type PublicInvitePreview = {
  readonly valid: true;
  readonly workspaceName: string;
  readonly inviterName: string;
  /** Absolute Unix timestamp in seconds. */
  readonly expiresAt: number;
};

export type PublicInvitePreviewResult =
  | { readonly status: 'found'; readonly preview: PublicInvitePreview }
  | { readonly status: 'not_found' }
  | { readonly status: 'rate_limited' };

export interface InvitePreviewAccessOptions {
  readonly now?: () => number;
  readonly maxRequestsPerWindow?: number;
  readonly windowMs?: number;
  readonly log?: (message: string, ...values: unknown[]) => void;
}

/**
 * The unauthenticated landing-page projection for a bearer invite URL.
 *
 * A valid token reveals only the two names the invitee sees on the landing
 * page and the token's own expiry. Unknown, expired, malformed, and creator-
 * retired tokens deliberately collapse to one result.
 */
export class InvitePreviewAccess {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly log: (message: string, ...values: unknown[]) => void;

  constructor(
    private readonly database: SqlDatabase,
    options: InvitePreviewAccessOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.maxRequests = options.maxRequestsPerWindow ?? MAX_REQUESTS_PER_WINDOW;
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.log = options.log ?? ((message, ...values) => console.log(message, ...values));
  }

  async resolve(rawToken: string, client: string): Promise<PublicInvitePreviewResult> {
    if (!this.admit(client)) {
      this.log('[invite-preview] rate-limited', `client=${client}`);
      return { status: 'rate_limited' };
    }
    if (!isCommunityInviteToken(rawToken)) return { status: 'not_found' };

    const result = await this.database.query<{
      workspace_name: string;
      inviter_name: string;
      expires_at: Date;
    }>(
      `SELECT w.name workspace_name,inviter.name inviter_name,i.expires_at
       FROM invites i
       JOIN workspaces w ON w.id=i.workspace_id
       JOIN identities inviter ON inviter.id=i.created_by
       JOIN memberships creator ON creator.workspace_id=i.workspace_id AND creator.room_id IS NULL
         AND creator.identity_id=i.created_by AND creator.removed_at IS NULL
       WHERE i.token_hash=$1 AND i.expires_at>now()`,
      [createHash('sha256').update(rawToken).digest('hex')],
    );
    const row = result.rows[0];
    if (!row) return { status: 'not_found' };
    return {
      status: 'found',
      preview: {
        valid: true,
        workspaceName: row.workspace_name,
        inviterName: row.inviter_name,
        expiresAt: Math.floor(row.expires_at.getTime() / 1000),
      },
    };
  }

  private admit(client: string): boolean {
    const now = this.now();
    const current = this.attempts.get(client);
    if (current && current.resetAt > now) {
      current.count += 1;
      return current.count <= this.maxRequests;
    }
    if (current) this.attempts.delete(client);
    // Scan only at the memory bound, not on every public request.
    if (this.attempts.size >= MAX_TRACKED_CLIENTS) {
      for (const [key, window] of this.attempts)
        if (window.resetAt <= now) this.attempts.delete(key);
      if (this.attempts.size >= MAX_TRACKED_CLIENTS) return false;
    }
    this.attempts.set(client, { count: 1, resetAt: now + this.windowMs });
    return true;
  }
}
