import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SYSTEM_IDENTITY_ID, DELETED_ACCOUNT_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { CONNECTOR_KINDS } from '@beeline/api-contract/workbench';
import { migrate, migrateData } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { directMessageRoomId, ensureSystemDirectMessageRoom } from './system-line.js';
import { PhoneService } from './phone-service.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OWNER = '1'.repeat(64);
const PEER = '2'.repeat(64);

describe('one System thread migration', () => {
  it('deletes all other bot DMs, their contents and connector identities; preserves conversations and System', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db, { deferData: true });
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline Review')`, [WORKSPACE]);
      await db.query(`INSERT INTO identities(id,kind,name,hidden_from_roster) VALUES
        ($1,'human','Owner',false),($2,'human','Peer',false),($3,'human','Deleted account',true)`,
        [OWNER, PEER, DELETED_ACCOUNT_IDENTITY_ID]);
      await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`,
        [WORKSPACE, OWNER, PEER]);
      const system = await ensureSystemDirectMessageRoom(db, WORKSPACE, OWNER);
      const bots = [...CONNECTOR_KINDS, 'composio'].map(type =>
        createHash('sha256').update(`beeline:connector-identity:${type}`).digest('hex'));
      const otherBot = '9'.repeat(64);
      const doomed: string[] = [];
      for (const bot of [...bots, otherBot]) {
        await db.query(`INSERT INTO identities(id,kind,name,hidden_from_roster) VALUES($1,'human','Old bot',true)`, [bot]);
        const id = directMessageRoomId(WORKSPACE, [bot, OWNER].sort() as [string, string]);
        doomed.push(id);
        await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants)
          VALUES($1,$2,$3,'Old bot DM',$4::jsonb)`, [id, WORKSPACE, bot, JSON.stringify([bot, OWNER].sort())]);
        await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, id, OWNER]);
        await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Old notice')`, [bot, id, bot]);
      }
      const phone = new PhoneService(db, 'http://local.test');
      const normal = await phone.execute('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: PEER }, OWNER);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Retained shared record')`,
        ['b'.repeat(64), normal.id, bots[0]]);
      const deletedConversation = directMessageRoomId(WORKSPACE, [OWNER, DELETED_ACCOUNT_IDENTITY_ID].sort() as [string, string]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Past conversation',$3::jsonb)`,
        [deletedConversation, WORKSPACE, JSON.stringify([OWNER, DELETED_ACCOUNT_IDENTITY_ID].sort())]);
      await migrateData(db);
      expect((await db.query('SELECT id FROM rooms WHERE id=ANY($1::uuid[])', [doomed])).rows).toEqual([]);
      expect((await db.query('SELECT id FROM messages WHERE id=ANY($1::text[])', [[...bots, otherBot]])).rows).toEqual([]);
      expect((await db.query('SELECT id FROM identities WHERE id=ANY($1::text[])', [bots])).rows).toEqual([]);
      expect((await db.query('SELECT author_id FROM messages WHERE id=$1', ['b'.repeat(64)])).rows)
        .toEqual([{ author_id: SYSTEM_IDENTITY_ID }]);
      expect((await db.query('SELECT id FROM rooms ORDER BY id')).rows.map(row => row.id).sort())
        .toEqual([system, normal.id, deletedConversation].sort());
      expect((await phone.readRoom(system, OWNER))?.viewer.permissions.send).toBe(false);
      await migrateData(db);
      expect((await db.query('SELECT 1 FROM rooms')).rowCount).toBe(3);
    } finally { await db.close(); }
  });
});
