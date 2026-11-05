import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { SUBSCRIBABLE_EVENT_KINDS } from '@beeline/api-contract/phone';
import { type SqlDatabase } from './database.js';
import { migratedDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';

// Retired predecessor writer: the post-cutover database must reject it.
function inheritableEventSubscriptionsSql(subscribableKindsParam: number): string {
  return `(
    SELECT COALESCE(jsonb_agg(elem),'[]'::jsonb)
    FROM jsonb_array_elements_text(parent_member.event_subscriptions) elem
    WHERE elem=ANY($${subscribableKindsParam}::text[])
  )`;
}

async function backfillInheritedCornerMemberships(database: SqlDatabase): Promise<number> {
  const result = await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions)
     SELECT corner.workspace_id,corner.id,parent_member.identity_id,parent_member.role,
            ${inheritableEventSubscriptionsSql(1)}
     FROM rooms corner
     JOIN memberships parent_member ON parent_member.room_id=corner.parent_id
       AND parent_member.removed_at IS NULL
     WHERE corner.parent_id IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [SUBSCRIBABLE_EVENT_KINDS],
  );
  console.log(
    `backfillInheritedCornerMemberships: added ${result.rowCount} missing corner membership row(s)`,
  );
  return result.rowCount;
}

it('rejects the retired predecessor backfill while parent-authorized corners stay readable', async () => {
  const db = await migratedDatabase();
  try {
    const workspace = randomUUID(),
      room = randomUUID(),
      corner = randomUUID(),
      later = randomUUID();
    const owner = 'd'.repeat(64),
      joiner = 'e'.repeat(64);
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'human','Joiner','joiner')`,
      [owner, joiner],
    );
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Rollback')`, [workspace]);
    await db.query(
      `INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'General','public')`,
      [room, workspace],
    );
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Before')`, [
      corner,
      workspace,
      room,
    ]);
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
      [workspace, owner, room],
    );
    const phone = new PhoneService(db, 'https://server.example');
    const invite = await phone.execute('createInvite', { workspaceId: workspace }, owner);
    expect(await phone.execute('redeemInvite', { token: invite.token }, joiner)).toMatchObject({
      joined: true,
    });
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'After')`, [
      later,
      workspace,
      room,
    ]);
    const oldAccess = async (identity: string, surface: string) =>
      (
        await db.query(
          `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
          [surface, identity],
        )
      ).rowCount;
    for (const person of [owner, joiner])
      for (const surface of [corner, later]) {
        expect(await oldAccess(person, surface)).toBe(0);
        expect(await phone.canReadRoom(surface, person)).toBe(true);
      }
    await expect(backfillInheritedCornerMemberships(db)).rejects.toThrow(/corner memberships/);
    expect((await phone.canReadRooms([corner, later], joiner)).size).toBe(2);
  } finally {
    await db.close();
  }
}, 120_000);
