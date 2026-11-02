import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { taggedIdentityIdsSql } from './message-mentions.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { claimAgentConnection } from './connection-presence.js';
import {
  createAgentCommand,
  renudgeStrandedPendingCommands,
  nextAgentDepth,
  reconcileCornerMergeBlockers,
  reconcileConfiguredCornerReviewers,
  routeSystemCommand,
  readAgentCommands,
} from './agent-command.js';
import { systemLine } from './system-line.js';
import { advanceCorner } from './corner-lifecycle.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
const H = 'a'.repeat(64),
  A = 'b'.repeat(64),
  B = 'c'.repeat(64),
  P = 'd'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  C = '33333333-3333-4333-8333-333333333333';
const id = () => randomBytes(32).toString('hex');
const stopProofPostgresUrl = process.env.BEELINE_STOP_TEST_POSTGRES_URL;
if (stopProofPostgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(stopProofPostgresUrl).hostname))
  throw new Error('Stop proofs require an isolated loopback PostgreSQL');
let db: SqlDatabase, closeDatabase: () => Promise<void>, phone: PhoneService, daemon: DaemonService, live: LiveHub;
const commands = (agentId = A, roomId = R) =>
  daemon.execute('getAgentCommands', { roomId }, agentId).then((r) => r.commands);
const send = (text: string, roomId = R) => phone.execute('sendRoomMessage', { roomId, text }, H);

it.each(['ordinary', 'tagged', 'threaded', 'private', 'private-agent', 'corner', 'dm'])(
  'Reproduction R1: discards final text after no-reply on the %s output path', async path => {
    const roomId = path === 'corner' ? C : R;
    if (path === 'dm')
      await db.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`, [R, JSON.stringify([H, A])]);
    const queued = await createAgentCommand(db, {
      roomId, agentId: A, sourceMessageId: null, reason: 'system',
      ...(path.startsWith('private') ? {
        privatePayload: { kind: 'order' as const, authorId: path === 'private-agent' ? B : H, fromRoomId: R, text: 'Observe silently' },
        reason: 'order' as const,
      } : {}),
    });
    const command = (await commands(A, roomId)).find(c => c.id === queued!.id)!;
    await claim(command);
    await daemon.execute('postAgentTurnReceipt', {
      roomId, requestId: command.turnRequestId, generationId: 'g1',
      status: 'complete', completionKind: 'no-reply',
    }, A);
    const text = `R1 unwanted closing sentence${path === 'tagged' ? ' @goosy' : ''}`;
    const parent = path === 'threaded' ? await send('Thread parent') : undefined;
    const before = (await phone.readRoom(roomId, H))!.messages.map(m => m.id);
    // A successful acknowledgement lets an old helper finish without retrying
    // or converting deliberate silence into a failure notice.
    await result(command, text, 'g1', parent ? { replyToMessageId: parent.messageId } : {});
    await result(command, text, 'g1', parent ? { replyToMessageId: parent.messageId } : {});
    await expect(result(command, text, 'other-generation')).rejects.toThrow('authority rejected');
    expect((await phone.readRoom(roomId, H))!.messages.map(m => m.id)).toEqual(before);
    expect((await db.query(`SELECT 1 FROM messages WHERE author_id=$1 AND text=$2`, [A, text])).rowCount).toBe(0);
    expect((await commands(B)).filter(c => c.source.body.includes(text))).toEqual([]);
    expect((await db.query(`SELECT completion_kind FROM agent_turns
      WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`, [roomId, A, command.turnRequestId])).rows)
      .toEqual([{ completion_kind: 'no-reply' }]);
    const next = await createAgentCommand(db, { roomId, agentId: A, sourceMessageId: null, reason: 'system' });
    const nextCommand = (await commands(A, roomId)).find(c => c.id === next!.id)!;
    await claim(nextCommand, 'next-generation');
    await result(nextCommand, 'R1 next turn remains visible', 'next-generation');
    expect((await phone.readRoom(roomId, H))!.messages.some(m => m.text === 'R1 next turn remains visible')).toBe(true);
  },
);


// R3: with text-pattern suppression removed, agent final text publishes as
// written on any wake. The only silence path is the no_reply_needed tool
// (a 'no-reply' completion receipt), which discards the turn's final text.
it.each(['I posted nothing.', 'Nothing to post.', "I won't post to the Room.", 'NO_REPLY', 'No reply needed.',
  'Nonhuman wake only … Ending silently',
  'Posted a concise Arabic list … Waiting for Mohammed',
  'blocked: Corner release is idle with no worker schedule or event subscription',
])(
  'WAKE-STORM: final text publishes as written on a system wake: %s', async text => {
    const queued = await createAgentCommand(db, { roomId: R, agentId: A, sourceMessageId: null, reason: 'system' });
    const command = (await commands(A, R)).find(c => c.id === queued!.id)!;
    await claim(command);
    await result(command, text);
    expect((await db.query('SELECT 1 FROM messages WHERE request_id=$1 AND author_id=$2 AND text=$3',
      [command.turnRequestId, A, text])).rowCount).toBe(1);
    expect((await db.query('SELECT completion_kind FROM agent_turns WHERE request_id=$1 AND agent_id=$2',
      [command.turnRequestId, A])).rows[0]?.completion_kind).toBeFalsy();
  });

it('WAKE-STORM: a no_reply_needed receipt posts nothing on a system wake', async () => {
  for (const roomId of [R, C]) {
    const queued = await createAgentCommand(db, { roomId, agentId: A, sourceMessageId: null, reason: 'system' });
    const command = (await commands(A, roomId)).find(c => c.id === queued!.id)!;
    await claim(command);
    await daemon.execute('postAgentTurnReceipt', {
      roomId, requestId: command.turnRequestId, generationId: 'g1',
      status: 'complete', completionKind: 'no-reply',
    }, A);
    const text = 'Nonhuman wake only … Ending silently';
    await result(command, text);
    await result(command, text);
    expect((await db.query('SELECT 1 FROM messages WHERE request_id=$1 AND author_id=$2', [command.turnRequestId, A])).rowCount).toBe(0);
    expect((await db.query('SELECT completion_kind FROM agent_turns WHERE request_id=$1 AND agent_id=$2', [command.turnRequestId, A])).rows[0]?.completion_kind).toBe('no-reply');
    await expect(result(command, text, 'wrong-generation')).rejects.toThrow('authority rejected');
  }
});

it('WAKE-STORM: a human wake publishes its report-status reply as written', async () => {
  const queued = await createAgentCommand(db, { roomId: R, agentId: A, sourceMessageId: null, reason: 'human_tag' });
  const command = (await commands(A, R)).find(c => c.id === queued!.id)!;
  await claim(command);
  const text = 'blocked: Corner release is idle with no worker schedule or event subscription';
  await result(command, text);
  expect((await db.query('SELECT 1 FROM messages WHERE request_id=$1 AND author_id=$2 AND text=$3',
    [command.turnRequestId, A, text])).rowCount).toBe(1);
  expect((await db.query('SELECT completion_kind FROM agent_turns WHERE request_id=$1 AND agent_id=$2',
    [command.turnRequestId, A])).rows[0]?.completion_kind).toBeFalsy();
});

// Claim must fold even when no queue read happened during the busy turn.
async function queuedHumanTags(roomId = R) {
  const started = await send('@hoots Long task', roomId);
  const busy = (await commands(A, roomId)).find(c => c.sourceMessageId === started.messageId)!;
  await claim(busy);
  const messages = [];
  for (const text of ['First question', 'Follow-up question', 'Last detail'])
    messages.push(await send(`@hoots ${text}`, roomId));
  // Complete directly: asking getAgentCommands while busy already coalesces
  // some traffic and would conceal the claim-time gap this reproduces.
  await result(busy, 'Long task finished');
  return messages;
}

it.each([R, C])('QUEUED-TAGS-REPEAT: claims three queued human tags as one turn in %s', async roomId => {
  const messages = await queuedHumanTags(roomId);
  const snapshot = await commands(A, roomId);
  expect(snapshot).toHaveLength(3);
  await expect(claim(snapshot[2]!)).rejects.toThrow('claim conflict');
  const head = snapshot[0]!;
  const claimed = await daemon.execute('claimAgentCommand',
    { roomId, commandId: head.id, generationId: 'combined' }, A);
  expect(head.sourceMessageId).toBe(messages[0]!.messageId);
  const prompt = head.sourceMessageId + head.source.body + claimed.coalescedContext;
  for (const message of messages) expect(prompt).toContain(message.messageId);
  const later = claimed.coalescedContext!.split('\n').map(line => JSON.parse(line));
  expect(later.map(item => item.sourceMessageId)).toEqual(messages.slice(1).map(message => message.messageId));
  expect(later.map(item => item.body)).toEqual(['@hoots Follow-up question', '@hoots Last detail']);
  // A cached snapshot and a lost claim response cannot produce another turn.
  const retry = await daemon.execute('claimAgentCommand',
    { roomId, commandId: head.id, generationId: 'combined' }, A);
  expect(retry.coalescedContext).toBe(claimed.coalescedContext);
  await result(head, 'One answer covers all three', 'combined');
  expect(await commands(A, roomId)).toEqual([]);
  for (const folded of snapshot.slice(1)) await expect(claim(folded)).rejects.toThrow();
  const view = await phone.readRoom(roomId, H);
  expect(view!.pendingAgentCommands).toEqual([]);
  expect(view!.latestAgentTurns!.some(turn => turn.agentPubkey === A && turn.status === 'working')).toBe(false);
});

it.each([0, 1, 2])('QUEUED-TAGS-REPEAT: Stop message %s cancels the combined turn', async stopIndex => {
  const messages = await queuedHumanTags();
  const snapshot = await commands();
  const head = snapshot[0]!;
  await claim(head);
  await phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: messages[stopIndex]!.messageId }, H);
  await expect(result(head, 'Must never publish')).rejects.toThrow();
  expect((await commands()).filter(c => c.action === 'input')).toEqual([]);
  expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,
    [R, A, head.turnRequestId])).rows[0]!.status).toBe('cancelled');
});

it.runIf(Boolean(stopProofPostgresUrl))('QUEUED-TAGS-REPEAT: Stop crossing a claim cannot lose its folded target', async () => {
  // Idle dispatch paints optimistic turns before helper pickup; Stop can
  // therefore race the first claim through any queued message's handle.
  const messages = [];
  for (const detail of ['First question', 'Follow-up question', 'Last detail'])
    messages.push(await send(`@hoots ${detail}`));
  const [head] = await commands();
  let reached!: () => void, release!: () => void, claimStarted!: () => void;
  const aliasRead = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { claimStarted = resolve; });
  const wrapStop = (database: SqlDatabase): SqlDatabase => ({
    query: async (sql, values) => {
      const result = await database.query(sql, values);
      if (sql.includes('SELECT head.turn_request_id FROM agent_commands source')) {
        reached();
        await resume;
      }
      return result;
    },
    transaction: work => database.transaction(transaction => work(wrapStop(transaction))),
  });
  const wrapClaim = (database: SqlDatabase): SqlDatabase => ({
    query: (sql, values) => {
      if (sql.includes('pg_advisory_xact_lock')) claimStarted();
      return database.query(sql, values);
    },
    transaction: work => database.transaction(transaction => work(wrapClaim(transaction))),
  });
  const stop = new PhoneService(wrapStop(db), 'http://test').execute('cancelAgentTurn',
    { roomId: R, agentId: A, requestId: messages[1]!.messageId }, H);
  // Observe rejections immediately, including on the unfixed implementation.
  const outcome = stop.then(() => undefined, error => error);
  let claimAttempt: Promise<{ coalescedContext?: string }> | undefined;
  try {
    await aliasRead;
    claimAttempt = new DaemonService(wrapClaim(db), live).execute('claimAgentCommand',
      { roomId: R, commandId: head!.id, generationId: 'crossing-claim' }, A);
    await started;
    const fence = await db.transaction(transaction => transaction.query<{ available: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) available`, [`agent-command-queue:${R}:${A}`]));
    // Before the fix, commit the fold while Stop still holds its stale alias
    // result. With the fix, the shared lock forces Stop to settle first.
    if (fence.rows[0]!.available) await claimAttempt;
    release();
    expect(await outcome).toBeUndefined();
    const claimed = await claimAttempt;
    expect(claimed.coalescedContext).not.toContain(messages[1]!.messageId);
    expect(claimed.coalescedContext).toContain(messages[2]!.messageId);
    await result(head!, 'Answers the remaining queued messages', 'crossing-claim');
    expect((await commands()).filter(command => command.action === 'input')).toEqual([]);
  } finally {
    release();
    await Promise.allSettled([stop, ...(claimAttempt ? [claimAttempt] : [])]);
  }
});

it.each(['deleted', 'stopped'])('QUEUED-TAGS-REPEAT: reclaim drops a %s folded source', async kind => {
  const messages = await queuedHumanTags();
  const [head] = await commands();
  await claim(head!);
  if (kind === 'deleted')
    await db.query(`UPDATE messages SET deleted_at=now() WHERE id=$1`, [messages[1]!.messageId]);
  else
    await db.query(`UPDATE agent_commands SET cancellation_reason='stop' WHERE source_message_id=$1`, [messages[1]!.messageId]);
  await db.query(`UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [head!.id]);
  const reclaimed = await daemon.execute('claimAgentCommand',
    { roomId: R, commandId: head!.id, generationId: 'reclaimed' }, A);
  expect(reclaimed.coalescedContext).not.toContain(messages[1]!.messageId);
  expect(reclaimed.coalescedContext).toContain(messages[2]!.messageId);
  await result(head!, 'Remaining details answered', 'reclaimed');
  expect(await commands()).toEqual([]);
});

it('QUEUED-TAGS-REPEAT: attachments on folded messages reach the combined source', async () => {
  const messages = await queuedHumanTags();
  const files = messages.map((_, index) => ({ url: `https://files.example.test/file-${index}.txt`,
    name: `file-${index}.txt`, mimeType: 'text/plain', size: index + 1 }));
  for (const [index, message] of messages.entries())
    await db.query(`UPDATE messages SET attachments=$2::jsonb WHERE id=$1`, [message.messageId, JSON.stringify([files[index]])]);
  const [head] = await commands();
  const claimed = await daemon.execute('claimAgentCommand',
    { roomId: R, commandId: head!.id, generationId: 'files' }, A);
  expect(claimed.source!.attachments).toEqual(files);
});

it('QUEUED-TAGS-REPEAT: skips deleted and stopped sources and preserves unrelated commands', async () => {
  const messages = await queuedHumanTags();
  await db.query(`UPDATE messages SET deleted_at=now() WHERE id=$1`, [messages[1]!.messageId]);
  await db.query(`UPDATE agent_commands SET state='cancelled',cancellation_reason='stop' WHERE source_message_id=$1`,
    [messages[2]!.messageId]);
  await phone.execute('sendRoomMessage', { roomId: R, text: '@hoots Another person' }, P);
  const order = await createAgentCommand(db, { roomId: R, agentId: A, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', authorId: B, fromRoomId: R, text: 'Separate assignment' } });
  const head = (await commands()).find(c => c.sourceMessageId === messages[0]!.messageId)!;
  const claimed = await daemon.execute('claimAgentCommand', { roomId: R, commandId: head.id, generationId: 'g1' }, A);
  expect(claimed.coalescedContext).toBeUndefined();
  expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [order!.id])).rows[0]!.state).toBe('pending');
  expect((await commands()).some(c => c.source.authorId === P)).toBe(true);
  expect((await commands()).some(c => c.sourceMessageId === messages[1]!.messageId)).toBe(false);
});

it('Reproduction cold-beebee-first-reply: paints every mentioned agent before helper pickup', async () => {
  await send('@hoots @goosy Hello');
  const before = await phone.readRoom(R, H);
  expect(before?.latestAgentTurns).toEqual(expect.arrayContaining([
    expect.objectContaining({ agentPubkey: A, status: 'working' }),
    expect.objectContaining({ agentPubkey: B, status: 'working' }),
  ]));
  const pending = await db.query(`SELECT state FROM agent_commands WHERE agent_id IN ($1,$2)`, [A,B]);
  expect(pending.rows).toEqual([{ state: 'pending' }, { state: 'pending' }]);
  await db.query(`UPDATE agent_turns SET started_at=now()-interval '17 minutes' WHERE agent_id=$1`, [A]);
  const [command] = await commands();
  await claim(command!, 'real-helper');
  expect((await db.query<{ fresh: boolean }>(`SELECT started_at>now()-interval '1 second' fresh
    FROM agent_turns WHERE agent_id=$1`, [A])).rows[0]?.fresh).toBe(true);
  const after = await phone.readRoom(R, H);
  expect(after?.latestAgentTurns?.filter(turn => turn.agentPubkey === A)).toEqual([
    expect.objectContaining({ status: 'working', generationId: 'real-helper' }),
  ]);
});

async function queueStopOrders() {
  await send('@goosy delegate work');
  const [root] = await commands(B);
  await claim(root!);
  for (let i = 1; i <= 3; i++) {
    await daemon.execute('order', { roomId: R, address: R, agent: 'hoots', text: `queued task ${i}`,
      requestId: root!.turnRequestId, generationId: 'g1' }, B);
  }
  const queued = await commands();
  expect(queued).toHaveLength(3);
  await claim(queued[0]!);
  return { queued, root: root! };
}

it('Reproduction stop-queued-orders: Stop drains the queued orders and reports once', async () => {
  const { queued } = await queueStopOrders();
  await phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: queued[0]!.turnRequestId }, H);
  const remaining = (await commands()).filter(command => command.action === 'input');
  expect(remaining).toHaveLength(0);
  for (const command of queued) await expect(claim(command, 'stale-helper')).rejects.toThrow();
  expect((await db.query(`SELECT state FROM agent_commands WHERE id=ANY($1::text[])`,
    [queued.map(command => command.id)])).rows).toEqual(Array(3).fill({ state: 'cancelled' }));
  const reports = (await commands(B)).filter(command => command.reason === 'report');
  expect(reports).toHaveLength(1);
  expect(reports[0]!.source.body).toContain('2 queued orders were dropped by a Stop');
  const lines = await db.query<{ text: string }>(
    `SELECT text FROM messages WHERE room_id=$1 AND system_event->>'kind'='turn-cancelled'
     AND request_id=$2`, [R, queued[0]!.turnRequestId]);
  expect(lines.rows).toHaveLength(1);
  expect(lines.rows[0]!.text).toContain('turn cancelled · 2 queued orders dropped');
  console.log('Demonstrated Reproduction stop-queued-orders: queue 3, claim first, owner Stop → all 3 cancelled, 0 input commands available, all cached claims refused, one count line and one sender report');
});

it('Stop preserves other senders, source Rooms, targets, human mentions and newer orders', async () => {
  const { queued, root } = await queueStopOrders();
  for (const [authorId, fromRoomId, agentId] of [[H, R, A], [B, C, A], [B, R, B]]) {
    await createAgentCommand(db, { roomId: R, agentId: agentId!, sourceMessageId: null,
      privatePayload: { kind: 'order', authorId: authorId!, fromRoomId: fromRoomId!, text: 'survivor' }, reason: 'order' });
  }
  await send('@hoots Human follow-up');
  const newer = await createAgentCommand(db, { roomId: R, agentId: A, sourceMessageId: null,
    privatePayload: { kind: 'order', authorId: B, fromRoomId: R, text: 'newer order' }, reason: 'order' });
  await db.query(`UPDATE agent_commands SET created_at=now()+interval '1 minute' WHERE id=$1`, [newer!.id]);
  await phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: queued[0]!.turnRequestId }, H);
  const remaining = (await commands()).filter(command => command.action === 'input');
  expect(remaining).toHaveLength(4);
  expect(remaining.some(command => command.source.body.includes('Human follow-up'))).toBe(true);
  expect(remaining.some(command => command.id === newer!.id)).toBe(true);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND state='pending' AND private_payload->>'text'='survivor'`, [B])).rowCount).toBe(1);
  await daemon.execute('order', { roomId: R, address: R, agent: 'hoots', text: 'after Stop',
    requestId: root.turnRequestId, generationId: 'g1' }, B);
  const after = (await commands()).find(command => command.source.body.includes('after Stop'))!;
  await expect(claim(after)).resolves.toBeUndefined();
});

it('tagged human Stop also drains orders and reports their count once', async () => {
  const { queued } = await queueStopOrders();
  await send('@hoots stop');
  expect((await commands()).filter(command => command.action === 'input')).toHaveLength(0);
  expect((await commands(B)).filter(command => command.reason === 'report')).toHaveLength(1);
  for (const command of queued) await expect(claim(command, 'late-helper')).rejects.toThrow();
  const line = await db.query<{ text: string }>(`SELECT text FROM messages
    WHERE room_id=$1 AND system_event->>'verb'='stopped its running turn' ORDER BY created_at DESC LIMIT 1`, [R]);
  expect(line.rows[0]!.text).toContain('2 queued orders dropped');
});

it.runIf(Boolean(stopProofPostgresUrl))('Stop holds the claim fence through the drain and preserves an order arriving during Stop', async () => {
  const { queued, root } = await queueStopOrders();
  let reached!: () => void, release!: () => void, claimStarted!: () => void;
  const stopped = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { claimStarted = resolve; });
  const wrapStop = (database: SqlDatabase): SqlDatabase => ({
    query: async (sql, values) => {
      const result = await database.query(sql, values);
      if (sql.includes("UPDATE agent_turns SET status='cancelled',created_at=now()")) {
        reached();
        await resume;
      }
      return result;
    },
    transaction: work => database.transaction(transaction => work(wrapStop(transaction))),
  });
  const wrapClaim = (database: SqlDatabase): SqlDatabase => ({
    query: (sql, values) => {
      if (sql.includes('pg_advisory_xact_lock')) claimStarted();
      return database.query(sql, values);
    },
    transaction: work => database.transaction(transaction => work(wrapClaim(transaction))),
  });
  const stop = new PhoneService(wrapStop(db), 'http://test').execute('cancelAgentTurn',
    { roomId: R, agentId: A, requestId: queued[0]!.turnRequestId }, H);
  let claimAttempt: Promise<unknown> | undefined;
  try {
    await stopped;
    claimAttempt = new DaemonService(wrapClaim(db), live).execute('claimAgentCommand',
      { roomId: R, commandId: queued[1]!.id, generationId: 'racing-helper' }, A);
    // Attach the rejection handler before releasing Stop.
    const rejected = expect(claimAttempt).rejects.toThrow('command claim conflict');
    await started;
    const fence = await db.transaction(transaction => transaction.query<{ available: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) available`, [`agent-command-queue:${R}:${A}`]));
    expect(fence.rows[0]!.available).toBe(false);
    await daemon.execute('order', { roomId: R, address: R, agent: 'hoots', text: 'arrived during Stop',
      requestId: root.turnRequestId, generationId: 'g1' }, B);
    release();
    await stop;
    await rejected;
    const surviving = (await commands()).filter(command => command.action === 'input');
    expect(surviving).toHaveLength(1);
    expect(surviving[0]!.source.body).toContain('arrived during Stop');
    await claim(surviving[0]!);
    console.log('Demonstrated Reproduction stop-queued-orders on PostgreSQL: claim fence held after turn cancellation and before drain; racing cached claim refused after commit; order accepted during Stop survived and claimed');
  } finally {
    release();
    await Promise.allSettled([stop, ...(claimAttempt ? [claimAttempt] : [])]);
  }
});

it('runs only the newest of three overdue pings, preserving the earlier text as history', async () => {
  await send('@hoots First request');
  await send('@hoots Are you there?');
  await send('@hoots Please answer this latest request');
  await db.query(`UPDATE agent_commands SET created_at=created_at-interval '2 minutes'`);
  const pending = await commands();
  expect(pending).toHaveLength(1);
  expect(pending[0]!.source.body).toBe('@hoots Please answer this latest request');
  expect(pending[0]!.recoveryContext).toContain('@hoots First request');
  expect(pending[0]!.recoveryContext).toContain('@hoots Are you there?');
  const cancelled = await db.query<{ cancellation_reason: string }>(
    `SELECT cancellation_reason FROM agent_commands WHERE state='cancelled'`,
  );
  expect(cancelled.rows).toEqual(Array(2).fill({ cancellation_reason: `superseded_on_return:${pending[0]!.id}` }));
  await claim(pending[0]!);
  await result(pending[0]!, 'Back now');
  expect(await commands()).toHaveLength(0);
});

it('keeps one latest wake in each Room when returning', async () => {
  for (const room of [R, C]) {
    await send('@hoots First ping', room);
    await send('@hoots Latest ping', room);
  }
  await db.query(`UPDATE agent_commands SET created_at=created_at-interval '2 minutes'`);
  for (const room of [R, C]) {
    const pending = await commands(A, room);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.source.body).toBe('@hoots Latest ping');
    expect(pending[0]!.recoveryContext).toContain('@hoots First ping');
    await claim(pending[0]!);
    await result(pending[0]!, 'Back in this Room');
  }
});

it('supersedes an expired claimed wake as well as pending pings on return', async () => {
  await send('@hoots Request before the helper exited');
  const [abandoned] = await commands();
  await claim(abandoned!);
  await send('@hoots First offline ping');
  await send('@hoots Latest offline ping');
  await db.query(`UPDATE agent_commands SET created_at=created_at-interval '2 minutes',
    lease_expires_at=CASE WHEN state='claimed' THEN now()-interval '1 second' ELSE lease_expires_at END`);
  const pending = await commands();
  expect(pending).toHaveLength(1);
  expect(pending[0]!.source.body).toBe('@hoots Latest offline ping');
  expect(pending[0]!.recoveryContext).toContain('Request before the helper exited');
  expect(pending[0]!.recoveryContext).toContain('First offline ping');
  expect(pending[0]!.recoveryContext!.split('\n')).toHaveLength(2);
  await expect(claim(abandoned!, 'returned-helper')).rejects.toThrow();
  await expect(result(abandoned!, 'Late output')).rejects.toThrow();
  expect((await db.query(`SELECT status FROM agent_turns WHERE request_id=$1`,
    [abandoned!.turnRequestId])).rows).toEqual([{ status: 'cancelled' }]);
  await claim(pending[0]!, 'returned-helper');
  await result(pending[0]!, 'Back now', 'returned-helper');
});

it('refuses a stale helper snapshot at claim and supplies the survivor its current history', async () => {
  await send('@hoots First request');
  await send('@hoots Latest request');
  const snapshot = await commands();
  await db.query(`UPDATE agent_commands SET created_at=created_at-interval '2 minutes'`);
  await expect(claim(snapshot[0]!)).rejects.toThrow();
  const claimed = await daemon.execute('claimAgentCommand', {
    roomId: R, commandId: snapshot[1]!.id, generationId: 'returned-helper',
  }, A);
  expect(claimed.recoveryContext).toContain('@hoots First request');
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE state='cancelled'`)).rowCount).toBe(1);
});

it('keeps the surviving resume claimable when superseded resumes share its turn', async () => {
  await send('@hoots Start the turn');
  const [parent] = await commands();
  await claim(parent!);
  await db.query(`UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [parent!.id]);
  for (const text of ['Earlier decision', 'Latest decision']) {
    const source = id();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [source, R, H, text]);
    await createAgentCommand(db, {
      roomId: R, agentId: A, sourceMessageId: source, action: 'resume', reason: 'resume',
      turnRequestId: parent!.turnRequestId,
    });
  }
  await db.query(`UPDATE agent_commands SET created_at=created_at-interval '2 minutes'`);
  const pending = await commands();
  expect(pending).toHaveLength(1);
  expect(pending[0]!.source.body).toBe('Latest decision');
  await claim(pending[0]!, 'returned-helper');
  await result(pending[0]!, 'Resumed once', 'returned-helper');
});

it('folds fresh online follow-ups at claim and preserves them during a live turn', async () => {
  await send('@hoots First request');
  await send('@hoots Second request');
  await send('@hoots Third request');
  const pending = await commands();
  expect(pending).toHaveLength(3);
  await claim(pending[0]!);
  await db.query(`UPDATE agent_commands SET created_at=created_at-interval '2 minutes' WHERE state='pending'`);
  expect(await commands()).toHaveLength(0);
  const head = (await db.query(`SELECT coalesced_context FROM agent_commands WHERE id=$1`, [pending[0]!.id])).rows[0]!;
  expect(head.coalesced_context).toContain('Second request');
  expect(head.coalesced_context).toContain('Third request');
  await result(pending[0]!, 'Finished all requests');
  expect(await commands()).toHaveLength(0);
});

it('coalesces recent offline pings on a new live connection, without waiting ninety seconds', async () => {
  await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('return-test') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id,released_at)
    VALUES($1,1,'return-test','return-test',clock_timestamp())`, [A]);
  // A crashed helper can leave a still-valid takeover lease behind.
  await send('@hoots Task before the helper exited');
  const [abandoned] = await commands();
  await claim(abandoned!);
  await send('@hoots First offline ping');
  await send('@hoots Last offline ping');
  await db.query(`UPDATE agent_connections SET connected_at=clock_timestamp(),released_at=NULL WHERE agent_id=$1`, [A]);
  const pending = await commands();
  expect(pending).toHaveLength(1);
  expect(pending[0]!.source.body).toBe('@hoots Last offline ping');
});

it('keeps an online long-running turn and its follow-ups after the takeover lease expires', async () => {
  await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('long-turn') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
    VALUES($1,1,'long-turn','long-turn')`, [A]);
  await send('@hoots Long-running task');
  const [working] = await commands();
  await claim(working!);
  await send('@hoots First follow-up');
  await send('@hoots Second follow-up');
  await db.query(`UPDATE agent_commands SET created_at=created_at-interval '2 minutes',
    lease_expires_at=CASE WHEN state='claimed' THEN now()-interval '1 second' ELSE lease_expires_at END`);
  expect(await commands()).toHaveLength(3);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE state='cancelled'`)).rowCount).toBe(0);
  // The live helper renews its own generation with its next working receipt.
  await daemon.execute('postAgentTurnReceipt', { roomId: R, agentId: A,
    requestId: working!.turnRequestId, generationId: 'g1', status: 'working' }, A);
  await result(working!, 'Finished the long task');
  expect(await commands()).toHaveLength(2);
});

it('keeps rapid online follow-ups across a brief socket reconnect', async () => {
  await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('online-test') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
    VALUES($1,1,'online-test','online-test')`, [A]);
  await send('@hoots First online request');
  await send('@hoots Second online request');
  await send('@hoots Third online request');
  await db.query(`UPDATE agent_connections SET connected_at=clock_timestamp() WHERE agent_id=$1`, [A]);
  expect(await commands()).toHaveLength(3);
});

it('carries accumulated history through a second offline return', async () => {
  await send('@hoots Original request');
  await send('@hoots Second request');
  await db.query(`UPDATE agent_commands SET created_at=created_at-interval '2 minutes'`);
  expect(await commands()).toHaveLength(1);
  await send('@hoots Third request');
  const [newest] = await commands();
  expect(newest!.source.body).toBe('@hoots Third request');
  expect(newest!.recoveryContext).toContain('@hoots Original request');
  expect(newest!.recoveryContext).toContain('@hoots Second request');
});

it('bootstrap identifies only pending member surfaces, including the corner parent', async () => {
  await send('@hoots Wake the Room');
  await send('@hoots Wake the corner', C);
  const bootstrap = await daemon.execute('getDaemonBootstrap', { agentId: A }, A);
  expect(bootstrap.pendingRooms).toEqual(expect.arrayContaining([
    { roomId: R }, { roomId: C, parentRoomId: R, openedBy: B },
  ]));
  await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`, [A, R]);
  expect((await daemon.execute('getDaemonBootstrap', { agentId: A }, A)).pendingRooms).toEqual([]);
});

it('shows an accepted tagged command until claim and re-nudges a connected idle helper once', async () => {
  const sent = await send('@hoots Please check this');
  const [command] = await commands(A);
  const waiting = { requestId: command!.turnRequestId, agentPubkey: A };
  expect(sent.pendingAgentCommands).toEqual([expect.objectContaining(waiting)]);
  expect((await phone.readRoom(R, H))?.pendingAgentCommands).toEqual([
    expect.objectContaining(waiting),
  ]);

  await db.query(`UPDATE agent_commands SET created_at=now()-interval '31 seconds' WHERE id=$1`, [command!.id]);
  expect(await renudgeStrandedPendingCommands(db)).toBe(0);
  await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('renudge-test') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
    VALUES($1,1,'renudge-test','renudge-test') ON CONFLICT(agent_id) DO UPDATE
    SET instance_id=EXCLUDED.instance_id,released_at=NULL`, [A]);
  const busySend = await send('@hoots An earlier task');
  await db.query(`UPDATE agent_commands SET state='claimed',lease_expires_at=now()+interval '90 seconds'
    WHERE source_message_id=$1`, [busySend.messageId]);
  expect(await renudgeStrandedPendingCommands(db)).toBe(0);
  await db.query(`UPDATE agent_commands SET state='complete' WHERE source_message_id=$1`, [busySend.messageId]);
  expect(await renudgeStrandedPendingCommands(db)).toBe(1);
  expect(await renudgeStrandedPendingCommands(db)).toBe(0);
  await claim(command!);
  expect((await phone.readRoom(R, H))?.pendingAgentCommands).toEqual([]);
});

it('Reproduction R2: an order accepted while the helper is offline runs when it reconnects', async () => {
  await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('r2-offline') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id,released_at)
    VALUES($1,1,'r2-offline','r2-offline',now())`, [A]);
  const command = await createAgentCommand(db, {
    roomId: C, agentId: A, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', text: 'Do the work', authorId: B, fromRoomId: R },
  });
  const stored = (await db.query<{ state: string; created_offline: boolean; claimed_at: Date | null; renudged_at: Date | null }>(
    `SELECT state,created_offline,claimed_at,renudged_at FROM agent_commands WHERE id=$1`, [command!.id],
  )).rows[0];
  expect(stored).toMatchObject({ state: 'pending', created_offline: true, claimed_at: null, renudged_at: null });
  expect(await renudgeStrandedPendingCommands(db, A)).toBe(0);
  await claimAgentConnection(db, live, A, { lifecycleId: 'back' }, { connectionId: 'r2-back', instanceId: 'r2-offline' });
  expect((await db.query<{ renudged_at: Date | null }>(
    `SELECT renudged_at FROM agent_commands WHERE id=$1`, [command!.id],
  )).rows[0]?.renudged_at).toBeTruthy();
  const delivered = await commands(A, C);
  expect(delivered.map((item) => item.id)).toContain(command!.id);
  await claim(delivered.find((item) => item.id === command!.id)!);
  expect((await db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [command!.id])).rows[0]?.state)
    .toBe('claimed');
});

it('re-nudges an order while the helper is claimed in a different room', async () => {
  await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('r2-busy') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
    VALUES($1,1,'r2-busy','r2-busy') ON CONFLICT(agent_id) DO UPDATE
    SET instance_id=EXCLUDED.instance_id,released_at=NULL`, [A]);
  const order = await createAgentCommand(db, {
    roomId: C, agentId: A, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', text: 'Queued behind another corner', authorId: B, fromRoomId: R },
  });
  await db.query(`UPDATE agent_commands SET created_at=now()-interval '31 seconds' WHERE id=$1`, [order!.id]);
  const busy = await send('@hoots busy elsewhere');
  await db.query(`UPDATE agent_commands SET state='claimed',lease_expires_at=now()+interval '90 seconds'
    WHERE source_message_id=$1`, [busy.messageId]);
  expect(await renudgeStrandedPendingCommands(db)).toBe(1);
  await db.query(`UPDATE agent_commands SET wake_after=now()+interval '1 hour',renudged_at=NULL WHERE id=$1`, [order!.id]);
  expect(await renudgeStrandedPendingCommands(db)).toBe(0);
});
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
const result = (c: AgentCommand, text: string, generationId = 'g1', extra = {}) =>
  daemon.execute(
    'postRoomMessage',
    {
      roomId: c.roomId,
      requestId: c.turnRequestId,
      generationId,
      text,
      ...extra,
    },
    c.agentId,
  );

it.each([R, C])('projects reply context outside the conversation window in %s', async (roomId) => {
  const parentId = id();
  const parentText = 'Five corners from the audit: '.repeat(30);
  await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',
    [parentId, roomId, B, parentText]);
  const sent = await phone.execute('sendRoomReply', {
    roomId, parentMessageId: parentId, text: '@hoots Dispatch these five corners',
  }, H);
  const command = (await commands(A, roomId)).find((c) => c.sourceMessageId === sent.messageId)!;
  expect(command).toBeDefined();
  const reply = {
    replyToMessageId: parentId,
    replyToAuthorId: B,
    replyToAuthorName: 'Goosy',
    replyToExcerpt: expect.any(String),
  };
  expect(command.source).toMatchObject(reply);
  expect(command.source.replyToExcerpt!.length).toBeLessThanOrEqual(300);
  const excerpt = command.source.replyToExcerpt!;
  expect(excerpt).toMatch(/…$/);
  expect(parentText.startsWith(excerpt.slice(0, -1))).toBe(true);
  expect(parentText[excerpt.length - 1]).toMatch(/\s/);
  const inbox = await daemon.execute('getRoomInbox', { roomId }, A);
  expect(inbox.items.find((m) => m.id === sent.messageId)).toMatchObject(reply);
  const conversation = await daemon.execute('getRoomConversation', { roomId, limit: 1 }, A);
  expect(conversation.items).toHaveLength(1);
  expect(conversation.items[0]).toMatchObject(reply);
  expect(conversation.items[0]?.id).toBe(sent.messageId);
  expect(conversation.items[0]?.replyToExcerpt).toBe(command.source.replyToExcerpt);
  console.log('Reproduction reply-context: phone reply → server wake/inbox/newest-page supplies parent ID, author and bounded excerpt');
});
beforeAll(async () => {
  if (stopProofPostgresUrl) {
    const schema = `stop_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: stopProofPostgresUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const postgres = new PostgresDatabase('', 5, { mode: 'migration', pool: new Pool({
      connectionString: stopProofPostgresUrl, options: `-c search_path=${schema},public`,
    }) });
    db = postgres;
    closeDatabase = async () => {
      await postgres.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    };
  } else {
    const pglite = new PgliteDatabase();
    db = pglite;
    closeDatabase = () => pglite.close();
  }
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
    for (const room of [null, R])
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
  live = new LiveHub();
  daemon = new DaemonService(db, live);
  Object.assign(daemon, { github: { assertCornerReviewerNotAuthor: async () => {} } });
}, 30_000);
afterAll(async () => closeDatabase?.());
beforeEach(async () => {
  await db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`, [R]);
  await db.query(`DELETE FROM agent_connections`);
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
  // The corner's workflow run and its wakes commit together; resetting one
  // resets the other.
  await db.query(`DELETE FROM messages WHERE card_type='corner-workflow-handoff'`);
  await db.query(`DELETE FROM agent_turns`);
  await db.query(`DELETE FROM corner_merge_approvals`);
  await db.query(`DELETE FROM corner_brief_revisions`);
  await db.query(`UPDATE agents SET access_policy='{"type":"everyone"}'::jsonb`);
  await db.query(`UPDATE memberships SET removed_at=NULL`);
  await db.query(`UPDATE memberships SET event_subscriptions='[]'::jsonb`);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL`);
  await db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`, [C]);
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"checks":"unknown"}'::jsonb`,
  );
});

it('Reproduction workflow-corner-objective: a corner objective rooted on a parent workflow handoff carries no run instruction', async () => {
  // A workflow handoff card in the parent Room R carries the run id, workflow
  // name and a receipt hint, exactly as a real handoff does. When a workflow
  // step opens a corner, `createCorner` roots the corner objective command on
  // this parent-Room message, so the read path sees it in the corner.
  const parentRunId = id();
  const parentHandoffId = id();
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,card_type,card)
     VALUES($1,$2,$3,$4,'workflow-handoff',$5::jsonb)`,
    [
      parentHandoffId,
      R,
      B,
      'Goosy handed off workflow feedback-triage',
      JSON.stringify({
        runId: parentRunId,
        workflowSlug: 'feedback-triage',
        toState: 'dispatch',
        seq: 6,
        receiptHint: 'Finish dispatch then stop.',
      }),
    ],
  );
  await createAgentCommand(db, {
    roomId: C,
    agentId: B,
    sourceMessageId: parentHandoffId,
    reason: 'corner_objective',
  });
  const [objective] = await commands(B, C);
  expect(objective?.reason).toBe('corner_objective');
  // The parent run is not reachable from the corner: its first turn must not
  // tell the implementer to hand off a run that lives in another Room.
  expect(objective?.source.body).not.toContain('You are in run');
  expect(objective?.source.body).not.toContain('This wake is attempt');
  expect(objective?.source.body).not.toContain('Receipt hint for this state');
  console.log(
    `Reproduction workflow-corner-objective: a corner objective rooted on the parent Room handoff (run ${parentRunId}) reads as: ${JSON.stringify(objective?.source.body)}`,
  );
});

it('a workflow wake for a run in the turn’s own Room still carries the run instruction', async () => {
  const runId = id();
  const handoffId = id();
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,card_type,card)
     VALUES($1,$2,$3,$4,'workflow-handoff',$5::jsonb)`,
    [
      handoffId,
      C,
      B,
      'Goosy handed off workflow feedback-triage',
      JSON.stringify({
        runId,
        workflowSlug: 'feedback-triage',
        toState: 'dispatch',
        seq: 6,
        receiptHint: 'Finish dispatch then stop.',
      }),
    ],
  );
  await createAgentCommand(db, {
    roomId: C,
    agentId: B,
    sourceMessageId: handoffId,
    reason: 'workflow_handoff',
  });
  const [wake] = await commands(B, C);
  expect(wake?.source.body).toContain(`You are in run ${runId} of feedback-triage`);
  expect(wake?.source.body).toContain('This wake is attempt 6');
  console.log(
    `Demonstrated workflow-corner-objective: a same-Room workflow wake (run ${runId}) still reads as: ${JSON.stringify(wake?.source.body)}`,
  );
});

it('lets the corner agent retitle its corner during its turn', async () => {
  await send('@hoots plan the launch', C);
  const [command] = await commands(A, C);
  await claim(command!);
  const rename = (name: string) =>
    daemon.execute(
      'renameCorner',
      { cornerId: C, requestId: command!.turnRequestId, generationId: 'g1', name },
      A,
    );

  await expect(rename('too many words for a title')).rejects.toThrow(
    'the name must not contain whitespace; use hyphens between words',
  );
  await expect(rename('  Launch\n plan ')).rejects.toThrow(/whitespace/);
  await expect(rename('Launch-plan')).resolves.toEqual({ cornerId: C, name: 'Launch-plan' });
  expect((await phone.readRoom(C, H))?.room.name).toBe('Launch-plan');
  await result(command!, 'Renamed.');
  await expect(rename('Too late')).rejects.toThrow();
  await db.query(`UPDATE rooms SET name='Corner' WHERE id=$1`, [C]);
});

it.each(['room', 'corner', 'dm'])(
  'Reproduction F1: a follow-up in a %s queues and the running turn stays the one shown working',
  async (path) => {
    const room = path === 'corner' ? C : R;
    if (path === 'dm')
      await db.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`, [R, JSON.stringify([H, A])]);
    try {
      await send(path === 'dm' ? 'start' : '@hoots start', room);
      const [running] = await commands(A, room);
      await claim(running!);
      const followUp = await send(path === 'dm' ? 'one more thing' : '@hoots one more thing', room);
      const shown = await phone.readRoom(room, H);
      expect(shown?.latestAgentTurns?.filter((turn) => turn.agentPubkey === A)).toEqual([
        expect.objectContaining({ requestId: running!.turnRequestId, status: 'working' }),
      ]);
      const [queued] = shown?.pendingAgentCommands ?? [];
      expect(queued).toMatchObject({ agentPubkey: A });
      expect(queued!.requestId).not.toBe(running!.turnRequestId);
      expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2
        AND request_id=$3`, [room, A, running!.turnRequestId])).rows).toEqual([{ status: 'working' }]);

      // Once the running turn ends, the queued follow-up's claim paints its own turn.
      await result(running!, 'Started');
      const next = (await commands(A, room)).find((command) => command.sourceMessageId === followUp.messageId);
      await claim(next!);
      expect((await phone.readRoom(room, H))?.latestAgentTurns?.filter((turn) => turn.agentPubkey === A))
        .toEqual([expect.objectContaining({ requestId: next!.turnRequestId, status: 'working' })]);
      await result(next!, 'Done');
    } finally {
      await db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`, [R]);
    }
  },
);

describe.each([R, C])('server command authority in %s', (room) => {
  it('acknowledges a committed human steer only while its targeted turn is active', async () => {
    const first = await send('@hoots start', room);
    const [active] = await commands(A, room);
    await claim(active!);

    const steerId = id();
    const received = await phone.execute(
      'sendRoomMessage',
      { roomId: room, messageId: steerId, text: '@hoots change course' },
      H,
    );
    expect(received).toMatchObject({ messageId: steerId, activeSteerAgentIds: [A],
      message: { id: steerId, text: '@hoots change course' } });
    expect((await commands(A, room)).map((command) => command.sourceMessageId)).toContain(steerId);

    // A retried write reads the same committed routing result instead of
    // falling back to a client-side guess.
    await expect(
      phone.execute(
        'sendRoomMessage',
        { roomId: room, messageId: steerId, text: '@hoots change course' },
        H,
      ),
    ).resolves.toEqual(received);

    await result(active!, 'Finished');
    const idleId = id();
    await expect(
      phone.execute(
        'sendRoomMessage',
        { roomId: room, messageId: idleId, text: '@hoots next task' },
        H,
      ),
    ).resolves.toMatchObject({ messageId: idleId, activeSteerAgentIds: [],
      message: { id: idleId, text: '@hoots next task' } });
    expect(first.messageId).toBe(active!.sourceMessageId);
  });

  it('routes a human message to an agent only when the message addresses it', async () => {
    // A typed tag routes.
    await send('@hoots ask Goosy', room);
    const [first] = await commands(A, room);
    expect(first).toBeDefined();
    await claim(first!);
    await result(first!, 'Tag @goosy and Goosy answers');
    const [tagged] = await commands(B, room);
    expect(tagged).toBeDefined();
    await claim(tagged!);
    await result(tagged!, 'Goosy answered');
    expect(await commands(A, room)).toEqual([]);

    // An untagged message routes to nobody, even when an agent wrote the
    // immediately preceding message: transcript adjacency starts no turn.
    await send('Thanks everyone', room);
    expect(await commands(A, room)).toEqual([]);
    expect(await commands(B, room)).toEqual([]);

    // A reply to an agent starts with the parent agent's @handle in the mobile
    // composer (apps/mobile/sources/buzz/composer-prefill.ts), so it routes as
    // a tag.
    const agentReply = (
      await db.query<{ id: string; text: string }>(
        `SELECT id,text FROM messages WHERE room_id=$1 AND author_id=$2 AND presentation='message'
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [room, B],
      )
    ).rows[0]!;
    expect(agentReply.text).toBe('Goosy answered');
    await phone.execute(
      'sendRoomReply',
      { roomId: room, parentMessageId: agentReply.id, text: '@goosy Thanks again' },
      H,
    );
    const [replyCommand] = await commands(B, room);
    expect(replyCommand?.reason).toBe('human_tag');
    expect(replyCommand?.sourceMessageId).not.toBe(agentReply.id);
    expect(await commands(A, room)).toEqual([]);
    await claim(replyCommand!);
    await result(replyCommand!, 'Settled');

    // Untagged messages after human traffic still route to nobody.
    await send('An intervening human message', room);
    await send('This is not a continuation', room);
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
      await result(c!, `@${target === A ? 'hoots' : 'goosy'} depth ${depth}`);
      const next = await commands(target, room);
      if (depth === 3) expect(next).toEqual([]);
      else c = next[0];
    }
  });
  it('routes replies only through exact tags', async () => {
    await send('@hoots start', room);
    const [a] = await commands(A, room);
    await claim(a!);
    const posted = await result(a!, '@goosy Delegation');
    const [b] = await commands(B, room);
    await claim(b!);
    const reply = await result(b!, 'Deliberate reply', 'g1', { replyToMessageId: posted.id });
    expect(await commands(A, room)).toEqual([]);
    await send('@goosy Start a tagged handoff', room);
    const fresh = (await commands(B, room))[0]!;
    await claim(fresh!);
    const taggedReply = await result(fresh!, '@hoots Deliberate handoff');
    expect((await commands(A, room))[0]?.agentDepth).toBe(1);
    await db.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [B]);
    await phone.execute(
      'sendRoomReply',
      { roomId: room, parentMessageId: reply.id, text: 'Continue' },
      H,
    );
    expect(await commands(B, room)).toEqual([]);
    await phone.execute(
      'sendRoomReply',
      { roomId: room, parentMessageId: taggedReply.id, text: '@goosy Continue' },
      H,
    );
    expect((await commands(B, room))[0]?.agentDepth).toBe(0);
  });
  it('wakes no agent whose handle appears only inside code', async () => {
    await send('@hoots review the probe', room);
    const [review] = await commands(A, room);
    await claim(review!);
    await result(
      review!,
      'FAIL. The probe reads `@goosy and @hoots take it`.\n\n```\n@goosy fix R1\n```\nNo tag here.',
    );
    expect(await commands(B, room)).toEqual([]);

    await send('Quoting `@goosy` and\n```\n@hoots\n```', room);
    expect(await commands(A, room)).toEqual([]);
    expect(await commands(B, room)).toEqual([]);

    await send('Run `npm test` then @goosy take a look', room);
    expect(await commands(B, room)).toHaveLength(1);
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
it('routes only the exact current spelling of an agent tag', async () => {
  await send('@Hoots @ｈｏｏｔｓ @hoots-old');
  expect(await commands(A)).toEqual([]);
  await send('@hoots');
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
  const one = await result(c!, '@goosy Done');
  const two = await result(c!, '@goosy Done');
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
  await result(c!, 'Current', 'g2');
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
it('routes a validated agent tag when the final message is committed', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  expect(await commands(B)).toEqual([]);
  await result(c!, '@goosy please help');
  expect(await commands(B)).toHaveLength(1);
});
it('does not trust a caller-supplied agent id without an exact tag', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  const posted = await result(c!, '@GOOSY please help');
  expect(await commands(B)).toEqual([]);
  // `@GOOSY` is not how Goosy is spelled, so it names nobody — and there is no
  // caller-supplied list that could disagree with the words.
  expect(
    (
      await db.query<{ tagged_ids: string[] }>(
        `SELECT ${taggedIdentityIdsSql('m')} tagged_ids FROM messages m WHERE m.id=$1`,
        [posted.id],
      )
    ).rows[0]?.tagged_ids,
  ).toEqual([]);
});
it('rolls final storage back if creating the next command fails', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  await db.query(`CREATE FUNCTION refuse_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected dispatch failure'; END $$;
 CREATE TRIGGER refuse_command BEFORE INSERT ON agent_commands FOR EACH ROW EXECUTE FUNCTION refuse_command();`);
  try {
    await expect(result(c!, '@goosy Atomic')).rejects.toThrow('injected');
    expect((await db.query(`SELECT 1 FROM messages WHERE text='Atomic'`)).rowCount).toBe(0);
  } finally {
    await db.query(
      `DROP TRIGGER refuse_command ON agent_commands; DROP FUNCTION refuse_command();`,
    );
  }
  await result(c!, '@goosy Atomic');
  expect(await commands(B)).toHaveLength(1);
});
it('gives old helpers only projected commands and refuses unsolicited old output', async () => {
  await send('@hoots');
  await send('ordinary traffic');
  const a = await daemon.execute('getRoomInbox', { roomId: R, startAtLatest: true }, A);
  const b = await daemon.execute('getRoomInbox', { roomId: R, startAtLatest: true }, B);
  expect(a.items).toHaveLength(1);
  // The item reached A because the server routed it to A; the row itself
  // carries no reader to re-check that against.
  expect(a.items[0]?.authorId).toBe(H);
  expect(b.items).toEqual([]);
  await expect(
    daemon.execute(
      'postRoomMessage',
      { roomId: R, text: 'Unsolicited', requestId: a.items[0]!.id },
      B,
    ),
  ).rejects.toThrow();
});
it('wakes the opener for failed checks even after a reviewer turn and retries a lost command', async () => {
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
  const reviewerSource = await send('Review this', C);
  await db.transaction((tx) =>
    routeSystemCommand(tx, {
      roomId: C,
      sourceMessageId: reviewerSource.messageId,
      targets: [A],
      kind: 'joined',
    }),
  );
  const [review] = await commands(A, C);
  await claim(review!);
  await result(review!, 'Review complete');
  await db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [C]);
  const headSha = 'e'.repeat(40);
  await db.query(
    `UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'failing',
        pr: {
          number: 31,
          headSha,
          title: 'Fix checks',
          url: 'https://github.com/acme/repo/pull/31',
        },
      }),
    ],
  );
  const note = await systemLine(db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'failed a check',
    kind: 'check-failed',
    object: { text: 'typecheck', headSha },
  });
  expect(await commands(B, C)).toEqual([
    expect.objectContaining({ reason: 'corner_check', sourceMessageId: note.id }),
  ]);
  expect((await readAgentCommands(db,C,A)).commands).toHaveLength(0);
  // The wake and the workflow transition commit together, so a command can
  // only be lost in a corner with no run record: one opened before the
  // workflow run existed. Its run is rebuilt from the lifecycle and the
  // missing wake re-sent.
  await db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [C]);
  await db.query(`DELETE FROM messages WHERE room_id=$1 AND card_type='corner-workflow-handoff'`, [C]);
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(1);
  expect(await commands(B, C)).toHaveLength(1);
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(0);
});

it('recovers a dirty PR lifecycle once per head and retries an undelivered conflict', async () => {
  const headSha = 'f'.repeat(40);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      checks: 'passing',
      pr: {
        number: 32,
        headSha,
        title: 'Resolve conflict',
        url: 'https://github.com/acme/repo/pull/32',
        mergeability: 'dirty',
      },
    }),
  ]);
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(1);
  expect(await commands(B, C)).toEqual([
    expect.objectContaining({ reason: 'corner_merge_conflict' }),
  ]);
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(0);
  await db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [C]);
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(1);
  expect(await commands(B, C)).toHaveLength(1);
  await db.query(
    `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,baseSha}',to_jsonb($2::text))
     WHERE corner_id=$1`,
    [C, 'a'.repeat(40)],
  );
  // A moved base is not a new head: the conflict wake stays one per head.
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(0);
  expect(await commands(B, C)).toHaveLength(1);
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(0);
});

it('Reproduction STALE-1: drops a merge-conflict wake whose head moved before the implementer claims it', async () => {
  const headA = '1'.repeat(40), headB = '2'.repeat(40);
  const dirty = (headSha: string) =>
    JSON.stringify({
      checks: 'passing',
      pr: {
        number: 41,
        headSha,
        title: 'Resolve conflict',
        url: 'https://github.com/acme/repo/pull/41',
        mergeability: 'dirty',
      },
    });
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C, dirty(headA)]);
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(1);
  const [staleWake] = await commands(B, C);
  expect(staleWake?.reason).toBe('corner_merge_conflict');
  expect(staleWake?.source.body).toContain(headA);
  // The PR head moves before the implementer claims the queued wake.
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C, dirty(headB)]);
  const delivered = (await commands(B, C)).filter((command) => command.reason === 'corner_merge_conflict');
  const staleState = (
    await db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [staleWake!.id])
  ).rows[0]?.state;
  console.info(
    `Reproduction STALE-1: wrong=1 delivered wake naming ${headA.slice(0, 8)}; right=0; observed=${delivered.filter((command) => command.source.body.includes(headA)).length}`,
  );
  expect(delivered).toHaveLength(0);
  expect(staleState).toBe('cancelled');
  await expect(claim(staleWake!)).rejects.toThrow();
  // The current dirty head still gets exactly one wake, naming that head.
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(1);
  const current = (await commands(B, C)).filter((command) => command.reason === 'corner_merge_conflict');
  expect(current).toHaveLength(1);
  expect(current[0]?.source.body).toContain(headB);
  expect(current[0]?.source.body).not.toContain(headA);
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(0);
  console.log('Demonstrated Reproduction STALE-1: stale head A wake cancelled and refused; current dirty head B wake delivered exactly once');
});

it.each(['delivery', 'claim'])('Reproduction CHECK-HEAD-1: cancels a failed-check wake for the previous head at %s', async boundary => {
  const oldHead = '1'.repeat(40), newHead = '2'.repeat(40);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C,
    JSON.stringify({ checks: 'failing', pr: { number: 41, headSha: oldHead } })]);
  const line = await systemLine(db, { roomId: C, authorId: H,
    subject: { kind: 'github', name: 'GitHub' }, verb: 'found failing checks on',
    object: { text: 'pull request #41', headSha: oldHead } });
  const queued = await createAgentCommand(db, { roomId: C, agentId: B, sourceMessageId: line.id, reason: 'corner_check' });
  expect(queued).toBeTruthy();
  const [stale] = await commands(B, C);
  expect(stale?.reason).toBe('corner_check');
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C,
    JSON.stringify({ checks: 'passing', pr: { number: 41, headSha: newHead } })]);
  if (boundary === 'delivery') expect(await commands(B, C)).toHaveLength(0);
  await expect(claim(stale!)).rejects.toThrow();
  // A rejected claim rolls back its transaction; delivery persists the cancellation.
  expect(await commands(B, C)).toHaveLength(0);
  expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [queued!.id])).rows[0]?.state).toBe('cancelled');
});

it('keeps a failed-check wake retryable while its opener is unreachable', async () => {
  const headSha = '9'.repeat(40);
  await db.query(
    `UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'failing',
        pr: {
          number: 33,
          headSha,
          title: 'Repair CI',
          url: 'https://github.com/acme/repo/pull/33',
        },
      }),
    ],
  );
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    B,
  ]);
  await systemLine(db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'failed a check',
    kind: 'check-failed',
    object: { text: 'typecheck', headSha },
  });
  await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [
    R,
    B,
  ]);
  await expect(reconcileCornerMergeBlockers(db)).resolves.toBe(1);
  expect(await commands(B, C)).toHaveLength(1);
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
    `UPDATE corner_facts SET lifecycle='{"checks":"passing"}' WHERE corner_id=$1`,
    [C],
  );
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
  await expect(
    daemon.execute('getAgentConfiguration', { agentId: A, roomId: C }, A),
  ).resolves.toEqual(expect.objectContaining({ reviewerHandle: 'hoots' }));
  await db.query(`UPDATE memberships SET event_subscriptions='[]'::jsonb WHERE identity_id=$1`, [
    A,
  ]);
  for (let n = 0; n < 2; n++)
    await systemLine(db, {
      roomId: C,
      subject: { kind: 'person', id: H, name: 'Human' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
  expect(await commands(B, C)).toHaveLength(0);
  expect(await commands(A, C)).toHaveLength(1);
  expect((await commands(A, C))[0]?.reason).toBe('subscribed_event');

  await db.query(`DELETE FROM agent_commands`);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    A,
  ]);
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"checks":"failing"}' WHERE corner_id=$1`,
    [C],
  );
  await systemLine(db, {
    roomId: C,
    subject: { kind: 'person', id: H, name: 'Human' },
    verb: 'failed a check',
    kind: 'check-failed',
  });
  expect((await readAgentCommands(db,C,A)).commands).toHaveLength(0);
  expect(await commands(B, C)).toHaveLength(1);

  await db.query(`DELETE FROM agent_commands`);
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: null }, H);
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"checks":"passing"}' WHERE corner_id=$1`,
    [C],
  );
  await systemLine(db, {
    roomId: C,
    subject: { kind: 'person', id: H, name: 'Human' },
    verb: 'passed a check',
    kind: 'check-passed',
  });
  // No reviewer: the implementer owns arranging review or asking for a decision.
  expect((await commands(B, C)).map(command => command.reason)).toEqual(['corner_review_needed']);
});
it('holds the green review wake while the corner worker still holds a live turn', async () => {
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
  // B is the corner's worker and is mid-turn: it claimed a command and its
  // lease is live.
  const worker = await send('Do the work', C);
  await db.transaction((tx) =>
    routeSystemCommand(tx, {
      roomId: C,
      sourceMessageId: worker.messageId,
      targets: [B],
      kind: 'joined',
    }),
  );
  const [workerCommand] = await commands(B, C);
  expect(workerCommand).toBeDefined();
  await claim(workerCommand!, 'gw');

  await db.query(
    `UPDATE corner_facts SET lifecycle='{"checks":"passing"}' WHERE corner_id=$1`,
    [C],
  );
  await systemLine(db, {
    roomId: C,
    subject: { kind: 'person', id: H, name: 'Human' },
    verb: 'passed a check',
    kind: 'check-passed',
  });

  // The reviewer's command exists and is durable, but is not delivered while
  // the worker's lease is live: two agents must not stream into one corner.
  await expect(
    db
      .query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [C, A])
      .then((r) => r.rowCount),
  ).resolves.toBe(1);
  expect((await readAgentCommands(db,C,A)).commands).toHaveLength(0);

  // The worker's lease lapses; the same durable row is now deliverable.
  await db.query(
    `UPDATE agent_commands SET lease_expires_at=now()-interval '1 minute' WHERE room_id=$1 AND agent_id=$2`,
    [C, B],
  );
  expect(await commands(A, C)).toHaveLength(1);

  // This suite shares one store, so leave none of the above behind.
  await db.query(`DELETE FROM agent_commands`);
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"checks":"passing"}' WHERE corner_id=$1`,
    [C],
  );
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: null }, H);
});
it('wakes the implementer without consuming a green transition when the configured reviewer is not a parent member', async () => {
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    A,
  ]);
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"checks":"passing"}' WHERE corner_id=$1`,
    [C],
  );
  await systemLine(db, {
    roomId: C,
    subject: { kind: 'person', id: H, name: 'Human' },
    verb: 'passed a check',
    kind: 'check-passed',
  });
  expect((await readAgentCommands(db,C,A)).commands).toHaveLength(0);
  const handback = await commands(B, C);
  expect(handback.map(command => command.reason)).toEqual(['corner_review_needed']);
  expect(handback[0]?.source.body).toContain('the configured reviewer is unreachable');
  expect(handback[0]?.source.body).toContain('report the blocker to its commander');
  expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%could not be reached%'`, [C])).rowCount).toBe(0);
  await expect(
    daemon.execute('getAgentConfiguration', { agentId: B, roomId: C }, B),
  ).resolves.toEqual(expect.objectContaining({ reviewerHandle: 'hoots' }));
});
it('keeps reviewer subscriptions mandatory and reconciles an unreviewed green head', async () => {
  const headSha = '7'.repeat(40);
  await db.query(
    `UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 17, url: 'https://github.com/acme/repo/pull/17', headSha },
      }),
    ],
  );
  const source = await systemLine(db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'passed a check',
    kind: 'check-passed',
    object: { text: 'BODY SUITE', headSha },
  });
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, A]);
  for (const roomId of [R, C]) {
    await expect(
      daemon.execute('setEventSubscriptions', { roomId, kinds: [] }, A),
    ).resolves.toEqual({ kinds: ['check-passed'] });
  }
  await db.query(`UPDATE memberships SET event_subscriptions='[]'::jsonb WHERE identity_id=$1`, [
    A,
  ]);

  await expect(reconcileConfiguredCornerReviewers(db, R)).resolves.toEqual({
    subscriptions: 1,
    commands: 1,
  });
  expect(await commands(A, C)).toEqual([
    expect.objectContaining({
      rootSourceMessageId: source.id,
      reason: 'subscribed_event',
      private: true,
      source: expect.objectContaining({ body: expect.stringContaining('Current handoff target: PR #17') }),
    }),
  ]);
  await expect(reconcileConfiguredCornerReviewers(db, R)).resolves.toEqual({
    subscriptions: 0,
    commands: 0,
  });
});
// Reproduction RG-1: a stored GitHub note and a passing lifecycle have no
// check-passed fact, so no configured reviewer receives a command.
it('recovers a green head whose earlier GitHub note never dispatched its reviewer', async () => {
  const headSha = '8'.repeat(40);
  await db.query(
    `UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 18, url: 'https://github.com/acme/repo/pull/18', headSha },
      }),
    ],
  );
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, A]);
  await systemLine(db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'passed a check',
    object: { text: 'BODY SUITE', headSha },
  });

  await expect(reconcileConfiguredCornerReviewers(db, R)).resolves.toEqual({
    subscriptions: 1,
    commands: 1,
  });
  expect(await commands(A, C)).toEqual([expect.objectContaining({ reason: 'subscribed_event' })]);
  await expect(reconcileConfiguredCornerReviewers(db, R)).resolves.toEqual({
    subscriptions: 0,
    commands: 0,
  });
});
it('runs revised-brief refusal, repair, rereview, exact-head approval, and implementer clearance as commands', async () => {
  const firstHead = '1'.repeat(40);
  const approvedHead = '2'.repeat(40);
  await db.query(
    `INSERT INTO corner_brief_revisions(
       corner_id,revision,content,intent_verbatim,build_spec,criteria,non_goals,
       brief_references,approval_basis,revision_hash,author_id,source_room_id,source_message_id
     ) VALUES
       ($1,1,'Build the full release card',$2::jsonb,'Build the full release card',$3::jsonb,
        '[]'::jsonb,'[]'::jsonb,$4::jsonb,$5,$6,$7,'intent-1'),
       ($1,2,'Build the corrected full release card',$8::jsonb,'Build the corrected full release card',$9::jsonb,
        '[]'::jsonb,'[]'::jsonb,$10::jsonb,$11,$6,$7,'correction-1')`,
    [
      C,
      JSON.stringify([{ sourceMessageId: 'intent-1', snapshot: 'Show status and owner.' }]),
      JSON.stringify([
        { id: 'AC-1', text: 'Show status.' },
        { id: 'AC-2', text: 'Show the corrected owner label from the approved mock.' },
      ]),
      JSON.stringify({
        kind: 'initiating-command',
        sourceMessageId: 'intent-1',
        snapshot: 'Show status and owner.',
        approvedBy: H,
        briefHash: '3'.repeat(64),
      }),
      '3'.repeat(64),
      B,
      R,
      JSON.stringify([
        { sourceMessageId: 'intent-1', snapshot: 'Show status and owner.' },
        { sourceMessageId: 'correction-1', snapshot: 'Correction: label it Responsible owner.' },
      ]),
      JSON.stringify([
        { id: 'AC-1', text: 'Show status.' },
        { id: 'AC-2', text: 'Show Responsible owner exactly as in the approved mock.' },
      ]),
      JSON.stringify({
        kind: 'explicit-human-answer',
        sourceMessageId: 'correction-1',
        snapshot: 'Correction: label it Responsible owner.',
        approvedBy: H,
        briefHash: '4'.repeat(64),
      }),
      '4'.repeat(64),
    ],
  );
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
  await db.query(
    `UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha: firstHead },
      }),
    ],
  );
  for (let n = 0; n < 2; n++)
    await systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
  const [firstReview] = await commands(A, C);
  expect(firstReview?.reason).toBe('subscribed_event');
  expect(await commands(A, C)).toHaveLength(1);
  await claim(firstReview!);
  await result(
    firstReview!,
    '@goosy PROD-AC-2-1 [AC-2] confirmed: the partial PR omits the corrected Responsible owner label; repair and preserve this finding ID.',
  );

  const [fix] = await commands(B, C);
  expect(fix?.reason).toBe('agent_tag');
  await claim(fix!);
  await result(fix!, 'Pushed the fix');
  await db.query(
    `UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha: approvedHead },
      }),
    ],
  );
  await systemLine(db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'passed a check',
    kind: 'check-passed',
  });
  const [secondReview] = await commands(A, C);
  await claim(secondReview!, 'g2');
  await expect(
    daemon.execute(
      'approveCornerMerge',
      { cornerId: C, headSha: approvedHead },
      A,
    ),
  ).resolves.toEqual({ status: 'approved', pullRequestNumber: 7, headSha: approvedHead });
  await result(secondReview!, `@goosy approved ${approvedHead}, merge`, 'g2');

  expect(
    (
      await db.query(
        `SELECT 1 FROM corner_merge_approvals
         WHERE corner_id=$1 AND approved_by=$2 AND pull_request_number=7 AND head_sha=$3`,
        [C, A, approvedHead],
      )
    ).rowCount,
  ).toBe(1);
  // The PASS wakes the implementer to merge, alongside the reviewer's tag.
  expect((await commands(B, C)).map((command) => command.source.body)).toEqual(
    expect.arrayContaining(['@system handed off review', expect.stringContaining(`@goosy approved ${approvedHead}, merge\nCurrent handoff target: PR #7 at ${approvedHead}`)]),
  );
});
// The merge webhook writes the parent card, then reports the landing to the
// corner workflow. Only the card's `merged` subscribers are woken by it.
const landCorner = async (title: string) => {
  const card = await systemLine(db, {
    id: id(),
    roomId: R,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'merged',
    kind: 'merged',
    object: { text: title, url: 'https://github.com/owner/widgets/pull/42' },
    presentation: 'card',
    cardType: 'daemon-fact',
    durableFact: 'merge',
    card: {
      type: 'corner-complete',
      cornerId: C,
      name: 'Corner',
      objective: 'Do work',
      outcome: 'landed',
      pullRequest: { number: 42, title, url: 'https://github.com/owner/widgets/pull/42' },
    },
  });
  await advanceCorner(db, C, {
    kind: 'merged',
    contents: {
      mergeVerdict: 'merged',
      pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
    },
  });
  return card;
};
it('wakes no parent Room agent on a corner merge without a merged subscription', async () => {
  await landCorner('Do work');
  // B opened the corner; opening it no longer earns a turn when it lands.
  expect(await commands(B, R)).toEqual([]);
  expect(await commands(A, R)).toEqual([]);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1`, [R])).rowCount).toBe(0);
});
it('ignores legacy Room merged subscriptions; lifecycle watches own merge delivery', async () => {
  await db.query(`UPDATE memberships SET event_subscriptions='["merged"]'::jsonb WHERE room_id=$1 AND identity_id=$2`, [R, A]);
  await landCorner('Ship the widget');
  expect(await commands(A, R)).toEqual([]);
  expect(await commands(B, R)).toEqual([]);
});
it('transfers a corner objective to the opener only, without resetting the authorized chain', async () => {
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
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
  expect(objective?.parentCommandId).toBe(c!.id);
  expect(objective?.agentDepth).toBe(c!.agentDepth);
  expect(objective?.source.body).toBe('Do this task');
  // B is a member (it can read the corner and answer when tagged) but the
  // objective is not its work: no intake command.
  expect(await commands(B, opened.cornerId)).toEqual([]);
  expect(
    (
      await db.query<{ event_subscriptions: string[] }>(
        `SELECT event_subscriptions FROM room_access WHERE room_id=$1 AND identity_id=$2`,
        [opened.cornerId, B],
      )
    ).rows,
  ).toEqual([{ event_subscriptions: ['check-passed'] }]);
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

it('keeps a mention queued without a premature offline notice during restart', async () => {
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
  ).toBe(0);
  expect((await db.query(`SELECT 1 FROM messages WHERE id=$1`, [source.messageId])).rowCount).toBe(
    1,
  );
  await db.query(`UPDATE live_outputs SET body='{"status":"online"}' WHERE agent_id=$1`, [A]);
  const [command] = await commands();
  await claim(command!, 'reconnected');
  await result(command!, 'I am here.', 'reconnected');
  expect((await phone.readRoom(R, H))?.messages).toContainEqual(
    expect.objectContaining({ text: 'I am here.' }),
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
it('restarts the turn clock when a parked turn resumes after a long approval wait', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!, 'before-approval');
  await result(c!, 'Waiting for your approval.', 'before-approval');
  const turn = () =>
    db
      .query<{ status: string; age_hours: number }>(
        `SELECT status,(extract(epoch FROM now()-started_at)/3600)::float8 age_hours FROM agent_turns
         WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
        [R, c!.turnRequestId, A],
      )
      .then((r) => r.rows[0]!);
  const parkFor57Hours = () =>
    db.query(
      `UPDATE agent_turns SET started_at=now()-interval '57 hours'
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [R, c!.turnRequestId, A],
    );
  await parkFor57Hours();
  expect((await turn()).status).not.toBe('working');

  // The approval resumes the same turn: a resume command on its request id.
  const decision = id();
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'approved')`, [
    decision,
    R,
    H,
  ]);
  const resume = (await createAgentCommand(db, {
    roomId: R,
    agentId: A,
    sourceMessageId: decision,
    action: 'resume',
    reason: 'resume',
    turnRequestId: c!.turnRequestId,
  }))!;
  await daemon.execute(
    'claimAgentCommand',
    { roomId: R, commandId: resume.id, generationId: 'after-approval' },
    A,
  );
  expect(await turn()).toMatchObject({ status: 'working' });
  expect((await turn()).age_hours).toBeLessThan(1);

  // A working receipt on a turn that had settled restarts the clock too,
  await db.query(
    `UPDATE agent_turns SET status='complete',started_at=now()-interval '57 hours'
     WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
    [R, c!.turnRequestId, A],
  );
  await daemon.execute(
    'postAgentTurnReceipt',
    { roomId: R, agentId: A, requestId: c!.turnRequestId, generationId: 'after-approval', status: 'working' },
    A,
  );
  expect((await turn()).age_hours).toBeLessThan(1);
  // and a receipt on a turn that is still working keeps its start.
  await parkFor57Hours();
  await daemon.execute(
    'postAgentTurnReceipt',
    { roomId: R, agentId: A, requestId: c!.turnRequestId, generationId: 'after-approval', status: 'working' },
    A,
  );
  expect((await turn()).age_hours).toBeGreaterThan(56);
});
it('rolls the command claim back when a cancelled turn cannot become working', async () => {
  await send('@hoots');
  const [c] = await commands();
  await db.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status)
     VALUES($1,$2,$3,'cancelled') ON CONFLICT(room_id,request_id,agent_id)
     DO UPDATE SET status='cancelled'`,
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
it('settles a failed command instead of redelivering it after its lease expires', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  await daemon.execute(
    'postAgentTurnReceipt',
    {
      roomId: R,
      requestId: c!.turnRequestId,
      generationId: 'g1',
      status: 'failed',
      reason: 'authentication required',
    },
    A,
  );
  await db.query(
    `UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [c!.id],
  );
  expect(await commands()).toEqual([]);
  await expect(claim(c!, 'retry')).rejects.toThrow('conflict');
});
it('rechecks tagged agent membership at final commit', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    B,
  ]);
  await result(c!, '@goosy no target remains');
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
  const mediaDigest = id();
  await db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
     VALUES($1,$2,'media',$3,'text/plain','result.txt',2,$4,'ready',now()+interval '24 hours')
     ON CONFLICT(id) DO NOTHING`,
    [media, A, `media/${A}/${mediaDigest}`, mediaDigest],
  );
  // Person files and artifacts both live in `objects` and share /v1/media/<id>.
  const artifact = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
     VALUES($1,$2,'artifact',$3,'text/html','Mock',12,$4,'ready',now()+interval '24 hours')
     ON CONFLICT(id) DO NOTHING`,
    [artifact, A, `artifact/${A}/${id()}`, id()],
  );
  await daemon.execute(
    'postAgentAttachment',
    {
      ...input,
      attachment: {
        url: 'http://test/v1/media/' + artifact,
        name: 'mock.html',
        mimeType: 'text/html',
        size: 12,
      },
    },
    A,
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
  expect(saved.attachments).toHaveLength(2);
  expect(
    (
      await db.query(
        `SELECT 1 FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND kind IN ('draft','thought')`,
        [R, A],
      )
    ).rowCount,
  ).toBe(0);
});

it('keeps Room drafts private while preserving liveness, final replies, and corner streaming', async () => {
  await send('@hoots work in the Room');
  const [roomCommand] = await commands();
  await claim(roomCommand!);
  const roomInput = {
    roomId: R,
    agentId: A,
    requestId: roomCommand!.turnRequestId,
    turnId: roomCommand!.turnRequestId,
    generationId: 'g1',
  };
  const events: Array<{ type: string; roomId?: string }> = [];
  const unsubscribe = live.subscribeAll((event) => events.push(event));
  try {
    await daemon.execute('postAgentDraft', { ...roomInput, text: 'Room draft' }, A);
    expect(
      (
        await db.query(
          `SELECT 1 FROM live_outputs
           WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind='draft'`,
          [R, A, roomCommand!.turnRequestId],
        )
      ).rowCount,
    ).toBe(0);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'draft', roomId: R }));
    // During a two-machine rollout, an older server can leave a Room draft
    // behind. Reconnecting readers must not recover that stale prose.
    await db.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       VALUES($1,$2,$3,'draft','{"text":"Stale Room draft"}'::jsonb)`,
      [R, A, roomCommand!.turnRequestId],
    );
    expect(await phone.liveDraftSnapshot(R)).toEqual([]);
    expect(
      (
        await db.query<{ status: string }>(
          `SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,
          [R, A, roomCommand!.turnRequestId],
        )
      ).rows[0]?.status,
    ).toBe('working');
    const final = await result(roomCommand!, 'Room final');
    expect(
      (await db.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [final.id]))
        .rows[0]?.text,
    ).toBe('Room final');

    await send('@hoots work in the corner', C);
    const [cornerCommand] = await commands(A, C);
    await claim(cornerCommand!);
    await daemon.execute(
      'postAgentDraft',
      {
        roomId: C,
        agentId: A,
        requestId: cornerCommand!.turnRequestId,
        turnId: cornerCommand!.turnRequestId,
        generationId: 'g1',
        text: 'Corner draft',
      },
      A,
    );
    expect(
      (
        await db.query(
          `SELECT 1 FROM live_outputs
           WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind='draft'`,
          [C, A, cornerCommand!.turnRequestId],
        )
      ).rowCount,
    ).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'draft', roomId: C, text: 'Corner draft' }),
    );
    expect(await phone.liveDraftSnapshot(C)).toContainEqual(
      expect.objectContaining({ type: 'draft', roomId: C, text: 'Corner draft' }),
    );
    expect(
      (
        await db.query<{ repository_resolution: string }>(
          `SELECT repository_resolution FROM rooms WHERE id=$1`,
          [C],
        )
      ).rows[0]?.repository_resolution,
    ).toBe('none');
    await result(cornerCommand!, 'No-code corner final');

    await db.query(
      `UPDATE rooms SET repository_resolution='repository',repository_key='owner/repo',
         repository_name='repo',repository_remote='https://github.com/owner/repo.git'
       WHERE id=$1`,
      [C],
    );
    await send('@hoots continue in the repository corner', C);
    const [repositoryCornerCommand] = await commands(A, C);
    await claim(repositoryCornerCommand!);
    await daemon.execute(
      'postAgentDraft',
      {
        roomId: C,
        agentId: A,
        requestId: repositoryCornerCommand!.turnRequestId,
        turnId: repositoryCornerCommand!.turnRequestId,
        generationId: 'g1',
        text: 'Repository corner draft',
      },
      A,
    );
    expect(
      (
        await db.query(
          `SELECT 1 FROM live_outputs
           WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind='draft'`,
          [C, A, repositoryCornerCommand!.turnRequestId],
        )
      ).rowCount,
    ).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'draft', roomId: C, text: 'Repository corner draft' }),
    );
  } finally {
    unsubscribe();
    await db.query(
      `UPDATE rooms SET repository_resolution='none',repository_key=NULL,
         repository_name=NULL,repository_remote=NULL WHERE id=$1`,
      [C],
    );
  }
});

it('deletes draft and thought rows when a successful turn settles without a reply', async () => {
  await send('@hoots open a corner');
  const [command] = await commands();
  await claim(command!);
  const input = {
    roomId: R,
    agentId: A,
    requestId: command!.turnRequestId,
    turnId: command!.turnRequestId,
    generationId: 'g1',
  };
  await daemon.execute('postAgentDraft', { ...input, text: 'Opening a corner.' }, A);
  await daemon.execute('postAgentThought', { ...input, text: 'Preparing the handoff.' }, A);

  // A successful open_corner turn has no postRoomMessage call. Its terminal
  // receipt is the durable ending and must reap the live rows itself even if
  // the best-effort retract never arrived.
  await daemon.execute('postAgentTurnReceipt', { ...input, status: 'complete' }, A);

  expect(
    (
      await db.query(
        `SELECT 1 FROM live_outputs
         WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind IN ('draft','thought')`,
        [R, A, command!.turnRequestId],
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

  it('stamps the producing model on an agent reply at generation time', async () => {
    await db.query(`UPDATE agents SET selected_model='grok-4-fast' WHERE agent_id=$1`, [A]);
    await send('@hoots model check');
    const command = (await commands(A))[0]!;
    await claim(command);
    await result(command, 'Stamped answer');
    // The stamp freezes the selection as of the turn; a later roster change
    // must not retro-label the row.
    await db.query(`UPDATE agents SET selected_model='newer-model' WHERE agent_id=$1`, [A]);
    const view = await phone.readRoom(R, H);
    const reply = view!.messages.find((message) => message.text === 'Stamped answer');
    expect(reply?.agentModel).toBe('grok-4-fast');
    // A human row carries no stamp, and an agent row with no known model
    // stays unstamped rather than guessing.
    expect(
      view!.messages.find((message) => message.author.pubkey === H)?.agentModel,
    ).toBeUndefined();
  });

describe('heartbeat authority across a lapsed lease', () => {
  // A turn is killed at 90s of silence, and its heartbeat is the only writer
  // that pushes `agent_turns.created_at` forward during the turn. The command
  // lease is also 90s and the same heartbeat is its only refresher, so any
  // gap long enough to expire the lease used to make the next heartbeat a
  // refusal — and a refusal refreshes nothing, so every later heartbeat was
  // refused too and a working turn was declared stalled. `authorizeCommandOutput`
  // already pins `generation_id`, so the expiry could only ever refuse the
  // live owner; `claimAgentCommand` remains the one place a DIFFERENT
  // generation may take over an expired lease.
  it('lands a same-generation heartbeat after the lease window and refreshes the turn', async () => {
    const source = id();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@hoots go')`, [
      source,
      R,
      H,
    ]);
    const command = (await createAgentCommand(db, {
      roomId: R,
      agentId: A,
      sourceMessageId: source,
      reason: 'human_tag',
    }))!;
    await claim({
      ...command,
      roomId: R,
      agentId: A,
      turnRequestId: command.turn_request_id,
    } as never);

    // One gap long enough to expire the lease: a deploy, a network blip, a 5xx
    // window, or a slow heartbeat request.
    await db.query(
      `UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
      [command.id],
    );
    await db.query(
      `UPDATE agent_turns SET created_at=now()-interval '100 seconds'
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [R, command.turn_request_id, A],
    );

    await expect(
      daemon.execute(
        'postAgentTurnReceipt',
        {
          roomId: R,
          agentId: A,
          requestId: command.turn_request_id,
          generationId: 'g1',
          status: 'working',
          heartbeat: true,
        },
        A,
      ),
    ).resolves.toBeDefined();

    const age = (
      await db.query<{ age: number }>(
        `SELECT extract(epoch FROM now()-created_at)::float age FROM agent_turns
         WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
        [R, command.turn_request_id, A],
      )
    ).rows[0]!.age;
    // Back inside the 90s pickup window, so the turn is no longer stalled.
    expect(age).toBeLessThan(5);
  });
});

it('excludes concurrent avatar jobs across rooms and refuses non-owner generation', async () => {
  const outcomes = await Promise.allSettled([
    send('@hoots /draw-avatar', R),
    send('@hoots /draw-avatar brighter eyes', C),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  expect((await phone.readAgent(W, A, H))?.avatarGenerationPending).toBe(true);
  await expect(
    phone.execute('sendRoomMessage', { roomId: R, text: '@hoots /draw-avatar' }, P),
  ).rejects.toThrow();
  await db.query(`UPDATE agent_commands SET state='complete' WHERE agent_id=$1 AND avatar_job`, [
    A,
  ]);
  expect((await phone.readAgent(W, A, H))?.avatarGenerationPending).toBe(false);
  await expect(send('@hoots /draw-avatar', R)).resolves.toBeDefined();
});


it.runIf(Boolean(stopProofPostgresUrl))('R-ACTIVITY-DEADLOCK: attempts concurrent activity and working receipt writes on isolated PostgreSQL', async () => {
  await send('@hoots inspect contention', C);
  const [command] = await commands(A, C);
  await claim(command!);
  const authority = { roomId: C, requestId: command!.turnRequestId!, generationId: 'g1' };
  await Promise.all(Array.from({ length: 12 }, (_, index) => Promise.all([
    daemon.execute('postAgentActivity', { ...authority, cornerActivityKey: `contention-${index}`,
      activity: [{ kind: 'tool', title: 'Inspect', operation: 'read', status: 'completed' }] }, A),
    daemon.execute('postAgentTurnReceipt', { ...authority, status: 'working' }, A),
  ])));
  expect((await phone.readRoom(C, H))?.toolRows?.filter(row => row.requestId === authority.requestId)).toHaveLength(12);
});

it('R-ACTIVITY-DEADLOCK: never replays another daemon operation', async () => {
  await send('@hoots inspect retry scope', C);
  const [command] = await commands(A, C);
  await claim(command!);
  let attempts = 0;
  const failure = Object.assign(new Error('deadlock proof'), { code: '40P01' });
  const watched = new DaemonService({
    query: (sql, values) => db.query(sql, values),
    transaction: async () => { attempts++; throw failure; },
  }, live);
  await expect(watched.execute('postAgentThought', {
    roomId: C, requestId: command!.turnRequestId!, generationId: 'g1', text: 'Inspecting',
  }, A)).rejects.toBe(failure);
  expect(attempts).toBe(1);
});

it.each([
  ['recover', '40P01', 1, 2],
  ['exhaust', '40P01', 10, 3],
  ['other error', '23505', 1, 1],
  ['authorization changes', '40P01', 1, 1],
])('R-ACTIVITY-DEADLOCK: %s at the owning transaction boundary', async (scenario, code, failures, expectedAttempts) => {
  await send('@hoots inspect recovery', C);
  const [command] = await commands(A, C);
  await claim(command!);
  const input = { roomId: C, requestId: command!.turnRequestId!, generationId: 'g1',
    cornerActivityKey: 'deadlock-proof',
    activity: [{ kind: 'tool' as const, title: 'Inspect', operation: 'read', status: 'completed' }] };
  const originalTurn = (await db.query(`SELECT created_at FROM agent_turns WHERE request_id=$1`, [input.requestId])).rows;
  let attempts = 0;
  const events: unknown[] = [];
  const hub = new LiveHub();
  hub.publish = event => { events.push(event); };
  const failure = Object.assign(new Error('transaction proof failure'), { code });
  const wrapped: SqlDatabase = {
    query: (sql, values) => db.query(sql, values),
    transaction: async work => {
      attempts++;
      try {
        return await db.transaction(async tx => {
          const result = await work(tx);
          // Fail after the activity insert, turn update and buffered event.
          // The real database must roll all writes back before recovery.
          if (attempts <= failures) throw failure;
          return result;
        });
      } catch (error) {
        expect(events).toHaveLength(0);
        expect((await db.query(`SELECT created_at FROM agent_turns WHERE request_id=$1`, [input.requestId])).rows).toEqual(originalTurn);
        expect((await db.query(`SELECT 1 FROM messages WHERE request_id=$1 AND presentation='activity'`,
          [input.requestId])).rowCount).toBe(0);
        if (scenario === 'authorization changes')
          await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [A]);
        throw error;
      }
    },
  };
  const watched = new DaemonService(wrapped, hub);
  if (scenario === 'recover') {
    const saved = await watched.execute('postAgentActivity', input, A);
    expect(attempts).toBe(expectedAttempts);
    expect(events).toHaveLength(1);
    expect((await phone.readRoom(C, H))?.toolRows?.find(row => row.id === saved.id)?.activity).toEqual(input.activity);
    expect(await watched.execute('postAgentActivity', input, A)).toEqual(saved);
    expect(events).toHaveLength(1);
  } else {
    await expect(watched.execute('postAgentActivity', input, A)).rejects.toThrow(
      scenario === 'authorization changes' ? /access|member|authority/i : failure.message);
    expect(attempts).toBe(expectedAttempts);
    expect(events).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM messages WHERE request_id=$1 AND presentation='activity'`,
      [input.requestId])).rowCount).toBe(0);
  }
});

it.each([
  ['NUL', 'before\0after', 'before\uFFFDafter'],
  ['high surrogate', 'before\uD800after', 'before\uFFFDafter'],
  ['low surrogate', 'before\uDC00after', 'before\uFFFDafter'],
  ['valid Unicode', 'café 😀 𝄞', 'café 😀 𝄞'],
  ['literal escapes', String.raw`\u0000 \ud800 \\u0000`, String.raw`\u0000 \ud800 \\u0000`],
])('Reproduction R-ACTIVITY-UNICODE: persists and reads %s tool output with stable replay', async (_label, output, expected) => {
  await send('@hoots inspect output', C);
  const [command] = await commands(A, C);
  await claim(command!);
  const activity = [{ kind: 'tool' as const, title: 'Inspect', operation: 'read', status: 'completed', output,
    files: [{ path: output }], plan: { items: [{ step: output, status: 'completed' as const }] } }];
  const input = { roomId: C, requestId: command!.turnRequestId!, generationId: 'g1',
    cornerActivityKey: 'unicode-proof', activity };
  const first = await daemon.execute('postAgentActivity', input, A);
  expect(await daemon.execute('postAgentActivity', input, A)).toEqual(first);
  const stored = [{ ...activity[0], output: expected, files: [{ path: expected }],
    plan: { items: [{ step: expected, status: 'completed' }] } }];
  expect((await db.query('SELECT activity FROM messages WHERE id=$1', [first.id])).rows[0]?.activity).toEqual(stored);
  const view = await phone.readRoom(C, H);
  expect(view?.toolRows?.find(row => row.id === first.id)?.activity).toEqual(stored);
  expect(activity[0]?.output).toBe(output);
  await expect(daemon.execute('postAgentActivity', { ...input,
    activity: [{ ...activity[0]!, output: 'different output' }] }, A)).rejects.toThrow('conflicts');
});

it('stuck-turn-1: a completion receipt closes a working turn even when its command already completed', async () => {
  await send('@hoots complete the work', C);
  const [command] = await commands(A, C);
  await claim(command!);
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [command!.id]);
  await daemon.execute('postAgentTurnReceipt', {roomId:C, requestId:command!.turnRequestId,
    generationId:'g1',status:'complete'}, A);
  expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
    [C,command!.turnRequestId,A])).rows).toEqual([{status:'complete'}]);
});

it('Reproduction stuck-turn-1: superseded review output completes its command and closes its turn together', async () => {
  const corner = '44444444-4444-4444-8444-444444444444';
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'stuck-turn-proof')`, [corner,W,R]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,lifecycle) VALUES($1,$2,'{"lifecycle":"working"}')`, [corner,A]);
  await send('@hoots review this head', corner);
  const [command] = await commands(A, corner);
  await claim(command!);
  await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`,
    [command!.id, JSON.stringify({cornerId:corner,headSha:'obsolete',pullRequest:1})]);
  const state = async () => (await phone.readCorners(R,H))!.corners.find(row => row.corner.id===corner)!.state;
  expect(await state()).toBe('working');
  await result(command!, '@hoots Review output for the old head');
  expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [command!.id])).rows)
    .toEqual([{state:'complete'}]);
  expect((await db.query(`SELECT status,failure_reason FROM agent_turns
    WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`, [corner,command!.turnRequestId,A])).rows)
    .toEqual([{status:'failed',failure_reason:'the review command was superseded'}]);
  expect(await state()).not.toBe('working');
  await daemon.execute('postAgentTurnReceipt', {roomId:corner,requestId:command!.turnRequestId,
    generationId:'g1',status:'complete'}, A);
  expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
    [corner,command!.turnRequestId,A])).rows).toEqual([{status:'failed'}]);
  console.log('Demonstrated stuck-turn-1: superseded review end → command complete, turn failed, phone corner no longer working; receipt replay preserves failure');
});


it('SILENT-END-1: late silent-tool results do not wake again; other completions and later triggers survive', async () => {
  const queued = await createAgentCommand(db, { roomId: C, agentId: A, sourceMessageId: null, reason: 'system' });
  const command = (await commands(A, C)).find(c => c.id === queued!.id)!;
  await claim(command);
  const turn = { roomId: C, requestId: command.turnRequestId, generationId: 'g1' };
  await daemon.execute('markAgentTurnSilent', turn, A);
  await daemon.execute('postAgentTurnReceipt', { ...turn, status: 'complete', completionKind: 'no-reply' }, A);
  for (const status of ['completed', 'failed'] as const) {
    await daemon.execute('postBackgroundToolCompletion', {
      ...turn, toolCallId: 'silent', title: 'mcp__beeline-agent__no_reply_needed', status,
    }, A);
  }
  expect((await commands(A, C)).filter(c => c.reason === 'corner_background_tool')).toEqual([]);
  await daemon.execute('postBackgroundToolCompletion', {
    ...turn, toolCallId: 'build', title: 'Run build', status: 'completed',
  }, A);
  expect((await commands(A, C)).filter(c => c.reason === 'corner_background_tool')).toHaveLength(1);
  const next = await createAgentCommand(db, { roomId: C, agentId: A, sourceMessageId: null, reason: 'system' });
  expect((await commands(A, C)).some(c => c.id === next!.id)).toBe(true);
});
