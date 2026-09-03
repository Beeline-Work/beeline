import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { joinRooms } from './membership-join.js';

const OWNER = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const LATE = 'e'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner',NULL),($2,'human','Member','member'),($3,'agent','Bee',NULL),($4,'human','Candy',NULL)`,
    [OWNER, MEMBER, AGENT, LATE],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,
    [ROOM, WORKSPACE, OWNER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),($1,NULL,$6,'member'),
      ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member')`,
    [WORKSPACE, OWNER, MEMBER, AGENT, ROOM, LATE],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
  return database;
}

type Line = {
  author_id: string;
  text: string;
  presentation: string;
  mention_ids: string[];
  card_type: string | null;
  system_event: Record<string, unknown> | null;
};
async function lines(database: PgliteDatabase, roomId = ROOM): Promise<Line[]> {
  return (
    await database.query<Line>(
      `SELECT author_id,text,presentation,mention_ids,card_type,system_event FROM messages
       WHERE room_id=$1 AND presentation IN ('system','card') ORDER BY created_at,id`,
      [roomId],
    )
  ).rows;
}

/**
 * Every producer phrases through `system-line.ts`: the text is the one grammar
 * and the structured event beside it names the subject (and object) so the
 * phone can render mentions and fold runs.
 */
describe('system-line producers', () => {
  it('phrases a membership join, a leave, and a removal', async () => {
    const database = await fixture();
    try {
      await joinRooms(database, {
        workspaceId: WORKSPACE,
        identityId: LATE,
        rooms: { type: 'rooms', roomIds: [ROOM] },
      });
      const phone = new PhoneService(database, 'http://local.test');
      await phone.execute('leaveRoom', { roomId: ROOM }, MEMBER);
      await phone.execute('removeRoomMember', { roomId: ROOM, memberId: LATE }, OWNER);
      expect(await lines(database)).toEqual([
        {
          author_id: LATE,
          text: 'Candy joined',
          presentation: 'system',
          mention_ids: [],
          card_type: 'member-joined',
          system_event: { subject: { kind: 'person', id: LATE, name: 'Candy' }, verb: 'joined' },
        },
        {
          author_id: MEMBER,
          text: 'Member left',
          presentation: 'system',
          mention_ids: [],
          card_type: 'member-left',
          system_event: { subject: { kind: 'person', id: MEMBER, name: 'Member' }, verb: 'left' },
        },
        {
          author_id: OWNER,
          text: 'Owner removed Candy',
          presentation: 'system',
          mention_ids: [],
          card_type: 'member-removed',
          system_event: {
            subject: { kind: 'person', id: OWNER, name: 'Owner' },
            verb: 'removed',
            object: { text: 'Candy', id: LATE },
          },
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it('phrases an agent removal in every live Room the agent was in', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      await phone.execute('removeAgent', { workspaceId: WORKSPACE, agentId: AGENT }, OWNER);
      expect(await lines(database)).toEqual([
        expect.objectContaining({
          author_id: OWNER,
          text: 'Owner removed Bee',
          card_type: 'member-removed',
          system_event: {
            subject: { kind: 'person', id: OWNER, name: 'Owner' },
            verb: 'removed',
            object: { text: 'Bee', id: AGENT },
          },
        }),
      ]);
    } finally {
      await database.close();
    }
  });

  it('phrases a yolo change with the agent as a tappable object', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      await phone.execute('updateAgentYolo', { workspaceId: WORKSPACE, agentId: AGENT, enabled: true }, OWNER);
      await phone.execute('updateAgentYolo', { workspaceId: WORKSPACE, agentId: AGENT, enabled: false }, OWNER);
      expect((await lines(database)).map((line) => [line.text, line.system_event])).toEqual([
        [
          'Owner turned yolo on for Bee · grant requests are now approved automatically',
          {
            subject: { kind: 'person', id: OWNER, name: 'Owner' },
            verb: 'turned yolo on for',
            object: { text: 'Bee', id: AGENT },
            consequence: 'grant requests are now approved automatically',
          },
        ],
        [
          'Owner turned yolo off for Bee · grant requests now ask before running',
          expect.objectContaining({ verb: 'turned yolo off for' }),
        ],
      ]);
    } finally {
      await database.close();
    }
  });

  it('phrases a failed turn, restates a retry in place, and settles it after success', async () => {
    const database = await fixture();
    try {
      const requestId = 'f'.repeat(64);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,mention_ids) VALUES($1,$2,$3,'@bee hi',$4::jsonb)`,
        [requestId, ROOM, OWNER, JSON.stringify([AGENT])],
      );
      const daemon = new DaemonService(database, new LiveHub());
      await daemon.execute(
        'postAgentTurnReceipt',
        { agentId: AGENT, roomId: ROOM, requestId, status: 'failed', reason: 'provider error 429' },
        AGENT,
      );
      await daemon.execute(
        'postAgentTurnReceipt',
        { agentId: AGENT, roomId: ROOM, requestId, status: 'failed', reason: 'timed out: after 120s' },
        AGENT,
      );
      const failed = await lines(database);
      expect(failed).toEqual([
        {
          author_id: AGENT,
          text: 'Bee could not answer · timed out: after 120s',
          presentation: 'system',
          mention_ids: [OWNER],
          card_type: 'turn-failed',
          system_event: {
            subject: { kind: 'agent', id: AGENT, name: 'Bee' },
            verb: 'could not answer',
            consequence: 'timed out: after 120s',
          },
        },
      ]);
      await daemon.execute(
        'postAgentTurnReceipt',
        { agentId: AGENT, roomId: ROOM, requestId, status: 'complete' },
        AGENT,
      );
      expect(await lines(database)).toEqual([
        expect.objectContaining({
          text: 'Bee answered after a retry',
          system_event: {
            subject: { kind: 'agent', id: AGENT, name: 'Bee' },
            verb: 'answered after a retry',
          },
        }),
      ]);
    } finally {
      await database.close();
    }
  });
});
