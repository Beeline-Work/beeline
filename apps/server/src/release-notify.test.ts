import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import {
  SYSTEM_IDENTITY_ID,
  composeReleaseNotice,
  notifyReleaseDelivered,
} from './release-notify.js';

const OWNER = 'a'.repeat(64);
const OTHER_PERSON = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
      ($1,'human','Owner'),($2,'human','Other'),($3,'agent','Worker')`,
    [OWNER, OTHER_PERSON, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`, [
    ROOM,
    WORKSPACE,
    OWNER,
  ]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
      ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member')`,
    [WORKSPACE, OWNER, OTHER_PERSON, AGENT, ROOM],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
  return database;
}

describe('composeReleaseNotice', () => {
  it('is the announcement line alone when the person is fully current', () => {
    expect(
      composeReleaseNotice({
        version: 'v0.0.42',
        changelogUrl: 'https://github.com/lunchboxfortwo/beeline/releases/tag/v0.0.42',
        behind: false,
        platforms: new Set(),
      }),
    ).toBe(
      'Beeline release v0.0.42 is out! New functionalities are in the changelog (https://github.com/lunchboxfortwo/beeline/releases/tag/v0.0.42).',
    );
  });

  it('adds the helper section only when behind, and both platform sections for both devices', () => {
    const text = composeReleaseNotice({
      version: 'v0.0.42',
      changelogUrl: 'https://example.test/releases/v0.0.42',
      behind: true,
      platforms: new Set(['android', 'ios']),
    });
    expect(text).toContain('"npx usebeeline update"');
    // Regression: `beeline` is an UNRELATED package on npm (a router
    // library), so the DM must never name an `npx beeline ...` spelling —
    // that would fetch a stranger's code. The published name is the safe
    // npx form, and #949 made it delegate to the installed bundle.
    expect(text).not.toContain('npx beeline');
    expect(text).toContain('Google Play');
    expect(text).toContain('App Store');
  });
});

describe('notifyReleaseDelivered', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await fixture();
  });
  afterEach(() => database.close());

  it('DMs every non-hidden human once, never touching a shared Room', async () => {
    const result = await notifyReleaseDelivered(database, {
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://example.test/releases/v0.0.42',
    });
    expect(result).toEqual({ notified: 2, skipped: 0 });

    const messages = await database.query<{ room_id: string; author_id: string; text: string }>(
      `SELECT room_id,author_id,text FROM messages ORDER BY room_id`,
    );
    expect(messages.rows).toHaveLength(2);
    for (const message of messages.rows) {
      expect(message.author_id).toBe(SYSTEM_IDENTITY_ID);
      expect(message.room_id).not.toBe(ROOM);
      expect(message.text).toContain('Beeline release v0.0.42 is out!');
    }

    // @system is never swept into the shared Room's roster.
    const inSharedRoom = await database.query(
      `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, SYSTEM_IDENTITY_ID],
    );
    expect(inSharedRoom.rowCount).toBe(0);
  });

  it('re-running the same version does not double-post (idempotent dedup on version+identity)', async () => {
    await notifyReleaseDelivered(database, {
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://example.test/releases/v0.0.42',
    });
    const rerun = await notifyReleaseDelivered(database, {
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://example.test/releases/v0.0.42',
    });
    expect(rerun).toEqual({ notified: 0, skipped: 2 });
    const count = await database.query(`SELECT count(*)::int c FROM messages WHERE author_id=$1`, [
      SYSTEM_IDENTITY_ID,
    ]);
    expect((count.rows[0] as { c: number }).c).toBe(2);

    // A later version DOES post again for the same person.
    const nextVersion = await notifyReleaseDelivered(database, {
      version: 'v0.0.43',
      sha: 'b'.repeat(40),
      changelogUrl: 'https://example.test/releases/v0.0.43',
    });
    expect(nextVersion).toEqual({ notified: 2, skipped: 0 });
  });

  it('includes the helper section only for the owner of a daemon reporting a different version', async () => {
    await database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'t','presence',$3::jsonb)`,
      [ROOM, AGENT, JSON.stringify({ status: 'online', observedAt: Date.now() / 1000, releaseVersion: 'v0.0.41' })],
    );
    await notifyReleaseDelivered(database, {
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://example.test/releases/v0.0.42',
    });
    const ownerMessage = await database.query<{ text: string }>(
      `SELECT m.text FROM messages m JOIN rooms r ON r.id=m.room_id
       WHERE r.direct_participants::jsonb ? $1 AND r.direct_participants::jsonb ? $2`,
      [SYSTEM_IDENTITY_ID, OWNER],
    );
    const otherMessage = await database.query<{ text: string }>(
      `SELECT m.text FROM messages m JOIN rooms r ON r.id=m.room_id
       WHERE r.direct_participants::jsonb ? $1 AND r.direct_participants::jsonb ? $2`,
      [SYSTEM_IDENTITY_ID, OTHER_PERSON],
    );
    expect(ownerMessage.rows[0]?.text).toContain('"npx usebeeline update"');
    expect(otherMessage.rows[0]?.text).not.toContain('npx usebeeline update');
  });

  it('omits the helper section once the owned daemon reports the matching version', async () => {
    await database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'t','presence',$3::jsonb)`,
      [ROOM, AGENT, JSON.stringify({ status: 'online', observedAt: Date.now() / 1000, releaseVersion: 'v0.0.42' })],
    );
    await notifyReleaseDelivered(database, {
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://example.test/releases/v0.0.42',
    });
    const ownerMessage = await database.query<{ text: string }>(
      `SELECT m.text FROM messages m JOIN rooms r ON r.id=m.room_id
       WHERE r.direct_participants::jsonb ? $1 AND r.direct_participants::jsonb ? $2`,
      [SYSTEM_IDENTITY_ID, OWNER],
    );
    expect(ownerMessage.rows[0]?.text).not.toContain('npx usebeeline update');
  });

  it('does not invent a helper section for an owned daemon that has never reported a version', async () => {
    // The agent exists and is owned, but has NEVER posted presence at all —
    // never-observed is not the same as behind, so nothing is asserted.
    await notifyReleaseDelivered(database, {
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://example.test/releases/v0.0.42',
    });
    const ownerMessage = await database.query<{ text: string }>(
      `SELECT m.text FROM messages m JOIN rooms r ON r.id=m.room_id
       WHERE r.direct_participants::jsonb ? $1 AND r.direct_participants::jsonb ? $2`,
      [SYSTEM_IDENTITY_ID, OWNER],
    );
    expect(ownerMessage.rows[0]?.text).not.toContain('npx usebeeline update');
  });

  it('includes only the platform section matching the person\'s registered devices', async () => {
    await database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES($1,$2,'android','physical')`,
      ['owner-device-token-12345678901234567890', OWNER],
    );
    await notifyReleaseDelivered(database, {
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://example.test/releases/v0.0.42',
    });
    const ownerMessage = await database.query<{ text: string }>(
      `SELECT m.text FROM messages m JOIN rooms r ON r.id=m.room_id
       WHERE r.direct_participants::jsonb ? $1 AND r.direct_participants::jsonb ? $2`,
      [SYSTEM_IDENTITY_ID, OWNER],
    );
    expect(ownerMessage.rows[0]?.text).toContain('Google Play');
    expect(ownerMessage.rows[0]?.text).not.toContain('App Store');
  });

  it('refuses a post from anyone but @system into the read-only announcement DM', async () => {
    await notifyReleaseDelivered(database, {
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://example.test/releases/v0.0.42',
    });
    const room = await database.query<{ id: string }>(
      `SELECT r.id FROM rooms r WHERE r.direct_participants::jsonb ? $1 AND r.direct_participants::jsonb ? $2`,
      [SYSTEM_IDENTITY_ID, OWNER],
    );
    const roomId = room.rows[0]!.id;
    const phone = new PhoneService(database, 'http://local.test');
    await expect(
      phone.execute('sendRoomMessage', { roomId, text: 'let me reply' }, OWNER),
    ).rejects.toThrow('access denied');
    // The read view agrees: send permission is false for the recipient.
    const view = await phone.readRoom(roomId, OWNER);
    expect(view?.viewer.permissions.send).toBe(false);
    // @system itself may still post through the ordinary send path.
    await expect(
      phone.execute('sendRoomMessage', { roomId, text: 'another notice' }, SYSTEM_IDENTITY_ID),
    ).resolves.toBeTruthy();
  });

  it('leaves an ordinary direct message between two people writable by both', async () => {
    const resolved = await new PhoneService(database, 'http://local.test').execute(
      'resolveDirectMessage',
      { workspaceId: WORKSPACE, participantId: OTHER_PERSON },
      OWNER,
    );
    const phone = new PhoneService(database, 'http://local.test');
    await expect(
      phone.execute('sendRoomMessage', { roomId: resolved.id, text: 'hi' }, OWNER),
    ).resolves.toBeTruthy();
    await expect(
      phone.execute('sendRoomMessage', { roomId: resolved.id, text: 'hey back' }, OTHER_PERSON),
    ).resolves.toBeTruthy();
  });
});
