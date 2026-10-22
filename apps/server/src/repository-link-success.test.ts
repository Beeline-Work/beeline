import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';

let db: PgliteDatabase;
let phone: PhoneService;
const owner = 'a'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const binding = { roomId: room, key: 'github:42', name: 'owner/project', remote: 'git://github.com/owner/project', targetBranch: 'main', githubInstallationId: 77 };
beforeEach(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  phone = new PhoneService(db, 'https://server.test');
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Production')`, [workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [workspace, owner]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'general')`, [room, workspace]);
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,status)
    VALUES(77,$1,'owner','User','active')`, [owner]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
    VALUES(42,77,'owner/project','main')`);
});
afterEach(async () => { await db.close(); });
const successes = async () => (await db.query(`SELECT * FROM repository_link_successes`)).rows;

it('starts empty, records a confirmed link once, and retains it after unlinking', async () => {
  const epoch = (await db.query(`SELECT started_at FROM operator_metric_epochs WHERE metric='repository_link'`)).rows;
  await db.query(`UPDATE rooms SET repository_key='github:42',github_installation_id=77,repository_resolution='repository' WHERE id=$1`, [room]);
  await migrate(db);
  expect(await successes()).toEqual([]); // No inferred history from preexisting bindings.
  expect((await db.query(`SELECT started_at FROM operator_metric_epochs WHERE metric='repository_link'`)).rows).toEqual(epoch);
  await phone.execute('setRoomRepository', binding, owner);
  const first = await successes();
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ identity_id: owner, workspace_id: workspace });
  await phone.execute('setRoomRepository', binding, owner);
  expect(await successes()).toEqual(first);
  await phone.execute('removeRoomRepository', { roomId: room }, owner);
  expect(await successes()).toEqual(first);
});
it('records a Room created with an installed repository and deduplicates another Room', async () => {
  await phone.execute('createRoom', { workspaceId: workspace, name: 'project', repositoryId: 42 }, owner);
  expect(await successes()).toHaveLength(1);
  await phone.execute('setRoomRepository', binding, owner);
  expect(await successes()).toHaveLength(1);
});
it('does not record denied or unverified bindings', async () => {
  await expect(phone.execute('setRoomRepository', { ...binding, key: 'github:99' }, owner)).rejects.toThrow();
  await phone.execute('setRoomRepository', { ...binding, githubInstallationId: undefined }, owner);
  expect(await successes()).toEqual([]);
});
it('rolls back the binding when its success record cannot commit', async () => {
  await db.query(`CREATE FUNCTION reject_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'proof rollback'; END $$;
    CREATE TRIGGER reject_link BEFORE INSERT ON repository_link_successes FOR EACH ROW EXECUTE FUNCTION reject_link()`);
  await expect(phone.execute('setRoomRepository', binding, owner)).rejects.toThrow('proof rollback');
  expect((await db.query(`SELECT repository_key FROM rooms WHERE id=$1`, [room])).rows[0]?.repository_key).toBeNull();
  await expect(phone.execute('createRoom', { workspaceId: workspace, name: 'project', repositoryId: 42 }, owner)).rejects.toThrow('proof rollback');
  expect((await db.query(`SELECT id FROM rooms WHERE name='project'`)).rows).toEqual([]);
});
