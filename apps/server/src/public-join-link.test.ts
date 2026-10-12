import { afterEach, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import { InvitePreviewAccess } from './invite-preview.js';
import { PgliteDatabase } from './test-support.js';
const workspace = '8556a9be-d929-41e7-a0ef-d70af452a494';
const room = '22222222-2222-4222-8222-222222222222';
const owner = 'a'.repeat(64),
  alice = 'b'.repeat(64),
  bob = 'c'.repeat(64);
let db: PgliteDatabase;
afterEach(async () => db?.close());
async function setup(visibility: 'public' | 'invite-only') {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name) VALUES ($1,'human','Owner'),($2,'human','Alice'),($3,'human','Bob')`,
    [owner, alice, bob],
  );
  await db.query(`INSERT INTO workspaces(id,name,visibility) VALUES ($1,'Beeline Community',$2)`, [
    workspace,
    visibility,
  ]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES ($1,$2,'owner')`, [
    workspace,
    owner,
  ]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES ($1,$2,'Support')`, [
    room,
    workspace,
  ]);
  return new PhoneService(db, 'https://server.example');
}
it('seeds once, joins multiple people and default Rooms, and invalidates rotated tokens', async () => {
  const phone = await setup('public');
  await migrate(db);
  const first = await phone.execute('createInvite', { workspaceId: workspace }, owner);
  expect(first.expiresAt).toBe(0);
  expect(await phone.execute('createInvite', { workspaceId: workspace }, owner)).toEqual(first);
  const preview = new InvitePreviewAccess(db);
  expect((await preview.resolve(first.token, 'visitor')).status).toBe('found');
  const redemptions = await Promise.all(
    [alice, bob].map((person) => phone.execute('redeemInvite', { token: first.token }, person)),
  );
  for (const redemption of redemptions)
    expect(redemption).toMatchObject({ joined: true, workspaceId: workspace, roomId: room });
  const retries = await Promise.all(
    [alice, alice].map((person) => phone.execute('redeemInvite', { token: first.token }, person)),
  );
  for (const retry of retries) expect(retry).toMatchObject({ joined: false });
  expect(await phone.readInvite(first.token, alice)).toMatchObject({
    expiresAt: 0,
    joinedWorkspaceId: workspace,
  });
  await expect(
    phone.execute('createInvite', { workspaceId: workspace, rotate: true }, alice),
  ).rejects.toThrow('manager');
  const rotated = await phone.execute(
    'createInvite',
    { workspaceId: workspace, rotate: true },
    owner,
  );
  expect(rotated.token).not.toBe(first.token);
  expect(await phone.readInvite(first.token, alice)).toBeNull();
  expect((await preview.resolve(first.token, 'visitor')).status).toBe('not_found');
  await expect(phone.execute('redeemInvite', { token: first.token }, bob)).rejects.toThrow(
    'invite not found',
  );
  await migrate(db);
  expect(await phone.execute('createInvite', { workspaceId: workspace }, owner)).toEqual(rotated);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [owner]);
  expect((await preview.resolve(rotated.token, 'visitor')).status).toBe('found');
  expect(await phone.execute('redeemInvite', { token: rotated.token }, alice)).toMatchObject({
    joined: false,
  });
  await db.query(`UPDATE workspaces SET visibility='invite-only' WHERE id=$1`, [workspace]);
  expect((await preview.resolve(rotated.token, 'visitor')).status).toBe('not_found');
  await expect(phone.execute('redeemInvite', { token: rotated.token }, alice)).rejects.toThrow(
    'invite not found',
  );
});
it('keeps private invites expiring and single-use, and disallows rotation', async () => {
  const phone = await setup('invite-only');
  const first = await phone.execute('createInvite', { workspaceId: workspace }, owner);
  expect(first.expiresAt).toBeGreaterThan(Date.now() / 1000);
  await expect(
    phone.execute('createInvite', { workspaceId: workspace, rotate: true }, owner),
  ).rejects.toThrow('only public');
  expect((await phone.execute('redeemInvite', { token: first.token }, alice)).joined).toBe(true);
  await expect(phone.execute('redeemInvite', { token: first.token }, bob)).rejects.toThrow(
    'invite not found',
  );
  expect((await new InvitePreviewAccess(db).resolve(first.token, 'visitor')).status).toBe(
    'not_found',
  );
  await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [alice]);
  await expect(phone.execute('redeemInvite', { token: first.token }, alice)).rejects.toThrow(
    'invite not found',
  );
});
