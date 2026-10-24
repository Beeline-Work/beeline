import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PushDeliveryLoop } from './background.js';
import { GitHubOperations } from './github-operations.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
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
async function sourceFor(kind: 'dm' | 'room' | 'parent') {
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
  return sourceRoom;
}
it.each(['dm', 'room', 'parent'] as const)(
  'projects an opening at its %s requesting message with no private origin in the Room',
  async (kind) => {
    const sourceRoom = await sourceFor(kind);
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

it.each(['dm', 'room', 'parent'] as const)('Reproduction CORNER-ROOM-2: keeps the %s Room opening static and reports the PR once', async (kind) => {
  const sourceRoom = await sourceFor(kind);
  const command = await request(sourceRoom);
  const opened = await open(sourceRoom, command);
  const read = async () => ({
    messages: (await phone.readRoom(sourceRoom, H))!.messages,
    roomMessages: (await phone.readRoom(R, OUTSIDER))!.messages,
  });
  const opening = await read();
  const marker = opening.messages.find(m => m.daemonFact?.cornerId === opened.cornerId)!;
  expect(marker.daemonFact).toMatchObject({ type: 'corner-open', sourceMessageId: command.sourceMessageId });
  const roomOpening = opening.roomMessages.find(m => m.daemonFact?.cornerId === opened.cornerId)!;
  expect(roomOpening.daemonFact?.type).toBe('corner-open');
  expect(roomOpening.daemonFact?.objective).toBe('requested-work');
  snapshots[`${kind}-opened`] = opening;
  // The real webhook service commits the merge, settles cards and archives the corner.
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
    VALUES(77,$1,'42','owner','User','selected','active') ON CONFLICT DO NOTHING`, [H]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
    VALUES(101,77,'owner/widgets','main') ON CONFLICT DO NOTHING`);
  await db.query(`UPDATE rooms SET github_installation_id=77,repository_remote='https://github.com/owner/widgets.git' WHERE id=$1`, [R]);
  const branch = `feature/corner-${opened.cornerId.replaceAll('-', '').slice(0,12)}`;
  await db.query(`UPDATE corner_facts SET feature_branch=$2 WHERE corner_id=$1`, [opened.cornerId, branch]);
  const app = {
    installationToken: vi.fn(async () => ({ token: 'fixture-token' })),
    readCommitCheckRollup: vi.fn(async () => ({ state: 'passed', total: 0, failing: [], checks: [] })),
    branchDeletionSafety: vi.fn(async () => ({ defaultBranch: 'main', protected: false })),
    openPullRequestsForBranch: vi.fn(async () => []), deleteBranch: vi.fn(async () => undefined),
  } as unknown as GitHubAppClient;
  const operations = new GitHubOperations(db, {} as GitHubOAuthClient, app, 'fixture-secret');
  const payload = { action: 'closed', installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' },
    pull_request: { number: 2832, title: 'PR title differs from the corner name', html_url: 'https://github.com/owner/widgets/pull/2832',
      head: { ref: branch, sha: '1'.repeat(40) }, base: { ref: 'main' }, merged: true,
      merged_at: '2026-10-23T10:00:00Z', merge_commit_sha: 'f'.repeat(40), merged_by: { login: 'owner' } } };
  await operations.processWebhook('pull_request', payload);
  await operations.processWebhook('pull_request', payload);
  const merged = await read();
  const settled = merged.messages.filter(m => m.daemonFact?.cornerId === opened.cornerId);
  expect(settled).toHaveLength(1);
  if (kind === 'room') expect(settled[0]).toEqual(marker);
  else expect(settled[0]).toMatchObject({ id: marker.id, createdAt: marker.createdAt,
    daemonFact: { type: 'corner-complete', outcome: 'landed', name: 'requested-work', sourceMessageId: command.sourceMessageId,
      pullRequest: { number: 2832, url: 'https://github.com/owner/widgets/pull/2832' } } });
  const roomCards = merged.roomMessages.filter(m => m.daemonFact?.cornerId === opened.cornerId);
  expect(roomCards).toEqual([roomOpening]);
  const prRows = merged.roomMessages.filter(m => m.githubEvent?.url === payload.pull_request.html_url);
  expect(prRows).toHaveLength(1);
  expect(prRows[0].githubEvent).toMatchObject({ action: 'merged', cornerId: opened.cornerId });
  const storedRoomOpening = (await db.query(`SELECT card FROM messages WHERE id=$1`, [roomOpening.id])).rows[0];
  expect(storedRoomOpening.card.type).toBe('corner-open');
  snapshots[`${kind}-merged`] = merged;
  // Closing an independent corner follows the phone action, with no extra row.
  await db.query(`UPDATE rooms SET repository_remote=NULL,github_installation_id=NULL WHERE id=$1`, [R]);
  const closeCommand = await request(sourceRoom);
  const closing = await open(sourceRoom, closeCommand, 'close-requested-work');
  const beforeClose = await read();
  const closeRoomMarker = beforeClose.roomMessages.find(m => m.daemonFact?.cornerId === closing.cornerId)!;
  const closeMarker = beforeClose.messages.find(m => m.daemonFact?.cornerId === closing.cornerId)!;
  await phone.execute('requestCornerClose', { roomId: closing.cornerId }, H);
  const closed = await read();
  const closedCards = closed.messages.filter(m => m.daemonFact?.cornerId === closing.cornerId);
  expect(closedCards).toHaveLength(1);
  if (kind === 'room') expect(closedCards[0]).toEqual(closeMarker);
  else expect(closedCards[0]).toMatchObject({ id: closeMarker.id, createdAt: closeMarker.createdAt,
    daemonFact: { type: 'corner-complete', outcome: 'abandoned', sourceMessageId: closeCommand.sourceMessageId } });
  expect(closed.roomMessages.filter(m => m.daemonFact?.cornerId === closing.cornerId)).toEqual([closeRoomMarker]);
  snapshots[`${kind}-closed`] = closed;
});

it('Reproduction CORNER-ROOM-2: preview, unread, history and live reads share opening visibility', async () => {
  const command = await request(DM);
  const opened = await open(DM, command);
  const view = (await phone.readRoom(R, OUTSIDER))!;
  const marker = view.messages.find(m => m.daemonFact?.cornerId === opened.cornerId)!;
  expect(marker.daemonFact?.type).toBe('corner-open');
  const legacy = 'f'.repeat(64);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
    VALUES($1,$2,$3,'Old completion','card','daemon-fact',$4,now()+interval '1 minute')`,
    [legacy,R,A,JSON.stringify({ type: 'corner-complete', cornerId: opened.cornerId,
      objective: 'Private objective', outcome: 'landed' })]);
  const room = (await phone.readRoom(R, OUTSIDER))!;
  expect(room.messages.map(m => m.id)).toContain(marker.id);
  expect(room.messages.map(m => m.id)).not.toContain(legacy);
  expect(room.viewer.readCursor).toMatchObject({ firstUnreadMessageId: marker.id, unreadCount: 1 });
  const chat = (await phone.readChats(W, OUTSIDER))!.chats.find(c => c.room.id === R)!;
  expect(chat.latestMessage?.id).toBe(marker.id);
  expect(chat.unread).toBe(true);
  expect((await phone.readHistory(R, OUTSIDER))!.messages.map(m => m.id)).toEqual([marker.id]);
  expect((await phone.readHistoryAround(R, OUTSIDER, marker.id))!.messages.map(m => m.id)).toEqual([marker.id]);
  const live = await phone.readLiveDelta(R, OUTSIDER, { type: 'message', messageId: marker.id });
  expect(live && 'message' in live ? live.message.daemonFact?.type : undefined).toBe('corner-open');
  expect(await phone.readLiveDelta(R, OUTSIDER, { type: 'message', messageId: legacy })).toBeNull();
  // Older Room opening rows that were settled still render their original opening.
  await db.query(`UPDATE messages SET card=card||'{"type":"corner-complete","outcome":"landed"}'::jsonb WHERE id=$1`, [marker.id]);
  expect((await phone.readRoom(R, OUTSIDER))!.messages.find(m => m.id===marker.id)?.daemonFact).toEqual(marker.daemonFact);
});

it('Reproduction CORNER-ROOM-2: opened and closed PR events keep an archived corner destination', async () => {
  const command = await request(DM);
  const opened = await open(DM, command);
  const opening = (await phone.readRoom(R, OUTSIDER))!.messages.find(m => m.daemonFact?.cornerId === opened.cornerId)!;
  await phone.execute('requestCornerClose', { roomId: opened.cornerId }, H);
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
    VALUES(77,$1,'42','owner','User','selected','active') ON CONFLICT DO NOTHING`, [H]);
  await db.query(`UPDATE rooms SET github_installation_id=77,repository_remote='https://github.com/owner/widgets.git' WHERE id=$1`, [R]);
  const branch = `feature/corner-${opened.cornerId.replaceAll('-', '').slice(0,12)}`;
  await db.query(`UPDATE corner_facts SET feature_branch=$2 WHERE corner_id=$1`, [opened.cornerId, branch]);
  const operations = new GitHubOperations(db, {} as GitHubOAuthClient, {} as GitHubAppClient, 'fixture-secret');
  for (const action of ['opened', 'closed']) {
    const payload = { action, installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      pull_request: { number: 42, title: 'Archived corner PR', html_url: 'https://github.com/owner/widgets/pull/42',
        head: { ref: branch }, base: { ref: 'main' }, merged: false } };
    await operations.processWebhook('pull_request', payload);
    await operations.processWebhook('pull_request', payload);
  }
  const messages = (await phone.readRoom(R, OUTSIDER))!.messages;
  expect(messages.filter(m => m.daemonFact?.cornerId === opened.cornerId)).toEqual([opening]);
  expect(messages.filter(m => m.githubEvent).map(m => m.githubEvent)).toEqual([
    expect.objectContaining({ action: 'opened', cornerId: opened.cornerId }),
    expect.objectContaining({ action: 'closed', cornerId: opened.cornerId }),
  ]);
});

it.each([false, true])('keeps a human opening static with a resident source=%s', async (withSource) => {
  const command = withSource ? await request(R) : undefined;
  const input = { roomId: R, title: 'human-work', cornerId: randomUUID(),
    ...(command ? { sourceMessageId: command.sourceMessageId } : {}) };
  await phone.execute('createHumanCorner', input, H);
  await phone.execute('createHumanCorner', input, H);
  const row = (await phone.readRoom(R, OUTSIDER))!.messages.filter(m => m.daemonFact?.cornerId === input.cornerId);
  expect(row).toHaveLength(1);
  expect(row[0].daemonFact).toMatchObject({ type: 'corner-open', name: 'human-work' });
  await phone.execute('requestCornerClose', { roomId: input.cornerId }, H);
  expect((await phone.readRoom(R, OUTSIDER))!.messages.filter(m => m.daemonFact?.cornerId === input.cornerId)).toEqual(row);
});
