import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

const OWNER = 'a'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

/**
 * listAgentGrantRequests is the inspect surface behind the agent's `list_grants`
 * tool: it shows the agent its own pending, approved, and once grants with
 * reason and age. It never authorizes anything — the run gate keeps the
 * approved-only `listAgentGrants` view.
 */
describe('listAgentGrantRequests', () => {
  let db: PgliteDatabase;
  let daemon: DaemonService;
  beforeAll(async () => {
    db = new PgliteDatabase();
    await migrate(db);
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
      [OWNER, AGENT],
    );
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, ROOM, AGENT],
    );
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
      [WORKSPACE, OWNER],
    );
    await db.query(
      `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,auto,created_at)
       VALUES
         ('10000000-0000-4000-8000-000000000001',$1,$2,'command','fly deploy -a preview --with FLY_TOKEN','publish the preview',$3,$4,'pending',false,now()-interval '1 minute'),
         ('10000000-0000-4000-8000-000000000002',$1,$2,'host','api.fly.io','reach the API',$3,$4,'approved',true,now()-interval '2 minutes'),
         ('10000000-0000-4000-8000-000000000003',$1,$2,'path','artifacts/','read the build output',$3,$4,'once',false,now()-interval '3 minutes')`,
      [AGENT, WORKSPACE, OWNER, ROOM],
    );
    daemon = new DaemonService(db, new LiveHub());
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });

  it('lists pending, approved and once grants with reason and age, newest first', async () => {
    const listed = await daemon.execute(
      'listAgentGrantRequests',
      { roomId: ROOM },
      AGENT,
    );
    expect(listed.grants.map((entry) => entry.status)).toEqual([
      'pending',
      'approved',
      'once',
    ]);
    expect(listed.grants[0]).toMatchObject({
      kind: 'command',
      target: 'fly deploy -a preview --with FLY_TOKEN',
      reason: 'publish the preview',
      status: 'pending',
      auto: false,
      requestedBy: OWNER,
    });
    const later = listed.grants[0]!.createdAt;
    const earlier = listed.grants[2]!.createdAt;
    expect(later).toBeGreaterThan(earlier);
    expect(typeof later).toBe('number');
  });

  it('exposes nothing to an agent that owns no grants', async () => {
    const stranger = 'd'.repeat(64);
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Nope','nope')`,
      [stranger],
    );
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [stranger, OWNER]);
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, ROOM, stranger],
    );
    const listed = await daemon.execute(
      'listAgentGrantRequests',
      { roomId: ROOM },
      stranger,
    );
    expect(listed.grants).toEqual([]);
  });
});