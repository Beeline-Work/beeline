import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKSPACE_ID } from '@beeline/api-contract/phone';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { PushDeliveryLoop } from './background.js';
import { notifyReleaseDelivered, SYSTEM_IDENTITY_ID } from './release-notify.js';
import { claimReleaseCatchup } from './release-push-catchup.js';

const PERSON = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('release push catch-up at device registration', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;
  let loop: PushDeliveryLoop;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Person'),($2,'human','Other')`,
      [PERSON, OTHER],
    );
    // A real sign-in lands each person in the default Workspace. Announcement
    // DM reads require that active Workspace membership, so the fixture must
    // model the supported signed-in state rather than a bare identity row.
    await database.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member'),($1,$3,'member')`,
      [DEFAULT_WORKSPACE_ID, PERSON, OTHER],
    );
    phone = new PhoneService(database, 'https://server.test');
    send = vi.fn(async () => undefined);
    loop = new PushDeliveryLoop(database, { send });
  });
  afterEach(() => database.close());
  const register = (token = 'device', identity = PERSON) =>
    phone.execute(
      'registerPushDevice',
      {
        token,
        platform: 'android',
        environment: 'physical',
      },
      identity,
    );
  const release = async (version: string, ageHours: number) => {
    await notifyReleaseDelivered(database, {
      version,
      sha: 'a'.repeat(40),
      changelogUrl: 'https://example.test/changelog',
    });
    await database.query(
      `UPDATE messages SET created_at=now()-($1 || ' hours')::interval WHERE text LIKE $2`,
      [String(ageHours), `Beeline release ${version} is out!%`],
    );
    return (
      await database.query<{ id: string; room_id: string }>(
        `SELECT m.id,m.room_id FROM messages m JOIN memberships member ON member.room_id=m.room_id
       WHERE member.identity_id=$1 AND m.text LIKE $2`,
        [PERSON, `Beeline release ${version} is out!%`],
      )
    ).rows[0]!;
  };
  const markRead = (message: { id: string; room_id: string }) =>
    phone.markRead(message.room_id, message.id, PERSON);

  it('delivers just the latest unseen notice predating registration, once, in its original Workspace', async () => {
    await release('v1', 3);
    const latest = await release('v2', 2);
    // Ordinary chat before registration must still never replay.
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'ordinary old message',now()-interval '1 hour')`,
      ['c'.repeat(64), latest.room_id, OTHER],
    );
    expect(await loop.runOnce()).toBe(0);
    await register();
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      'device',
      expect.objectContaining({
        messageId: latest.id,
        workspaceId: DEFAULT_WORKSPACE_ID,
        roomId: latest.room_id,
        type: 'message',
      }),
    );
    expect(send.mock.calls[0]![1].text).toContain('v2');
    await register();
    expect(await loop.runOnce()).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    expect(
      (await database.query(`SELECT 1 FROM messages WHERE author_id=$1`, [SYSTEM_IDENTITY_ID]))
        .rowCount,
    ).toBe(4);
  });

  it('does not queue a read notice and rechecks read marks after registration', async () => {
    const latest = await release('v1', 2);
    await register();
    await markRead(latest);
    expect(await loop.runOnce()).toBe(0);
    await register('new-install');
    expect(
      (
        await database.query('SELECT 1 FROM push_release_catchups WHERE device_token=$1', [
          'new-install',
        ])
      ).rowCount,
    ).toBe(0);
    expect(await loop.runOnce()).toBe(0);
  });

  it('does not claim a queued notice that became read before dispatch', async () => {
    const latest = await release('v1', 2);
    await register();
    expect(
      (
        await database.query('SELECT 1 FROM push_release_catchups WHERE device_token=$1', [
          'device',
        ])
      ).rowCount,
    ).toBe(1);
    await markRead(latest);
    await expect(claimReleaseCatchup(database, latest.id, 'device', PERSON)).resolves.toBe(false);
    expect(
      (await database.query('SELECT 1 FROM push_delivery_claims WHERE message_id=$1', [latest.id]))
        .rowCount,
    ).toBe(0);
  });

  it('retires delivered and read catch-up candidates', async () => {
    const delivered = await release('v1', 2);
    await register();
    expect(await loop.runOnce()).toBe(1);
    expect(
      (
        await database.query('SELECT 1 FROM push_release_catchups WHERE device_token=$1', [
          'device',
        ])
      ).rowCount,
    ).toBe(0);

    const read = await release('v2', 2);
    await register('read-device');
    await markRead(read);
    expect(await loop.runOnce()).toBe(0);
    expect(
      (
        await database.query('SELECT 1 FROM push_release_catchups WHERE device_token=$1', [
          'read-device',
        ])
      ).rowCount,
    ).toBe(0);
    expect(delivered.id).not.toBe(read.id);
  });

  it('catches up after reinstall with a new token and avoids a duplicate normal delivery', async () => {
    await register();
    const latest = await release('v1', 2);
    await phone.execute(
      'unregisterPushDevice',
      { token: 'device', platform: 'android', environment: 'physical' },
      PERSON,
    );
    await register('new-install');
    // Make both normal and catch-up lanes eligible for the same notice.
    await database.query(`UPDATE push_devices SET registered_at=now()-interval '3 hours'`);
    await database.query(
      `INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '3 hours')`,
    );
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      'new-install',
      expect.objectContaining({ messageId: latest.id }),
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it('drops a superseded queued notice and scopes a reassigned token to its current identity', async () => {
    const old = await release('v1', 3);
    await register();
    await release('v2', 2);
    expect(await loop.runOnce()).toBe(0); // v1 is no longer the latest.
    expect(
      (
        await database.query('SELECT 1 FROM push_release_catchups WHERE device_token=$1', [
          'device',
        ])
      ).rowCount,
    ).toBe(0);
    await register('device', OTHER);
    expect(await loop.runOnce()).toBe(1);
    expect(send.mock.calls[0]![1].roomId).not.toBe(old.room_id);
    expect(send.mock.calls[0]![1].text).toContain('v2');
  });

  it('can retry a confirmed failed release send on re-registration without replaying successful sends', async () => {
    await release('v1', 2);
    await register();
    send.mockRejectedValueOnce(new Error('temporary sender failure'));
    expect(await loop.runOnce()).toBe(0);
    expect(await loop.runOnce()).toBe(0);
    expect(
      (
        await database.query('SELECT 1 FROM push_release_catchups WHERE device_token=$1', [
          'device',
        ])
      ).rowCount,
    ).toBe(1);
    await register();
    expect(await loop.runOnce()).toBe(1);
    expect(
      (
        await database.query('SELECT 1 FROM push_release_catchups WHERE device_token=$1', [
          'device',
        ])
      ).rowCount,
    ).toBe(0);
    await register();
    expect(await loop.runOnce()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
