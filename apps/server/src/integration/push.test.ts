import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { migrate } from '.././database.js';
import { PushDeliveryLoop } from '.././background.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: push', () => {
const fixture = monolithFixture();


  it('upgrades legacy push registrations and preserves their first registration timestamp', async () => {
    await fixture.database.query(`ALTER TABLE push_devices ALTER COLUMN registered_at DROP DEFAULT`);
    await migrate(fixture.database);
    const defaulted = await fixture.database.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_name='push_devices' AND column_name='registered_at'`,
    );
    expect(defaulted.rows).toEqual([
      expect.objectContaining({ column_default: expect.any(String) }),
    ]);

    const token = 'new-device-token-registered-at-1234567890';
    const registered = await fixture.operation('registerPushDevice', {
      token,
      platform: 'android',
      environment: 'physical',
    });
    expect(registered.status).toBe(200);
    expect(
      (
        await fixture.database.query<{ registered: boolean }>(
          `SELECT registered_at IS NOT NULL registered FROM push_devices WHERE token=$1`,
          [token],
        )
      ).rows,
    ).toEqual([{ registered: true }]);

    await fixture.database.query(
      `UPDATE push_devices SET registered_at='2000-01-01T00:00:00.000Z' WHERE token=$1`,
      [token],
    );
    expect(
      (
        await fixture.operation('registerPushDevice', {
          token,
          platform: 'ios',
          environment: 'physical',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.database.query<{ registered_at: Date }>(
          `SELECT registered_at FROM push_devices WHERE token=$1`,
          [token],
        )
      ).rows,
    ).toEqual([expect.objectContaining({ registered_at: new Date('2000-01-01T00:00:00.000Z') })]);
  });


  it('resets a reassigned device registration floor', async () => {
    const otherId = createHash('sha256').update('github:other-push-owner').digest('hex');
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other push owner','other')`,
      [otherId],
    );
    const roomId = 'b1111111-1111-4111-8111-111111111111';
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Push test')`,
      [roomId, WORKSPACE, otherId],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
        ($1,$2,$3,'member'),($1,$2,$4,'member')`,
      [WORKSPACE, roomId, HUMAN, otherId],
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES($1,$2,$3,'@other old mention',now()-interval '1 hour')`,
      ['d'.repeat(64), roomId, HUMAN],
    );
    const token = 'reassigned-device-token-1234567890';
    expect(
      (
        await fixture.operation('registerPushDevice', {
          token,
          platform: 'android',
          environment: 'physical',
        })
      ).status,
    ).toBe(200);
    await fixture.database.query(
      `UPDATE push_devices SET registered_at=now()-interval '2 hours' WHERE token=$1`,
      [token],
    );
    await fixture.database.query(
      `INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '2 hours')
       ON CONFLICT(id) DO UPDATE SET started_at=EXCLUDED.started_at`,
    );
    await fixture.phone.execute(
      'registerPushDevice',
      { token, platform: 'android', environment: 'physical' },
      otherId,
    );
    const send = vi.fn(async () => undefined);
    await expect(new PushDeliveryLoop(fixture.database, { send }).runOnce()).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });


  it('reads and updates only the signed-in person push level', async () => {
    const managed = async () =>
      (await (await fixture.operation('getManagedIdentity', {})).json()) as { pushLevel: string };
    expect((await managed()).pushLevel).toBe('attention');

    const updated = await fixture.operation('updateIdentityPushLevel', { pushLevel: 'full' });
    expect(updated.status).toBe(200);
    expect((await updated.json()) as { pushLevel: string }).toEqual(
      expect.objectContaining({ pushLevel: 'full' }),
    );
    expect((await managed()).pushLevel).toBe('full');
    expect(
      (
        await fixture.database.query<{ push_level: string }>(
          `SELECT push_level FROM identities WHERE id=$1`,
          [HUMAN],
        )
      ).rows[0]?.push_level,
    ).toBe('full');

    expect((await fixture.operation('updateIdentityPushLevel', { pushLevel: 'loud' })).status).toBe(400);
    expect((await managed()).pushLevel).toBe('full');
  });


  it('deduplicates push delivery claims in Postgres', async () => {
    await fixture.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('device-token-12345678901234567890',$1,'android','physical')`,
      [HUMAN],
    );
    const floor = new PushDeliveryLoop(fixture.database, { send: vi.fn().mockResolvedValue(undefined) });
    expect(await floor.runOnce()).toBe(0);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text)
       VALUES($1,$2,$3,'@owner push me')`,
      ['d'.repeat(64), ROOM, AGENT],
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(fixture.database, { send });
    expect(await loop.runOnce()).toBe(1);
    expect(await loop.runOnce()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
