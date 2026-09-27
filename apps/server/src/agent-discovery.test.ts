import { describe, expect, it } from 'vitest';
import { agentDiscoveryChanges, agentDiscoverySnapshot } from './agent-discovery.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';

const AGENT = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';

describe('agent discovery cursor', () => {
  it('snapshots active Rooms and corners and pages durable membership and archive deltas', async () => {
    const database = new PgliteDatabase();
    try {
      await migrate(database);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Agent'),($2,'agent','Other')`, [AGENT, OTHER]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
      const empty = await agentDiscoverySnapshot(database, AGENT);
      expect(empty).toMatchObject({ workspaceIds: [], rooms: [] });
      await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [WORKSPACE, AGENT]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Room',$3)`, [ROOM, WORKSPACE, AGENT]);
      await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`, [CORNER, WORKSPACE, ROOM, AGENT]);
      await database.query(`INSERT INTO corner_facts(corner_id,owner_agent_id) VALUES($1,$2)`, [CORNER, AGENT]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$4,$3,'member')`, [WORKSPACE, ROOM, AGENT, CORNER]);
      const snapshot = await agentDiscoverySnapshot(database, AGENT);
      expect(snapshot.workspaceIds).toEqual([WORKSPACE]);
      expect(snapshot.rooms).toEqual(expect.arrayContaining([
        expect.objectContaining({ roomId: ROOM, archived: false }),
        expect.objectContaining({ roomId: CORNER, parentRoomId: ROOM, openedBy: AGENT, archived: false }),
      ]));
      expect(await agentDiscoveryChanges(database, OTHER, empty.cursor)).toMatchObject({ changes: [] });
      const added = await agentDiscoveryChanges(database, AGENT, empty.cursor);
      expect(added.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ workspaceId: WORKSPACE, removed: false }),
        expect.objectContaining({ roomId: CORNER, openedBy: AGENT, removed: false }),
      ]));
      expect(added.hasMore).toBe(false);

      await database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [CORNER]);
      const archived = await agentDiscoveryChanges(database, AGENT, snapshot.cursor);
      expect(archived.changes).toEqual([
        expect.objectContaining({ roomId: CORNER, parentRoomId: ROOM, archived: true, removed: false }),
      ]);
      expect((await agentDiscoverySnapshot(database, AGENT)).rooms.map((room) => room.roomId)).toEqual([ROOM]);

      await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id IS NULL`, [AGENT]);
      const removed = await agentDiscoveryChanges(database, AGENT, archived.cursor);
      expect(removed.changes).toEqual([
        expect.objectContaining({ workspaceId: WORKSPACE, removed: true }),
      ]);
      expect(removed.changes[0]).not.toHaveProperty('roomId');
      await database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type)
         VALUES(17,$1,'example','Organization')`, [AGENT],
      );
      await database.query(`UPDATE rooms SET github_installation_id=17 WHERE id=$1`, [ROOM]);
      const beforeInstallationChange = (await agentDiscoverySnapshot(database, AGENT)).cursor;
      await database.query(`UPDATE github_installations SET status='suspended' WHERE installation_id=17`);
      expect(await agentDiscoveryChanges(database, AGENT, beforeInstallationChange)).toMatchObject({
        changes: [], resetRequired: true, hasMore: false,
      });
      const pageStart = (await agentDiscoverySnapshot(database, AGENT)).cursor;
      for (let index = 1; index <= 101; index++)
        await database.query(`UPDATE rooms SET repository_updated_at=$2 WHERE id=$1`, [
          ROOM, new Date(1_700_000_000_000 + index * 1000),
        ]);
      const firstPage = await agentDiscoveryChanges(database, AGENT, pageStart);
      expect(firstPage.changes).toHaveLength(100);
      expect(firstPage.hasMore).toBe(true);
      const finalPage = await agentDiscoveryChanges(database, AGENT, firstPage.cursor);
      expect(finalPage.changes).toHaveLength(1);
      expect(finalPage.hasMore).toBe(false);
      await expect(agentDiscoveryChanges(database, AGENT, 'bad')).rejects.toThrow(/invalid discovery cursor/);
    } finally {
      await database.close();
    }
  });
});
