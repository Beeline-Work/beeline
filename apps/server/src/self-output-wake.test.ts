import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import { LiveHub } from './live.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import { reportToCommander } from './commander.js';
import { setRoomEventSubscriptions } from './agent-subscriptions.js';
import { systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { refreshCornerAttention } from './corner-attention.js';
import { describedWorkflow } from './test-support.js';
import { saveWorkflow, startWorkflow } from './workflow-runs.js';

const HUMAN = 'a'.repeat(64),
  AGENT = 'b'.repeat(64),
  OTHER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase, phone: PhoneService, daemon: HelperDaemonService;
beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Person','person'),($2,'agent','Worker','worker'),($3,'agent','Commander','commander')`,
    [HUMAN, AGENT, OTHER],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    AGENT,
    OTHER,
    HUMAN,
  ]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Self output proof')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Work')`, [ROOM, WORKSPACE]);
  for (const who of [HUMAN, AGENT, OTHER]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`,
      [WORKSPACE, ROOM, who],
    );
  }
  phone = new PhoneService(db, 'http://test');
  daemon = new HelperDaemonService(db, new LiveHub());
}, 30_000);
afterAll(async () => db?.close());

it('SELF-OUTPUT: its own corner assignment queues once; posts and reports queue no extra turns', async () => {
  const source = randomBytes(32).toString('hex');
  await phone.execute(
    'sendRoomMessage',
    { roomId: ROOM, messageId: source, text: '@worker align the glyphs' },
    HUMAN,
  );
  const incoming = (
    await daemon.execute('getAgentCommands', { roomId: ROOM }, AGENT)
  ).commands.find((c) => c.sourceMessageId === source)!;
  await daemon.execute(
    'claimAgentCommand',
    { roomId: ROOM, commandId: incoming.id, generationId: 'self-proof' },
    AGENT,
  );
  const input = {
      roomId: ROOM,
      requestId: incoming.turnRequestId,
      generationId: 'self-proof',
      name: 'Glyph-alignment',
      objective: 'Align the glyphs',
    };
  const { cornerId } = await daemon.execute('createCorner', input, AGENT);
  expect((await daemon.execute('createCorner', input, AGENT)).cornerId).toBe(cornerId);
  const opening = (
    await db.query<CommandRow>(
      `SELECT * FROM agent_commands WHERE room_id=$1 AND reason='corner_objective'`,
      [cornerId],
    )
  ).rows[0]!;
  expect(opening).toBeDefined(); // The order still owns corner provenance and idempotency.
  expect((await daemon.execute('getAgentCommands', { roomId: cornerId }, AGENT)).commands.map(c => c.id))
    .toEqual([opening.id]);
  await daemon.execute('claimAgentCommand', { roomId: cornerId, commandId: opening.id,
    generationId: 'own-corner-work' }, AGENT);
  await daemon.execute('postCornerMessage', { roomId: cornerId, cornerId,
    requestId: opening.turn_request_id, generationId: 'own-corner-work', text: '@worker mock ready' }, AGENT);
  await daemon.execute('postAgentTurnReceipt', { roomId: cornerId,
    requestId: opening.turn_request_id, generationId: 'own-corner-work', status: 'complete' }, AGENT);
  expect(
    await reportToCommander(db, cornerId, AGENT, 'done: mock ready', opening, 'self-report-proof'),
  ).toMatchObject({ delivered: true });
  await refreshCornerAttention(db, cornerId); // Production's immediate System idle report.
  expect(
    (
      await db.query(
        `SELECT state,private_payload->>'sourceAgentId' source_agent
    FROM agent_commands WHERE room_id=$1 AND private_payload->>'idleSince' IS NOT NULL`,
        [cornerId],
      )
    ).rows,
  ).toEqual([{ state: 'complete', source_agent: AGENT }]);
  expect(
    (await daemon.execute('getAgentCommands', { roomId: ROOM }, AGENT)).commands.map((c) => c.id),
  ).not.toContain('self-report-proof');
  expect(
    (
      await db.query(
        `SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND status='working'`,
        [cornerId, AGENT],
      )
    ).rowCount,
  ).toBe(0);
  expect((await db.query(`SELECT count(*)::int total FROM agent_commands
    WHERE room_id=$1 AND reason='corner_objective'`, [cornerId])).rows).toEqual([{ total: 1 }]);
  expect(
    (
      await db.query(
        `SELECT 1 FROM agent_commands WHERE agent_id=$1 AND id<>$2 AND state IN ('pending','claimed')`,
        [AGENT, incoming.id],
      )
    ).rowCount,
  ).toBe(0);
});

it('SELF-OUTPUT: a different commander still receives explicit and System reports', async () => {
  const source = randomBytes(32).toString('hex');
  await phone.execute(
    'sendRoomMessage',
    { roomId: ROOM, messageId: source, text: '@commander dispatch this work' },
    HUMAN,
  );
  const incoming = (
    await daemon.execute('getAgentCommands', { roomId: ROOM }, OTHER)
  ).commands.find((c) => c.sourceMessageId === source)!;
  await daemon.execute(
    'claimAgentCommand',
    { roomId: ROOM, commandId: incoming.id, generationId: 'other-proof' },
    OTHER,
  );
  const { cornerId } = await daemon.execute(
    'createCorner',
    {
      roomId: ROOM,
      requestId: incoming.turnRequestId,
      generationId: 'other-proof',
      name: 'Delegated-work',
      objective: 'Make the mock',
      implementer: 'worker',
    },
    OTHER,
  );
  const opening = (
    await db.query<CommandRow>(
      `SELECT * FROM agent_commands WHERE room_id=$1 AND reason='corner_objective'`,
      [cornerId],
    )
  ).rows[0]!;
  expect(opening.state).toBe('pending');
  await reportToCommander(db, cornerId, AGENT, 'done: mock ready', opening, 'other-report-proof');
  expect(
    (await daemon.execute('getAgentCommands', { roomId: ROOM }, OTHER)).commands.map((c) => c.id),
  ).toContain('other-report-proof');
  const systemReport = await reportToCommander(
    db,
    cornerId,
    SYSTEM_IDENTITY_ID,
    'blocked: worker needs attention',
    undefined,
    'other-system-report-proof',
    { automatic: true, agentOnly: true, wakeInCorner: true },
  );
  expect(systemReport.delivered).toBe(true);
  expect(
    (
      await db.query(
        `SELECT state,private_payload->>'sourceAgentId' source_agent FROM agent_commands WHERE id='other-system-report-proof'`,
      )
    ).rows,
  ).toEqual([{ state: 'pending', source_agent: AGENT }]);
});

it.each([false, true])(
  'SELF-OUTPUT: a room subscription cannot echo its author (prompted=%s)',
  async (prompted) => {
    for (const agentId of [AGENT, OTHER]) {
      await setRoomEventSubscriptions(db, ROOM, agentId, ['joined']);
      await db.query(
        `UPDATE agent_subscriptions SET prompt=$3 WHERE room_id=$1 AND agent_id=$2 AND event='joined'`,
        [ROOM, agentId, prompted ? 'Handle this joining event' : null],
      );
    }
    const event = await systemLine(db, {
      roomId: ROOM,
      authorId: AGENT,
      subject: { kind: 'agent', id: AGENT, name: 'Worker' },
      verb: 'joined',
      kind: 'joined',
    });
    const rows = (
      await db.query<{ agent_id: string; state: string }>(
        `SELECT command.agent_id,command.state
    FROM agent_commands command JOIN messages source ON source.id=command.source_message_id
    WHERE source.id=$1 OR source.event_cause_id=$1`,
        [event.id],
      )
    ).rows;
    expect(
      rows.filter((row) => row.agent_id === AGENT && ['pending', 'claimed'].includes(row.state)),
    ).toEqual([]);
    expect(rows.filter((row) => row.agent_id === OTHER && row.state === 'pending')).toHaveLength(1);
  },
);

it('SELF-OUTPUT: external lifecycle events still wake a self-opening implementer', async () => {
  const corner = (
    await db.query<{ room_id: string }>(
      `SELECT room_id FROM agent_commands WHERE reason='corner_objective' AND agent_id=$1 AND private_payload->>'authorId'=$1 LIMIT 1`,
      [AGENT],
    )
  ).rows[0]!.room_id;
  const event = await systemLine(db, {
    roomId: corner,
    authorId: AGENT,
    subject: { kind: 'system', id: OTHER, name: 'Commander' },
    verb: 'requested follow-up',
  });
  const command = await createAgentCommand(db, {
    roomId: corner,
    agentId: AGENT,
    sourceMessageId: event.id,
    reason: 'subscribed_event',
  });
  expect(command?.state).toBe('pending');
});

it('SELF-OUTPUT: workflow assignment wakes only its assignee, not its self-subscribed author', async () => {
  await setRoomEventSubscriptions(db, ROOM, AGENT, ['workflow-handoff']);
  const source = randomBytes(32).toString('hex');
  await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: source, text: '@worker start the steps' }, HUMAN);
  const command = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`, [source, AGENT])).rows[0]!;
  await saveWorkflow(db, command, { contract: describedWorkflow({ version: 1, name: 'assignment-only',
    description: 'Assign work without echoing to the author', roles: ['worker'], start: 'work', handoffs: {
      work: { role: 'worker', requires: [], on: { done: 'done' } }, done: { kind: 'terminal', status: 'done' },
    } }) });
  const { runId } = await startWorkflow(db, command, { name: 'assignment-only', roleBindings: { worker: OTHER } });
  expect((await db.query(`SELECT agent_id,state FROM agent_commands WHERE source_message_id=$1 ORDER BY agent_id`, [runId])).rows)
    .toEqual([{ agent_id: AGENT, state: 'complete' }, { agent_id: OTHER, state: 'pending' }]);
  await saveWorkflow(db, command, { contract: describedWorkflow({ version: 1, name: 'own-assignment',
    description: 'Assign the author without an extra subscription turn', roles: ['worker'], start: 'work', handoffs: {
      work: { role: 'worker', requires: [], on: { done: 'done' } }, done: { kind: 'terminal', status: 'done' },
    } }) });
  const own = await startWorkflow(db, command, { name: 'own-assignment', roleBindings: { worker: AGENT } });
  expect((await db.query(`SELECT agent_id,state FROM agent_commands WHERE source_message_id=$1`, [own.runId])).rows)
    .toEqual([{ agent_id: AGENT, state: 'pending' }]);
  await setRoomEventSubscriptions(db, ROOM, AGENT, []);
});

it('SELF-OUTPUT: connected apps receive no webhook or MCP event for their own output', async () => {
  await db.query(
    `INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('self-output-client','Proof','[]')`,
  );
  await db.query(
    `INSERT INTO rooms_mcp_connections(client_id,identity_id,scope) VALUES('self-output-client',$1,'rooms:read rooms:write')`,
    [HUMAN],
  );
  await db.query(
    `INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label,callback_url)
    VALUES('self-output-client',$1,$2,'Proof','https://example.com/self-output')`,
    [HUMAN, AGENT],
  );
  await db.query(
    `INSERT INTO rooms_mcp_event_subscriptions(id,client_id,owner_id,member_id,url,secret,verified_at,expires_at,event_name)
    VALUES('self-output-subscription','self-output-client',$1,$2,'https://example.com/self-output','fixture',now(),now()+interval '1 hour','wake')`,
    [HUMAN, AGENT],
  );
  const own = await createAgentCommand(db, {
    roomId: ROOM,
    agentId: AGENT,
    sourceMessageId: null,
    reason: 'new_output_reason',
    privatePayload: { kind: 'lifecycle', authorId: AGENT, fromRoomId: ROOM, text: 'My own output' },
  });
  expect(own).toMatchObject({ state: 'complete' });
  expect(
    (await db.query(`SELECT 1 FROM rooms_mcp_event_deliveries WHERE command_id=$1`, [own!.id]))
      .rowCount,
  ).toBe(0);
  expect(
    (await db.query(`SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1`, [AGENT])).rowCount,
  ).toBe(0);
  const incoming = await createAgentCommand(db, {
    roomId: ROOM,
    agentId: AGENT,
    sourceMessageId: null,
    reason: 'new_output_reason',
    privatePayload: {
      kind: 'lifecycle',
      authorId: OTHER,
      fromRoomId: ROOM,
      text: 'External output',
    },
  });
  expect(incoming?.state).toBe('pending');
  expect(
    (await db.query(`SELECT 1 FROM rooms_mcp_event_deliveries WHERE command_id=$1`, [incoming!.id]))
      .rowCount,
  ).toBe(1);
  expect(
    (await db.query(`SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1`, [AGENT])).rowCount,
  ).toBe(1);
});
