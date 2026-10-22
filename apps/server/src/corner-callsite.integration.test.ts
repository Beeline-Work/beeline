import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PushDeliveryLoop } from './background.js';
import { createAgentCommand } from './agent-command.js';

const H = 'a'.repeat(64),
  A = 'b'.repeat(64),
  OUTSIDER = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  DM = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;
const snapshots: Record<string, unknown> = {};
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Captain','captain'),($2,'agent','Ruby','ruby'),($3,'human','Room member','member')`,
    [H, A, OUTSIDER],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A, H]);
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30000);
afterAll(async () => {
  if (process.env.BEELINE_CORNER_CALLSITE_PROOF_OUTPUT)
    writeFileSync(
      process.env.BEELINE_CORNER_CALLSITE_PROOF_OUTPUT,
      JSON.stringify(snapshots, null, 2) + '\n',
    );
  await db.close();
});
beforeEach(async () => {
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM workspaces`);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Call-site proof')`, [W]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$3,'Work Room',NULL),($2,$3,'Private request',jsonb_build_array($4::text,$5::text))`,
    [R, DM, W, H, A],
  );
  for (const who of [H, A, OUTSIDER]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [W, who, R],
    );
    if (who !== OUTSIDER)
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [W, DM, who],
      );
  }
});
async function request(roomId: string) {
  const sourceMessageId = randomBytes(32).toString('hex');
  await phone.execute(
    'sendRoomMessage',
    { roomId, messageId: sourceMessageId, text: '@ruby open a corner for the requested work' },
    H,
  );
  const command = (await daemon.execute('getAgentCommands', { roomId }, A)).commands.find(
    (c) => c.sourceMessageId === sourceMessageId,
  )!;
  expect(command).toBeDefined();
  await daemon.execute(
    'claimAgentCommand',
    { roomId, commandId: command.id, generationId: 'proof' },
    A,
  );
  return command;
}
async function open(roomId: string, command: { turnRequestId: string }, name = 'requested-work') {
  return daemon.execute(
    'createCorner',
    {
      roomId,
      targetRoomId: R,
      requestId: command.turnRequestId,
      generationId: 'proof',
      name,
      objective: 'Build the requested work',
    },
    A,
  );
}
async function facts(cornerId: string) {
  return (
    await db.query<{
      room_id: string;
      card: { sourceMessageId?: string };
      text: string;
      system_event: unknown;
    }>(
      `SELECT room_id,card,text,system_event FROM messages WHERE card_type='daemon-fact' AND card->>'cornerId'=$1`,
      [cornerId],
    )
  ).rows;
}
it.each(['dm', 'room', 'parent'] as const)(
  'projects an opening at its %s requesting message with no private origin in the Room',
  async (kind) => {
    let sourceRoom = kind === 'dm' ? DM : R;
    if (kind === 'parent') {
      sourceRoom = randomUUID();
      await db.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'parent-work',$4)`,
        [sourceRoom, W, R, A],
      );
      await db.query(
        `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Parent work','{"lifecycle":"working","checks":"unknown"}')`,
        [sourceRoom, A],
      );
    }
    const command = await request(sourceRoom);
    const opened = await open(sourceRoom, command);
    const written = await facts(opened.cornerId);
    expect(written).toHaveLength(kind === 'room' ? 1 : 2);
    const callsite = written.find((row) => row.room_id === sourceRoom)!;
    expect(callsite.card.sourceMessageId).toBe(command.sourceMessageId);
    const parent = written.find((row) => row.room_id === R)!;
    if (kind !== 'room') {
      expect(parent.card).not.toHaveProperty('sourceMessageId');
      expect(parent.system_event).not.toEqual(expect.objectContaining({ kind: 'direct-message' }));
      expect(JSON.stringify(parent)).not.toContain(sourceRoom);
      expect(JSON.stringify(parent)).not.toContain(command.sourceMessageId);
      expect(callsite.system_event).not.toHaveProperty('kind');
    }
    expect(parent.text).toBe('@ruby opened a corner requested-work');
    // The same member-gated phone read that feeds the actual transcripts.
    const sourceView = await phone.readRoom(sourceRoom, H);
    expect(
      sourceView?.messages.find((message) => message.daemonFact?.cornerId === opened.cornerId)
        ?.daemonFact?.sourceMessageId,
    ).toBe(command.sourceMessageId);
    const roomView = await phone.readRoom(R, OUTSIDER);
    expect(
      roomView?.messages.some((message) => message.daemonFact?.cornerId === opened.cornerId),
    ).toBe(true);
    if (kind === 'dm') expect(await phone.readRoom(DM, OUTSIDER)).toBeNull();
    if (kind !== 'room')
      snapshots[kind] = { messages: sourceView!.messages, roomMessages: roomView!.messages };
    // Tool-call retry must not add either a second Room record or call-site line.
    expect((await open(sourceRoom, command)).cornerId).toBe(opened.cornerId);
    expect(await facts(opened.cornerId)).toHaveLength(written.length);
  },
);
it.each(['schedule', 'workflow', 'order', 'report', 'judgment'] as const)(
  'does not borrow a previous root for a %s wake without a dispatching message',
  async (reason) => {
    const previous = await request(DM);
    const parent = (
      await db.query<any>(`SELECT * FROM agent_commands WHERE turn_request_id=$1`, [
        previous.turnRequestId,
      ])
    ).rows[0];
    const command = await createAgentCommand(db, {
      roomId: DM,
      agentId: A,
      sourceMessageId: null,
      reason,
      parent,
      retainDepth: true,
      ...(reason === 'order' || reason === 'report'
        ? {
            privatePayload: {
              kind: reason,
              text: 'Private instruction',
              authorId: H,
              fromRoomId: R,
            },
          }
        : {}),
    });
    expect(command).toBeDefined();
    await daemon.execute(
      'claimAgentCommand',
      { roomId: DM, commandId: command!.id, generationId: 'proof' },
      A,
    );
    const opened = await open(DM, { turnRequestId: command!.turn_request_id });
    expect(await facts(opened.cornerId)).toEqual([
      expect.objectContaining({
        room_id: R,
        card: expect.not.objectContaining({ sourceMessageId: expect.anything() }),
      }),
    ]);
  },
);

it('keeps both opening projections out of push notifications', async () => {
  await db.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('captain-proof-device-1234567890',$1,'android','physical'),('outsider-proof-device-1234567890',$2,'android','physical')`,
    [H, OUTSIDER],
  );
  const send = vi.fn(async () => undefined);
  const loop = new PushDeliveryLoop(db, { send });
  await loop.runOnce();
  const command = await request(DM);
  await loop.runOnce();
  send.mockClear();
  await open(DM, command);
  expect(await loop.runOnce()).toBe(0);
  expect(send).not.toHaveBeenCalled();
});
it('does not treat an automatic workflow card as a dispatching message', async () => {
  const previous = await request(DM);
  const parent = (
    await db.query<any>(`SELECT * FROM agent_commands WHERE turn_request_id=$1`, [
      previous.turnRequestId,
    ])
  ).rows[0];
  const sourceId = randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES($1,$2,$3,'Workflow step','card','workflow-handoff','{}')`,
    [sourceId, DM, A],
  );
  const command = await createAgentCommand(db, {
    roomId: DM,
    agentId: A,
    sourceMessageId: sourceId,
    reason: 'workflow',
    parent,
    retainDepth: true,
  });
  expect(command).toBeDefined();
  await daemon.execute(
    'claimAgentCommand',
    { roomId: DM, commandId: command!.id, generationId: 'proof' },
    A,
  );
  const opened = await open(DM, { turnRequestId: command!.turn_request_id });
  expect(await facts(opened.cornerId)).toHaveLength(1);
  expect((await facts(opened.cornerId))[0].room_id).toBe(R);
});
