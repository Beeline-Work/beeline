import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKSPACE_ID } from '@beeline/api-contract/phone';
import { TokenAuth, type PhoneTokens } from './auth.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import {
  REVIEW_IDENTITY_ID,
  REVIEW_IDENTITY_NAME,
  ReviewAccess,
} from './review-access.js';
import {
  REVIEW_PROOF_CORNER_ID,
  REVIEW_PROOF_OBJECTIVE,
  REVIEW_PROOF_ROOM_ID,
  REVIEW_WORKSPACE_ID,
  ensureReviewProofFixture,
} from './review-proof-fixture.js';
import { PhoneService } from './phone-service.js';
import { joinRooms } from './membership-join.js';

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

  it('lands as owner of its own Workspace with #general and the proof fixture, never Welcome', async () => {
    const issued = await auth.exchangeReviewIdentity();
    expect(issued.identityId).toBe(REVIEW_IDENTITY_ID);
    expect(await auth.authenticatePhone(issued.accessToken)).toBe(REVIEW_IDENTITY_ID);
    const memberships = await database.query<{
      workspace_id: string;
      room: string | null;
      role: string;
    }>(
      `SELECT m.workspace_id,r.name room,m.role FROM memberships m LEFT JOIN rooms r ON r.id=m.room_id
       WHERE m.identity_id=$1 AND m.removed_at IS NULL
       ORDER BY m.room_id IS NOT NULL,r.name`,
      [REVIEW_IDENTITY_ID],
    );
    expect(memberships.rows).toEqual([
      { workspace_id: REVIEW_WORKSPACE_ID, room: null, role: 'owner' },
      { workspace_id: REVIEW_WORKSPACE_ID, room: 'general', role: 'owner' },
      { workspace_id: REVIEW_WORKSPACE_ID, room: 'proof', role: 'member' },
      { workspace_id: REVIEW_WORKSPACE_ID, room: 'release proof', role: 'member' },
    ]);
    expect(
      (await database.query(`SELECT 1 FROM workspaces WHERE id=$1`, [DEFAULT_WORKSPACE_ID]))
        .rowCount,
    ).toBe(0);
  });

  it('keeps a proof fixture seeded in the retired Welcome Workspace where it lives', async () => {
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline Welcome')`, [
      DEFAULT_WORKSPACE_ID,
    ]);
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human',$2)`,
      [REVIEW_IDENTITY_ID, REVIEW_IDENTITY_NAME],
    );
    await database.transaction((tx) =>
      ensureReviewProofFixture(tx, REVIEW_IDENTITY_ID, DEFAULT_WORKSPACE_ID),
    );
    await auth.exchangeReviewIdentity();
    const fixture = await database.query<{ room_id: string; workspace_id: string }>(
      `SELECT m.room_id,m.workspace_id FROM memberships m JOIN rooms r ON r.id=m.room_id
       WHERE m.identity_id=$1 AND m.room_id IN ($2,$3) AND r.workspace_id=m.workspace_id
       ORDER BY m.room_id`,
      [REVIEW_IDENTITY_ID, REVIEW_PROOF_ROOM_ID, REVIEW_PROOF_CORNER_ID],
    );
    expect(fixture.rows.map((row) => row.workspace_id)).toEqual([
      DEFAULT_WORKSPACE_ID,
      DEFAULT_WORKSPACE_ID,
    ]);
  });

  it('seeds the release-proof fixture: one invite-only room with one live corner on the deck', async () => {
    await auth.exchangeReviewIdentity();
    const phone = new PhoneService(database, 'http://placeholder');
    const deck = await phone.readChats(REVIEW_WORKSPACE_ID, REVIEW_IDENTITY_ID);
    expect(deck).not.toBeNull();
    const proofRoom = deck!.chats.find((chat) => chat.room.id === REVIEW_PROOF_ROOM_ID);
    expect(proofRoom?.cornerCount).toBe(1);
    const corners = await phone.readCorners(REVIEW_PROOF_ROOM_ID, REVIEW_IDENTITY_ID);
    expect(corners?.corners.map((corner) => corner.corner.id)).toEqual([REVIEW_PROOF_CORNER_ID]);
    expect(corners?.corners[0]?.state).toBe('waiting');
    // The corner screen's objective line reads the corner Room's `about`.
    const cornerRoom = await phone.readRoom(REVIEW_PROOF_CORNER_ID, REVIEW_IDENTITY_ID);
    expect(cornerRoom?.room.about).toBe(REVIEW_PROOF_OBJECTIVE);
  });

  it('the proof fixture is visible to no one else', async () => {
    await auth.exchangeReviewIdentity();
    // Another person joins the reviewer's Workspace the ordinary way: every
    // public Room, never the invite-only proof room.
    const other = createHash('sha256').update('other-human').digest('hex');
    await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO identities(id,kind,name,handle,updated_at) VALUES($1,'human','Other','other',now())
         ON CONFLICT(id) DO NOTHING`,
        [other],
      );
      await tx.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,'member') ON CONFLICT DO NOTHING`,
        [REVIEW_WORKSPACE_ID, other],
      );
      await joinRooms(tx, {
        workspaceId: REVIEW_WORKSPACE_ID,
        identityId: other,
        rooms: { type: 'all-live-top-level' },
        workspaceJoined: true,
      });
    });
    const members = await database.query<{ identity_id: string }>(
      `SELECT identity_id FROM memberships
       WHERE room_id IN ($1,$2) AND removed_at IS NULL`,
      [REVIEW_PROOF_ROOM_ID, REVIEW_PROOF_CORNER_ID],
    );
    expect(members.rows).toEqual([{ identity_id: REVIEW_IDENTITY_ID }, { identity_id: REVIEW_IDENTITY_ID }]);
  });

  it('reseeding the fixture changes nothing', async () => {
    await auth.exchangeReviewIdentity();
    await auth.exchangeReviewIdentity();
    await database.transaction(async (tx) => {
      await ensureReviewProofFixture(tx, REVIEW_IDENTITY_ID, REVIEW_WORKSPACE_ID);
    });
    const rooms = await database.query<{ id: string }>(
      `SELECT id FROM rooms WHERE id IN ($1,$2)`,
      [REVIEW_PROOF_ROOM_ID, REVIEW_PROOF_CORNER_ID],
    );
    expect(rooms.rows.map((row) => row.id).sort()).toEqual(
      [REVIEW_PROOF_CORNER_ID, REVIEW_PROOF_ROOM_ID].sort(),
    );
    const memberships = await database.query(
      `SELECT 1 FROM memberships WHERE identity_id=$1 AND removed_at IS NULL`,
      [REVIEW_IDENTITY_ID],
    );
    expect(memberships.rowCount).toBe(4);
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
    expect(memberships.rowCount).toBe(4);
  });
});
