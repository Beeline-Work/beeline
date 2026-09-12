import { createAgentCommand, claimAgentCommand } from './agent-command.js';
import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { joinRooms } from './membership-join.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

const OWNER = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const LATE = 'e'.repeat(64);
const MANAGER = 'f'.repeat(64);
const ADDED_AGENT = 'd'.repeat(64);
const HANDLELESS = '9'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner','owner'),($2,'human','Member','member'),($3,'agent','Bee','bee'),($4,'human','Candy','candy'),
      ($5,'human','Manager','manager'),($6,'agent','Scout','scout'),($7,'human','Unnamed',NULL)`,
    [OWNER, MEMBER, AGENT, LATE, MANAGER, ADDED_AGENT, HANDLELESS],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,
    [ROOM, WORKSPACE, OWNER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),($1,NULL,$6,'member'),($1,NULL,$7,'admin'),($1,NULL,$8,'member'),
      ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member'),($1,$5,$8,'member')`,
    [WORKSPACE, OWNER, MEMBER, AGENT, ROOM, LATE, MANAGER, HANDLELESS],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2),($3,$2)`, [
    AGENT,
    OWNER,
    ADDED_AGENT,
  ]);
  return database;
}

type Line = {
  author_id: string;
  text: string;
  presentation: string;
  woke: string[];
  card_type: string | null;
  system_event: Record<string, unknown> | null;
};
async function lines(database: PgliteDatabase, roomId = ROOM): Promise<Line[]> {
  return (
    await database.query<Line>(
      `SELECT author_id,text,presentation,card_type,system_event,
         ARRAY(SELECT agent_id FROM agent_commands WHERE source_message_id=messages.id) woke
       FROM messages
       WHERE room_id=$1 AND presentation IN ('system','card') ORDER BY created_at,id`,
      [roomId],
    )
  ).rows;
}

async function workspaceLineCounts(
  database: PgliteDatabase,
  cardTypes: readonly string[],
): Promise<Array<{ text: string; author_id: string; count: number }>> {
  return (
    await database.query<{ text: string; author_id: string; count: number }>(
      `SELECT message.text,message.author_id,count(*)::int count
       FROM messages message JOIN rooms room ON room.id=message.room_id
       WHERE room.workspace_id=$1 AND room.direct_participants IS NOT NULL
         AND message.card_type=ANY($2::text[])
       GROUP BY message.text,message.author_id ORDER BY message.text`,
      [WORKSPACE, [...cardTypes]],
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
        invitedById: OWNER,
        rooms: { type: 'rooms', roomIds: [ROOM] },
      });
      const phone = new PhoneService(database, 'http://local.test');
      await phone.execute('leaveRoom', { roomId: ROOM }, MEMBER);
      await phone.execute('removeRoomMember', { roomId: ROOM, memberId: LATE }, OWNER);
      expect(await lines(database)).toEqual([
        {
          author_id: LATE,
          text: '@candy joined · invited by @owner',
          presentation: 'system',
          woke: [],
          card_type: 'member-joined',
          // The kind is additive: the TEXT above is byte-identical to what this
          // producer wrote before events existed. Verbs are prose; kinds are
          // the contract, and they never meet in the sentence.
          system_event: {
            subject: { kind: 'person', id: LATE, name: '@candy' },
            verb: 'joined',
            consequence: 'invited by @owner',
            kind: 'joined',
          },
        },
        {
          author_id: MEMBER,
          text: '@member left',
          presentation: 'system',
          woke: [],
          card_type: 'member-left',
          system_event: { subject: { kind: 'person', id: MEMBER, name: '@member' }, verb: 'left' },
        },
        {
          author_id: OWNER,
          text: '@owner removed @candy',
          presentation: 'system',
          woke: [],
          card_type: 'member-removed',
          system_event: {
            subject: { kind: 'person', id: OWNER, name: '@owner' },
            verb: 'removed',
            object: { text: '@candy', id: LATE },
          },
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it('keeps a handleless inviter in membership history without a dangling join attribution', async () => {
    const database = await fixture();
    try {
      await joinRooms(database, {
        workspaceId: WORKSPACE,
        identityId: LATE,
        invitedById: HANDLELESS,
        rooms: { type: 'rooms', roomIds: [ROOM] },
      });
      expect((await lines(database)).map((line) => line.text)).toEqual(['@candy joined']);
      expect(
        (
          await database.query<{ invited_by: string | null }>(
            `SELECT invited_by FROM memberships WHERE room_id=$1 AND identity_id=$2`,
            [ROOM, LATE],
          )
        ).rows,
      ).toEqual([{ invited_by: HANDLELESS }]);
    } finally {
      await database.close();
    }
  });

  it('attributes an added agent to the manager without changing its connected owner', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      await phone.execute(
        'addWorkspaceMember',
        { workspaceId: WORKSPACE, memberId: ADDED_AGENT, role: 'member' },
        MANAGER,
      );
      await phone.execute('addRoomMember', { roomId: ROOM, memberId: ADDED_AGENT }, MANAGER);
      expect((await lines(database)).map((line) => line.text)).toEqual([
        '@scout joined · invited by @manager',
      ]);
      expect(
        (
          await database.query<{ owner_id: string }>(
            `SELECT owner_id FROM agents WHERE agent_id=$1`,
            [ADDED_AGENT],
          )
        ).rows,
      ).toEqual([{ owner_id: OWNER }]);
    } finally {
      await database.close();
    }
  });

  it('omits the possessive target when changing a handleless member role', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      await phone.execute(
        'addWorkspaceMember',
        { workspaceId: WORKSPACE, memberId: HANDLELESS, role: 'admin' },
        OWNER,
      );
      expect(await lines(database)).toEqual([]);
      expect(await workspaceLineCounts(database, ['member-role'])).toEqual([
        {
          author_id: SYSTEM_IDENTITY_ID,
          text: '@owner changed role to admin',
          count: 5,
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it("routes an agent Workspace removal to each person's @system DM", async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      await phone.execute('removeAgent', { workspaceId: WORKSPACE, agentId: AGENT }, OWNER);
      expect(await lines(database)).toEqual([]);
      expect(await workspaceLineCounts(database, ['member-removed'])).toEqual([
        { author_id: SYSTEM_IDENTITY_ID, text: '@owner removed @bee', count: 5 },
      ]);
    } finally {
      await database.close();
    }
  });

  it('phrases a yolo change with the agent as a tappable object', async () => {
    const database = await fixture();
    try {
      await database.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [AGENT]);
      const phone = new PhoneService(database, 'http://local.test');
      await phone.execute(
        'updateAgentYolo',
        { workspaceId: WORKSPACE, agentId: AGENT, enabled: true },
        OWNER,
      );
      await phone.execute(
        'updateAgentYolo',
        { workspaceId: WORKSPACE, agentId: AGENT, enabled: false },
        OWNER,
      );
      expect((await lines(database)).map((line) => [line.text, line.system_event])).toEqual([
        [
          '@owner turned yolo on for @bee · grant requests are now approved automatically',
          {
            subject: { kind: 'person', id: OWNER, name: '@owner' },
            verb: 'turned yolo on for',
            object: { text: '@bee', id: AGENT },
            consequence: 'grant requests are now approved automatically',
          },
        ],
        [
          '@owner turned yolo off for @bee · grant requests now ask before running',
          expect.objectContaining({ verb: 'turned yolo off for' }),
        ],
      ]);
    } finally {
      await database.close();
    }
  });

  it('names the acting human on model, role, and visibility changes', async () => {
    const database = await fixture();
    try {
      await database.query(
        `UPDATE agents SET selected_model='sonnet',model_catalog=$2::jsonb WHERE agent_id=$1`,
        [
          AGENT,
          JSON.stringify([
            {
              id: 'model',
              category: 'model',
              currentValue: 'sonnet',
              options: [
                { id: 'sonnet', name: 'Sonnet' },
                { id: 'codex', name: 'Codex' },
              ],
            },
          ]),
        ],
      );
      const phone = new PhoneService(database, 'http://local.test');
      await phone.execute(
        'updateAgentModelSelection',
        { workspaceId: WORKSPACE, agentId: AGENT, model: 'codex' },
        OWNER,
      );
      await phone.execute(
        'addWorkspaceMember',
        { workspaceId: WORKSPACE, memberId: MEMBER, role: 'admin' },
        OWNER,
      );
      await phone.execute(
        'updateWorkspace',
        { workspaceId: WORKSPACE, visibility: 'public' },
        OWNER,
      );
      expect((await lines(database)).map((line) => line.text)).toEqual([
        "@owner changed @bee's model to Codex",
      ]);
      expect(await workspaceLineCounts(database, ['member-role', 'workspace-visibility'])).toEqual([
        {
          author_id: SYSTEM_IDENTITY_ID,
          text: "@owner changed @member's role to admin",
          count: 5,
        },
        {
          author_id: SYSTEM_IDENTITY_ID,
          text: '@owner changed workspace visibility to public',
          count: 5,
        },
      ]);
    } finally {
      await database.close();
    }
  });

  it('writes one Room visibility line for concurrent identical updates', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      await Promise.all([
        phone.execute('updateRoom', { roomId: ROOM, visibility: 'public' }, OWNER),
        phone.execute('updateRoom', { roomId: ROOM, visibility: 'public' }, OWNER),
      ]);
      expect((await lines(database)).map((line) => line.text)).toEqual([
        '@owner changed room visibility to public',
      ]);
    } finally {
      await database.close();
    }
  });

  it('phrases a failed turn once and rejects a stale retry', async () => {
    const database = await fixture();
    try {
      const requestId = 'f'.repeat(64);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@bee hi')`,
        [requestId, ROOM, OWNER],
      );
      const command = await database.transaction((tx) =>
        createAgentCommand(tx, {
          roomId: ROOM,
          agentId: AGENT,
          sourceMessageId: requestId,
          reason: 'fixture',
        }),
      );
      await claimAgentCommand(database, ROOM, AGENT, command!.id, 'g1');
      const daemon = new DaemonService(database, new LiveHub());
      await daemon.execute(
        'postAgentTurnReceipt',
        {
          agentId: AGENT,
          roomId: ROOM,
          requestId,
          generationId: 'g1',
          status: 'failed',
          reason: 'provider error 429',
        },
        AGENT,
      );
      await expect(
        daemon.execute(
          'postAgentTurnReceipt',
          {
            agentId: AGENT,
            roomId: ROOM,
            requestId,
            generationId: 'g1',
            status: 'failed',
            reason: 'timed out: after 120s',
          },
          AGENT,
        ),
      ).rejects.toThrow('authority rejected');
      const failed = await lines(database);
      expect(failed).toEqual([
        {
          author_id: AGENT,
          text: '@bee could not answer · provider error 429',
          presentation: 'system',
          woke: [],
          card_type: 'turn-failed',
          system_event: {
            subject: { kind: 'agent', id: AGENT, name: '@bee' },
            verb: 'could not answer',
            consequence: 'provider error 429',
          },
        },
      ]);
      await expect(
        daemon.execute(
          'postAgentTurnReceipt',
          { agentId: AGENT, roomId: ROOM, requestId, generationId: 'g1', status: 'complete' },
          AGENT,
        ),
      ).resolves.toBeDefined();
      expect(await lines(database)).toEqual(failed);
    } finally {
      await database.close();
    }
  });
});
