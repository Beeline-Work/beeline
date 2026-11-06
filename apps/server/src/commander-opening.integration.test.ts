import { randomBytes, expect, it, HUMAN, RUBY, WORKER, ROOM, DM, rootFixture,
  authority, claim, commands, open, worker, createAgentCommand, type CommandRow } from './test-support-commander.integration.test-support.js';
import { commanderReportAddress } from './commander.js';

it.each((['Room', 'DM'] as const).flatMap(surface => (['blocked', 'needs_decision', 'failed', 'done'] as const).map(status => ({ surface, status }))))('opening commander $status escalation returns to the original $surface even from inside the corner', async ({ surface, status }) => {
  if (surface === 'Room') {
    const messageId = randomBytes(32).toString('hex');
    await rootFixture.phone.execute('sendRoomMessage', { roomId: ROOM, messageId, text: '@ruby Build the widget' }, HUMAN);
    rootFixture.order = (await commands(ROOM, RUBY)).find(command => command.sourceMessageId === messageId)!;
    await claim(rootFixture.order);
  }
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('report', { ...authority(turn), status: 'blocked', text: 'An endpoint decision is needed' }, WORKER);
  const sourceRoom = surface === 'Room' ? ROOM : DM;
  const handback = (await commands(sourceRoom, RUBY)).find(command => command.reason === 'report')!;
  expect(handback).toMatchObject({ private: true, source: { authorId: WORKER } });

  // The commander joins the corner to inspect the worker's blocker. Its
  // command's source is now here; that must not move the human return place.
  const messageId = randomBytes(32).toString('hex');
  await rootFixture.phone.execute('sendRoomMessage', { roomId: opened.cornerId, messageId, text: '@ruby inspect the blocker' }, HUMAN);
  const inspection = (await commands(opened.cornerId, RUBY)).find(command => command.sourceMessageId === messageId)!;
  await claim(inspection);
  const result = await rootFixture.daemon.execute('report', { ...authority(inspection), status, text: 'Choose the endpoint' }, RUBY);
  expect((await rootFixture.db.query(`SELECT room_id,card->>'reportToId' recipient FROM messages WHERE id=$1`, [result.id])).rows)
    .toEqual([{ room_id: sourceRoom, recipient: ['blocked', 'needs_decision'].includes(status) ? HUMAN : null }]);
  expect((await rootFixture.db.query(`SELECT id FROM messages WHERE room_id=$1 AND text=$2 AND presentation='message'`,
    [opened.cornerId, `${status.replace('_', '-')}: Choose the endpoint`])).rows).toEqual([]);
});

it('later human orders get ordinary replies here while escalations still go to the opening commander', async () => {
  const opened = await open(), initial = await worker(opened.cornerId);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(initial), agentId: WORKER, status: 'complete' }, WORKER);
  const messageId = randomBytes(32).toString('hex');
  await rootFixture.phone.execute('sendRoomMessage', { roomId: opened.cornerId, messageId, text: '@worker explain your endpoint choice' }, HUMAN);
  const turn = (await commands(opened.cornerId, WORKER)).find(command => command.sourceMessageId === messageId)!;
  await claim(turn);
  const reply = await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn),
    text: '@captain The endpoint requires a decision from the opening commander.' }, WORKER);
  expect((await rootFixture.db.query(`SELECT room_id FROM messages WHERE id=$1`, [reply.id])).rows).toEqual([{ room_id: opened.cornerId }]);
  expect((await commands(DM, RUBY)).filter(command => command.reason === 'report')).toEqual([]);
  const wake = await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null, reason: 'corner_check' });
  const resumed = (await commands(opened.cornerId, WORKER)).find(command => command.id === wake!.id)!;
  await claim(resumed);
  await rootFixture.daemon.execute('report', { ...authority(resumed), status: 'blocked', text: 'Choose the endpoint' }, WORKER);
  expect((await commands(DM, RUBY)).filter(command => command.reason === 'report'))
    .toEqual([expect.objectContaining({ source: expect.objectContaining({ authorId: WORKER, body: 'blocked: Choose the endpoint' }) })]);
  const saved = (await rootFixture.db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [turn.id])).rows[0];
  expect(await commanderReportAddress(rootFixture.db, opened.cornerId, saved))
    .toMatchObject({ recipient: RUBY, returnRoom: DM });
  expect(await commanderReportAddress(rootFixture.db, opened.cornerId))
    .toMatchObject({ recipient: RUBY, returnRoom: DM });
});

it('refuses an escalation tag to the human opener when their surface is elsewhere', async () => {
  const opened = await open();
  const command = await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: RUBY,
    sourceMessageId: null, reason: 'corner_check' });
  const turn = (await commands(opened.cornerId, RUBY)).find(turn => turn.id === command!.id)!;
  await claim(turn);
  await expect(rootFixture.daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId,
    text: '@captain Choose the endpoint' }, RUBY)).rejects.toThrow('Use report');
});

it.each([false, true])('nested corners report one step up even with opening parent removed=%s', async removed => {
  const outer = await open(), parentTurn = await worker(outer.cornerId);
  const child = await rootFixture.daemon.execute('createCorner', { ...authority(parentTurn), targetRoomId: ROOM,
    idempotencyKey: 'nested-opening', name: 'Nested', objective: 'Check the nested work', implementer: 'ruby',
    brief: { spec: 'Check the nested work', repositoryWork: false } }, WORKER);
  const assignment = (await commands(child.cornerId, RUBY)).find(command => command.reason === 'corner_objective')!;
  if (removed) await rootFixture.db.query(`UPDATE agent_commands SET parent_command_id=NULL WHERE id=$1`, [assignment.id]);
  const opener = (await rootFixture.db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [parentTurn.id])).rows[0]!;
  expect(await commanderReportAddress(rootFixture.db, child.cornerId, opener))
    .toMatchObject({ recipient: RUBY, returnRoom: DM });
  await claim(assignment);
  await rootFixture.daemon.execute('report', { ...authority(assignment), status: 'blocked', text: 'Nested decision needed' }, RUBY);
  const report = (await commands(outer.cornerId, WORKER)).find(command => command.reason === 'report')!;
  expect(report).toMatchObject({ private: true, source: { authorId: RUBY, body: 'blocked: Nested decision needed' } });
  expect((await commands(DM, RUBY)).filter(command => command.reason === 'report')).toEqual([]);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(parentTurn), agentId: WORKER, status: 'complete' }, WORKER);
  await claim(report);
  await rootFixture.daemon.execute('report', { ...authority(report), status: 'needs_decision', text: 'Nested decision needed' }, WORKER);
  expect((await commands(DM, RUBY)).find(command => command.reason === 'report'))
    .toMatchObject({ private: true, source: { authorId: WORKER, body: 'needs-decision: Nested decision needed' } });
});

it('a stale recipient field cannot redirect a worker report into the corner', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const result = await rootFixture.daemon.execute('report', { ...authority(turn), status: 'needs_decision',
    text: 'Choose the endpoint', to: '@captain' } as never, WORKER);
  expect((await commands(DM, RUBY)).find(command => command.id === result.id))
    .toMatchObject({ private: true, source: { authorId: WORKER, body: 'needs-decision: Choose the endpoint' } });
  expect((await rootFixture.db.query(`SELECT id FROM messages WHERE id=$1 AND presentation='message'`, [result.id])).rows).toEqual([]);
});
