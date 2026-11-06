import { describe, expect, it, taggedIdentityIdsSql, seedCornerOpening, PhoneService, DaemonService, createAgentCommand, H, A, B, P, R, C, id, stopProofPostgresUrl, db, phone, daemon, live, commands, send, disconnectHelper, helperOwner, queuedHumanTags, queueStopOrders, claim, result, rootFixture, fixtureScope1, type SqlDatabase } from './test-support-agent-command.integration.test-support.js';




it.each(['ordinary', 'tagged', 'threaded', 'private', 'private-agent', 'corner', 'dm'])(
  'Reproduction R1: discards final text after no-reply on the %s output path', async path => {
    const roomId = path === 'corner' ? C : R;
    if (path === 'dm')
      await rootFixture.db.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`, [R, JSON.stringify([H, A])]);
    const queued = await createAgentCommand(rootFixture.db, {
      roomId, agentId: A, sourceMessageId: null, reason: 'system',
      ...(path.startsWith('private') ? {
        privatePayload: { kind: 'order' as const, authorId: path === 'private-agent' ? B : H, fromRoomId: R, text: 'Observe silently' },
        reason: 'order' as const,
      } : {}),
    });
    const command = (await commands(A, roomId)).find(c => c.id === queued!.id)!;
    await claim(command);
    await rootFixture.daemon.execute('postAgentTurnReceipt', {
      roomId, requestId: command.turnRequestId, generationId: 'g1',
      status: 'complete', completionKind: 'no-reply',
    }, A, await helperOwner(A));
    const text = `R1 unwanted closing sentence${path === 'tagged' ? ' @goosy' : ''}`;
    const parent = path === 'threaded' ? await send('Thread parent') : undefined;
    const before = (await rootFixture.phone.readRoom(roomId, H))!.messages.map(m => m.id);
    // A successful acknowledgement lets an old helper finish without retrying
    // or converting deliberate silence into a failure notice.
    await result(command, text, 'g1', parent ? { replyToMessageId: parent.messageId } : {});
    await result(command, text, 'g1', parent ? { replyToMessageId: parent.messageId } : {});
    await expect(result(command, text, 'other-generation')).rejects.toThrow('authority rejected');
    expect((await rootFixture.phone.readRoom(roomId, H))!.messages.map(m => m.id)).toEqual(before);
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE author_id=$1 AND text=$2`, [A, text])).rowCount).toBe(0);
    expect((await commands(B)).filter(c => c.source.body.includes(text))).toEqual([]);
    expect((await rootFixture.db.query(`SELECT completion_kind FROM agent_turns
      WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`, [roomId, A, command.turnRequestId])).rows)
      .toEqual([{ completion_kind: 'no-reply' }]);
    const next = await createAgentCommand(rootFixture.db, { roomId, agentId: A, sourceMessageId: null, reason: 'system' });
    const nextCommand = (await commands(A, roomId)).find(c => c.id === next!.id)!;
    await claim(nextCommand, 'next-generation');
    await result(nextCommand, 'R1 next turn remains visible', 'next-generation');
    expect((await rootFixture.phone.readRoom(roomId, H))!.messages.some(m => m.text === 'R1 next turn remains visible')).toBe(true);
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
    const queued = await createAgentCommand(rootFixture.db, { roomId: R, agentId: A, sourceMessageId: null, reason: 'system' });
    const command = (await commands(A, R)).find(c => c.id === queued!.id)!;
    await claim(command);
    await result(command, text);
    expect((await rootFixture.db.query('SELECT 1 FROM messages WHERE request_id=$1 AND author_id=$2 AND text=$3',
      [command.turnRequestId, A, text])).rowCount).toBe(1);
    expect((await rootFixture.db.query('SELECT completion_kind FROM agent_turns WHERE request_id=$1 AND agent_id=$2',
      [command.turnRequestId, A])).rows[0]?.completion_kind).toBeFalsy();
  });


it('WAKE-STORM: a no_reply_needed receipt posts nothing on a system wake', async () => {
  for (const roomId of [R, C]) {
    const queued = await createAgentCommand(rootFixture.db, { roomId, agentId: A, sourceMessageId: null, reason: 'system' });
    const command = (await commands(A, roomId)).find(c => c.id === queued!.id)!;
    await claim(command);
    await rootFixture.daemon.execute('postAgentTurnReceipt', {
      roomId, requestId: command.turnRequestId, generationId: 'g1',
      status: 'complete', completionKind: 'no-reply',
    }, A, await helperOwner(A));
    const text = 'Nonhuman wake only … Ending silently';
    await result(command, text);
    await result(command, text);
    expect((await rootFixture.db.query('SELECT 1 FROM messages WHERE request_id=$1 AND author_id=$2', [command.turnRequestId, A])).rowCount).toBe(0);
    expect((await rootFixture.db.query('SELECT completion_kind FROM agent_turns WHERE request_id=$1 AND agent_id=$2', [command.turnRequestId, A])).rows[0]?.completion_kind).toBe('no-reply');
    await expect(result(command, text, 'wrong-generation')).rejects.toThrow('authority rejected');
  }
});


it('WAKE-STORM: a human wake publishes its report-status reply as written', async () => {
  const queued = await createAgentCommand(rootFixture.db, { roomId: R, agentId: A, sourceMessageId: null, reason: 'human_tag' });
  const command = (await commands(A, R)).find(c => c.id === queued!.id)!;
  await claim(command);
  const text = 'blocked: Corner release is idle with no worker schedule or event subscription';
  await result(command, text);
  expect((await rootFixture.db.query('SELECT 1 FROM messages WHERE request_id=$1 AND author_id=$2 AND text=$3',
    [command.turnRequestId, A, text])).rowCount).toBe(1);
  expect((await rootFixture.db.query('SELECT completion_kind FROM agent_turns WHERE request_id=$1 AND agent_id=$2',
    [command.turnRequestId, A])).rows[0]?.completion_kind).toBeFalsy();
});

it.each([R, C])('QUEUED-TAGS-REPEAT: each queued human tag needs its own answer in %s', async roomId => {
  const messages = await queuedHumanTags(roomId);
  const snapshot = await commands(A, roomId);
  expect(snapshot.map(command => command.sourceMessageId)).toEqual(messages.map(message => message.messageId));
  for (const [index, command] of snapshot.entries()) {
    await claim(command);
    await result(command, `Answer ${index}`);
    expect((await commands(A, roomId)).map(row => row.id)).toEqual(snapshot.slice(index + 1).map(row => row.id));
  }
  expect((await rootFixture.phone.readRoom(roomId, H))!.pendingAgentCommands).toEqual([]);
});

it.each([0, 1, 2])('QUEUED-TAGS-REPEAT: Stop message %s preserves the other requests', async stopIndex => {
  const messages = await queuedHumanTags();
  const snapshot = await commands();
  const stopped = snapshot[stopIndex]!;
  await claim(stopped);
  await rootFixture.phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: messages[stopIndex]!.messageId }, H);
  await expect(result(stopped, 'Must never publish')).rejects.toThrow();
  expect((await commands()).filter(command => command.action === 'input').map(command => command.id)).toEqual(snapshot.filter(command => command.id !== stopped.id).map(command => command.id));
});

it.each(['deleted', 'stopped'])('QUEUED-TAGS-REPEAT: reconnect preserves unrelated work after a source is %s', async kind => {
  const messages = await queuedHumanTags();
  const snapshot = await commands();
  await claim(snapshot[0]!);
  if (kind === 'deleted')
    await rootFixture.db.query('UPDATE messages SET deleted_at=now() WHERE id=$1', [messages[1]!.messageId]);
  else await rootFixture.phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: messages[1]!.messageId }, H);
  await disconnectHelper();
  await helperOwner(A);
  await claim(snapshot[0]!, 'reclaimed');
  await result(snapshot[0]!, 'First answer', 'reclaimed');
  expect((await commands()).filter(command => command.action === 'input').map(command => command.sourceMessageId)).toEqual([messages[2]!.messageId]);
});

it('QUEUED-TAGS-REPEAT: each source retains only its own attachments', async () => {
  const messages = await queuedHumanTags();
  const files = messages.map((_, index) => ({ url: `https://files.example.test/file-${index}.txt`,
    name: `file-${index}.txt`, mimeType: 'text/plain', size: index + 1 }));
  for (const [index, message] of messages.entries())
    await rootFixture.db.query('UPDATE messages SET attachments=$2::jsonb WHERE id=$1', [message.messageId, JSON.stringify([files[index]])]);
  const snapshot = await commands();
  for (const [index, command] of snapshot.entries()) {
    expect(command.source.attachments).toEqual([files[index]]);
    await claim(command);
    await result(command, `File ${index} answered`);
  }
});


it('Reproduction cold-beebee-first-reply: shows every queued agent, then only its claimed turn as working', async () => {
  await send('@hoots @goosy Hello');
  const before = await rootFixture.phone.readRoom(R, H);
  expect(before?.pendingAgentCommands).toEqual(expect.arrayContaining([
    expect.objectContaining({ agentPubkey: A }),
    expect.objectContaining({ agentPubkey: B }),
  ]));
  expect(before?.latestAgentTurns?.filter(turn => turn.status === 'working')).toEqual([]);
  const pending = await rootFixture.db.query(`SELECT state FROM agent_commands WHERE agent_id IN ($1,$2)`, [A,B]);
  expect(pending.rows).toEqual([{ state: 'pending' }, { state: 'pending' }]);
  await rootFixture.db.query(`UPDATE agent_turns SET started_at=now()-interval '17 minutes' WHERE agent_id=$1`, [A]);
  const [command] = await commands();
  await claim(command!, 'real-helper');
  expect((await rootFixture.db.query<{ fresh: boolean }>(`SELECT started_at>now()-interval '1 second' fresh
    FROM agent_turns WHERE agent_id=$1`, [A])).rows[0]?.fresh).toBe(true);
  const after = await rootFixture.phone.readRoom(R, H);
  expect(after?.latestAgentTurns?.filter(turn => turn.agentPubkey === A)).toEqual([
    expect.objectContaining({ status: 'working', generationId: 'real-helper' }),
  ]);
  expect(after?.pendingAgentCommands).toEqual([expect.objectContaining({ agentPubkey: B })]);
});


it('Reproduction stop-queued-orders: Stop drains the queued orders and reports once', async () => {
  const { queued } = await queueStopOrders();
  await rootFixture.phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: queued[0]!.turnRequestId }, H);
  const remaining = (await commands()).filter(command => command.action === 'input');
  expect(remaining).toHaveLength(0);
  for (const command of queued) await expect(claim(command, 'stale-helper')).rejects.toThrow();
  expect((await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=ANY($1::text[])`,
    [queued.map(command => command.id)])).rows).toEqual(Array(3).fill({ state: 'cancelled' }));
  const reports = (await commands(B)).filter(command => command.reason === 'report');
  expect(reports).toHaveLength(1);
  expect(reports[0]!.source.body).toContain('2 queued orders were dropped by a Stop');
  const lines = await rootFixture.db.query<{ text: string }>(
    `SELECT text FROM messages WHERE room_id=$1 AND system_event->>'kind'='turn-cancelled'
     AND request_id=$2`, [R, queued[0]!.turnRequestId]);
  expect(lines.rows).toHaveLength(1);
  expect(lines.rows[0]!.text).toContain('turn cancelled · 2 queued orders dropped');
  console.log('Demonstrated Reproduction stop-queued-orders: queue 3, claim first, owner Stop → all 3 cancelled, 0 input commands available, all cached claims refused, one count line and one sender report');
});


it('Stop preserves other senders, source Rooms, targets, human mentions and newer orders', async () => {
  const { queued, root } = await queueStopOrders();
  for (const [authorId, fromRoomId, agentId] of [[H, R, A], [B, C, A], [H, R, B]]) {
    await createAgentCommand(rootFixture.db, { roomId: R, agentId: agentId!, sourceMessageId: null,
      privatePayload: { kind: 'order', authorId: authorId!, fromRoomId: fromRoomId!, text: 'survivor' }, reason: 'order' });
  }
  await send('@hoots Human follow-up');
  const newer = await createAgentCommand(rootFixture.db, { roomId: R, agentId: A, sourceMessageId: null,
    privatePayload: { kind: 'order', authorId: B, fromRoomId: R, text: 'newer order' }, reason: 'order' });
  await rootFixture.db.query(`UPDATE agent_commands SET created_at=now()+interval '1 minute' WHERE id=$1`, [newer!.id]);
  await rootFixture.phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: queued[0]!.turnRequestId }, H);
  const remaining = (await commands()).filter(command => command.action === 'input');
  expect(remaining).toHaveLength(4);
  expect(remaining.some(command => command.source.body.includes('Human follow-up'))).toBe(true);
  expect(remaining.some(command => command.id === newer!.id)).toBe(true);
  expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND state='pending' AND private_payload->>'text'='survivor'`, [B])).rowCount).toBe(1);
  await rootFixture.daemon.execute('order', { roomId: R, address: R, agent: 'hoots', text: 'after Stop',
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
  const line = await rootFixture.db.query<{ text: string }>(`SELECT text FROM messages
    WHERE room_id=$1 AND system_event->>'verb'='stopped its running turn' ORDER BY created_at DESC LIMIT 1`, [R]);
  expect(line.rows[0]!.text).toContain('2 queued orders dropped');
});


it.runIf(Boolean(stopProofPostgresUrl))('Stop holds the claim fence through the drain and preserves an order arriving during Stop', async () => {
  const { queued, root } = await queueStopOrders();
  let reached!: () => void, release!: () => void, claimStarted!: () => void, orderStarted!: () => void;
  const stopped = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { claimStarted = resolve; }), queuedOrder = new Promise<void>(resolve => { orderStarted = resolve; });
  const wrapStop = (database: SqlDatabase): SqlDatabase => ({
    query: async (sql, values) => {
      const result = await database.query(sql, values);
      if (sql.startsWith('SELECT * FROM beeline_end_agent_turn(') && values?.[2] === 'cancelled' && values?.[3] === 'stop') {
        reached();
        await resume;
      }
      return result;
    },
    transaction: work => database.transaction(transaction => work(wrapStop(transaction))),
  });
  const wrapClaim = (database: SqlDatabase, onQueue = claimStarted): SqlDatabase => ({
    query: (sql, values) => {
      if (sql.includes('FOR UPDATE OF member')) onQueue();
      return database.query(sql, values);
    },
    transaction: work => database.transaction(transaction => work(wrapClaim(transaction,onQueue))),
  });
  const stop = new PhoneService(wrapStop(db), 'http://test').execute('cancelAgentTurn',
    { roomId: R, agentId: A, requestId: queued[0]!.turnRequestId }, H);
  let claimAttempt: Promise<unknown> | undefined, arriving: Promise<unknown> | undefined;
  try {
    await stopped;
    claimAttempt = new DaemonService(wrapClaim(db), live).execute('claimAgentCommand',
      { roomId: R, commandId: queued[1]!.id, generationId: 'racing-helper' }, A, await helperOwner(A));
    // Attach the rejection handler before releasing Stop.
    const rejected = expect(claimAttempt).rejects.toThrow('command claim conflict');
    await started;
    await expect(db.transaction(transaction => transaction.query(
      'SELECT identity_id FROM memberships WHERE room_id=$1 AND identity_id=$2 FOR UPDATE NOWAIT',[R,A])))
      .rejects.toMatchObject({code:'55P03'});
    arriving = new DaemonService(wrapClaim(db,orderStarted),live).execute('order', { roomId: R, address: R, agent: 'hoots', text: 'arrived during Stop',
      requestId: root.turnRequestId, generationId: 'g1' }, B);
    await Promise.race([queuedOrder,arriving.then(()=>{throw new Error('Order did not reach the recipient fence');})]); release();
    await stop;
    await rejected; await arriving;
    const surviving = (await commands()).filter(command => command.action === 'input');
    expect(surviving).toHaveLength(1);
    expect(surviving[0]!.source.body).toContain('arrived during Stop');
    await claim(surviving[0]!);
    console.log('Demonstrated Reproduction stop-queued-orders on PostgreSQL: claim fence held after turn cancellation and before drain; racing cached claim refused after commit; order accepted during Stop survived and claimed');
  } finally {
    release();
    await Promise.allSettled([stop, ...(claimAttempt ? [claimAttempt] : []), ...(arriving ? [arriving] : [])]);
  }
});


it('preserves each fresh follow-up while another request is being answered', async () => {
  for (const text of ['First request', 'Second request', 'Third request']) await send(`@hoots ${text}`);
  const pending = await commands();
  expect(pending).toHaveLength(3);
  await claim(pending[0]!);
  expect((await commands()).map(command => command.id)).toEqual(pending.slice(1).map(command => command.id));
  await result(pending[0]!, 'First answer');
  expect((await commands()).map(command => command.source.body)).toEqual(['@hoots Second request', '@hoots Third request']);
});


it('keeps rapid online follow-ups across a brief socket reconnect', async () => {
  await rootFixture.db.query(`INSERT INTO live_server_instances(instance_id) VALUES('online-test') ON CONFLICT DO NOTHING`);
  await rootFixture.db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
    VALUES($1,1,'online-test','online-test')`, [A]);
  await send('@hoots First online request');
  await send('@hoots Second online request');
  await send('@hoots Third online request');
  await rootFixture.db.query(`UPDATE agent_connections SET connected_at=clock_timestamp() WHERE agent_id=$1`, [A]);
  expect(await commands()).toHaveLength(3);
});


it('bootstrap identifies only pending member surfaces, including the corner parent', async () => {
  // B opened the corner: its opening order owns the corner's kind and owner.
  await seedCornerOpening(rootFixture.db, { cornerId: C, agentId: B });
  await send('@hoots Wake the Room');
  await send('@hoots Wake the corner', C);
  const bootstrap = await rootFixture.daemon.execute('getDaemonBootstrap', { agentId: A }, A);
  expect(bootstrap.pendingRooms).toEqual(expect.arrayContaining([
    { roomId: R }, { roomId: C, parentRoomId: R, openedBy: B },
  ]));
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`, [A, R]);
  expect((await rootFixture.daemon.execute('getDaemonBootstrap', { agentId: A }, A)).pendingRooms).toEqual([]);
});


it.each([R, C])('projects reply context outside the conversation window in %s', async (roomId) => {
  await rootFixture.db.query(`UPDATE messages SET created_at=now()-interval '1 day' WHERE room_id=$1`, [roomId]);
  const parentId = id();
  const parentText = 'Five corners from the audit: '.repeat(30);
  await rootFixture.db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',
    [parentId, roomId, B, parentText]);
  const sent = await rootFixture.phone.execute('sendRoomReply', {
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
  const inbox = await rootFixture.daemon.execute('getRoomInbox', { roomId }, A);
  expect(inbox.items.find((m) => m.id === sent.messageId)).toMatchObject(reply);
  const conversation = await rootFixture.daemon.execute('getRoomConversation', { roomId, limit: 1 }, A);
  expect(conversation.items).toHaveLength(1);
  expect(conversation.items[0]).toMatchObject(reply);
  expect(conversation.items[0]?.id).toBe(sent.messageId);
  expect(conversation.items[0]?.replyToExcerpt).toBe(command.source.replyToExcerpt);
  console.log('Reproduction reply-context: phone reply → server wake/inbox/newest-page supplies parent ID, author and bounded excerpt');
});


it('Reproduction workflow-corner-objective: a corner objective rooted on a parent workflow handoff carries no run instruction', async () => {
  // A workflow handoff card in the parent Room R carries the run id, workflow
  // name and a receipt hint, exactly as a real handoff does. When a workflow
  // step opens a corner, `createCorner` roots the corner objective command on
  // this parent-Room message, so the read path sees it in the corner.
  const parentRunId = id();
  const parentHandoffId = id();
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text,card_type,card)
     VALUES($1,$2,$3,$4,'workflow-handoff',$5::jsonb)`,
    [
      parentHandoffId,
      R,
      A,
      'Hoots handed off workflow feedback-triage',
      JSON.stringify({
        runId: parentRunId,
        workflowSlug: 'feedback-triage',
        toState: 'dispatch',
        seq: 6,
        receiptHint: 'Finish dispatch then stop.',
      }),
    ],
  );
  await createAgentCommand(rootFixture.db, {
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
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text,card_type,card)
     VALUES($1,$2,$3,$4,'workflow-handoff',$5::jsonb)`,
    [
      handoffId,
      C,
      A,
      'Hoots handed off workflow feedback-triage',
      JSON.stringify({
        runId,
        workflowSlug: 'feedback-triage',
        toState: 'dispatch',
        seq: 6,
        receiptHint: 'Finish dispatch then stop.',
      }),
    ],
  );
  await createAgentCommand(rootFixture.db, {
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
  // B opened the corner: its opening order owns the corner's kind and owner.
  await seedCornerOpening(rootFixture.db, { cornerId: C, agentId: B });
  await send('@hoots plan the launch', C);
  const [command] = await commands(A, C);
  await claim(command!);
  const rename = (name: string) =>
    rootFixture.daemon.execute(
      'renameCorner',
      { cornerId: C, requestId: command!.turnRequestId, generationId: 'g1', name },
      A,
    );

  await expect(rename('too many words for a title')).rejects.toThrow(
    'the name must not contain whitespace; use hyphens between words',
  );
  await expect(rename('  Launch\n plan ')).rejects.toThrow(/whitespace/);
  await expect(rename('Launch-plan')).resolves.toEqual({ cornerId: C, name: 'Launch-plan' });
  expect((await rootFixture.phone.readRoom(C, H))?.room.name).toBe('Launch-plan');
  await result(command!, 'Renamed.');
  await expect(rename('Too late')).rejects.toThrow();
  await rootFixture.db.query(`UPDATE rooms SET name='Corner' WHERE id=$1`, [C]);
});


it.each(['room', 'corner', 'dm'])(
  'Reproduction F1: a follow-up in a %s queues and the running turn stays the one shown working',
  async (path) => {
    const room = path === 'corner' ? C : R;
    if (path === 'dm')
      await rootFixture.db.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`, [R, JSON.stringify([H, A])]);
    try {
      await send(path === 'dm' ? 'start' : '@hoots start', room);
      const [running] = await commands(A, room);
      await claim(running!);
      const followUp = await send(path === 'dm' ? 'one more thing' : '@hoots one more thing', room);
      const shown = await rootFixture.phone.readRoom(room, H);
      expect(shown?.latestAgentTurns?.filter((turn) => turn.agentPubkey === A)).toEqual([
        expect.objectContaining({ requestId: running!.turnRequestId, status: 'working' }),
      ]);
      const [queued] = shown?.pendingAgentCommands ?? [];
      expect(queued).toMatchObject({ agentPubkey: A });
      expect(queued!.requestId).not.toBe(running!.turnRequestId);
      expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2
        AND request_id=$3`, [room, A, running!.turnRequestId])).rows).toEqual([{ status: 'working' }]);

      // Once the running turn ends, the queued follow-up's claim paints its own turn.
      await result(running!, 'Started');
      const next = (await commands(A, room)).find((command) => command.sourceMessageId === followUp.messageId);
      await claim(next!);
      expect((await rootFixture.phone.readRoom(room, H))?.latestAgentTurns?.filter((turn) => turn.agentPubkey === A))
        .toEqual([expect.objectContaining({ requestId: next!.turnRequestId, status: 'working' })]);
      await result(next!, 'Done');
    } finally {
      await rootFixture.db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`, [R]);
    }
  },
);
describe.each([R, C])('server command authority in %s', (room) => {
const scope1 = fixtureScope1(room);

  it('acknowledges a committed human steer only while its targeted turn is active', async () => {
    const first = await send('@hoots start', scope1.room);
    const [active] = await commands(A, scope1.room);
    await claim(active!);

    const steerId = id();
    const received = await rootFixture.phone.execute(
      'sendRoomMessage',
      { roomId: scope1.room, messageId: steerId, text: '@hoots change course' },
      H,
    );
    expect(received).toMatchObject({ messageId: steerId, activeSteerAgentIds: [A],
      message: { id: steerId, text: '@hoots change course' } });
    expect((await commands(A, scope1.room)).map((command) => command.sourceMessageId)).toContain(steerId);

    // A retried write reads the same committed routing result instead of
    // falling back to a client-side guess.
    await expect(
      rootFixture.phone.execute(
        'sendRoomMessage',
        { roomId: scope1.room, messageId: steerId, text: '@hoots change course' },
        H,
      ),
    ).resolves.toEqual(received);

    await result(active!, 'Finished');
    const idleId = id();
    await expect(
      rootFixture.phone.execute(
        'sendRoomMessage',
        { roomId: scope1.room, messageId: idleId, text: '@hoots next task' },
        H,
      ),
    ).resolves.toMatchObject({ messageId: idleId, activeSteerAgentIds: [],
      message: { id: idleId, text: '@hoots next task' } });
    expect(first.messageId).toBe(active!.sourceMessageId);
  });


  it('routes a human message to an agent only when the message addresses it', async () => {
    // A typed tag routes.
    await send('@hoots ask Goosy', scope1.room);
    const [first] = await commands(A, scope1.room);
    expect(first).toBeDefined();
    await claim(first!);
    await result(first!, 'Tag @goosy and Goosy answers');
    const [tagged] = await commands(B, scope1.room);
    expect(tagged).toBeDefined();
    await claim(tagged!);
    await result(tagged!, 'Goosy answered');
    expect(await commands(A, scope1.room)).toEqual([]);

    // An untagged message routes to nobody, even when an agent wrote the
    // immediately preceding message: transcript adjacency starts no turn.
    await send('Thanks everyone', scope1.room);
    expect(await commands(A, scope1.room)).toEqual([]);
    expect(await commands(B, scope1.room)).toEqual([]);

    // A reply to an agent starts with the parent agent's @handle in the mobile
    // composer (apps/mobile/sources/buzz/composer-prefill.ts), so it routes as
    // a tag.
    const agentReply = (
      await rootFixture.db.query<{ id: string; text: string }>(
        `SELECT id,text FROM messages WHERE room_id=$1 AND author_id=$2 AND presentation='message'
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [scope1.room, B],
      )
    ).rows[0]!;
    expect(agentReply.text).toBe('Goosy answered');
    await rootFixture.phone.execute(
      'sendRoomReply',
      { roomId: scope1.room, parentMessageId: agentReply.id, text: '@goosy Thanks again' },
      H,
    );
    const [replyCommand] = await commands(B, scope1.room);
    expect(replyCommand?.reason).toBe('human_tag');
    expect(replyCommand?.sourceMessageId).not.toBe(agentReply.id);
    expect(await commands(A, scope1.room)).toEqual([]);
    await claim(replyCommand!);
    await result(replyCommand!, 'Settled');

    // Untagged messages after human traffic still route to nobody.
    await send('An intervening human message', scope1.room);
    await send('This is not a continuation', scope1.room);
    expect(await commands(A, scope1.room)).toEqual([]);
    expect(await commands(B, scope1.room)).toEqual([]);
  });

  it('allows depths zero through three and refuses a fourth dispatch', async () => {
    await send('@hoots start', scope1.room);
    let [c] = await commands(A, scope1.room);
    const root = c!.id;
    for (let depth = 0; depth <= 3; depth++) {
      expect(c!.agentDepth).toBe(depth);
      expect(c!.rootCommandId).toBe(root);
      await claim(c!);
      const target = c!.agentId === A ? B : A;
      await result(c!, `@${target === A ? 'hoots' : 'goosy'} depth ${depth}`);
      const next = await commands(target, scope1.room);
      if (depth === 3) expect(next).toEqual([]);
      else c = next[0];
    }
  });

  it('routes replies only through exact tags', async () => {
    await send('@hoots start', scope1.room);
    const [a] = await commands(A, scope1.room);
    await claim(a!);
    const posted = await result(a!, '@goosy Delegation');
    const [b] = await commands(B, scope1.room);
    await claim(b!);
    const reply = await result(b!, 'Deliberate reply', 'g1', { replyToMessageId: posted.id });
    expect(await commands(A, scope1.room)).toEqual([]);
    await send('@goosy Start a tagged handoff', scope1.room);
    const fresh = (await commands(B, scope1.room))[0]!;
    await claim(fresh!);
    const taggedReply = await result(fresh!, '@hoots Deliberate handoff');
    expect((await commands(A, scope1.room))[0]?.agentDepth).toBe(1);
    await rootFixture.db.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [B]);
    await rootFixture.phone.execute(
      'sendRoomReply',
      { roomId: scope1.room, parentMessageId: reply.id, text: 'Continue' },
      H,
    );
    expect(await commands(B, scope1.room)).toEqual([]);
    await rootFixture.phone.execute(
      'sendRoomReply',
      { roomId: scope1.room, parentMessageId: taggedReply.id, text: '@goosy Continue' },
      H,
    );
    expect((await commands(B, scope1.room))[0]?.agentDepth).toBe(0);
  });

  it('wakes no agent whose handle appears only inside code', async () => {
    await send('@hoots review the probe', scope1.room);
    const [review] = await commands(A, scope1.room);
    await claim(review!);
    await result(
      review!,
      'FAIL. The probe reads `@goosy and @hoots take it`.\n\n```\n@goosy fix R1\n```\nNo tag here.',
    );
    expect(await commands(B, scope1.room)).toEqual([]);

    await send('Quoting `@goosy` and\n```\n@hoots\n```', scope1.room);
    expect(await commands(A, scope1.room)).toEqual([]);
    expect(await commands(B, scope1.room)).toEqual([]);

    await send('Run `npm test` then @goosy take a look', scope1.room);
    expect(await commands(B, scope1.room)).toHaveLength(1);
  });
});

it('resolves multiple natural tags and ignores human-only and unknown tags', async () => {
  await send('@hoots and @goosy');
  expect(await commands(A)).toHaveLength(1);
  expect(await commands(B)).toHaveLength(1);
  await send('@person @missing');
  expect(await commands(A)).toHaveLength(1);
  const human = await send('Human text');
  await rootFixture.phone.execute(
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
  await rootFixture.db.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`, [
    R,
    JSON.stringify([H, A]),
  ]);
  try {
    await rootFixture.db.query(`DELETE FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [A]);
    await send('Hello');
    expect((await commands(A))[0]?.reason).toBe('direct_message');
    expect(await commands(B)).toEqual([]);
  } finally {
    await rootFixture.db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`, [R]);
  }
});

it('does not route a removed target or refused human', async () => {
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    B,
  ]);
  await send('@goosy');
  expect(await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [B])).toMatchObject({
    rowCount: 0,
  });
  await rootFixture.db.query(`UPDATE agents SET access_policy='{"type":"creator"}'::jsonb WHERE agent_id=$1`, [
    A,
  ]);
  await rootFixture.phone.execute('sendRoomMessage', { roomId: R, text: '@hoots' }, P);
  expect(await commands(A)).toEqual([]);
});

it('deduplicates human writes, claims and final results', async () => {
  const messageId = id();
  for (let n = 0; n < 2; n++)
    await rootFixture.phone.execute('sendRoomMessage', { roomId: R, text: '@hoots', messageId }, H);
  expect(
    (
      await rootFixture.db.query(
        `SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2 AND state='pending'`,
        [messageId, A],
      )
    ).rowCount,
  ).toBe(1);
  const [c] = await commands();
  await claim(c!);
  const attempts = await Promise.allSettled(
    ['g2', 'g3'].map(async (generationId) =>
      rootFixture.daemon.execute('claimAgentCommand', { roomId: R, commandId: c!.id, generationId }, A, await helperOwner(A)),
    ),
  );
  expect(attempts.every((a) => a.status === 'rejected')).toBe(true);
  const one = await result(c!, '@goosy Done');
  const two = await result(c!, '@goosy Done');
  expect(two.id).toBe(one.id);
  expect(await commands(B)).toHaveLength(1);
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
  await expect(rootFixture.daemon.execute('postAgentDraft', { ...draft, turnId: id() }, A)).rejects.toThrow();
  await expect(rootFixture.daemon.execute('postAgentDraft', { ...draft, roomId: C }, A)).rejects.toThrow();
  await expect(rootFixture.daemon.execute('postAgentDraft', { ...draft, agentId: B }, B)).rejects.toThrow();
  await rootFixture.daemon.execute('postAgentDraft', draft, A);
  await rootFixture.phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: c!.turnRequestId }, H);
  await expect(result(c!, 'Stopped')).rejects.toThrow();
  await expect(rootFixture.daemon.execute('postAgentDraft', draft, A)).rejects.toThrow();
  expect((await commands())[0]?.action).toBe('stop');
  await send('@hoots next');
  const [next] = (await commands()).filter((c) => c.action === 'input');
  await claim(next!);
  await result(next!, 'Done');
  await expect(
    rootFixture.daemon.execute('postAgentDraft', { ...draft, turnId: next!.turnRequestId }, A),
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
      await rootFixture.db.query<{ tagged_ids: string[] }>(
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
  await rootFixture.db.query(`CREATE FUNCTION refuse_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected dispatch failure'; END $$;
 CREATE TRIGGER refuse_command BEFORE INSERT ON agent_commands FOR EACH ROW EXECUTE FUNCTION refuse_command();`);
  try {
    await expect(result(c!, '@goosy Atomic')).rejects.toThrow('injected');
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text='Atomic'`)).rowCount).toBe(0);
  } finally {
    await rootFixture.db.query(
      `DROP TRIGGER refuse_command ON agent_commands; DROP FUNCTION refuse_command();`,
    );
  }
  await result(c!, '@goosy Atomic');
  expect(await commands(B)).toHaveLength(1);
});
