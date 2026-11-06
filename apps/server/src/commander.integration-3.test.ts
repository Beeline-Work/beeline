import { readCornerObjective, activeCornerHolds, SYSTEM_IDENTITY_ID, cornerMergeGate, randomUUID, randomBytes, expect, it, DaemonService, LiveHub, createAgentCommand, systemLine, HUMAN, RUBY, WORKER, WS, ROOM, DM, db, daemon, phone, order, claim, authority, commands, open, worker, currentPlaceReminder, rootFixture, type CommandRow, type AgentCommand } from './commander.integration.test-support.js';



it.each(['final', 'post-final', 'silent', 'post-silent'] as const)('Reproduction R1 missing attachments: report wake delivers files once (%s)', async mode => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text: 'Work started.' }, RUBY);
  await rootFixture.daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: files ready' }, WORKER);
  const wake = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(wake);
  const objectId = randomUUID();
  await rootFixture.db.query(`INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'image/png','proof.png',10,$4,'ready',now()+interval '24 hours')`,
    [objectId, RUBY, `artifact/${objectId}`, randomBytes(32).toString('hex')]);
  await rootFixture.daemon.execute('postAgentAttachment', { ...authority(wake), attachment: {
    url: `http://test/v1/media/${objectId}`, name: 'proof.png', mimeType: 'image/png', size: 10,
  } }, RUBY);
  if (mode.startsWith('post-')) {
    const receipt = await rootFixture.daemon.execute('postCornerMessage', { ...authority(wake), cornerId: DM, text: 'Here is the image.' }, RUBY);
    expect(receipt.receipt).not.toContain('closing text here also publishes');
  }
  if (mode.endsWith('silent')) {
    await rootFixture.daemon.execute('markAgentTurnSilent', authority(wake), RUBY);
    await rootFixture.daemon.execute('postRoomMessage', { ...authority(wake), text: 'This must remain silent.' }, RUBY);
  } else {
    await rootFixture.daemon.execute('postRoomMessage', { ...authority(wake), text: 'Here is the image.' }, RUBY);
  }
  const visible = (await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message' && m.text !== 'Work started.');
  expect(visible).toHaveLength(mode === 'post-final' ? 2 : 1);
  expect(visible.flatMap(message => (message.attachments ?? []).map(attachment => attachment.name))).toEqual(['proof.png']);
  expect(visible[0]!.text).not.toContain('must remain silent');
  expect((await rootFixture.db.query('SELECT 1 FROM agent_pending_attachments WHERE request_id=$1', [wake.turnRequestId])).rowCount).toBe(0);
});


it.each([false, true])('same-place closing keeps a new attachment on the visible post (tagged=%s)', async tagged => {
  const text = `${tagged ? '@captain ' : ''}Google sign-in is merged.`;
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text }, RUBY);
  const objectId = randomUUID();
  await rootFixture.db.query(`INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'text/plain','proof',10,$4,'ready',now()+interval '24 hours')`,
    [objectId, RUBY, `artifact/${objectId}`, randomBytes(32).toString('hex')]);
  await rootFixture.daemon.execute('postAgentAttachment', { ...authority(rootFixture.order), attachment: {
    url: `http://test/v1/media/${objectId}`, name: 'proof.txt', mimeType: 'text/plain', size: 10,
  } }, RUBY);
  const final = await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text }, RUBY);
  const messages = (await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message');
  expect(messages.map(m => m.id)).toEqual([posted.id]);
  const message = messages[0]!;
  expect((await rootFixture.db.query(`SELECT presentation FROM messages WHERE id=$1`, [final.id])).rows[0]?.presentation).toBe('activity');
  expect(message.presentation).toBe('message');
  expect(message.attachments).toHaveLength(1);
});


it.each([
  ['The balance is -5. The checks passed.', 'The balance is 5.', true],
  ['Open https://example.com/a-b. The checks passed.', 'Open https://example.com/a/b.', true],
  ['The balance is -5. The checks passed.', 'The balance is -5.', false],
  ['Open https://example.com/a-b. The checks passed.', 'Open https://example.com/a-b.', false],
])('same-place summaries retain literal corrections in activity: %s -> %s', async (post, final) => {
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text: post }, RUBY);
  const result = await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text: final }, RUBY);
  const messages = (await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message');
  expect(messages.map(m => m.id)).toEqual([posted.id]);
  expect((await rootFixture.db.query(`SELECT activity FROM messages WHERE id=$1`, [result.id])).rows[0]?.activity).toContainEqual({ kind: 'note', title: 'Turn summary', text: final });
});


it.each([
  ['Read /tmp/a-b. The checks passed.', 'Read /tmp/a/b.'],
  ['The identifier is account_ready. The checks passed.', 'The identifier is account-ready.'],
  ['Run `send(a-b)`. The checks passed.', 'Run `send(a/b)`.'],
  ['Run `send(a-b)`.', 'Run `send(a/b)`.'],
  ['Run `READY`.', 'Run `ready`.'],
  ['Run `a  b`.', 'Run `a b`.'],
])('same-place summaries retain corrected paths, identifiers and code in activity: %s -> %s', async (post, final) => {
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text: post }, RUBY);
  const result = await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text: final }, RUBY);
  expect((await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message').map(m => m.id))
    .toEqual([posted.id]);
});


it.each([
  ['Do not deploy the release.', 'deploy the release.', true],
  ['If checks pass, deploy the release.', 'deploy the release.', true],
  ['Deploy the release only after checks pass.', 'Deploy the release', true],
  ['Deploy the release. Only after checks pass.', 'Deploy the release.', true],
  ['Do not deploy the release. The checks passed.', 'Do not deploy the release.', false],
])('same-place summaries retain polarity and qualifying context in activity: %s -> %s', async (post, final) => {
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text: post }, RUBY);
  const result = await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text: final }, RUBY);
  expect((await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message').map(m => m.id))
    .toEqual([posted.id]);
});



it.each(['human', 'order'])('Reproduction R1: silent completion preserves fresh %s input without a pause', async input => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  // The old tool completed the command while the helper still had draft writes.
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(turn), status: 'complete', completionKind: 'no-reply' }, WORKER);
  await expect(rootFixture.daemon.execute('postAgentDraft', { ...authority(turn), agentId: WORKER, turnId: turn.turnRequestId, text: 'late' }, WORKER))
    .rejects.toThrow('command output authority rejected');
  if (input === 'human') {
    await rootFixture.phone.execute('sendRoomMessage', { roomId: opened.cornerId, text: '@worker Continue the widget' }, HUMAN);
  } else {
    await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: opened.cornerId, agent: 'worker', text: 'Continue the widget' }, RUBY);
  }
  const next = await worker(opened.cornerId);
  // The helper now owns completion: queued presentation writes finish first.
  await rootFixture.daemon.execute('postAgentDraft', { ...authority(next), agentId: WORKER, turnId: next.turnRequestId, text: 'Checking the widget' }, WORKER);
  await rootFixture.daemon.execute('retractAgentLiveOutput', { ...authority(next), agentId: WORKER, turnId: next.turnRequestId, kind: 'draft' }, WORKER);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(next), status: 'complete', completionKind: 'no-reply' }, WORKER);
  expect((await rootFixture.db.query(`SELECT state,generation_id FROM agent_commands WHERE id=$1`, [next.id])).rows[0])
    .toMatchObject({ state: 'complete', generation_id: authority(next).generationId });
  expect(await commands(opened.cornerId, WORKER)).toEqual([]);
  expect((await commands(DM, RUBY)).filter(command => command.reason === 'report')).toEqual([]);
});

it.each(['dm', 'room', 'corner', 'parent-room'] as const)('post receipt identifies the actual current place: %s', async (place) => {
  let command = rootFixture.order;
  let agent = RUBY;
  let target = DM;
  if (place === 'room') {
    await rootFixture.phone.execute('sendRoomMessage', { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text: '@ruby Post here' }, HUMAN);
    command = (await commands(ROOM, RUBY))[0]!;
    await claim(command);
    target = ROOM;
  } else if (place === 'corner' || place === 'parent-room') {
    const opened = await open();
    command = await worker(opened.cornerId);
    agent = WORKER;
    target = place === 'corner' ? opened.cornerId : ROOM;
  }
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(command), cornerId: target, text: 'Receipt path proof' }, agent);
  expect(posted.receipt).toBe('Message stored and visible.' + (place === 'parent-room' ? '' : '\n' + currentPlaceReminder));
  expect((await rootFixture.phone.readRoom(target, HUMAN))?.messages.some(message => message.id === posted.id && message.text === 'Receipt path proof')).toBe(true);
});



it('opens with an independent reviewer and lets another member change it through metadata', async () => {
  const input = { ...authority(rootFixture.order), requestId: rootFixture.order.turnRequestId, targetRoomId: ROOM,
    name: 'Reviewer', objective: 'Prove corner reviewer assignment', implementer: 'worker', reviewer: 'ruby',
    brief: { spec: 'Prove reviewer assignment', repositoryWork: false } };
  const opened = await rootFixture.daemon.execute('createCorner', input, RUBY);
  expect((await rootFixture.db.query(`SELECT reviewer_agent_id FROM corner_facts WHERE corner_id=$1`, [opened.cornerId])).rows[0])
    .toEqual({ reviewer_agent_id: RUBY });
  // Tool retries retain the original corner rather than opening duplicate work.
  expect((await rootFixture.daemon.execute('createCorner', input, RUBY)).cornerId).toBe(opened.cornerId);
  const turn = await worker(opened.cornerId);
  await expect(rootFixture.daemon.execute('renameCorner', { ...authority(turn), cornerId: opened.cornerId, reviewer: 'worker' }, WORKER))
    .rejects.toThrow('implementer cannot review');
  await rootFixture.daemon.execute('renameCorner', { ...authority(turn), cornerId: opened.cornerId, reviewer: 'ruby' }, WORKER);
  const lines = await rootFixture.db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%set the corner reviewer%'`, [opened.cornerId]);
  expect(lines.rowCount).toBe(1);
  console.info('Demonstrated corner-reviewer: open assigns an independent reviewer; another member can set it without editing the brief; self review is refused.');
});


it('refuses opening with the implementer as reviewer atomically', async () => {
  await expect(rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), requestId: rootFixture.order.turnRequestId,
    targetRoomId: ROOM, name: 'Reviewer', objective: 'Prove reviewer independence',
    implementer: 'worker', reviewer: 'worker', brief: { spec: 'Prove reviewer independence', repositoryWork: false } }, RUBY))
    .rejects.toThrow('implementer cannot review');
  expect((await rootFixture.db.query(`SELECT 1 FROM rooms WHERE parent_id=$1`, [ROOM])).rowCount).toBe(0);
});


it.each(['room', 'corner'] as const)('Reproduction R1: silent %s rejects late final text before the terminal receipt', async scope => {
  const turn = scope === 'corner' ? await worker((await open()).cornerId) : rootFixture.order;
  if (scope === 'room') await rootFixture.db.query(`UPDATE agent_commands SET reason='report' WHERE id=$1`, [turn.id]);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(turn), status: 'working' }, turn.agentId);
  await rootFixture.daemon.execute('markAgentTurnSilent', authority(turn), turn.agentId);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'This must never be a message.' }, turn.agentId);
  expect((await rootFixture.db.query(`SELECT id FROM messages WHERE room_id=$1 AND author_id=$2 AND request_id=$3`,
    [turn.roomId, turn.agentId, turn.turnRequestId])).rows).toEqual([]);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(turn), status: 'complete' }, turn.agentId);
  expect((await rootFixture.db.query(`SELECT completion_kind FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,
    [turn.roomId, turn.agentId, turn.turnRequestId])).rows[0]?.completion_kind).toBe('no-reply');
});


it('Reproduction R1: the server refuses silence on human input', async () => {
  await expect(rootFixture.daemon.execute('markAgentTurnSilent', authority(rootFixture.order), RUBY)).rejects.toThrow('requires a nonhuman wake');
});



it.each(['room', 'corner'] as const)('Reproduction R1: post then a differently worded summary leaves one visible %s message', async scope => {
  let turn: AgentCommand;
  if (scope === 'corner') turn = await worker((await open()).cornerId);
  else {
    await rootFixture.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@ruby Check the widget' }, HUMAN);
    turn = (await rootFixture.daemon.execute('getAgentCommands', { roomId: ROOM }, RUBY)).commands[0]!;
    await claim(turn);
  }
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(turn), cornerId: turn.roomId, text: 'The widget is ready.' }, turn.agentId);
  const summary = 'Finished checking it; the widget can be used now.';
  const final = await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: summary }, turn.agentId);
  const messages = (await rootFixture.phone.readRoom(turn.roomId, HUMAN))!.messages.filter(message => message.author.pubkey === turn.agentId && message.presentation === 'message');
  expect(messages.map(message => message.id)).toEqual([posted.id]);
  expect((await rootFixture.db.query(`SELECT presentation,activity FROM messages WHERE id=$1`, [final.id])).rows[0])
    .toMatchObject({ presentation: 'activity', activity: [{ kind: 'note', title: 'Turn summary', text: summary }] });
});


it.each(['done','no-reply'])('WAKE-STORM: auth-failed reviewer reports once; its later command keeps its own result (%s)', async outcome => {
  const NIGLET = '6'.repeat(64), SOL = '7'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Niglet','niglet'),($2,'agent','Sol','sol') ON CONFLICT DO NOTHING`, [NIGLET,SOL]);
  await rootFixture.db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3) ON CONFLICT DO NOTHING', [NIGLET,SOL,HUMAN]);
  for (const agent of [NIGLET,SOL]) for (const address of [null,ROOM,DM])
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS,address,agent]);
  await rootFixture.daemon.execute('postAgentTurnReceipt', {...authority(rootFixture.order),status:'complete'}, RUBY);
  const queuedRoot = await createAgentCommand(rootFixture.db, {roomId:DM,agentId:NIGLET,
    sourceMessageId:rootFixture.order.sourceMessageId,reason:'human_tag'});
  const root = (await commands(DM,NIGLET)).find(c=>c.id===queuedRoot!.id)!;
  await claim(root);
  await rootFixture.daemon.execute('order', {...authority(root),address:DM,agent:'ruby',text:'Build the widget'}, NIGLET);
  rootFixture.order = (await commands(DM,RUBY)).find(c=>c.reason==='order')!;
  await claim(rootFixture.order);
  const opened = await open();
  const turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('postAgentTurnReceipt', {...authority(turn),status:'complete'}, WORKER);
  await rootFixture.db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [ROOM,SOL]);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [opened.cornerId,
    JSON.stringify({checks:'passing',pr:{number:42,headSha:'a'.repeat(40)}})]);
  await systemLine(rootFixture.db, {roomId:opened.cornerId,authorId:HUMAN,subject:{kind:'github',name:'GitHub'},
    verb:'passed checks',kind:'check-passed',object:{text:'checks',headSha:'a'.repeat(40)}});
  const review = (await commands(opened.cornerId,SOL))[0]!;
  await claim(review);
  await rootFixture.daemon.execute('postAgentTurnReceipt', {...authority(review),status:'failed',reason:'ACP error -32000: Authentication required'}, SOL);
  const {reconcileConfiguredCornerReviewers} = await import('./agent-command.js');
  for (let cycle=0;cycle<5;cycle++) await reconcileConfiguredCornerReviewers(rootFixture.db,ROOM);
  expect(await commands(opened.cornerId,SOL)).toHaveLength(0);
  const failures = (await commands(DM,RUBY)).filter(c=>c.reason==='report');
  expect(failures).toHaveLength(1);
  if (outcome === 'done') await rootFixture.daemon.execute('report', {...authority(rootFixture.order),status:'done',text:'done: the assigned coordination is complete'}, RUBY);
  else await rootFixture.daemon.execute('postAgentTurnReceipt', {...authority(rootFixture.order),status:'complete',completionKind:'no-reply'}, RUBY);
  const upstreamResults = outcome === 'done' ? 1 : 0;
  expect((await commands(DM,NIGLET)).filter(c=>c.reason==='report')).toHaveLength(upstreamResults);
  await claim(failures[0]!);
  // This later report is a separate command with its own result.
  await rootFixture.daemon.execute('postRoomMessage', {...authority(failures[0]!),text:'The reviewer still requires authentication.'}, RUBY);
  expect((await commands(DM,NIGLET)).filter(c=>c.reason==='report')).toHaveLength(upstreamResults + 1);
  const {reportToCommander} = await import('./commander.js');
  const row = (await rootFixture.db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1',[review.id])).rows[0]!;
  for(let attempt=0;attempt<5;attempt++) await rootFixture.daemon.execute('postAgentTurnReceipt',
    {...authority(review),status:'failed',reason:'ACP error -32000: Authentication required'},SOL);
  expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND reason='report' AND private_payload->>'authorId'=$2`,[RUBY,SOL])).rowCount).toBe(1);
  // Closing the source corner silences both old pending and fresh reports.
  await rootFixture.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[opened.cornerId]);
  expect(await rootFixture.db.transaction(tx=>reportToCommander(tx,opened.cornerId,SOL,'failed: another auth failure',row,'after-close',{automatic:true})))
    .toMatchObject({skipped:true});
  expect((await commands(DM,RUBY)).filter(c=>c.reason==='report')).toHaveLength(0);
});



it('WAKE-STORM: identical pending failures collapse and closed-corner reports vanish', async () => {
  const opened = await open();

  {
    const queued = [];
    for(let attempt=0;attempt<3;attempt++) queued.push(await createAgentCommand(rootFixture.db,{
      roomId:DM,agentId:RUBY,sourceMessageId:null,reason:'report',
      privatePayload:{kind:'report',authorId:WORKER,fromRoomId:opened.cornerId,originCornerId:opened.cornerId,
        text:'failed: Authentication required'},
    }));
    const pending = (await commands(DM,RUBY)).filter(c=>c.reason==='report');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queued[0]!.id);
    await expect(claim({...pending[0]!,id:queued[1]!.id})).rejects.toThrow();
    await rootFixture.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[opened.cornerId]);
    expect((await commands(DM,RUBY)).filter(c=>c.reason==='report')).toHaveLength(0);
    await expect(claim(pending[0]!)).rejects.toThrow();
  }
});



it('WAKE-STORM: identical failures of separate Room orders retain both results', async () => {
  for (let task=0;task<2;task++) await createAgentCommand(rootFixture.db, {
    roomId:DM,agentId:RUBY,sourceMessageId:null,reason:'report',
    privatePayload:{kind:'report',authorId:WORKER,fromRoomId:ROOM,text:'failed: provider unavailable'},
  });
  expect((await commands(DM,RUBY)).filter(c=>c.reason==='report')).toHaveLength(2);
});



it('WAKE-STORM: a later delegate report publishes its reply without re-answering the inherited order', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('report', {...authority(rootFixture.order),status:'done',text:'done: coordination finished'}, RUBY);
  await rootFixture.daemon.execute('report', {...authority(turn),status:'blocked',text:'blocked: reviewer requires authentication'}, WORKER);
  const returned = (await commands(DM,RUBY)).find(c=>c.reason==='report')!;
  await claim(returned);
  await rootFixture.daemon.execute('postRoomMessage', {...authority(returned),text:'The reviewer still needs to sign in.'}, RUBY);
  expect((await rootFixture.phone.readRoom(DM,HUMAN))!.messages.filter(m=>m.author.pubkey===RUBY && m.presentation==='message').map(m=>m.text))
    .toEqual(['done: coordination finished', 'The reviewer still needs to sign in.']);
});


it('Reproduction SELF-1: self-orders in another Room and corner retain receipts without wakes', async () => {
  const receipt = await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: ROOM, agent: 'ruby', text: 'Continue in the Room' }, RUBY);
  expect(receipt.accepted).toBe(true);
  expect(await commands(ROOM, RUBY)).toEqual([]);
  expect((await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`,[receipt.id])).rows).toEqual([{state:'complete'}]);
  const opened = await rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), targetRoomId: ROOM,
    name: 'self-work', objective: 'Continue own work', implementer: 'ruby',
    brief: { spec: 'Continue own work', repositoryWork: false } }, RUBY);
  await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: opened.cornerId, text: 'Resume own corner' }, RUBY);
  expect(await commands(opened.cornerId, RUBY)).toEqual([]);
  await expect(rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: DM, agent: 'ruby', text: 'Recurse' }, RUBY))
    .rejects.toThrow('current place');
});


it('Reproduction SELF-1: cross-place self-tags never start a ping-pong chain', async () => {
  const opened = await open();
  for (const cornerId of [ROOM, opened.cornerId, ROOM, opened.cornerId]) {
    const posted = await rootFixture.daemon.execute('postCornerMessage', {...authority(rootFixture.order),cornerId,text:'@ruby continue here'}, RUBY);
    expect(posted.woken).toEqual([]);
    expect(await commands(cornerId,RUBY)).toEqual([]);
  }
});


it('Reproduction SELF-1: replaying a self-order retains one completed receipt and zero wakes', async () => {
  const input = {...authority(rootFixture.order),address:ROOM,agent:'ruby',text:'Continue elsewhere'};
  const first = await rootFixture.daemon.execute('order',input,RUBY);
  const replay = await rootFixture.daemon.execute('order',input,RUBY);
  expect(replay.id).toBe(first.id);
  expect(await commands(ROOM,RUBY)).toEqual([]);
  expect((await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`,[first.id])).rows).toEqual([{state:'complete'}]);
});


it('Reproduction SELF-2: own brief revisions stay quiet while external shell completions can finish silently', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('postBackgroundToolCompletion', { ...authority(turn), toolCallId: 'shell', title: 'Run tests', status: 'completed' }, WORKER);
  const shell = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'corner_background_tool')!;
  await claim(shell);
  await rootFixture.daemon.execute('markAgentTurnSilent', authority(shell), WORKER);
  const own = await rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), targetRoomId: ROOM,
    idempotencyKey: 'own-revision', name: 'own-revision', objective: 'Continue own work', implementer: 'ruby',
    brief: { spec: 'Continue own work', repositoryWork: false } }, RUBY);
  await rootFixture.db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}'::jsonb)`, [own.cornerId, RUBY]);
  await rootFixture.daemon.execute('reviseCornerBrief', { ...authority(rootFixture.order), cornerId: own.cornerId, expectedRevision: 1,
    brief: { spec: 'Build the clarified widget', change: 'Clarify work' } }, RUBY);
  expect((await commands(own.cornerId,RUBY)).filter(c=>c.reason==='corner_brief_revision')).toEqual([]);
  expect((await rootFixture.db.query(`SELECT state FROM agent_commands WHERE room_id=$1 AND reason='corner_brief_revision'`,[own.cornerId])).rows)
    .toEqual([{state:'complete'}]);

});


it.each([
  ['recover', '40P01', 1, 2],
  ['exhaust', '40P01', 10, 1],
  ['other error', '23505', 1, 1],
  ['authority revoked', '40P01', 1, 1],
  ['revision changed', '40P01', 1, 2],
])('R-BRIEF-DEADLOCK: %s rolls back the revision and command delivery', async (scenario, code, failures, expectedAttempts) => {
  const opened = await open();
  const snapshot = async () => ({
    briefs: (await rootFixture.db.query(`SELECT * FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision`, [opened.cornerId])).rows,
    commands: (await rootFixture.db.query(`SELECT * FROM agent_commands ORDER BY id`)).rows,
    notes: (await rootFixture.db.query(`SELECT * FROM messages WHERE room_id=$1 ORDER BY id`, [opened.cornerId])).rows,
  });
  const before = await snapshot();
  const events: unknown[] = [];
  const hub = new LiveHub();
  hub.publish = event => { events.push(event); };
  let attempts = 0;
  const failure = Object.assign(new Error('brief transaction failure'), { code });
  const wrapped: import('./database.js').SqlDatabase = {
    query: (sql, values) => rootFixture.db.query(sql, values),
    transaction: async work => {
      attempts++;
      try {
        return await rootFixture.db.transaction(async tx => {
          const result = await work(tx);
          if (attempts <= failures) throw failure;
          return result;
        });
      } catch (error) {
        if (error !== failure) throw error;
        expect(events).toHaveLength(0);
        expect(await snapshot()).toEqual(before);
        if (scenario === 'authority revoked')
          await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [RUBY]);
        if (scenario === 'revision changed')
          await rootFixture.daemon.execute('reviseCornerBrief', { ...authority(rootFixture.order), cornerId: opened.cornerId,
            expectedRevision: 1, brief: { spec: 'Concurrent authorized scope', change: 'Concurrent revision' } }, RUBY);
        throw error;
      }
    },
  };
  const watched = new DaemonService(wrapped, hub);
  const input = { ...authority(rootFixture.order), cornerId: opened.cornerId, expectedRevision: 1,
    brief: { spec: 'Build the clarified widget', change: 'Clarify scope' } };
  await expect(watched.execute('reviseCornerBrief', input, RUBY)).rejects.toBe(failure);
  expect(attempts).toBe(1);
  expect(events).toHaveLength(0);
  if (scenario !== 'revision changed') expect(await snapshot()).toEqual(before);
  if (scenario === 'recover') {
    // Only a separate explicit action may acquire fresh authority and try again.
    expect((await watched.execute('reviseCornerBrief', input, RUBY)).revision).toBe(2);
    const restored = await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, RUBY);
    expect(restored.brief?.spec).toBe(input.brief.spec);
    const after = await snapshot();
    expect(after.briefs).toHaveLength(2);
    expect(after.notes.length).toBe(before.notes.length + 1);
    expect(after.commands.filter(row => row.state === 'pending' && row.room_id === opened.cornerId)).toHaveLength(1);
  } else if (scenario === 'authority revoked' || scenario === 'revision changed') {
    await expect(watched.execute('reviseCornerBrief', input, RUBY)).rejects.toThrow(
      scenario === 'authority revoked' ? /access|member|authority/i : /revision changed/);
    expect(events).toHaveLength(0);
  }
  expect(attempts).toBe(expectedAttempts);
});


it.each([true, false])('records mock reply evidence through brief reads (reply=%s)', async (reply) => {
  const opened = await open();
  const mock = randomBytes(32).toString('hex'), approval = randomBytes(32).toString('hex');
  const objectId = randomUUID(), urlObjectId = randomUUID();
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments,created_at)
    VALUES($1,$2,$3,'Mock', $4::jsonb,'2026-01-01T00:00:00Z')`,
    [mock, DM, RUBY, JSON.stringify([{mediaId: objectId}, {url: 'https://test/v1/media/' + urlObjectId}])]);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,created_at)
    VALUES($1,$2,$3,'Use this mock',$4,'2026-01-01T00:01:00Z')`, [approval, DM, HUMAN, reply ? mock : null]);
  const revised = await rootFixture.daemon.execute('reviseCornerBrief', { ...authority(rootFixture.order), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: 'Build the approved widget', change: 'Record mock approval', approval: {sourceMessageId: approval} } }, RUBY);
  const restored = await rootFixture.daemon.execute('getCornerRestoreState', {cornerId: opened.cornerId}, WORKER);
  const revisions = await rootFixture.daemon.execute('listCornerBriefRevisions', {cornerId: opened.cornerId}, WORKER);
  for (const brief of [revised, restored.brief, revisions.revisions[0]]) {
    expect(brief?.approval).toMatchObject({kind: 'explicit-human-answer', sourceMessageId: approval,
      text: 'Use this mock', approvedBy: HUMAN, replyToMessageId: reply ? mock : null,
      replyToAttachmentIds: reply ? expect.arrayContaining([objectId, urlObjectId]) : [],
      replyToCreatedAt: reply ? expect.any(String) : null, approvedAt: expect.any(String)});
    if (reply) expect(Date.parse(brief!.approval!.approvedAt!)).toBeGreaterThan(Date.parse(brief!.approval!.replyToCreatedAt!));
  }
  // The worker can verify stored evidence without gaining access to the private DM.
  await expect(rootFixture.daemon.execute('getRoomMessage', {roomId: DM, messageId: approval}, WORKER)).rejects.toThrow();
});


// HOLD-CITATION: isolated stand-in; live replay would create owner-account corners.
it.each(['set', 'open'] as const)('HOLD-CITATION: %s accepts a readable person citation and displays its author', async mode => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const sourceMessageId = randomBytes(32).toString('hex');
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Hold this PR')`, [sourceMessageId, ROOM, HUMAN]);
  const result = mode === 'set'
    ? await rootFixture.daemon.execute('setCornerHold', { ...authority(turn), cornerId: opened.cornerId, sourceMessageId }, WORKER)
    : await rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), targetRoomId: ROOM,
        idempotencyKey: randomUUID(), name: 'cited-hold', objective: 'Verify hold citation', hold: true, sourceMessageId }, RUBY);
  const cornerId = 'cornerId' in result ? result.cornerId : opened.cornerId;
  expect(await activeCornerHolds(rootFixture.db, cornerId)).toEqual([expect.objectContaining({
    sourceMessageId, sourceAuthorId: HUMAN, sourceAuthorName: 'Captain',
    sourceText: 'Hold this PR',
  })]);
  const gate = await cornerMergeGate(rootFixture.db, cornerId, { number: 1, headSha: 'head' });
  expect(gate).toMatchObject({ held: true, open: false,
    holds: [expect.objectContaining({ sourceMessageId, sourceAuthorName: 'Captain' })] });
  const line = (await rootFixture.db.query<{text:string}>(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%set a merge hold%'`, [cornerId])).rows[0]!;
  expect(line.text).toContain('Captain');
  expect(line.text).toContain('Hold this PR');
  if (mode === 'set') {
    const next = randomBytes(32).toString('hex');
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Keep this PR held')`, [next, ROOM, HUMAN]);
    await rootFixture.daemon.execute('setCornerHold', { ...authority(turn), cornerId, sourceMessageId: next }, WORKER);
    expect(await activeCornerHolds(rootFixture.db, cornerId)).toEqual([expect.objectContaining({ sourceMessageId: next, sourceText: 'Keep this PR held' })]);
    expect((await rootFixture.db.query<{text:string}>(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%set a merge hold%'`, [cornerId])).rows)
      .toEqual([expect.objectContaining({ text: expect.stringContaining('Keep this PR held') })]);
  }
  // Citation is not needed to release the agent's own hold.
  const hold = (await activeCornerHolds(rootFixture.db, cornerId))[0]!;
  const command = mode === 'set' ? turn : rootFixture.order;
  await rootFixture.daemon.execute('setCornerHold', { ...authority(command), cornerId, releaseHoldId: hold.id }, mode === 'set' ? WORKER : RUBY);
});

it.each(['missing', 'nonexistent', 'deleted', 'self', 'other-agent', 'system', 'unreadable'])(
  'HOLD-CITATION: refuses %s citations on both agent entry points', async kind => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const id = randomBytes(32).toString('hex');
    if (kind !== 'missing' && kind !== 'nonexistent') {
      let room = ROOM;
      if (kind === 'unreadable') {
        room = randomUUID();
        await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Private',$3)`, [room, WS, HUMAN]);
      }
      const author = kind === 'self' ? WORKER : kind === 'other-agent' ? RUBY : kind === 'system' ? SYSTEM_IDENTITY_ID : HUMAN;
      await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,deleted_at) VALUES($1,$2,$3,'Hold this PR',$4)`,
        [id, room, author, kind === 'deleted' ? new Date() : null]);
    }
    const sourceMessageId = kind === 'missing' ? undefined : id;
    for (const action of [
      () => rootFixture.daemon.execute('setCornerHold', { ...authority(turn), cornerId: opened.cornerId, sourceMessageId }, WORKER),
      () => rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), targetRoomId: ROOM,
        idempotencyKey: randomUUID(), name: 'bad-citation', objective: 'Verify hold citation', hold: true, sourceMessageId }, RUBY),
    ]) {
      const failure = kind === 'missing' ? 'sourceMessageId is required' : kind === 'nonexistent' ? 'does not exist' :
        kind === 'deleted' ? 'is deleted' : kind === 'unreadable' ? 'cannot read' : 'not an agent or System';
      await expect(action()).rejects.toMatchObject({ status: 403, message: expect.stringContaining(failure) });
      await expect(action()).rejects.toThrow("cite the person's message that asks for the hold, or close the PR to stop it");
    }
    expect(await activeCornerHolds(rootFixture.db, opened.cornerId)).toEqual([]);
  },
);

it('HOLD-CITATION: human hold needs no citation and still blocks merge', async () => {
  const opened = await open();
  await rootFixture.phone.execute('setCornerHold', { cornerId: opened.cornerId }, HUMAN);
  expect(await cornerMergeGate(rootFixture.db, opened.cornerId, {number:1,headSha:'head'})).toMatchObject({held:true,open:false});
});


it('OBJECTIVE-BRIEF: reads the latest brief and renames navigation in place without authority changes or a wake', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
    VALUES($1,2,'Latest authorized scope','Latest navigation',$2,$3)`, [opened.cornerId,RUBY,ROOM]);
  expect(await readCornerObjective(rootFixture.db, opened.cornerId)).toBe('Latest navigation');
  await rootFixture.db.query(`UPDATE corner_brief_revisions SET objective=NULL WHERE corner_id=$1 AND revision=2`,[opened.cornerId]);
  expect(await readCornerObjective(rootFixture.db,opened.cornerId)).toBe('');
  await rootFixture.db.query(`UPDATE corner_brief_revisions SET objective='Latest navigation' WHERE corner_id=$1 AND revision=2`,[opened.cornerId]);
  expect((await rootFixture.phone.readRoom(opened.cornerId,HUMAN))?.room.about).toBe('Latest navigation');
  expect((await rootFixture.phone.readCorners(ROOM,HUMAN))?.corners)
    .toContainEqual(expect.objectContaining({corner: expect.objectContaining({id: opened.cornerId, about: 'Latest navigation'})}));
  const before = (await rootFixture.db.query(`SELECT * FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision`,[opened.cornerId])).rows;
  const facts = (await rootFixture.db.query(`SELECT * FROM corner_facts WHERE corner_id=$1`,[opened.cornerId])).rows;
  const wakes = (await rootFixture.db.query(`SELECT * FROM agent_commands ORDER BY id`)).rows;
  await rootFixture.daemon.execute('renameCorner',{...authority(turn),cornerId:opened.cornerId,name:'New-name',objective:'New navigation'},WORKER);
  expect(await readCornerObjective(rootFixture.db,opened.cornerId)).toBe('New navigation');
  expect((await rootFixture.daemon.execute('getCornerRestoreState',{cornerId:opened.cornerId},WORKER)).objective).toBe('New navigation');
  expect((await rootFixture.db.query(`SELECT * FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision`,[opened.cornerId])).rows)
    .toEqual(before.map(row => row.revision === 2 ? {...row,objective:'New navigation'} : row));
  expect((await rootFixture.db.query(`SELECT * FROM corner_facts WHERE corner_id=$1`,[opened.cornerId])).rows).toEqual(facts);
  expect((await rootFixture.db.query(`SELECT * FROM agent_commands ORDER BY id`)).rows).toEqual(wakes);
});


it('OBJECTIVE-BRIEF: no-brief objectives use the opening order and plan fills only missing navigation', async () => {
  const opened = await rootFixture.daemon.execute('createCorner',{...authority(rootFixture.order),targetRoomId:ROOM,
    name:'Scratch',objective:'Opening navigation',implementer:'worker'},RUBY);
  const turn = await worker(opened.cornerId);
  expect(await readCornerObjective(rootFixture.db,opened.cornerId)).toBe('Opening navigation');
  expect((await rootFixture.phone.readRoom(opened.cornerId,HUMAN))?.room.about).toBe('Opening navigation');
  await rootFixture.daemon.execute('renameCorner',{...authority(turn),cornerId:opened.cornerId,name:'Scratch-renamed',objective:'Edited navigation'},WORKER);
  expect(await readCornerObjective(rootFixture.db,opened.cornerId)).toBe('Edited navigation');
  const postPlan = (objective:string) => rootFixture.daemon.execute('postCornerPlan',{...authority(turn),cornerId:opened.cornerId,objective,items:[]},WORKER);
  await postPlan('Must not replace');
  expect(await readCornerObjective(rootFixture.db,opened.cornerId)).toBe('Edited navigation');
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=private_payload-'objective' WHERE room_id=$1`,[opened.cornerId]);
  await postPlan('Filled navigation');
  expect(await readCornerObjective(rootFixture.db,opened.cornerId)).toBe('Filled navigation');
  expect((await rootFixture.db.query(`SELECT count(*)::int n FROM corner_brief_revisions WHERE corner_id=$1`,[opened.cornerId])).rows[0]).toEqual({n:0});
});


it('Reproduction RETURN-ADDRESS: an agent order without an explicit return address reports to its parent commander', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=private_payload-'fromRoomId' WHERE id=$1`, [turn.id]);
  await rootFixture.daemon.execute('report', { ...authority(turn), status: 'blocked', text: 'blocked: need a decision' }, WORKER);
  const returned = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
  expect(returned).toHaveLength(1);
  expect(returned[0]!.source.body).toBe('blocked: need a decision');
  await claim(returned[0]!);
});


it('Reproduction RETURN-ADDRESS: a report whose parent expired retains the recorded human source route', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('report', { ...authority(turn), status: 'blocked', text: 'blocked: decision needed' }, WORKER);
  const returned = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(returned);
  // Production feedback fb_135f018e: the report parent was gone, but its
  // root_source_message_id still named the human's original Room order.
  await rootFixture.db.query('DELETE FROM agent_commands WHERE id=$1', [rootFixture.order.id]);
  await rootFixture.db.query('UPDATE messages SET deleted_at=now() WHERE id=$1', [rootFixture.order.sourceMessageId]);
  await expect(rootFixture.daemon.execute('report', { ...authority(returned), status: 'needs_decision', text: 'needs-decision: approve the next step?' }, RUBY))
    .rejects.toThrow('no commander return address');
  await rootFixture.db.query('UPDATE messages SET deleted_at=NULL WHERE id=$1', [rootFixture.order.sourceMessageId]);
  await rootFixture.daemon.execute('report', { ...authority(returned), status: 'needs_decision', text: 'needs-decision: approve the next step?' }, RUBY);
  expect((await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.text === 'needs-decision: approve the next step?')).toHaveLength(1);
});


it('Reproduction POST-ID: different explicit replies receive their own stored ids and identical retries reuse them', async () => {
  const { mentionReplyKey, mentionReplyId } = await import('./owed-mentions.js');
  const key = await mentionReplyKey(rootFixture.db, RUBY, DM, rootFixture.order.sourceMessageId);
  expect(key).toBeDefined();
  const legacyId = mentionReplyId(key!);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,root_message_id)
    VALUES($1,$2,$3,'Opened the fix.',$4,$4)`, [legacyId, DM, RUBY, rootFixture.order.sourceMessageId]);
  const post = (text: string) => rootFixture.daemon.execute('postCornerMessage', {
    ...authority(rootFixture.order), cornerId: DM, replyTo: rootFixture.order.sourceMessageId, text,
  }, RUBY);
  const first = await post('Opened the fix.');
  expect(first.id).toBe(legacyId);
  const second = await post('The fix is complete.');
  expect(second.id).not.toBe(first.id);
  expect((await post('The fix is complete.')).id).toBe(second.id);
  expect((await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY).map(m => m.text))
    .toEqual(expect.arrayContaining(['Opened the fix.', 'The fix is complete.']));
  expect((await rootFixture.db.query('SELECT id FROM messages WHERE id=ANY($1::text[])', [[first.id, second.id]])).rowCount).toBe(2);
});


it('Reproduction REPLY-ONCE: a direct human reply retried three times stores and wakes once', async () => {
  const parent = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text: 'Is the boot fix approved?' }, RUBY);
  const messageId = randomBytes(32).toString('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    expect((await rootFixture.phone.execute('sendRoomReply', { roomId: DM, messageId, parentMessageId: parent.id,
      text: '@ruby is this still current? Approved in that case' }, HUMAN)).messageId).toBe(messageId);
  }
  expect((await rootFixture.db.query('SELECT id FROM messages WHERE id=$1', [messageId])).rowCount).toBe(1);
  expect((await rootFixture.db.query('SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [messageId, RUBY])).rowCount).toBe(1);
});
