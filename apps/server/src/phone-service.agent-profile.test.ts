import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const parent = '22222222-2222-4222-8222-222222222222';
const agent = 'a'.repeat(64);
const viewer = 'b'.repeat(64);
const other = 'c'.repeat(64);
let database: PgliteDatabase;
afterEach(async () => database?.close());

describe('agent profile recent work', () => {
  it('shows only merged, attributed work in readable corners, and revokes it with membership', async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES ($1,'agent','Agent'),($2,'human','Viewer'),($3,'agent','Other')`,
      [agent, viewer, other],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES ($1,'Workspace')`, [workspace]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES ($1,$2,'Parent')`, [
      parent,
      workspace,
    ]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES ($1,$2)`, [agent, viewer]);
    await database.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES ($1,$2,'member'),($1,$3,'member')`,
      [workspace, agent, viewer],
    );
    const corners = ['Readable', 'Private', 'Unmerged', 'Other author', 'Unsafe URL'];
    for (const [index, title] of corners.entries()) {
      const id = `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES ($1,$2,$3,$4)`,
        [id, workspace, parent, title],
      );
      await database.query(
        `INSERT INTO corner_facts(corner_id,owner_agent_id,lifecycle) VALUES ($1,$2,$3::jsonb)`,
        [
          id,
          index === 3 ? other : agent,
          JSON.stringify({
            lifecycle: 'done',
            checks: 'passing',
            pr: {
              title,
              url:
                index === 4
                  ? 'https://evil.example/pull/1'
                  : `https://github.com/acme/repo/pull/${index + 1}`,
              ...(index === 2 ? {} : { mergedAt: '2026-09-24T00:00:00Z' }),
            },
          }),
        ],
      );
      if (index !== 1)
        await database.query(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES ($1,$2,$3,'member')`,
          [workspace, id, viewer],
        );
    }
    const phone = new PhoneService(database, 'https://server.example');
    expect((await phone.readAgent(workspace, agent, viewer))?.recentWork).toEqual([
      { title: 'Readable', url: 'https://github.com/acme/repo/pull/1' },
    ]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name)
      SELECT ('44444444-4444-4444-8444-' || lpad(n::text,12,'0'))::uuid,$1,$2,'Older '||n
      FROM generate_series(1,24) n`,
      [workspace, parent],
    );
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,lifecycle)
      SELECT id,$2,jsonb_build_object('pr', jsonb_build_object('title',name,
        'url','https://github.com/acme/repo/pull/'||right(id::text,12),
        'mergedAt','2026-09-23T00:00:00Z')) FROM rooms WHERE workspace_id=$1 AND name LIKE 'Older %'`,
      [workspace, agent],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT workspace_id,id,$2,'member' FROM rooms WHERE workspace_id=$1 AND name LIKE 'Older %'`,
      [workspace, viewer],
    );
    const first = await phone.readAgent(workspace, agent, viewer);
    expect(first?.recentWork).toHaveLength(20);
    expect(first?.recentWorkCursor).toBeTruthy();
    const second = await phone.readAgent(workspace, agent, viewer, first!.recentWorkCursor);
    expect(second?.recentWork).toHaveLength(5);
    expect(second?.recentWorkCursor).toBeUndefined();
    expect(
      new Set([...first!.recentWork!, ...second!.recentWork!].map((work) => work.url)).size,
    ).toBe(25);
    await expect(phone.readAgent(workspace, agent, viewer, 'bad cursor')).rejects.toThrow('cursor');
    await database.query(
      `UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id IS NOT NULL`,
      [viewer],
    );
    expect((await phone.readAgent(workspace, agent, viewer))?.recentWork).toEqual([]);
    expect(
      (await phone.readAgent(workspace, agent, viewer, first!.recentWorkCursor))?.recentWork,
    ).toEqual([]);
    await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [viewer]);
    expect(await phone.readAgent(workspace, agent, viewer)).toBeNull();
  });
});

describe('persistent Workspace bans', () => {
  it('blocks every membership restoration until lifted, without restoring access on unban', async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES ($1,'human','Owner'),($2,'human','Person'),($3,'agent','Agent')`,
      [viewer, other, agent],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES ($1,'Workspace')`, [workspace]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES ($1,$2,'Room')`, [
      parent,
      workspace,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')`,
      [workspace, viewer, other, agent],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES ($1,$2,$3,'member')`,
      [workspace, parent, other],
    );
    const phone = new PhoneService(database, 'https://server.example');
    const invite = await phone.execute('createInvite', { workspaceId: workspace }, viewer);
    expect(
      (await phone.readWorkspaceMembers(workspace, viewer, { memberId: other }))?.members.map(
        (m) => m.identity.pubkey,
      ),
    ).toEqual([other]);
    await expect(
      phone.execute('listWorkspaceBans', { workspaceId: workspace }, other),
    ).rejects.toThrow();
    await expect(
      phone.execute('unbanWorkspaceMember', { workspaceId: workspace, memberId: agent }, other),
    ).rejects.toThrow();

    await expect(
      phone.execute('banWorkspaceMember', { workspaceId: workspace, memberId: viewer }, other),
    ).rejects.toThrow();
    await phone.execute('banWorkspaceMember', { workspaceId: workspace, memberId: other }, viewer);
    expect(
      (await phone.execute('listWorkspaceBans', { workspaceId: workspace }, viewer)).members,
    ).toEqual([{ pubkey: other, name: 'Person', kind: 'human', canLift: true }]);
    expect(await phone.readWorkspace(workspace, other)).toBeNull();
    await expect(phone.execute('redeemInvite', { token: invite.token }, other)).rejects.toThrow(
      'banned',
    );
    await expect(
      phone.execute(
        'addWorkspaceMember',
        { workspaceId: workspace, memberId: other, role: 'member' },
        viewer,
      ),
    ).rejects.toThrow('banned');
    await expect(
      database.query(
        `UPDATE memberships SET removed_at=NULL WHERE workspace_id=$1 AND identity_id=$2`,
        [workspace, other],
      ),
    ).rejects.toThrow('banned');
    await phone.execute(
      'unbanWorkspaceMember',
      { workspaceId: workspace, memberId: other },
      viewer,
    );
    expect(await phone.readWorkspace(workspace, other)).toBeNull();
    expect((await phone.execute('redeemInvite', { token: invite.token }, other)).joined).toBe(true);
    await phone.execute('banWorkspaceMember', { workspaceId: workspace, memberId: agent }, viewer);
    await expect(
      database.query(
        `UPDATE memberships SET removed_at=NULL WHERE workspace_id=$1 AND identity_id=$2`,
        [workspace, agent],
      ),
    ).rejects.toThrow('banned');
    await expect(
      phone.execute('banWorkspaceMember', { workspaceId: workspace, memberId: viewer }, viewer),
    ).rejects.toThrow();
  });
});
