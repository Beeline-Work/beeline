import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID } from '@beeline/api-contract/phone';
import { TokenAuth, type PhoneTokens } from './auth.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { REVIEW_IDENTITY_ID, REVIEW_IDENTITY_NAME, ReviewAccess } from './review-access.js';

const SECRET = 'play-review-secret-value-0001';

function tokens(identityId = REVIEW_IDENTITY_ID): PhoneTokens {
  return {
    accessToken: 'bat_x',
    accessExpiresAt: 1,
    refreshToken: 'brt_x',
    refreshExpiresAt: 2,
    identityId,
  };
}

describe('the Google Play review secret', () => {
  const log = vi.fn();
  let mint: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    log.mockClear();
    mint = vi.fn(async () => tokens());
  });

  const access = (overrides: Partial<ConstructorParameters<typeof ReviewAccess>[0]> = {}) =>
    new ReviewAccess({ secret: SECRET, mint, log, ...overrides });

  it('redeems exactly the configured secret', async () => {
    const result = await access().redeem(SECRET, '203.0.113.7');
    expect(result).toEqual({ status: 'redeemed', tokens: tokens() });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[review-access] redeemed',
      'client=203.0.113.7',
      `identity=${REVIEW_IDENTITY_ID}`,
    );
  });

  it('refuses a wrong secret without minting anything', async () => {
    for (const wrong of [
      `${SECRET}x`,
      SECRET.slice(0, -1),
      SECRET.toUpperCase(),
      ' ',
      '',
      'short',
      'contains spaces and punctuation!!',
      undefined,
      null,
      42,
      { secret: SECRET },
    ]) {
      expect(await access().redeem(wrong, '203.0.113.7')).toEqual({ status: 'refused' });
    }
    expect(mint).not.toHaveBeenCalled();
  });

  it('refuses everything when no secret is configured, telling a client nothing new', async () => {
    const unconfigured = access({ secret: undefined });
    expect(unconfigured.configured).toBe(false);
    expect(await unconfigured.redeem(SECRET, 'client')).toEqual({ status: 'refused' });
    expect(await access({ secret: '   ' }).redeem('', 'client')).toEqual({ status: 'refused' });
    expect(mint).not.toHaveBeenCalled();
  });

  it('rate-limits one client without touching another, and reopens after the window', async () => {
    let now = 1_000;
    const limited = access({ maxAttemptsPerWindow: 3, windowMs: 60_000, now: () => now });
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect(await limited.redeem('wrong-but-well-formed-secret', 'a')).toEqual({
        status: 'refused',
      });
    expect(await limited.redeem(SECRET, 'a')).toEqual({ status: 'rate_limited' });
    // A different client is unaffected: one attacker cannot lock the reviewer out.
    expect(await limited.redeem(SECRET, 'b')).toEqual({ status: 'redeemed', tokens: tokens() });
    now += 60_001;
    expect(await limited.redeem(SECRET, 'a')).toEqual({ status: 'redeemed', tokens: tokens() });
  });

  it('logs every attempt and never the secret', async () => {
    const configured = access();
    await configured.redeem('wrong-but-well-formed-secret', 'client');
    await configured.redeem(SECRET, 'client');
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      '[review-access] refused',
      '[review-access] redeemed',
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });
});

describe('the review identity', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    auth = new TokenAuth(database, async () => {
      throw new Error('the review identity never verifies a GitHub proof');
    });
  });
  afterEach(() => database.close());

  it('lands in the same welcome Workspace and Room every person lands in', async () => {
    const issued = await auth.exchangeReviewIdentity();
    expect(issued.identityId).toBe(REVIEW_IDENTITY_ID);
    expect(await auth.authenticatePhone(issued.accessToken)).toBe(REVIEW_IDENTITY_ID);
    const memberships = await database.query<{ workspace_id: string; room_id: string | null }>(
      `SELECT workspace_id,room_id FROM memberships WHERE identity_id=$1 AND removed_at IS NULL
       ORDER BY room_id NULLS FIRST`,
      [REVIEW_IDENTITY_ID],
    );
    expect(memberships.rows).toEqual([
      { workspace_id: DEFAULT_WORKSPACE_ID, room_id: null },
      { workspace_id: DEFAULT_WORKSPACE_ID, room_id: WELCOME_ROOM_ID },
    ]);
  });

  it('holds no GitHub linkage, so it can never mint a repository token', async () => {
    await auth.exchangeReviewIdentity();
    const identity = await database.query<{ name: string; github_subject: string | null }>(
      `SELECT name,github_subject FROM identities WHERE id=$1`,
      [REVIEW_IDENTITY_ID],
    );
    expect(identity.rows).toEqual([{ name: REVIEW_IDENTITY_NAME, github_subject: null }]);
    const links = await database.query(
      `SELECT 1 FROM identity_external_links WHERE identity_id=$1`,
      [REVIEW_IDENTITY_ID],
    );
    expect(links.rowCount).toBe(0);
  });

  it('is one identity however many times the link is used', async () => {
    const first = await auth.exchangeReviewIdentity();
    const second = await auth.exchangeReviewIdentity();
    expect(second.identityId).toBe(first.identityId);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const identities = await database.query(`SELECT 1 FROM identities WHERE id=$1`, [
      REVIEW_IDENTITY_ID,
    ]);
    expect(identities.rowCount).toBe(1);
    const memberships = await database.query(
      `SELECT 1 FROM memberships WHERE identity_id=$1 AND removed_at IS NULL`,
      [REVIEW_IDENTITY_ID],
    );
    expect(memberships.rowCount).toBe(2);
  });
});
