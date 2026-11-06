import { releaseAgentConnection, advanceCorner, randomUUID, randomBytes, expect, it, vi, MemoryObjectStorage, ObjectService, DaemonService, LiveHub, PushDeliveryLoop, createAgentCommand, GITHUB_SUBJECT, systemLine, HUMAN, RUBY, WORKER, WS, ROOM, DM, db, daemon, phone, order, claim, authority, commands, open, worker, rootFixture, type AgentCommand } from './test-support-commander-recovery.integration.test-support.js';



it.each(['report', 'postRoomMessage'] as const)('Reproduction FILE-HANDOFF: independent reports retain every file through %s', async (delivery) => {
  const objects = new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test');
  const attachments = [];
  const turns = [];
  // Both workers finish before the commander consumes either report.
  for (const name of ['first.txt', 'second.txt']) {
    const opened = await open(name);
    const turn = await worker(opened.cornerId);
    const bytes = Buffer.from(`${delivery}:${name}`);
    const uploaded = await objects.uploadArtifact(WORKER, bytes, 'text/plain', name);
    const attachment = { url: uploaded.url, name, mimeType: 'text/plain', size: bytes.length };
    attachments.push(attachment);
    await rootFixture.daemon.execute('postAgentAttachment', { ...authority(turn), attachment }, WORKER);
    turns.push(turn);
  }
  for (const [index, turn] of turns.entries()) {
    await rootFixture.daemon.execute('report', { ...authority(turn), status: 'done', text: `done: attached ${attachments[index]!.name}` }, WORKER);
  }
  const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
  expect(reports).toHaveLength(2);
  for (const [index, report] of reports.entries()) {
    expect(report.source.attachments).toEqual([attachments[index]]);
    await claim(report);
    if (delivery === 'report')
      await rootFixture.daemon.execute('report', { ...authority(report), status: 'done', text: `done: attached ${attachments[index]!.name}` }, RUBY);
    else await rootFixture.daemon.execute('postRoomMessage', { ...authority(report), text: `Attached ${attachments[index]!.name}` }, RUBY);
  }
  const visible = (await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(message => message.attachments?.length);
  expect(visible).toHaveLength(2);
  for (const [index, message] of visible.entries()) {
    expect(message.attachments).toEqual([expect.objectContaining(attachments[index])]);
    const readable = await rootFixture.daemon.execute('getRoomMessage', { roomId: DM, messageId: message.id }, RUBY);
    expect(readable.attachments).toEqual([expect.objectContaining(attachments[index])]);
    const attachment = readable.attachments[0]!;
    expect(Buffer.from((await objects.readOwnedBytes(WORKER, attachment.url.split('/').at(-1)!))!).toString())
      .toBe(`${delivery}:${attachment.name}`);
  }
});


it.each(['report', 'postRoomMessage'] as const)('Reproduction FILE-HANDOFF: %s keeps files on their own commander route', async delivery => {
  const objects = new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test');
  const commanders = ['12'.repeat(32), '13'.repeat(32)];
  const incoming = [];
  for (const commander of commanders) {
    await rootFixture.db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Commander') ON CONFLICT DO NOTHING`, [commander]);
    await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [commander, HUMAN]);
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, ROOM, commander]);
    const parent = (await createAgentCommand(rootFixture.db, {
      roomId: ROOM, agentId: RUBY, sourceMessageId: null, reason: 'order',
      privatePayload: { kind: 'order', authorId: commander, fromRoomId: ROOM, text: 'Prepare my file' },
    }))!;
    await rootFixture.db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [parent.id]);
    const name = `${commander.slice(0, 2)}.txt`;
    // Distinct objects with identical bytes also exercise deduplication after routing.
    const uploaded = await objects.uploadArtifact(commander, Buffer.from(`private-${delivery}`), 'text/plain', name);
    incoming.push({ parent, attachment: { url: uploaded.url, name, mimeType: 'text/plain', size: Buffer.byteLength(`private-${delivery}`) } });
  }
  for (const { parent, attachment } of incoming) {
    await createAgentCommand(rootFixture.db, {
      roomId: ROOM, agentId: RUBY, sourceMessageId: null, reason: 'report', parent, retainDepth: true,
      privatePayload: { kind: 'report', authorId: WORKER, fromRoomId: ROOM, text: 'done: file ready', attachments: [attachment] },
    });
  }
  const reports = (await commands(ROOM, RUBY)).filter(command => command.reason === 'report');
  expect(reports).toHaveLength(2);
  for (const report of reports) {
    expect(report.source.attachments).toHaveLength(1);
    await claim(report);
    if (delivery === 'report')
      await rootFixture.daemon.execute('report', { ...authority(report), status: 'done', text: 'done: file attached' }, RUBY);
    else await rootFixture.daemon.execute('postRoomMessage', { ...authority(report), text: 'File attached' }, RUBY);
  }
  for (const [index, commander] of commanders.entries()) {
    const delivered = (await commands(ROOM, commander)).find(command => command.reason === 'report')!;
    expect(delivered.source.attachments).toEqual([incoming[index]!.attachment]);
    const read = await rootFixture.daemon.execute('getRoomMessage', { roomId: ROOM, messageId: delivered.id }, commander);
    expect(read.attachments).toEqual([expect.objectContaining(incoming[index]!.attachment)]);
    await expect(rootFixture.daemon.execute('getRoomMessage', { roomId: ROOM, messageId: delivered.id }, commanders[1 - index]!))
      .rejects.toThrow('message access denied');
  }
});


it('reports a later corner order to its actual orderer', async () => {
  const opened = await open();
  const OTHER = 'd'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Other','other')`, [OTHER]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [OTHER, HUMAN]);
  await rootFixture.db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`,
    [WS, ROOM, OTHER],
  );
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('second-command',$1,$2,'Follow up')`,
    [ROOM, HUMAN],
  );
  const incoming = (await createAgentCommand(rootFixture.db, {
    roomId: ROOM,
    agentId: OTHER,
    sourceMessageId: 'second-command',
    reason: 'human_tag',
  }))!;
  await claim({
    ...incoming,
    roomId: ROOM,
    agentId: OTHER,
    id: incoming.id,
  } as unknown as AgentCommand);
  await rootFixture.daemon.execute(
    'order',
    {
      roomId: ROOM,
      requestId: incoming.turn_request_id,
      generationId: 'proof-generation',
      address: opened.cornerId,
      text: 'Other requests a follow-up',
    },
    OTHER,
  );
  const turn = (await commands(opened.cornerId, WORKER)).find((c) => c.reason === 'order')!;
  await claim(turn);
  await rootFixture.daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: Other follow-up' }, WORKER);
  expect((await commands(DM, RUBY)).some((c) => c.source.body === 'done: Other follow-up')).toBe(
    false,
  );
  expect((await commands(ROOM, OTHER)).some((c) => c.reason === 'report')).toBe(true);
});

it('keeps approval resume provenance and posts progress only in the corner', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await systemLine(rootFixture.db, {
    roomId: opened.cornerId,
    authorId: HUMAN,
    subject: { kind: 'person', id: HUMAN, name: 'Captain' },
    verb: 'received approval',
    kind: 'squire-approval-decided',
    wakes: [WORKER],
    requestId: turn.turnRequestId,
  });
  const resumed = (await commands(opened.cornerId, WORKER)).find((c) => c.action === 'resume')!;
  expect(resumed.private).toBe(true);
  expect(resumed.source.body).toContain('received approval');
  expect(resumed.source.body).toContain('Build the widget');
  await claim(resumed);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(resumed), text: 'PRIVATE COORDINATION LEAK' },
    WORKER,
  );
  expect(
    (await rootFixture.db.query(`SELECT text FROM messages WHERE text='PRIVATE COORDINATION LEAK'`)).rowCount,
  ).toBe(1);
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body === 'done: PRIVATE COORDINATION LEAK',
    ),
  ).toBe(false);
});

it('hands private work back on connection close without a failure report', async () => {
  const opened=await open(),turn=await worker(opened.cornerId);
  const connection=(await rootFixture.db.query<{connection_id:string}>('SELECT connection_id FROM agent_connections WHERE agent_id=$1',[WORKER])).rows[0]!;
  await releaseAgentConnection(rootFixture.db,new LiveHub(),WORKER,connection.connection_id);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[turn.id])).rows[0]).toMatchObject({state:'pending'});
  expect((await commands(DM,RUBY)).some(command=>command.reason==='report'&&command.source.body.startsWith('failed:'))).toBe(false);
  await rootFixture.daemon.execute('claimAgentCommand',{roomId:opened.cornerId,commandId:turn.id,generationId:'after-reconnect'},WORKER);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[turn.id])).rows[0]).toMatchObject({state:'claimed'});
});


it('retains workflow run and attempt guidance in private commands', async () => {
  const opened = await open();
  await systemLine(rootFixture.db, {
    id: 'specific-run-id',
    roomId: opened.cornerId,
    authorId: RUBY,
    subject: { kind: 'agent', id: RUBY, name: 'Ruby' },
    verb: 'started',
    object: 'a workflow',
    kind: 'workflow-handoff',
    presentation: 'card',
    cardType: 'workflow-handoff',
    card: {
      runId: 'specific-run-id',
      workflowSlug: 'specific-workflow',
      seq: 1,
      toState: 'build',
      runStatus: 'live',
    },
    wakes: [WORKER],
  });
  const fired = (await commands(opened.cornerId, WORKER)).find(
    (c) => c.reason === 'subscribed_event',
  )!;
  expect(fired.source.body).toContain('specific-run-id');
  expect(fired.source.body).toContain('attempt');
  await claim(fired);
  await systemLine(rootFixture.db, {
    roomId: opened.cornerId,
    authorId: HUMAN,
    subject: { kind: 'person', id: HUMAN, name: 'Captain' },
    verb: 'approved a credential',
    kind: 'squire-approval-decided',
    requestId: fired.turnRequestId,
    wakes: [WORKER],
  });
  const resumed = (await commands(opened.cornerId, WORKER)).find((c) => c.action === 'resume')!;
  expect(resumed.source.body).toContain('specific-run-id');
  expect(resumed.source.body).toContain('attempt 1');
});

it('opens a sibling when given a corner target', async () => {
  const opened = await open();
  const nested = await rootFixture.daemon.execute(
    'createCorner',
    {
      ...authority(rootFixture.order),
      targetRoomId: opened.cornerId,
      idempotencyKey: 'nested',
      name: 'Nested',
      objective: 'Nested venue',
      brief: { spec: 'Nested work', approval: { sourceMessageId: rootFixture.order.sourceMessageId } },
    },
    RUBY,
  );
  expect(
    (await rootFixture.db.query(`SELECT parent_id FROM rooms WHERE id=$1`, [nested.cornerId])).rows[0],
  ).toMatchObject({ parent_id: ROOM });
});


it('delivers artifacts privately and forwards them in human reports', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId),
    media = randomUUID();
  await rootFixture.db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at) VALUES($1,$2,'artifact',$3,'text/plain','report.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, WORKER, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await rootFixture.daemon.execute(
    'postAgentAttachment',
    {
      ...authority(turn),
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'report.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    WORKER,
  );
  await rootFixture.daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: report is attached' }, WORKER);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'report is attached' },
    WORKER,
  );
  expect(
    (
      await rootFixture.db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`, [
        turn.turnRequestId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (await rootFixture.db.query(`SELECT 1 FROM messages WHERE attachments::text LIKE $1`, ['%' + media + '%']))
      .rowCount,
  ).toBe(0);
  const report = (await commands(DM, RUBY)).find((c) => c.reason === 'report')!;
  expect(report.source.attachments).toEqual([expect.objectContaining({ name: 'report.txt' })]);
  await claim(report);
  await rootFixture.daemon.execute('report', { status: 'done', ...authority(report), text: 'done: report is attached' }, RUBY);
  expect(
    (await rootFixture.db.query(`SELECT 1 FROM messages WHERE attachments::text LIKE $1`, ['%' + media + '%']))
      .rowCount,
  ).toBe(1);
});

it('routes zero-check completion through a durable lifecycle fact', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId),
    head = '7'.repeat(40);
  await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, RUBY]);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    opened.cornerId,
    JSON.stringify({ checks: 'pending', pr: { number: 21, headSha: head, mergeability: 'clean' } }),
  ]);
  const zero = new DaemonService(
    rootFixture.db,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    async () =>
      ({
        checks: 'pending',
        checkCount: 0,
        zeroChecksConfirmed: true,
        headSha: head,
        approved: false,
        held: false,
        mergeAllowed: false,
      }) as any,
  );
  await zero.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'Finished zero-check work' },
    WORKER,
  );
  await zero.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  expect((await rootFixture.db.query(`SELECT lifecycle->>'checks' checks FROM corner_github_cache WHERE corner_id=$1`, [opened.cornerId])).rows[0]?.checks).toBe('passing');
  await advanceCorner(rootFixture.db, opened.cornerId, { kind: 'reconcile' });
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body.includes('foreign key constraint'),
    ),
  ).toBe(false);
  expect(
    (await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id])).rows[0],
  ).toMatchObject({ state: 'complete' });
  expect(
    (
      await rootFixture.db.query(
        `SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason IN ('subscribed_event','corner_review_dispatch')`,
        [opened.cornerId, RUBY],
      )
    ).rowCount,
  ).toBe(1);
});

it('ends a private provider failure once without a retry', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  const result = await rootFixture.daemon.execute(
    'postAgentTurnReceipt',
    {
      ...authority(turn),
      agentId: WORKER,
      status: 'failed',
      reason: 'provider error 429 concurrency_limit',
      reasonKind: 'hiccup',
    },
    WORKER,
  );
  expect(result).not.toHaveProperty('hiccupRestart');
  expect(
    (await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id]))
      .rows[0],
  ).toMatchObject({ state: 'complete' });
  expect((await commands(DM,RUBY)).filter(command=>command.reason==='report'&&command.source.body.startsWith('failed:'))).toHaveLength(1);
  expect(await commands(opened.cornerId,WORKER)).toEqual([]);
});


it('maintains human follows through private orders', async () => {
  const opened = await open(),
    other = 'e'.repeat(64);
  await rootFixture.db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Second Person','secondperson')`,
    [other],
  );
  await rootFixture.db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WS, ROOM, other],
  );
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('follow-up-person',$1,$2,'@ruby update the widget')`,
    [ROOM, other],
  );
  const incoming = (await createAgentCommand(rootFixture.db, {
    roomId: ROOM,
    agentId: RUBY,
    sourceMessageId: 'follow-up-person',
    reason: 'human_tag',
  }))!;
  await claim({
    ...incoming,
    roomId: ROOM,
    agentId: RUBY,
    id: incoming.id,
  } as unknown as AgentCommand);
  await rootFixture.daemon.execute(
    'order',
    {
      roomId: ROOM,
      requestId: incoming.turn_request_id,
      generationId: 'proof-generation',
      address: opened.cornerId,
      text: 'Update as the second person asked',
    },
    RUBY,
  );
  expect(
    (
      await rootFixture.db.query(`SELECT 1 FROM corner_follows WHERE corner_id=$1 AND identity_id=$2`, [
        opened.cornerId,
        other,
      ])
    ).rowCount,
  ).toBe(1);
});


it('resumes the incoming human order for a non-opener watch', async () => {
  const opened = await open();
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('watch-request',$1,$2,'@worker watch the widget')`,
    [ROOM, HUMAN],
  );
  const incoming = (await createAgentCommand(rootFixture.db, {
    roomId: ROOM,
    agentId: WORKER,
    sourceMessageId: 'watch-request',
    reason: 'human_tag',
  }))!;
  await claim({
    ...incoming,
    roomId: ROOM,
    agentId: WORKER,
    id: incoming.id,
  } as unknown as AgentCommand);
  await rootFixture.daemon.execute(
    'watchCorner',
    { roomId: ROOM, cornerId: opened.cornerId, kinds: ['merged'] },
    WORKER,
  );
  await systemLine(rootFixture.db, { roomId: opened.cornerId, authorId: HUMAN, subject: { kind: 'system', name: 'GitHub' }, verb: 'merged', kind: 'merged' });
  const merged = (await commands(ROOM, WORKER)).find((c) => c.reason === 'watched_corner')!;
  expect(merged.parentCommandId).toBe(incoming.id);
  await claim(merged);
  await expect(
    rootFixture.daemon.execute('report', { status: 'done', ...authority(merged), text: 'done: watched corner merged' }, WORKER),
  ).resolves.toHaveProperty('id');
});


it('rejects stale private workflow wakes after their run ends', async () => {
  const opened = await open(),
    run = randomBytes(32).toString('hex');
  await systemLine(rootFixture.db, {
    id: run,
    roomId: opened.cornerId,
    authorId: RUBY,
    subject: { kind: 'agent', id: RUBY, name: 'Ruby' },
    verb: 'started',
    object: 'a workflow',
    kind: 'workflow-handoff',
    presentation: 'card',
    cardType: 'workflow-handoff',
    card: {
      runId: run,
      workflowSlug: 'stale-workflow',
      seq: 0,
      toState: 'build',
      runStatus: 'live',
    },
    wakes: [WORKER],
  });
  const stale = (await commands(opened.cornerId, WORKER)).find(
    (c) => c.reason === 'subscribed_event',
  )!;
  await rootFixture.db.query(`UPDATE messages SET card=card||'{"runStatus":"done"}'::jsonb WHERE id=$1`, [run]);
  const connection = (await rootFixture.db.query<{ connection_id: string }>(
    'SELECT connection_id FROM agent_connections WHERE agent_id=$1', [WORKER])).rows[0]!;
  await releaseAgentConnection(rootFixture.db, new LiveHub(), WORKER, connection.connection_id);
  expect((await commands(opened.cornerId, WORKER)).some((c) => c.id === stale.id)).toBe(false);
  await expect(claim(stale)).rejects.toThrow('command claim conflict');
  expect(
    (await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [stale.id])).rows[0],
  ).toMatchObject({ state: 'cancelled' });
});

it('commits terminal failure when the commander has left', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    DM,
    RUBY,
  ]);
  await expect(
    rootFixture.daemon.execute(
      'postAgentTurnReceipt',
      {
        ...authority(turn),
        agentId: WORKER,
        status: 'failed',
        reason: 'provider outage',
        reasonKind: 'hiccup',
      },
      WORKER,
    ),
  ).resolves.toHaveProperty('id');
  expect(
    (await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id])).rows[0],
  ).toMatchObject({ state: 'complete' });
  expect(
    (
      await rootFixture.db.query(
        `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
        [opened.cornerId, turn.turnRequestId, WORKER],
      )
    ).rows[0],
  ).toMatchObject({ status: 'failed' });
});

it.each([false, true])('the commander revises from its DM after a check wake (cited approval: %s)', async citedApproval => {
  const opened = await open();
  const head = '9'.repeat(40);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    opened.cornerId,
    JSON.stringify({ checks: 'failing', pr: { number: 21, headSha: head } }),
  ]);
  await advanceCorner(rootFixture.db, opened.cornerId, { kind: 'push', contents: { headSha: head } });
  await systemLine(rootFixture.db, {
    roomId: opened.cornerId,
    authorId: WORKER,
    subject: GITHUB_SUBJECT,
    verb: 'failed checks',
    kind: 'check-failed',
  });
  const check = (await commands(opened.cornerId, WORKER)).find((c) => c.reason === 'corner_check')!;
  await claim(check);
  expect(check.sourceMessageId).toBe(check.id);
  expect(check.rootSourceMessageId).toBe(rootFixture.order.rootSourceMessageId);
  const stored = (await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, RUBY)).brief!;
  await rootFixture.daemon.execute(
    'reviseCornerBrief',
    {
      ...authority(rootFixture.order),
      cornerId: opened.cornerId,
      expectedRevision: 1,
      brief: {
        spec: 'Build the widget with the necessary CI repair',
        ...(citedApproval ? { approval: { sourceMessageId: stored.approval!.sourceMessageId } } : {}),
        change: 'Repair CI',
      },
    },
    RUBY,
  );
  expect(
    (
      await rootFixture.db.query(
        `SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1 AND revision=2`,
        [opened.cornerId],
      )
    ).rows[0],
  ).toMatchObject({
    approval_basis: citedApproval ? {
      kind: 'initiating-command',
      approvedBy: HUMAN,
      sourceMessageId: stored.approval!.sourceMessageId,
      snapshot: 'Build the widget in the target Room',
    } : {
      kind: 'commander-direct',
      approvedBy: RUBY,
      sourceMessageId: '',
      snapshot: 'Commander revised the corner brief directly',
    },
  });
});


it('discovers only reachable member addresses and corners from a DM', async () => {
  const opened = await open();
  const hidden = randomUUID();
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Hidden')`, [hidden, WS]);
  const addresses = await rootFixture.daemon.execute('listRooms', { roomId: DM }, RUBY);
  expect(addresses.rooms).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ roomId: ROOM, name: 'Target Room' }),
      expect.objectContaining({ roomId: opened.cornerId, parentRoomId: ROOM }),
    ]),
  );
  expect(addresses.rooms.some((room) => room.roomId === hidden)).toBe(false);
  expect((await rootFixture.daemon.execute('listReachableCorners', { roomId: DM }, RUBY)).corners).toEqual([
    expect.objectContaining({ cornerId: opened.cornerId }),
  ]);
  expect((await rootFixture.daemon.execute('listRoomMembers', { roomId: ROOM }, RUBY)).members).toEqual(
    expect.arrayContaining([expect.objectContaining({ handle: 'worker' })]),
  );
});


it('keeps file-only corner final replies in the corner without reporting progress', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  const media = randomUUID();
  await rootFixture.db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'text/plain','legacy.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, WORKER, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await rootFixture.daemon.execute(
    'postAgentAttachment',
    {
      ...authority(turn),
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'legacy.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    WORKER,
  );
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: '' }, WORKER);
  const returned = (await commands(DM, RUBY)).filter((c) => c.reason === 'report');
  expect(returned).toHaveLength(0);
  expect(
    (
      await rootFixture.db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`, [
        turn.turnRequestId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND presentation='message'`, [
        opened.cornerId,
      ])
    ).rowCount,
  ).toBe(1);
});


it('acknowledges explicit reports so final prose does not send a second report', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: widget tested' }, WORKER);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'The widget is tested' },
    WORKER,
  );
  expect((await commands(DM, RUBY)).filter((c) => c.reason === 'report')).toHaveLength(1);
});


it('human Room reports with an agent-written mention enter the needs-you tray and push at Attention sensitivity', async () => {
  await rootFixture.db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`, [HUMAN]);
  await rootFixture.db.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment)
    VALUES('commander-device-token-12345678901234567890',$1,'android','physical')`,
    [HUMAN],
  );
  const send = vi.fn(async () => undefined);
  const loop = new PushDeliveryLoop(rootFixture.db, { send });
  await loop.runOnce();
  await rootFixture.phone.execute(
    'sendRoomMessage',
    { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text: '@ruby decide the scope' },
    HUMAN,
  );
  const incoming = (await commands(ROOM, RUBY)).find((c) => c.reason === 'human_tag')!;
  await claim(incoming);
  const delivered = await rootFixture.daemon.execute(
    'report',
    { status: 'needs_decision', ...authority(incoming), ask: 'Which endpoint should we use?', text: 'needs-decision: choose an endpoint @captain' },
    RUBY,
  );
  expect((await rootFixture.phone.execute('readNeedsYou', { workspaceId: WS }, HUMAN)).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ messageId: delivered.id })]),
  );
  await loop.runOnce();
  expect(send.mock.calls).toEqual(
    expect.arrayContaining([
      expect.arrayContaining([expect.objectContaining({ messageId: delivered.id })]),
    ]),
  );
});


it('refuses newly queued files after a terminal report and ignores closing prose', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId),
    media = randomUUID();
  await rootFixture.daemon.execute(
    'report',
    { status: 'done', ...authority(turn), text: 'done: preparing the artifact' },
    WORKER,
  );
  await rootFixture.db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'text/plain','late.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, WORKER, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await expect(rootFixture.daemon.execute(
    'postAgentAttachment',
    {
      ...authority(turn),
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'late.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    WORKER,
  )).rejects.toThrow('authority rejected');
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'The artifact is ready' },
    WORKER,
  );
  const reports = (await commands(DM, RUBY)).filter((c) => c.reason === 'report');
  expect(reports).toHaveLength(1);
  expect((await rootFixture.phone.readRoom(opened.cornerId, HUMAN))?.messages.some(message =>
    message.attachments?.some(attachment => attachment.name === 'late.txt'))).toBe(false);
  expect(
    (
      await rootFixture.db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`, [
        turn.turnRequestId,
      ])
    ).rowCount,
  ).toBe(0);
});


it('keeps unrelated Room subscriptions independent of completed orders', async () => {
  await rootFixture.daemon.execute(
    'order',
    { ...authority(rootFixture.order), address: ROOM, agent: WORKER, text: 'One-off Room instruction' },
    RUBY,
  );
  const prior = (await commands(ROOM, WORKER)).find((c) => c.reason === 'order')!;
  await claim(prior);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(prior), text: 'One-off complete' },
    WORKER,
  );
  await systemLine(rootFixture.db, {
    roomId: ROOM,
    authorId: HUMAN,
    subject: { kind: 'person', id: HUMAN, name: 'Captain' },
    verb: 'received',
    object: 'an unrelated Room event',
    kind: 'subscription-fired',
    wakes: [WORKER],
    subscriptionPrompt: 'POST IN THE ROOM',
    payload: { text: 'new event' },
  });
  const event = (await commands(ROOM, WORKER)).find((c) => c.reason === 'subscribed_event')!;
  await claim(event);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(event), text: 'Unrelated subscription result' },
    WORKER,
  );
  expect(event.private).not.toBe(true);
  expect(event.parentCommandId).not.toBe(prior.id);
  expect(
    (
      await rootFixture.db.query(
        `SELECT 1 FROM messages WHERE room_id=$1 AND text='Unrelated subscription result'`,
        [ROOM],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body.includes('Unrelated subscription result'),
    ),
  ).toBe(false);
});

it('refuses retired relay writes on private turns without reporting success', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  const r = await rootFixture.daemon
    .execute(
      'postRoomMessage',
      {
        ...authority(turn),
        text: 'Old steer',
        relay: { fromRoomId: opened.cornerId, toRoomId: ROOM, direction: 'down' },
      } as any,
      WORKER,
    )
    .then(
      (v) => ({ ok: true, value: v }),
      (e) => ({ ok: false, status: e.status, message: e.message }),
    );
  expect(r).toMatchObject({ ok: false, status: 410 });
  expect(
    (await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id])).rows[0]?.state,
  ).toBe('claimed');
  expect((await commands(DM, RUBY)).some((c) => c.reason === 'report')).toBe(false);
});
