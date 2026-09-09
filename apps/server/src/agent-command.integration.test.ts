import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createAgentCommand, nextAgentDepth, routeSystemCommand } from './agent-command.js';
import { systemLine } from './system-line.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
const H = 'a'.repeat(64),
  A = 'b'.repeat(64),
  B = 'c'.repeat(64),
  P = 'd'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  C = '33333333-3333-4333-8333-333333333333';
const id = () => randomBytes(32).toString('hex');
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;
const commands = (agentId = A, roomId = R) =>
  daemon.execute('getAgentCommands', { roomId }, agentId).then((r) => r.commands);
const send = (text: string, roomId = R) => phone.execute('sendRoomMessage', { roomId, text }, H);
async function claim(c: AgentCommand, generationId = 'g1') {
  await daemon.execute(
    'claimAgentCommand',
    { roomId: c.roomId, commandId: c.id, generationId },
    c.agentId,
  );
  await daemon.execute(
    'postAgentTurnReceipt',
    {
      roomId: c.roomId,
      agentId: c.agentId,
      requestId: c.turnRequestId,
      generationId,
      status: 'working',
    },
    c.agentId,
  );
}
const result = (
  c: AgentCommand,
  text: string,
  delegateAgentIds: string[] = [],
  generationId = 'g1',
  extra = {},
) =>
  daemon.execute(
    'postRoomMessage',
    {
      roomId: c.roomId,
      requestId: c.turnRequestId,
      generationId,
      text,
      delegateAgentIds,
      ...extra,
    },
    c.agentId,
  );
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Hoots','hoots'),($3,'agent','Goosy','goosy'),($4,'human','Person','person')`,
    [H, A, B, P],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [A, B, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Commands')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [
    R,
    C,
    W,
  ]);
  await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [R, C]);
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Do work','{"checks":"unknown"}')`,
    [C, B],
  );
  for (const who of [H, A, B, P])
    for (const room of [null, R, C])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  for (const agent of [A, B])
    await db.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}') ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
      [R, agent],
    );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);
afterAll(async () => db?.close());
beforeEach(async () => {
  await db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
     VALUES($1,$2,'presence','presence','{"status":"online"}'),
           ($1,$3,'presence','presence','{"status":"online"}')
     ON CONFLICT(room_id,agent_id,turn_id,kind)
     DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
    [R, A, B],
  );
  await db.query(`DELETE FROM live_outputs WHERE kind<>'presence'`);
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM agent_turns`);
  await db.query(`UPDATE agents SET access_policy='{"type":"everyone"}'::jsonb`);
  await db.query(`UPDATE memberships SET removed_at=NULL`);
});

describe.each([R, C])('server command authority in %s', (room) => {
  it('replays the exact Hoots/Goosy incident without remembered-responder work', async () => {
    await send('@hoots ask Goosy', room);
    const [first] = await commands(A, room);
    expect(first).toBeDefined();
    await claim(first!);
    await result(first!, '@goosy please help', [B]);
    const [delegated] = await commands(B, room);
    expect(delegated?.agentDepth).toBe(1);
    await claim(delegated!);
    await result(delegated!, 'Here is the answer');
    expect(await commands(A, room)).toEqual([]);
    await send('@hoots explain tags', room);
    const [next] = await commands(A, room);
    await claim(next!);
    await result(next!, 'Tag @goosy and Goosy answers', [], 'g1', { mentionIds: [B] });
    expect(await commands(B, room)).toEqual([]);
    await send('Thanks everyone', room);
    expect(await commands(A, room)).toEqual([]);
    expect(await commands(B, room)).toEqual([]);
  });
  it('allows depths zero through three and refuses a fourth dispatch', async () => {
    await send('@hoots start', room);
    let [c] = await commands(A, room);
    const root = c!.id;
    for (let depth = 0; depth <= 3; depth++) {
      expect(c!.agentDepth).toBe(depth);
      expect(c!.rootCommandId).toBe(root);
      await claim(c!);
      const target = c!.agentId === A ? B : A;
      await result(c!, `depth ${depth}`, [target]);
      const next = await commands(target, room);
      if (depth === 3) expect(next).toEqual([]);
      else c = next[0];
    }
  });
  it('routes human reply as fresh intent and structured agent reply only within the chain', async () => {
    await send('@hoots start', room);
    const [a] = await commands(A, room);
    await claim(a!);
    const posted = await result(a!, 'Delegation', [B]);
    const [b] = await commands(B, room);
    await claim(b!);
    const reply = await result(b!, 'Deliberate reply', [], 'g1', { replyToMessageId: posted.id });
    expect((await commands(A, room))[0]?.agentDepth).toBe(2);
    await db.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [B]);
    await phone.execute(
      'sendRoomReply',
      { roomId: room, parentMessageId: reply.id, text: 'Continue' },
      H,
    );
    expect((await commands(B, room))[0]?.agentDepth).toBe(0);
  });
});
it('resolves multiple natural tags and ignores human-only and unknown tags', async () => {
  await send('@hoots and @goosy');
  expect(await commands(A)).toHaveLength(1);
  expect(await commands(B)).toHaveLength(1);
  await send('@person @missing');
  expect(await commands(A)).toHaveLength(1);
  const human = await send('Human text');
  await phone.execute(
    'sendRoomReply',
    { roomId: R, parentMessageId: human.messageId, text: 'Reply' },
    H,
  );
  expect(await commands(A)).toHaveLength(1);
});
it('routes a direct message without redundant tags or a presence row', async () => {
  await db.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`, [
    R,
    JSON.stringify([H, A]),
  ]);
  try {
    await db.query(`DELETE FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [A]);
    await send('Hello');
    expect((await commands(A))[0]?.reason).toBe('direct_message');
    expect(await commands(B)).toEqual([]);
  } finally {
    await db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`, [R]);
  }
});
it('does not route a removed target or refused human', async () => {
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    B,
  ]);
  await send('@goosy');
  expect(await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [B])).toMatchObject({
    rowCount: 0,
  });
  await db.query(`UPDATE agents SET access_policy='{"type":"creator"}'::jsonb WHERE agent_id=$1`, [
    A,
  ]);
  await phone.execute('sendRoomMessage', { roomId: R, text: '@hoots' }, P);
  expect(await commands(A)).toEqual([]);
});
it('deduplicates human writes, claims and final results', async () => {
  const messageId = id();
  for (let n = 0; n < 2; n++)
    await phone.execute('sendRoomMessage', { roomId: R, text: '@hoots', messageId }, H);
  expect(
    (
      await db.query(
        `SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2 AND state='pending'`,
        [messageId, A],
      )
    ).rowCount,
  ).toBe(1);
  const [c] = await commands();
  await claim(c!);
  const attempts = await Promise.allSettled(
    ['g2', 'g3'].map((generationId) =>
      daemon.execute('claimAgentCommand', { roomId: R, commandId: c!.id, generationId }, A),
    ),
  );
  expect(attempts.every((a) => a.status === 'rejected')).toBe(true);
  const one = await result(c!, 'Done', [B]);
  const two = await result(c!, 'Done', [B]);
  expect(two.id).toBe(one.id);
  expect(await commands(B)).toHaveLength(1);
});
it('redelivers the same expired command, rejects late generation and keeps successor output', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  await db.query(
    `UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [c!.id],
  );
  expect((await commands())[0]?.id).toBe(c!.id);
  await claim(c!, 'g2');
  await expect(result(c!, 'Late')).rejects.toThrow('authority');
  await result(c!, 'Current', [], 'g2');
  await expect(result(c!, 'Late')).rejects.toThrow('authority');
});
it('heartbeats extend only the matching generation lease', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  const receipt = {
    roomId: R,
    agentId: A,
    requestId: c!.turnRequestId,
    status: 'working' as const,
    heartbeat: true,
  };
  await expect(
    daemon.execute('postAgentTurnReceipt', { ...receipt, generationId: 'wrong' }, A),
  ).rejects.toThrow('authority');
  await daemon.execute('postAgentTurnReceipt', { ...receipt, generationId: 'g1' }, A);
  expect(
    (
      await db.query<{ future: boolean }>(
        `SELECT lease_expires_at>now()+interval '80 seconds' future FROM agent_commands WHERE id=$1`,
        [c!.id],
      )
    ).rows[0]?.future,
  ).toBe(true);
});
it('rejects unknown, wrong agent, cross-Room, completed and cancelled turn output without side effects', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  const draft = {
    roomId: R,
    agentId: A,
    turnId: c!.turnRequestId,
    generationId: 'g1',
    text: 'draft',
  };
  await expect(daemon.execute('postAgentDraft', { ...draft, turnId: id() }, A)).rejects.toThrow();
  await expect(daemon.execute('postAgentDraft', { ...draft, roomId: C }, A)).rejects.toThrow();
  await expect(daemon.execute('postAgentDraft', { ...draft, agentId: B }, B)).rejects.toThrow();
  await daemon.execute('postAgentDraft', draft, A);
  await phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: c!.turnRequestId }, H);
  await expect(result(c!, 'Stopped')).rejects.toThrow();
  await expect(daemon.execute('postAgentDraft', draft, A)).rejects.toThrow();
  expect((await commands())[0]?.action).toBe('stop');
  await send('@hoots next');
  const [next] = (await commands()).filter((c) => c.action === 'input');
  await claim(next!);
  await result(next!, 'Done');
  await expect(
    daemon.execute('postAgentDraft', { ...draft, turnId: next!.turnRequestId }, A),
  ).rejects.toThrow();
});
it('stores deliberate tool delegation separately from prose mentions', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  await daemon.execute(
    'stageAgentDelegation',
    { roomId: R, requestId: c!.turnRequestId, generationId: 'g1', targetAgentId: B },
    A,
  );
  expect(await commands(B)).toEqual([]);
  await result(c!, 'Please help');
  expect(await commands(B)).toHaveLength(1);
});
it('rolls final storage back if creating the next command fails', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  await db.query(`CREATE FUNCTION refuse_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected dispatch failure'; END $$;
 CREATE TRIGGER refuse_command BEFORE INSERT ON agent_commands FOR EACH ROW EXECUTE FUNCTION refuse_command();`);
  try {
    await expect(result(c!, 'Atomic', [B])).rejects.toThrow('injected');
    expect((await db.query(`SELECT 1 FROM messages WHERE text='Atomic'`)).rowCount).toBe(0);
  } finally {
    await db.query(
      `DROP TRIGGER refuse_command ON agent_commands; DROP FUNCTION refuse_command();`,
    );
  }
  await result(c!, 'Atomic', [B]);
  expect(await commands(B)).toHaveLength(1);
});
it('gives old helpers only projected commands and refuses unsolicited old output', async () => {
  await send('@hoots');
  await send('ordinary traffic');
  const a = await daemon.execute('getRoomInbox', { roomId: R, startAtLatest: true }, A);
  const b = await daemon.execute('getRoomInbox', { roomId: R, startAtLatest: true }, B);
  expect(a.items).toHaveLength(1);
  expect(a.items[0]?.mentionIds).toEqual([A]);
  expect(b.items).toEqual([]);
  await expect(
    daemon.execute(
      'postRoomMessage',
      { roomId: R, text: 'Unsolicited', requestId: a.items[0]!.id },
      B,
    ),
  ).rejects.toThrow();
});
it('routes subscribed events, grants and changed corner checks through actions', async () => {
  await daemon.execute('setEventSubscriptions', { roomId: R, kinds: ['joined'] }, A);
  await systemLine(db, {
    roomId: R,
    subject: { kind: 'person', id: H, name: 'Human' },
    verb: 'joined',
    kind: 'joined',
  });
  expect((await commands())[0]?.reason).toBe('subscribed_event');
  const [c] = await commands();
  await claim(c!);
  const source = await send('Grant decision');
  await db.transaction((tx) =>
    routeSystemCommand(tx, {
      roomId: R,
      sourceMessageId: source.messageId,
      targets: [A],
      kind: 'grant-decided',
      commandId: c!.id,
    }),
  );
  const [resume] = await commands();
  expect(resume?.action).toBe('resume');
  expect(resume?.turnRequestId).toBe(c!.turnRequestId);
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"checks":"passing"}',command_check_state=NULL WHERE corner_id=$1`,
    [C],
  );
  for (let n = 0; n < 2; n++)
    await systemLine(db, {
      roomId: C,
      subject: { kind: 'person', id: H, name: 'Human' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
  expect(await commands(B, C)).toHaveLength(1);
  expect((await commands(B, C))[0]?.reason).toBe('corner_check');
});
it('transfers a corner objective without resetting the authorized chain', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  const opened = await daemon.execute(
    'createCorner',
    {
      roomId: R,
      requestId: c!.turnRequestId,
      generationId: 'g1',
      name: 'Task',
      objective: 'Do this task',
    },
    A,
  );
  const [objective] = await commands(A, opened.cornerId);
  expect(objective?.reason).toBe('corner_objective');
  expect(objective?.rootCommandId).toBe(c!.id);
  expect(await commands(B, opened.cornerId)).toEqual([]);
});
it('makes the depth boundary explicit', () => {
  expect([0, 1, 2, 3].map(nextAgentDepth)).toEqual([1, 2, 3, undefined]);
});

it.each(['absent', 'stale', 'offline'] as const)(
  'keeps exactly one pending command while helper presence is %s and permits claim after return',
  async (presence) => {
    if (presence === 'absent')
      await db.query(`DELETE FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [A]);
    else if (presence === 'stale')
      await db.query(
        `UPDATE live_outputs SET body='{"status":"online"}',updated_at=now()-interval '10 minutes' WHERE agent_id=$1 AND kind='presence'`,
        [A],
      );
    else
      await db.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [A]);

    const messageId = id();
    for (let attempt = 0; attempt < 2; attempt++)
      await phone.execute(
        'sendRoomMessage',
        { roomId: R, text: '@hoots are you there?', messageId },
        H,
      );
    expect(
      (
        await db.query<{ state: string }>(
          `SELECT state FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`,
          [messageId, A],
        )
      ).rows,
    ).toEqual([{ state: 'pending' }]);

    await db.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       VALUES($1,$2,'presence','presence','{"status":"online"}')
       ON CONFLICT(room_id,agent_id,turn_id,kind)
       DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
      [R, A],
    );
    const [command] = await commands();
    expect(command?.sourceMessageId).toBe(messageId);
    await daemon.execute(
      'claimAgentCommand',
      { roomId: R, commandId: command!.id, generationId: `return-${presence}` },
      A,
    );
    expect(
      (
        await db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [
          command!.id,
        ])
      ).rows[0]?.state,
    ).toBe('claimed');
  },
);

it('still presents an offline notice without dropping the durable command', async () => {
  await db.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [A]);
  const source = await send('@hoots are you there?');
  expect(await commands()).toHaveLength(1);
  expect(
    (
      await db.query(
        `SELECT text FROM messages WHERE room_id=$1 AND presentation='system' AND text LIKE '%helper is offline%'`,
        [R],
      )
    ).rowCount,
  ).toBeGreaterThan(0);
  expect((await db.query(`SELECT 1 FROM messages WHERE id=$1`, [source.messageId])).rowCount).toBe(
    1,
  );
});
it('selects exactly one winner when two generations claim a pending command together', async () => {
  await send('@hoots');
  const [c] = await commands();
  const attempts = await Promise.allSettled(
    ['race-a', 'race-b'].map((generationId) =>
      daemon.execute('claimAgentCommand', { roomId: R, commandId: c!.id, generationId }, A),
    ),
  );
  expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter((a) => a.status === 'rejected')).toHaveLength(1);
});
it('atomically establishes the working receipt when an input command is claimed', async () => {
  await send('@hoots');
  const [c] = await commands();
  await daemon.execute(
    'claimAgentCommand',
    { roomId: R, commandId: c!.id, generationId: 'working-at-claim' },
    A,
  );
  expect(
    (
      await db.query(
        `SELECT status,generation_id FROM agent_turns
         WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
        [R, c!.turnRequestId, A],
      )
    ).rows,
  ).toEqual([{ status: 'working', generation_id: 'working-at-claim' }]);
  expect((await phone.readRoom(R, H))?.latestAgentTurns).toContainEqual(
    expect.objectContaining({
      requestId: c!.turnRequestId,
      agentPubkey: A,
      status: 'working',
    }),
  );
});
it('rolls the command claim back when a cancelled turn cannot become working', async () => {
  await send('@hoots');
  const [c] = await commands();
  await db.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status)
     VALUES($1,$2,$3,'cancelled')`,
    [R, c!.turnRequestId, A],
  );
  await expect(
    daemon.execute(
      'claimAgentCommand',
      { roomId: R, commandId: c!.id, generationId: 'too-late' },
      A,
    ),
  ).rejects.toThrow('cancelled');
  expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [c!.id])).rows).toEqual([
    { state: 'pending' },
  ]);
});
it('never reopens terminal commands and never accepts missing generation claims', async () => {
  await send('@hoots');
  const [c] = await commands();
  await expect(
    daemon.execute('claimAgentCommand', { roomId: R, commandId: c!.id } as never, A),
  ).rejects.toThrow();
  await claim(c!);
  await result(c!, 'Terminal');
  await expect(claim(c!, 'another')).rejects.toThrow();
});
it('rechecks delegated membership at final commit, including staged targets', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  await daemon.execute(
    'stageAgentDelegation',
    { roomId: R, requestId: c!.turnRequestId, generationId: 'g1', targetAgentId: B },
    A,
  );
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    B,
  ]);
  await result(c!, 'No target remains', [B]);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [B])).rowCount).toBe(0);
});
it('binds emitted events to the issuing command when agents share a human request', async () => {
  await send('@hoots @goosy');
  const [a] = await commands(A),
    [b] = await commands(B);
  await claim(a!);
  await claim(b!);
  const event = await daemon.execute(
    'postRoomEvent',
    {
      roomId: R,
      requestId: a!.turnRequestId,
      generationId: 'g1',
      kind: 'agent:handoff',
      consequence: 'Ready',
      mentionAgentIds: [B],
    },
    A,
  );
  const [child] = (await commands(B)).filter((c) => c.sourceMessageId === event.id);
  expect(child?.parentCommandId).toBe(a!.id);
  expect(child?.agentDepth).toBe(1);
});

it.each(['unknown', 'wrong-agent', 'wrong-room', 'stale', 'cancelled', 'completed'])(
  'rejects every output surface for %s authority',
  async (invalid) => {
    await send('@hoots');
    const [c] = await commands();
    await claim(c!);
    const input = {
      roomId: R,
      agentId: A,
      requestId: c!.turnRequestId,
      turnId: c!.turnRequestId,
      generationId: 'g1',
    };
    let author = A;
    if (invalid === 'unknown') {
      input.requestId = id();
      input.turnId = input.requestId;
    }
    if (invalid === 'wrong-agent') {
      author = B;
      input.agentId = B;
    }
    if (invalid === 'wrong-room') input.roomId = C;
    if (invalid === 'stale') input.generationId = 'stale';
    if (invalid === 'cancelled')
      await phone.execute(
        'cancelAgentTurn',
        { roomId: R, agentId: A, requestId: c!.turnRequestId },
        H,
      );
    if (invalid === 'completed') await result(c!, 'Already done');
    const writes = [
      ['postAgentDraft', { text: 'Late draft' }],
      ['postAgentThought', { text: 'Late thought' }],
      [
        'postAgentActivity',
        { activity: [{ kind: 'thinking', title: 'Late', status: 'in_progress' }] },
      ],
      [
        'postAgentAttachment',
        {
          attachment: {
            url: 'http://test/v1/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            name: 'file.txt',
            mimeType: 'text/plain',
            size: 1,
          },
        },
      ],
      ['postRoomMessage', { text: 'Late final' }],
    ] as const;
    const before = (await db.query(`SELECT count(*)::int n FROM messages`)).rows[0];
    for (const [operation, payload] of writes)
      await expect(
        daemon.execute(operation, { ...input, ...payload } as never, author),
      ).rejects.toThrow();
    expect((await db.query(`SELECT count(*)::int n FROM messages`)).rows[0]).toEqual(before);
  },
);
it('accepts and settles draft, thought, activity, attachment and final under one claimed generation', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  const input = {
    roomId: R,
    agentId: A,
    requestId: c!.turnRequestId,
    turnId: c!.turnRequestId,
    generationId: 'g1',
  };
  await daemon.execute('postAgentDraft', { ...input, text: 'Draft' }, A);
  await daemon.execute('postAgentThought', { ...input, text: 'Thought' }, A);
  await daemon.execute(
    'postAgentActivity',
    { ...input, activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }] },
    A,
  );
  const media = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await db.query(
    `INSERT INTO media(id,owner_id,bytes,mime_type,name,sha256) VALUES($1,$2,$3,'text/plain','result.txt',$4) ON CONFLICT(id) DO NOTHING`,
    [media, A, Buffer.from('ok'), id()],
  );
  await daemon.execute(
    'postAgentAttachment',
    {
      ...input,
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'result.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    A,
  );
  const final = await result(c!, 'With attachment');
  const saved = (
    await db.query<{ attachments: unknown[] }>(`SELECT attachments FROM messages WHERE id=$1`, [
      final.id,
    ])
  ).rows[0]!;
  expect(saved.attachments).toHaveLength(1);
  expect(
    (
      await db.query(
        `SELECT 1 FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND kind IN ('draft','thought')`,
        [R, A],
      )
    ).rowCount,
  ).toBe(0);
});

it('stores an ambiguous agent tag as prose without dispatching either candidate', async () => {
  await db.query(`UPDATE identities SET handle='hoots' WHERE id=$1`, [B]);
  try {
    const source = await send('@hoots who is this?');
    expect(await commands(A)).toEqual([]);
    expect(await commands(B)).toEqual([]);
    expect(
      (await db.query(`SELECT text FROM messages WHERE id=$1`, [source.messageId])).rows[0]?.text,
    ).toBe('@hoots who is this?');
  } finally {
    await db.query(`UPDATE identities SET handle='goosy' WHERE id=$1`, [B]);
  }
});
