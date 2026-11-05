import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentCommand, claimAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111119';
const ROOM = '22222222-2222-4222-8222-222222222229';
const REQUEST = 'd'.repeat(64);
const GENERATION = 'steps-generation';

const STEPS = [
  { kind: 'note', title: 'Note', text: 'Now close the Play declaration corner.' },
  { kind: 'tool', title: 'ToolSearch', operation: 'other', status: 'completed' },
  { kind: 'tool', title: 'close_corner', operation: 'other', status: 'completed' },
] as const;

describe('a Room reply’s steps', () => {
  let database: PgliteDatabase;
  let daemon: DaemonService;

  beforeEach(async () => {
    database = await migratedDatabase();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Human','human'),($2,'agent','Agent','agent')`,
      [HUMAN, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Steps')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@agent close it')`,
      [REQUEST, ROOM, HUMAN],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: REQUEST,
      reason: 'human_tag',
    });
    await claimAgentCommand(database, ROOM, AGENT, command!.id, GENERATION);
    daemon = new DaemonService(
      database,
      new LiveHub(),
      undefined,
      undefined,
      false,
      undefined,
      true,
      'machine-test',
    );
  });

  afterEach(async () => database.close());

  const reply = (input: Record<string, unknown>) =>
    daemon.execute(
      'postRoomMessage',
      {
        roomId: ROOM,
        requestId: REQUEST,
        generationId: GENERATION,
        text: 'I closed the Play declaration corner.',
        ...input,
      } as never,
      AGENT,
    );

  const stored = async () =>
    (
      await database.query<{ text: string; presentation: string; activity: unknown }>(
        `SELECT text,presentation,activity FROM messages WHERE room_id=$1 AND author_id=$2`,
        [ROOM, AGENT],
      )
    ).rows;

  it('stores the steps, in order, on the reply message itself', async () => {
    await reply({ steps: STEPS });
    expect(await stored()).toEqual([
      {
        text: 'I closed the Play declaration corner.',
        presentation: 'message',
        activity: STEPS,
      },
    ]);
  });

  it('stores one long run split across continuing notes', async () => {
    const steps = [
      { kind: 'note', title: 'Note', text: 'x'.repeat(16_000) },
      { kind: 'note', title: 'Note', text: 'y'.repeat(14), continues: true },
    ];
    await reply({ steps });
    expect((await stored())[0]!.activity).toEqual(steps);
  });

  it('a reply without steps stores none', async () => {
    await reply({});
    expect((await stored())[0]!.activity).toBeNull();
  });

  it.each([
    ['an output row', [{ kind: 'output', title: 'Update', text: 'prose' }]],
    ['an empty note', [{ kind: 'note', title: 'Note', text: '' }]],
    ['an oversized note', [{ kind: 'note', title: 'Note', text: 'x'.repeat(16_001) }]],
    ['a tool marked as continuing', [{ ...STEPS[1], continues: true }]],
    ['too many steps', Array.from({ length: 2_001 }, () => STEPS[1])],
    [
      'a payload over 4 MB',
      Array.from({ length: 260 }, () => ({ kind: 'note', title: 'Note', text: 'x'.repeat(16_000) })),
    ],
  ])('refuses %s and posts nothing', async (_name, steps) => {
    await expect(reply({ steps })).rejects.toThrow('reply steps are invalid');
    expect(await stored()).toEqual([]);
  });
});
