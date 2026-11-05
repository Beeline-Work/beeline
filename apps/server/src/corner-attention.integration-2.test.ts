import { cornerReportWaiting, cornerIdleSql, cornerOwedAnswerTimesSql, expect, it, PgliteDatabase, insertCornerFacts, createAgentCommand, CORNER_ATTENTION_SCHEMA, refreshCornerAttention, WS, ROOM, C, HUMAN, COMMANDER, WORKER, REVIEWER, db, daemon, phone, state, wake, post, commanderFlags, turn, end, ci, rootFixture } from './corner-attention.integration.test-support.js';



it('Reproduction HEADER-STATE-4: pending CI wins over a human question with a hold', async () => {
  await post('scope-question', 'needs-decision: @owner Which scope should I implement?');
  await rootFixture.phone.execute('setCornerHold', { cornerId: C }, HUMAN);
  await ci('pending');
  expect(await state()).toBe('review');
  expect((await rootFixture.phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('review');
  await ci('passing');
  expect(await state()).toBe('waiting');
});

it('Reproduction R1: a worker order waiting on an offline helper stays working', async () => {
  await wake(WORKER, 'queued-implementer');
  await rootFixture.db.query("UPDATE agent_turns SET created_at=now()-interval '31 seconds' WHERE room_id=$1", [C]);
  await rootFixture.db.query(`DELETE FROM agent_turns WHERE room_id=$1`, [C]);
  const restore = await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER);
  expect(restore).toMatchObject({ state: 'working', activity: 'running' });
  expect((await rootFixture.phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'working' });
  expect(
    (await rootFixture.phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0],
  ).toMatchObject({ state: 'working' });
  await rootFixture.db.query(`INSERT INTO live_server_instances(instance_id) VALUES('r1-online') ON CONFLICT DO NOTHING`);
  await rootFixture.db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
    VALUES($1,1,'r1-online','r1-online')`, [WORKER]);
  expect(await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).toMatchObject({
    state: 'working', activity: 'running',
  });
  expect((await rootFixture.phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'working' });
  const behind = '44444444-4444-4444-8444-444444444444';
  await rootFixture.db.query(
    `INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'codex-dot-connect',$3)`,
    [behind, WS, HUMAN],
  );
  await rootFixture.db.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
     VALUES($1,$2,$3,'working','g-live')`,
    [behind, 'f'.repeat(64), WORKER],
  );
  expect(await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).toMatchObject({
    state: 'working', activity: 'running',
  });
  expect((await rootFixture.phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({
    state: 'working',
  });
  expect(
    (await rootFixture.phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0],
  ).toMatchObject({ state: 'working' });
  await rootFixture.db.query(`DELETE FROM agent_turns WHERE room_id=$1`, [behind]);
  await rootFixture.db.query(
    `UPDATE agent_commands SET state='claimed',lease_expires_at=now()+interval '90 seconds',
       claimed_at=now(),generation_id='g-hold' WHERE id='queued-implementer'`,
  );
  expect(await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).toMatchObject({
    state: 'working', activity: 'running',
  });
  await rootFixture.db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,lease_expires_at=NULL,claimed_at=NULL WHERE id='queued-implementer'`);

  expect(await state()).toBe('working');
  await rootFixture.db.query("UPDATE agent_commands SET state='complete',completed_at=now() WHERE id='queued-implementer'");
  expect(await state()).toBe('idle');
});



it.each(['agent', 'human'] as const)('REPORT-WAITING-DERIVED: %s report quiets wakes and clears on each authorized input', async recipientKind => {
  const { reportToCommander } = await import('./commander.js');
  const recipient = recipientKind === 'agent' ? COMMANDER : HUMAN;
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($1::text))
    WHERE id='opening-order'`, [recipient]);
  const changes: string[] = [];
  const unlisten = rootFixture.db instanceof PgliteDatabase ? await rootFixture.db.client.listen('beeline_live_v1', raw => {
    const event = JSON.parse(raw);
    if (event.table === 'corner_state') changes.push(event.roomId);
  }) : undefined;
  try {
    for (const input of ['return-room-answer', 'commander-order', 'new-head'] as const) {
      const automatic = await createAgentCommand(rootFixture.db, { id: `automatic-${input}`, roomId: C, agentId: WORKER,
        sourceMessageId: null, reason: 'corner_lifecycle',
        privatePayload: { kind: 'lifecycle', authorId: WORKER, fromRoomId: C, text: 'Continue automatically' } });
      expect(automatic).toBeDefined();
      expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`, [C,automatic!.turn_request_id])).rows)
        .toEqual([{ status: 'working' }]);
      changes.length = 0;
      const report = await reportToCommander(rootFixture.db, C, WORKER, 'blocked: choose the next direction', undefined, `report-${input}`);
      expect(await cornerReportWaiting(rootFixture.db, C)).toBe(true);
      expect(await state()).toBe('waiting');
      if (unlisten) expect(changes).toContain(C);
      expect((await rootFixture.db.query(`SELECT state,cancellation_reason FROM agent_commands WHERE id=$1`, [automatic!.id])).rows)
        .toEqual([{ state: 'cancelled', cancellation_reason: 'corner_waiting' }]);
      expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND status='working'`, [C,automatic!.turn_request_id])).rows)
        .toEqual([]);
      // An unrelated agent's prose and order cannot answer this report.
      await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
        VALUES($1,$2,$3,'Proceed','message')`, [`unrelated-${input}`, ROOM, REVIEWER]);
      await createAgentCommand(rootFixture.db, { id: `unrelated-order-${input}`, roomId: C, agentId: REVIEWER,
        sourceMessageId: null, reason: 'order', privatePayload: { kind: 'order', authorId: REVIEWER, fromRoomId: ROOM, text: 'Other work' } });
      expect(await cornerReportWaiting(rootFixture.db, C)).toBe(true);
      await rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [`unrelated-order-${input}`]);
      await rootFixture.db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND agent_id=$2`, [C,REVIEWER]);
      changes.length = 0;
      if (input === 'return-room-answer') {
        // A current human member may answer even when the commander is an agent.
        await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
          VALUES('derived-answer',$1,$2,'Proceed','message')`, [ROOM,HUMAN]);
      } else if (input === 'commander-order') {
        const next = await createAgentCommand(rootFixture.db, { id: 'derived-order', roomId: C, agentId: WORKER,
          sourceMessageId: null, reason: 'order', privatePayload: { kind: 'order', authorId: recipient, fromRoomId: ROOM, text: 'Proceed' } });
        await rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [next!.id]);
        await rootFixture.db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND request_id=$2`, [C,next!.turn_request_id]);
      } else {
        await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle='{"pr":{"headSha":"new-head"},"checks":"failing"}'::jsonb WHERE corner_id=$1`, [C]);
      }
      expect(await cornerReportWaiting(rootFixture.db, C)).toBe(false);
      if (unlisten) expect(changes).toContain(C);
      const saved = recipientKind === 'agent'
        ? (await rootFixture.db.query(`SELECT private_payload->>'waitingAnswered' answered FROM agent_commands WHERE id=$1`, [report.id])).rows
        : (await rootFixture.db.query(`SELECT card->>'waitingAnswered' answered FROM messages WHERE id=$1`, [report.id])).rows;
      expect(saved).toEqual([{ answered: 'true' }]);
      const cardId = (await rootFixture.db.query<{ card_id: string }>(`SELECT encode(sha256(convert_to('agent-command-card:'||$1::text,'UTF8')),'hex') card_id`, [report.id])).rows[0]!.card_id;
      expect((await rootFixture.db.query(`SELECT card->>'waitingAnswered' answered FROM messages WHERE id=$1`, [cardId])).rows)
        .toEqual([{ answered: 'true' }]);
    }
  } finally { await unlisten?.(); }
});



it('REPORT-WAITING-DERIVED: automatic blocked prose preserves the committed turn end', async () => {
  await turn();
  await end(WORKER, 10);
  const idle = async () => (await rootFixture.db.query<{ last_turn_ended_at: Date | null; idle_since: string }>(
    cornerIdleSql('$1'), [C])).rows.map(row => ({ ended: row.last_turn_ended_at, since: row.idle_since }));
  const before = await idle();
  expect(before[0]!.ended).not.toBeNull();
  const { reportToCommander } = await import('./commander.js');
  await reportToCommander(rootFixture.db, C, WORKER, 'blocked: an automatic completion', undefined, 'automatic-report', { automatic: true });
  expect(await cornerReportWaiting(rootFixture.db, C)).toBe(false);
  expect(await idle()).toEqual(before);
});


it('IDLE-DERIVED: concurrent recomputations claim one command with no span rows', async () => {
  await Promise.all([refreshCornerAttention(rootFixture.db,C),refreshCornerAttention(rootFixture.db,C)]);
  const reports = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM agent_commands
    WHERE reason='report' AND private_payload->>'idleSince' IS NOT NULL`)).rows;
  expect(reports).toHaveLength(1);
  expect(await commanderFlags()).toHaveLength(1);
  await refreshCornerAttention(rootFixture.db,C);
  expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE reason='report'`)).rows).toEqual(reports);
});


it.each(['human','worker'] as const)('IDLE-DERIVED: a %s event replaces the episode and fences its cached claim', async event => {
  await refreshCornerAttention(rootFixture.db,C);
  const first = (await commanderFlags())[0]!;
  // A new event withdraws the old idle episode.
  if (event === 'human') await post('new-idle-human','Please continue',HUMAN);
  else { await turn(); await refreshCornerAttention(rootFixture.db,C); await end(); }
  await refreshCornerAttention(rootFixture.db,C);
  await expect(rootFixture.daemon.execute('claimAgentCommand', {
    roomId:C,commandId:first.id,generationId:'obsolete-idle',
  },COMMANDER)).rejects.toThrow();
  expect(await commanderFlags()).toHaveLength(1);
  const current = (await rootFixture.db.query<{ id: string }>(`SELECT id
    FROM agent_commands WHERE reason='report' AND state='pending'`)).rows;
  expect(current).toHaveLength(1);
  expect(current[0]!.id).not.toBe(first.id);


  expect((await commanderFlags()).map(command=>command.id)).toEqual([current[0]!.id]);
});


it('IDLE-DERIVED: a commander reply and turn do not change the idle command', async () => {
  await refreshCornerAttention(rootFixture.db,C);
  const first = (await commanderFlags())[0]!;
  await post('commander-idle-reply','I will pick this up',COMMANDER);
  await turn(COMMANDER);
  await end(COMMANDER);
  await refreshCornerAttention(rootFixture.db,C);
  expect((await commanderFlags()).map(command=>command.id)).toEqual([first.id]);
  expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE reason='report'`)).rows).toHaveLength(1);
});


it.each(['hold','owed','expiry'] as const)('IDLE-DERIVED: ending a %s opens an episode without a worker turn', async wait => {
  await refreshCornerAttention(rootFixture.db,C);
  const first = (await commanderFlags())[0]!;
  await rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`,[first.id]);
  if (wait === 'hold') await rootFixture.db.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,standing)
    VALUES($1,$2,'owner')`,[C,HUMAN]);
  if (wait === 'owed' || wait === 'expiry') {
    await post('derived-question','@owner Which scope?',WORKER);
    expect((await rootFixture.db.query('SELECT 1 FROM corner_owed WHERE corner_id=$1',[C])).rows.length).toBeGreaterThan(0);
  }
  await refreshCornerAttention(rootFixture.db,C);
  expect(await commanderFlags()).toHaveLength(0);
  if (wait === 'hold') await rootFixture.db.query('UPDATE corner_merge_holds SET released_at=clock_timestamp(),released_by=$2 WHERE corner_id=$1',[C,HUMAN]);
  if (wait === 'owed') await post('derived-answer','The narrow scope',HUMAN);
  if (wait === 'expiry') await rootFixture.db.query("UPDATE corner_owed SET expires_at=clock_timestamp()-interval '1 second' WHERE corner_id=$1",[C]);
  await Promise.all([refreshCornerAttention(rootFixture.db,C),refreshCornerAttention(rootFixture.db,C)]);
  const current = await commanderFlags();
  expect(current).toHaveLength(1);
  expect(current[0]!.id).not.toBe(first.id);
  expect((await rootFixture.db.query('SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2',[C,WORKER])).rows).toEqual([]);
});


it.each(['expired','removed','exhausted'] as const)('IDLE-DERIVED: a schedule ending (%s) alone does not reopen a reported episode', async ending => {
  await refreshCornerAttention(rootFixture.db,C);
  const first = (await commanderFlags())[0]!;
  await rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`,[first.id]);
  await rootFixture.db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,message,cadence,next_run_at,max_runs)
    VALUES(gen_random_uuid(),$1,$2,$3,$3,'Wait','{"kind":"interval","everySeconds":86400}',now()+interval '1 day',1)`,[WS,C,WORKER]);
  await refreshCornerAttention(rootFixture.db,C);
  expect(await commanderFlags()).toHaveLength(0);
  if (ending === 'removed') await rootFixture.db.query('DELETE FROM agent_schedules WHERE room_id=$1',[C]);
  if (ending === 'expired') await rootFixture.db.query("UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE room_id=$1",[C]);
  if (ending === 'exhausted') await rootFixture.db.query('UPDATE agent_schedules SET run_count=max_runs WHERE room_id=$1',[C]);
  await Promise.all([refreshCornerAttention(rootFixture.db,C),refreshCornerAttention(rootFixture.db,C)]);
  expect(await commanderFlags()).toHaveLength(0);
  expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE reason='report'`)).rows).toEqual([{id:first.id}]);
  await post('after-schedule','Continue',HUMAN);
  await refreshCornerAttention(rootFixture.db,C);
  expect(await commanderFlags()).toHaveLength(1);
});


it.each(['message','order','same-time order'] as const)('IDLE-DERIVED: a report resolution uses the first commander %s timestamp', async kind => {
  const { reportToCommander } = await import('./commander.js');
  const report = await reportToCommander(rootFixture.db,C,WORKER,'blocked: Choose the scope.');
  expect(await state()).toBe('waiting');
  await refreshCornerAttention(rootFixture.db,C);
  expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE private_payload->>'idleSince' IS NOT NULL`)).rows).toEqual([]);
  // Explicit past timestamps prove no deletion/refresh time is substituted.
  const at = new Date(Date.now()-60_000);
  await rootFixture.db.query('UPDATE agent_commands SET created_at=$2 WHERE id=$1',[report.id,kind === 'same-time order' ? at : new Date(at.getTime()-60_000)]);
  if (kind === 'message') await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
    VALUES('report-answer',$1,$2,'The narrow scope','message',$3)`,[ROOM,COMMANDER,at]);
  else await rootFixture.db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,private_payload,created_at,state)
    VALUES('report-answer',$1,$2,'report-answer','input','order','report-answer','report-answer',0,jsonb_build_object('kind','order','authorId',$3::text,'text','The narrow scope'),$4,'complete')`,[C,WORKER,COMMANDER,at]);
  const idleSince = async () => (await rootFixture.db.query<{idle_since:string}>(cornerIdleSql('$1'),[C])).rows[0]!.idle_since;
  expect(Number(await idleSince())).toBeCloseTo(at.getTime()/1000,3);
  await refreshCornerAttention(rootFixture.db,C);
  const first = (await commanderFlags()).filter(command=>command.source.body.includes('is idle'));
  expect(first).toHaveLength(1);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
    VALUES('later-commander-reply',$1,$2,'One more detail','message')`,[ROOM,COMMANDER]);
  expect(Number(await idleSince())).toBeCloseTo(at.getTime()/1000,3);
  await refreshCornerAttention(rootFixture.db,C);
  expect((await commanderFlags()).filter(command=>command.source.body.includes('is idle')).map(command=>command.id)).toEqual(first.map(command=>command.id));
});


it('IDLE-DERIVED: a human-directed report resolves from the message log once answered', async () => {
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($1::text)) WHERE id='opening-order'`,[HUMAN]);
  const { reportToCommander } = await import('./commander.js');
  const report = await reportToCommander(rootFixture.db,C,WORKER,'blocked: Which scope?');
  expect(await cornerReportWaiting(rootFixture.db, C)).toBe(true);
  const at = new Date(Date.now()-60_000);
  await rootFixture.db.query('UPDATE messages SET created_at=$2 WHERE id=$1',[report.id,new Date(at.getTime()-60_000)]);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
    VALUES('human-report-answer',$1,$2,'Narrow scope','message',$3)`,[ROOM,HUMAN,at]);
  expect(await cornerReportWaiting(rootFixture.db, C)).toBe(false);
  const row = (await rootFixture.db.query<{idle_since:string}>(cornerIdleSql('$1'),[C])).rows[0]!;
  expect(Number(row.idle_since)).toBeCloseTo(at.getTime()/1000,3);
});


it('IDLE-DERIVED: an owed item in the return Room resolves at its first answering message', async () => {
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card,created_at)
    VALUES('return-question',$1,$2,'@owner Which scope?','message',jsonb_build_object('sourceRoomId',$3::text),now()-interval '2 minutes')`,[ROOM,WORKER,C]);
  expect((await rootFixture.db.query('SELECT 1 FROM corner_owed WHERE corner_id=$1',[C])).rows).toHaveLength(1);
  const at = new Date(Date.now()-60_000);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
    VALUES('return-answer',$1,$2,'The narrow scope','message',$3)`,[ROOM,HUMAN,at]);
  expect((await rootFixture.db.query('SELECT 1 FROM corner_owed WHERE corner_id=$1',[C])).rows).toEqual([]);
  const idleSince = async () => (await rootFixture.db.query<{idle_since:string}>(cornerIdleSql('$1'),[C])).rows[0]!.idle_since;
  expect(Number(await idleSince())).toBeCloseTo(at.getTime()/1000,3);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
    VALUES('later-return-answer',$1,$2,'More context','message')`,[ROOM,HUMAN]);
  expect(Number(await idleSince())).toBeCloseTo(at.getTime()/1000,3);
  await rootFixture.db.query(`UPDATE messages SET deleted_at=now() WHERE id IN ('return-answer','later-return-answer')`);
  expect((await rootFixture.db.query(cornerOwedAnswerTimesSql('$1'),[C])).rows).toEqual([]);
});


it('IDLE-DERIVED: pending checks invalidate deferred delivery and a cached claim', async () => {
  await turn(); await end();
  await refreshCornerAttention(rootFixture.db,C);
  const pending = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM agent_commands WHERE reason='report'`)).rows[0]!;
  await ci('pending');


  expect(await commanderFlags()).toHaveLength(0);
  await expect(rootFixture.daemon.execute('claimAgentCommand',{roomId:C,commandId:pending.id,generationId:'ci-idle'},COMMANDER)).rejects.toThrow();
  await refreshCornerAttention(rootFixture.db,C);
  expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE reason='report' AND state='pending'`)).rows).toEqual([]);
});


it('IDLE-DERIVED: the attention schema reruns with no span table or maintenance', async () => {
  await rootFixture.db.query(CORNER_ATTENTION_SCHEMA);
  await turn(); await end();
  await post('retired-span-human','Continue',HUMAN);
  await ci('pending');
  await refreshCornerAttention(rootFixture.db,C);
  expect((await rootFixture.db.query(`SELECT to_regclass('corner_attention_spans') IS NULL gone`)).rows[0]).toEqual({ gone: true });
  expect((await rootFixture.db.query(`SELECT proname FROM pg_proc WHERE proname IN (
    'corner_attention_push','corner_attention_human','corner_state_changed')`)).rows).toEqual([]);
});


it('IDLE-DERIVED: CI completion emits an immediate idle signal when no work remains', async () => {
  await turn();await end();
  await ci('pending');await refreshCornerAttention(rootFixture.db,C);
  await ci('failing');await refreshCornerAttention(rootFixture.db,C);
  expect(await state()).toBe('idle');
  expect(await commanderFlags()).toHaveLength(1);
  const pending=(await rootFixture.db.query(`SELECT id FROM agent_commands WHERE reason='report' AND state='pending'`)).rows;
  expect(pending).toHaveLength(1);
});


it('IDLE-SCOPE: another corner’s answered report never changes this corner’s idle episode', async () => {
  const other = '44444444-4444-4444-8444-444444444444';
  const idleSince = async () => (await rootFixture.db.query<{ idle_since: string }>(cornerIdleSql('$1'), [C])).rows[0]!.idle_since;
  const before = await idleSince();
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$2,$3,'Unrelated corner',$4)`, [other, WS, ROOM, COMMANDER]);
  await insertCornerFacts(rootFixture.db, { cornerId: other, ownerAgentId: WORKER, workerAgentId: WORKER });
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at)
    VALUES($1,$2,$3,'blocked: Choose a scope.',
      jsonb_build_object('sourceRoomId',$4::text,'reportToId',$5::text,'waitingAnswered',true),now()-interval '2 minutes')`,
    ['e'.repeat(64), ROOM, WORKER, other, COMMANDER]);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    VALUES($1,$2,$3,'Proceed with that scope.',now()-interval '1 minute')`, ['f'.repeat(64), ROOM, COMMANDER]);
  expect(await idleSince()).toBe(before);
  await rootFixture.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [other]);
  expect((await rootFixture.db.query(cornerIdleSql('$1'), [other])).rows).toEqual([]);
  expect(await idleSince()).toBe(before);
});
