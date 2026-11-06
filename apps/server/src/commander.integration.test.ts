import { readCornerObjective, SYSTEM_IDENTITY_ID, AgentScheduleLoop, advanceCorner, randomUUID, randomBytes, describe, expect, it, vi, insertCornerFacts, DaemonService, LiveHub, GitHubOperations, createAgentCommand, GITHUB_SUBJECT, systemLine, unreadMessageSql, HUMAN, RUBY, WORKER, WS, ROOM, DM, db, daemon, phone, order, claim, authority, commands, open, worker, rootFixture, fixtureScope1, type CommandRow, type GitHubAppClient, type GitHubOAuthClient } from './commander.integration.test-support.js';


it('opens in an unrelated member Room from a DM and records the caller as commander', async () => {
  const opened = await open();
  expect((await rootFixture.db.query(`SELECT parent_id,created_by FROM rooms WHERE id=$1`, [opened.cornerId])).rows[0])
    .toMatchObject({ parent_id: ROOM, created_by: RUBY });
  expect((await commands(opened.cornerId, WORKER))[0]).toMatchObject({ private: true,
    source: { authorId: RUBY, body: 'Build the widget' } });
  expect(opened.watch?.kinds).toEqual(['opened', 'merged']);
});

it.each(['opening key', 'request fallback'])(
  'PROVENANCE-REPLAY reuses the active corner through %s', async provenance => {
    const key = provenance === 'request fallback' ? rootFixture.order.turnRequestId : 'stable-open-key';
    const input = { ...authority(rootFixture.order), targetRoomId: ROOM, idempotencyKey: key,
      name: 'Widget', objective: 'Build the widget', implementer: 'worker',
      brief: { spec: 'Build the widget', repositoryWork: false,
        approval: { sourceMessageId: rootFixture.order.sourceMessageId } },
    };
    const first = await rootFixture.daemon.execute('createCorner', input, RUBY);
    expect((await rootFixture.db.query(`SELECT private_payload->>'openKey' key FROM agent_commands
      WHERE room_id=$1 AND reason='corner_objective'`, [first.cornerId])).rows[0]?.key).toBe(key);
    if (provenance !== 'opening key')
      await rootFixture.db.query(`UPDATE agent_commands SET private_payload=private_payload-'openKey'
        WHERE room_id=$1 AND reason='corner_objective'`, [first.cornerId]);
    expect(await rootFixture.daemon.execute('createCorner', input, RUBY)).toEqual(first);
    await expect(rootFixture.daemon.execute('createCorner', { ...input, objective: 'Different work' }, RUBY))
      .rejects.toThrow('different assignment');
    expect(await rootFixture.daemon.execute('getRequestCompletion', { roomId: ROOM,
      requestId: rootFixture.order.turnRequestId }, RUBY)).toMatchObject({ openedCornerId: first.cornerId });
    expect((await rootFixture.db.query(`SELECT count(*)::int count FROM rooms WHERE parent_id=$1`, [ROOM])).rows[0]?.count)
      .toBe(1);
  },
);


it('delivers blocked privately to Ruby and Ruby orders the current worker privately', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('report', { status: 'blocked', ...authority(turn), text: 'blocked: need an endpoint decision' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  expect(report).toMatchObject({ private: true, source: { authorId: WORKER, body: 'blocked: need an endpoint decision' } });
  await claim(report);
  await rootFixture.daemon.execute('order', { ...authority(report), address: opened.cornerId, text: 'Use endpoint v2' }, RUBY);
  expect((await commands(opened.cornerId, WORKER)).find(c => c.reason === 'order'))
    .toMatchObject({ private: true, source: { authorId: RUBY, body: 'Use endpoint v2' } });
  expect((await rootFixture.db.query(`SELECT text FROM messages WHERE text IN ($1,$2)`,
    ['blocked: need an endpoint decision', 'Use endpoint v2'])).rowCount).toBe(0);
});

it('records each corner order and report as one collapsed card in the corner only', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const before = (await rootFixture.db.query(`SELECT count(*)::int n FROM messages WHERE room_id=ANY($1::uuid[])`, [[ROOM, DM]])).rows[0]!.n;
  const unread = async () => (await rootFixture.db.query<{ n: number }>(
    `SELECT count(*)::int n FROM messages message WHERE message.room_id=$1 AND ${unreadMessageSql('message')}`,
    [opened.cornerId, HUMAN])).rows[0]!.n;
  const unreadBefore = await unread();
  const reportText = 'blocked: need an endpoint decision\nv1 or v2?';
  await rootFixture.daemon.execute('report', { status: 'blocked', ...authority(turn), text: reportText }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  expect(report).toMatchObject({ private: true, source: { authorId: WORKER, body: reportText } });
  await claim(report);
  await rootFixture.daemon.execute('order', { ...authority(report), address: opened.cornerId, text: 'Use endpoint v2' }, RUBY);
  expect((await commands(opened.cornerId, WORKER)).find(c => c.reason === 'order'))
    .toMatchObject({ private: true, source: { authorId: RUBY, body: 'Use endpoint v2' } });
  const cards = (await rootFixture.db.query<{ id: string; author_id: string; presentation: string; text: string; card: unknown }>(
    `SELECT id,author_id,presentation,text,card FROM messages WHERE room_id=$1 AND card_type='agent-command' ORDER BY created_at,id`,
    [opened.cornerId])).rows;
  expect(cards.map(({ id: _id, ...card }) => card)).toEqual(expect.arrayContaining([
    { author_id: WORKER, presentation: 'card', text: '@worker reported to @ruby · blocked',
      card: { kind: 'report', recipient: { id: RUBY, name: 'Ruby', handle: 'ruby' }, status: 'blocked', text: reportText, waitingAnswered: true } },
    { author_id: RUBY, presentation: 'card', text: '@ruby ordered @worker',
      card: { kind: 'order', recipient: { id: WORKER, name: 'Worker', handle: 'worker' }, text: 'Use endpoint v2' } },
  ]));
  expect(cards).toHaveLength(2);
  // The parent Room and the commander's DM gain nothing; the cards wake nobody.
  expect((await rootFixture.db.query(`SELECT count(*)::int n FROM messages WHERE room_id=ANY($1::uuid[])`, [[ROOM, DM]])).rows[0]!.n).toBe(before);
  expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE source_message_id=ANY($1::text[])`, [cards.map(card => card.id)])).rowCount).toBe(0);
  expect(await unread()).toBe(unreadBefore);
  const view = (await rootFixture.phone.readRoom(opened.cornerId, HUMAN))!.messages.filter(m => m.agentCommand);
  expect(view.map(m => [m.author.pubkey, m.agentCommand])).toEqual(expect.arrayContaining([
    [WORKER, { kind: 'report', recipient: { id: RUBY, name: 'Ruby', handle: 'ruby' }, status: 'blocked', text: reportText, waitingAnswered: true }],
    [RUBY, { kind: 'order', recipient: { id: WORKER, name: 'Worker', handle: 'worker' }, text: 'Use endpoint v2' }],
  ]));
});

it.each(['needs_decision: choose the product scope', 'needs-decision: choose the product scope', 'needs-decision: choose the product scope @captain'])('R1 delivers decision reports with the display prefix in the original DM: %s', async (inputText) => {
  const text = inputText.replace(/^needs_decision:/, 'needs-decision:');
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(turn), text: inputText, ask: 'Which product scope should we use?' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(report);
  await rootFixture.daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(report), text: inputText, ask: 'Which product scope should we use?' }, RUBY);
  const rows = (await rootFixture.db.query(`SELECT room_id,author_id,text,card FROM messages WHERE text=$1`,
    [text])).rows;
  expect(rows).toEqual([{ room_id: DM, author_id: RUBY, text, card: { ask: 'Which product scope should we use?', reportToId: HUMAN } }]);
  expect((await rootFixture.phone.readRoom(DM, HUMAN))?.messages.some(m => m.text === rows[0]!.text)).toBe(true);
});

it('chain of command: a corner agent cannot tag a person above its commander', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const text = '@captain Approve the reviewer-link fetch here?';
  await expect(rootFixture.daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId, text }, WORKER))
    .rejects.toThrow('@captain is not your direct commander. Your commander is @ruby in Captain and Ruby.');
  await expect(rootFixture.daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId, text: '@channel approve?' }, WORKER))
    .rejects.toThrow('not your direct commander');
  await expect(rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text }, WORKER))
    .rejects.toThrow('not your direct commander');
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text=$1`, [text])).rowCount).toBe(0);
  // The same ask goes up by report, and Ruby asks the Captain where the Captain gave the order.
  await rootFixture.daemon.execute('report', { status: 'needs_decision', ...authority(turn), text: 'needs-decision: Approve the reviewer-link fetch?' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(report);
  await rootFixture.daemon.execute('report', { status: 'needs_decision', ...authority(report), text: 'needs-decision: Approve the reviewer-link fetch?' }, RUBY);
  const tray = await rootFixture.phone.execute('readNeedsYou', { workspaceId: WS }, HUMAN);
  expect(tray.items.map(item => [item.roomId, item.text])).toEqual([[DM, 'Approve the reviewer-link fetch?']]);
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%@captain%'`, [opened.cornerId])).rowCount).toBe(0);
});

it('chain of command: a corner agent may tag the person who directed this turn', async () => {
  const opened = await open();
  await worker(opened.cornerId);
  await rootFixture.phone.execute('sendRoomMessage', { roomId: opened.cornerId, messageId: randomBytes(32).toString('hex'), text: '@worker which endpoint did you pick?' }, HUMAN);
  const asked = (await commands(opened.cornerId, WORKER)).find(c => c.reason !== 'order' && c.source.authorId === HUMAN)!;
  await claim(asked);
  const reply = await rootFixture.daemon.execute('postRoomMessage', { ...authority(asked), text: '@captain v2. Keep it?' }, WORKER);
  expect((await rootFixture.db.query(`SELECT room_id FROM messages WHERE id=$1`, [reply.id])).rows[0]?.room_id).toBe(opened.cornerId);
});

it('uses terminal status to deliver the canonical prefix and preserves the body', async () => {
  const result=await rootFixture.daemon.execute('report',{...authority(rootFixture.order),status:'blocked',text:'done: choose scope'},RUBY);
  expect((await rootFixture.db.query(`SELECT text FROM messages WHERE id=$1`,[result.id])).rows)
    .toEqual([{text:'blocked: choose scope'}]);
});

it('accepts needs-decision without an ask and validates optional asks', async () => {
  await expect(rootFixture.daemon.execute('report', { status: 'needs_decision', ...authority(rootFixture.order), text: 'needs-decision: pick scope', ask: '**Which scope?**' }, RUBY)).rejects.toThrow('plain text');
  const reported = await rootFixture.daemon.execute('report', { status: 'needs_decision', ...authority(rootFixture.order), text: 'needs-decision: Which scope should we use? @captain' }, RUBY);
  expect((await rootFixture.phone.execute('readNeedsYou', { workspaceId: WS }, HUMAN)).items.find(item => item.messageId === reported.id)?.text).toBe('Which scope should we use?');
});

it('nested Room orders forward reports one commander at a time before reaching the human', async () => {
  const otherRoom = randomUUID();
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Agent work',$3)`, [otherRoom, WS, HUMAN]);
  for (const agent of [RUBY, WORKER]) await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [WS, otherRoom, agent]);
  await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: ROOM, agent: WORKER, text: 'Run the project' }, RUBY);
  const managerOrder = (await commands(ROOM, WORKER)).find(c => c.reason === 'order')!;
  await claim(managerOrder);
  await rootFixture.daemon.execute('order', { ...authority(managerOrder), address: otherRoom, agent: RUBY, text: 'Decide the project scope' }, WORKER);
  const childOrder = (await commands(otherRoom, RUBY)).find(c => c.reason === 'order')!;
  await claim(childOrder);
  const text = 'needs-decision: select the final scope';
  await rootFixture.daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(childOrder), text, ask: 'Which product scope should we use?' }, RUBY);
  const managerReport = (await commands(ROOM, WORKER)).find(c => c.reason === 'report')!;
  await claim(managerReport);
  await rootFixture.daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(managerReport), text, ask: 'Which product scope should we use?' }, WORKER);
  const rubyReport = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  expect(rubyReport).toMatchObject({ private: true, source: { authorId: WORKER, body: text } });
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text=$1`, [text])).rowCount).toBe(0);
  await claim(rubyReport);
  await rootFixture.daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(rubyReport), text, ask: 'Which product scope should we use?' }, RUBY);
  expect((await rootFixture.db.query(`SELECT room_id,author_id FROM messages WHERE text=$1`, [text])).rows)
    .toEqual([{ room_id: DM, author_id: RUBY }]);
});

it('a real GitHub merge webhook wakes Ruby once through the corner lifecycle', async () => {
  const opened = await open();
  const branch = `feature/corner-${opened.cornerId.replaceAll('-', '').slice(0, 12)}`;
  await rootFixture.db.query(`UPDATE rooms SET repository_key='owner/widgets' WHERE id=$1`, [ROOM]);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [opened.cornerId, JSON.stringify({ lifecycle: 'in-review', checks: 'passing',
      pr: { number: 42, url: 'https://github.com/owner/widgets/pull/42', headSha: '9'.repeat(40), targetBranch: 'main' } })]);
  await rootFixture.db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
    VALUES(77,$1,'42','owner','User','selected','active') ON CONFLICT DO NOTHING`, [HUMAN]);
  await rootFixture.db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
    VALUES(101,77,'owner/widgets','main') ON CONFLICT DO NOTHING`);
  await rootFixture.db.query(`UPDATE rooms SET github_installation_id=77 WHERE id=$1`, [ROOM]);
  const github = new GitHubOperations(rootFixture.db, {} as GitHubOAuthClient,
    { deleteBranch: vi.fn(async () => undefined) } as unknown as GitHubAppClient, 'secret');
  await github.processWebhook('pull_request', {
    installation: { id: 77 },
    action: 'closed', repository: { id: 101, full_name: 'owner/widgets' },
    pull_request: { number: 42, title: 'Widget', html_url: 'https://github.com/owner/widgets/pull/42',
      merged: true, merge_commit_sha: '8'.repeat(40), head: { ref: branch, sha: '9'.repeat(40) },
      base: { ref: 'main' } },
  });
  const mergeWakes = (await commands(DM, RUBY)).filter(c => c.reason === 'watched_corner' && c.source.body.includes('merged'));
  expect(mergeWakes).toHaveLength(1);
  expect(mergeWakes[0]!.private).toBe(true);
});

it('a configured reviewer can record PASS from its DM without changing the reviewer gate', async () => {
  const github = new GitHubOperations(rootFixture.db, {} as GitHubOAuthClient, {} as GitHubAppClient, 'secret');
  vi.spyOn(github, 'assertCornerReviewerNotAuthor').mockResolvedValue(undefined);
  Object.assign(rootFixture.daemon, { github });
  const opened = await open(), headSha = '9'.repeat(40);
  await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, RUBY]);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [opened.cornerId,
    JSON.stringify({ lifecycle: 'in-review', checks: 'passing', pr: { number: 42, headSha } })]);
  await advanceCorner(rootFixture.db, opened.cornerId, { kind: 'push', contents: { headSha } });
  await systemLine(rootFixture.db, { roomId: opened.cornerId, authorId: WORKER, subject: GITHUB_SUBJECT,
    verb: 'passed checks', kind: 'check-passed' });
  await expect(rootFixture.daemon.execute('approveCornerMerge', { ...authority(rootFixture.order), cornerId: opened.cornerId, headSha }, RUBY))
    .resolves.toMatchObject({ status: 'approved' });
  await expect(rootFixture.daemon.execute('approveCornerMerge', { cornerId: opened.cornerId, headSha }, WORKER))
    .rejects.toThrow('configured reviewer');
});

it.each(['@ruby', RUBY, '@opener', '@captain', undefined] as const)('Reproduction R1: a scheduled report uses explicit recipient %s and preserves the default', async to => {
  const opener = '8'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Opener','opener') ON CONFLICT DO NOTHING`, [opener]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [opener, HUMAN]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`, [WS, opener]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, ROOM, opener]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, DM, opener]);
  const opened = await open();
  await rootFixture.db.query(`UPDATE rooms SET created_by=$2 WHERE id=$1`, [opened.cornerId, opener]);
  const initial = await worker(opened.cornerId);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(initial), agentId: WORKER, status: 'complete' }, WORKER);
  await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: opened.cornerId, text: 'Watch the release and report back' }, RUBY);
  const assigned = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'order')!;
  await claim(assigned);
  const schedule = await rootFixture.daemon.execute('createAgentSchedule', { ...authority(assigned), title: 'Check release',
    prompt: 'Finish watching the release', cadence: { kind: 'interval', everyMinutes: 1 }, maxRuns: 1 }, WORKER);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(assigned), agentId: WORKER, status: 'complete' }, WORKER);
  await rootFixture.db.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1`, [schedule.scheduleId]);
  expect(await new AgentScheduleLoop(rootFixture.db).runOnce()).toBe(1);
  const wake = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'schedule')!;
  await claim(wake);
  for (const invalid of ['@missing']) {
    await expect(rootFixture.daemon.execute('report', { ...authority(wake), to: invalid, status: 'done', text: 'done: release finished' }, WORKER))
      .rejects.toThrow('current member handle or id');
  }
  expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE reason='report'`)).rows).toEqual([]);
  await expect(rootFixture.daemon.execute('report', { ...authority(wake), to, status: 'done', text: 'done: release finished' }, WORKER))
    .resolves.toMatchObject({ delivered: true });
  if (to === '@captain') {
    expect((await rootFixture.db.query(`SELECT text FROM messages WHERE room_id=$1 AND text=$2`, [opened.cornerId, 'done: release finished'])).rows)
      .toEqual([{ text: 'done: release finished' }]);
  } else {
    const recipient = to === '@opener' || !to ? opener : RUBY;
    const returnRoom = to === '@opener' ? opened.cornerId : DM;
    expect((await commands(returnRoom, recipient)).filter(c => c.reason === 'report'))
      .toEqual([expect.objectContaining({ source: expect.objectContaining({ body: 'done: release finished', authorId: WORKER }) })]);
    expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE agent_id=$1 AND reason='report'`, [recipient === RUBY ? opener : RUBY])).rows).toEqual([]);
  }
  if (to === '@ruby' || to === RUBY) await expect(rootFixture.daemon.execute('report', { ...authority(wake), to, status: 'done', text: 'done: release finished' }, WORKER))
    .rejects.toThrow('command output authority rejected');

});

it('report to answers the latest human command from a later system wake', async () => {
  const opened = await open(), initial = await worker(opened.cornerId);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(initial), agentId: WORKER, status: 'complete' }, WORKER);
  const messageId = randomBytes(32).toString('hex');
  await rootFixture.phone.execute('sendRoomMessage', { roomId: opened.cornerId, messageId, text: '@worker finish my check' }, HUMAN);
  const directed = (await commands(opened.cornerId, WORKER)).find(c => c.sourceMessageId === messageId)!;
  await claim(directed);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(directed), agentId: WORKER, status: 'complete' }, WORKER);
  await systemLine(rootFixture.db, { roomId: opened.cornerId, authorId: HUMAN, subject: { kind: 'system', name: 'Scheduler' },
    verb: 'ran a schedule', kind: 'schedule-ran', wakes: [WORKER] });
  const wake = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'schedule')!;
  await claim(wake);
  await expect(rootFixture.daemon.execute('report', { ...authority(wake), to: '@captain', status: 'done', text: 'done: human check finished' }, WORKER))
    .resolves.toMatchObject({ delivered: true });
  expect((await rootFixture.db.query(`SELECT report_outcome FROM agent_commands WHERE id=$1`, [directed.id])).rows[0])
    .toMatchObject({ report_outcome: 'done' });
});

it.each([false, true])('REPORT-RETURN-403: scheduled completion uses opening commander and enforces revocation=%s', async (revoked) => {
  const opened = await open();
  const initial = await worker(opened.cornerId);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(initial), agentId: WORKER, status: 'complete' }, WORKER);
  await rootFixture.db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at)
    VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":1}', 'Finish assigned work',1,now()-interval '1 minute')`,
    [randomUUID(), WS, opened.cornerId, WORKER]);
  expect(await new AgentScheduleLoop(rootFixture.db).runOnce()).toBe(1);
  const wake = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'schedule')!;
  expect(wake).toBeDefined();
  await claim(wake);
  if (revoked) await rootFixture.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [DM, RUBY]);
  const outcome = rootFixture.daemon.execute('report', { ...authority(wake), status: 'done', text: 'done: assigned work completed' }, WORKER);
  if (revoked) {
    await expect(outcome).rejects.toThrow('commander is no longer a member of the return address');
    expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE reason='report' AND private_payload->>'text'=$1`,
      ['done: assigned work completed'])).rows).toEqual([]);
  } else {
    await expect(outcome).resolves.toMatchObject({ delivered: true });
    const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ private: true, source: { authorId: WORKER, body: 'done: assigned work completed' } });
    expect((await rootFixture.db.query(`SELECT id FROM messages WHERE text=$1 AND presentation='message'`,
      ['done: assigned work completed'])).rows).toEqual([]);
  }
});

it('schedules, check events and chatter in the corner never wake a watcher', async () => {
  const opened = await open();
  const before = (await commands(DM, RUBY)).map(c => c.id);
  await rootFixture.db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at)
    VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":1}', 'Check the widget once',1,now()-interval '1 minute')`,
    [randomUUID(), WS, opened.cornerId, WORKER]);
  expect(await new AgentScheduleLoop(rootFixture.db).runOnce()).toBe(1);
  expect((await commands(opened.cornerId, WORKER)).some(c => c.reason === 'schedule')).toBe(true);
  await systemLine(rootFixture.db, { roomId: opened.cornerId, authorId: WORKER, subject: GITHUB_SUBJECT,
    verb: 'checked', kind: 'check-passed', object: 'the widget' });
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'corner chatter')`,
    [randomBytes(32).toString('hex'), opened.cornerId, WORKER]);
  expect((await commands(DM, RUBY)).map(c => c.id)).toEqual(before);
});

it('an ordered corner turn keeps live work and progress in the corner', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const before = (await rootFixture.db.query(`SELECT id FROM messages`)).rows.length;
  const live = new LiveHub(), seen: unknown[] = [];
  live.subscribeAll((event) => seen.push(event));
  const watched = new DaemonService(rootFixture.db, live);
  await watched.execute('postAgentDraft', { ...authority(turn), agentId: WORKER, turnId: turn.turnRequestId, text: 'live draft' }, WORKER);
  await watched.execute('postAgentActivity', { ...authority(turn), agentId: WORKER, requestId: turn.turnRequestId!,
    cornerActivityKey: '1:tool-0', activity: [{ kind: 'tool', title: 'Read widget.ts', operation: 'read', status: 'completed' }] }, WORKER);
  expect((await rootFixture.db.query(`SELECT room_id,presentation FROM messages WHERE author_id=$1`, [WORKER])).rows)
    .toEqual([{ room_id: opened.cornerId, presentation: 'activity' }]);
  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({ roomId: opened.cornerId, reason: 'activity' }),
  ]));
  expect(seen.every((event) => (event as { roomId?: string }).roomId === opened.cornerId)).toBe(true);
  // The corner screen reads this view while the turn runs.
  const corner = await rootFixture.phone.readRoom(opened.cornerId, HUMAN);
  const row = corner?.messages.find((message) => message.author.pubkey === WORKER);
  console.log('[R1] corner view while the ordered turn runs:', JSON.stringify(row?.activity));
  expect(row?.activity).toEqual([expect.objectContaining({ kind: 'tool', title: 'Read widget.ts' })]);
  await watched.execute('postRoomMessage', { ...authority(turn), text: 'private final output' }, WORKER);
  await watched.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete', completionKind: 'no-reply' }, WORKER);
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text='private final output'`)).rowCount).toBe(1);
  expect((await rootFixture.db.query(`SELECT id FROM messages`)).rows).toHaveLength(before + 2);
  expect((await commands(opened.cornerId, WORKER))).toEqual([]);
});

it('Reproduction quiet-final: private order prose keeps its return route without an invented status', async () => {
  await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: ROOM, agent: WORKER, text: 'Check the widget' }, RUBY);
  const turn = (await commands(ROOM, WORKER)).find(c => c.reason === 'order')!;
  await claim(turn);
  const before = (await rootFixture.db.query(`SELECT id FROM messages`)).rows;
  await rootFixture.daemon.execute('postAgentDraft', { ...authority(turn), agentId: WORKER, turnId: turn.turnRequestId, text: 'private draft' }, WORKER);
  await rootFixture.daemon.execute('postAgentActivity', { ...authority(turn), agentId: WORKER, requestId: turn.turnRequestId!,
    activity: [{ kind: 'tool', title: 'Read widget.ts', operation: 'read', status: 'completed' }] }, WORKER);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'private final output' }, WORKER);
  expect((await rootFixture.db.query(`SELECT id FROM messages`)).rows).toEqual(before);
  expect((await commands(DM, RUBY)).find(c => c.reason === 'report')?.source.body).toBe('private final output');
  console.info('Demonstrated quiet-final: ordered Room final text reaches commander unchanged, private, without done prefix');
});


it('Reproduction reported-stall: delivered done survives loss of terminal receipt', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: widget complete' }, WORKER);
  const { ConnectionPresence } = await import('./connection-presence.js');
  await rootFixture.db.query(`UPDATE agent_turns SET created_at=now()-interval '2 minutes' WHERE room_id=$1 AND request_id=$2`,
    [opened.cornerId, turn.turnRequestId]);
  const presence = new ConnectionPresence(rootFixture.db, new LiveHub());
  try {
    await presence.start();
    await vi.waitFor(async () => expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
      [opened.cornerId, turn.turnRequestId])).rows[0]?.status).toBe('complete'));
  } finally { await presence.stop(); }
  expect((await rootFixture.db.query(`SELECT status,failure_reason FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [opened.cornerId, turn.turnRequestId])).rows).toEqual([{ status: 'complete', failure_reason: null }]);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report').map(c => c.source.body))
    .toEqual(['done: widget complete']);
  expect((await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id])).rows)
    .toEqual([{ state: 'complete' }]);
  console.info('Demonstrated reported-stall: commander retains done; worker complete; no failure or retry');
});


it('Reproduction R1: elapsed time keeps work queued behind a claimed turn', async () => {
  const opened = await open();
  const running = (await commands(opened.cornerId, WORKER))[0]!;
  // The second wake arrives just before the first claim (the production race).
  const queued = await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: WORKER,
    sourceMessageId: null, reason: 'corner_background_tool',
    privatePayload: { kind: 'lifecycle', text: 'Background tool completed', authorId: SYSTEM_IDENTITY_ID, fromRoomId: opened.cornerId } });

  expect((await rootFixture.db.query(`SELECT generation_id FROM agent_turns WHERE request_id=$1`, [queued!.turn_request_id])).rows)
    .toEqual([{ generation_id: 'pending:' + queued!.id }]);
  await claim(running);
  await rootFixture.db.query(`UPDATE agent_turns SET created_at=now()-interval '2 minutes'
    WHERE room_id=$1 AND request_id=$2`, [opened.cornerId, queued!.turn_request_id]);
  expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [opened.cornerId, queued!.turn_request_id])).rows).toEqual([{status:'working'}]);
  expect((await rootFixture.db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%did not claim%'`,
    [opened.cornerId])).rows).toEqual([]);
  expect((await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [queued!.id])).rows)
    .toEqual([{ state: 'pending' }]);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(running), agentId: WORKER, status: 'complete' }, WORKER);
  const next = (await commands(opened.cornerId, WORKER)).find(command => command.id === queued!.id)!;
  expect(next).toBeDefined();
  await claim(next);
  expect((await rootFixture.db.query(`SELECT status,generation_id FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [opened.cornerId, next.turnRequestId])).rows).toEqual([{ status: 'working', generation_id: 'proof-generation' }]);
});


it.each([false,true])('queued corner work stays pending without a reachability notice (human commander: %s)',async humanCommander=>{
  const opened=await open();
  if(humanCommander)await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($1::text)) WHERE room_id=$2 AND agent_id=$3`,[HUMAN,opened.cornerId,WORKER]);
  await rootFixture.db.query("UPDATE agent_commands SET created_at=now()-interval '8 hours' WHERE room_id=$1",[opened.cornerId]);
  const before=(await rootFixture.db.query('SELECT id FROM messages ORDER BY id')).rows;
  const pending=await commands(opened.cornerId,WORKER);
  expect(pending).toHaveLength(1);
  expect((await commands(DM,RUBY)).filter(command=>command.reason==='report')).toEqual([]);
  expect((await rootFixture.db.query('SELECT id FROM messages ORDER BY id')).rows).toEqual(before);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[pending[0]!.id])).rows).toEqual([{state:'pending'}]);
});


it('reconnect recovery keeps every private report, even when each was queued offline', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const {reportToCommander}=await import('./commander.js');
  const source=(await rootFixture.db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1',[turn.id])).rows[0]!;
  for (const [index,text] of ['blocked: missing input', 'failed: build stopped', 'needs-decision: select scope'].entries())
    await reportToCommander(rootFixture.db,opened.cornerId,WORKER,text,source,`offline-report-${index}`,{ask:'Which product scope should we use?'});
  await rootFixture.db.query(`UPDATE agent_commands SET created_offline=true,created_at=now()-interval '10 minutes' WHERE reason='report'`);
  // Preserve causal order: the assignment preceded these offline reports.
  await rootFixture.db.query(`UPDATE agent_commands SET created_at=now()-interval '11 minutes' WHERE id=$1`, [turn.id]);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(3);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(3);
});

it('cross-Room reads work from a DM, while nonmembers get no data or order', async () => {
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('target-read',$1,$2,'Member history')`, [ROOM, HUMAN]);
  expect((await rootFixture.daemon.execute('read', { roomId: DM, address: ROOM }, RUBY)).items.map(m => m.body)).toContain('Member history');
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`, [RUBY, ROOM]);
  await expect(rootFixture.daemon.execute('read', { roomId: DM, address: ROOM }, RUBY)).rejects.toThrow('membership');
  await expect(rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: ROOM, text: 'Do this' }, RUBY)).rejects.toThrow('membership');
});

it('R-REVISE revises and restores the cited approval without a false reproduction warning', async () => {
  const opened = await open();
  await rootFixture.db.query(`UPDATE rooms SET repository_resolution='repository',repository_key='owner/repo' WHERE id=$1`, [ROOM]);
  const revision = await rootFixture.daemon.execute('reviseCornerBrief', { ...authority(rootFixture.order), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: '## Intent\nFix the reported endpoint bug.\n## Reproduction R-REVISE\nRevise the brief and restore it; the approval link disappears.', repositoryWork: true,
      approval: { sourceMessageId: rootFixture.order.sourceMessageId }, change: 'Clarify the endpoint' } }, RUBY);
  expect(revision.revision).toBe(2);
  expect(await readCornerObjective(rootFixture.db, opened.cornerId)).toBe('Build the widget');
  expect((await rootFixture.db.query(`SELECT objective FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision`, [opened.cornerId])).rows)
    .toEqual([{objective:'Build the widget'},{objective:'Build the widget'}]);
  const restored = await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, RUBY);
  expect(restored.brief?.approval?.sourceMessageId).toBe(rootFixture.order.sourceMessageId);
  expect(revision.warnings ?? []).toEqual([]);
});

it('Reproduction commander-direct: commander revises without a cited approval', async () => {
  const opened = await open();
  const revised = await rootFixture.daemon.execute('reviseCornerBrief', { ...authority(rootFixture.order), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: 'Build the clarified widget', change: 'Clarify scope' },
  }, RUBY);
  expect(revised.revision).toBe(2);
  const restored = await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, RUBY);
  expect(restored.brief?.approval).toMatchObject({ approvedBy: RUBY, approverName: 'Ruby' });
  const turn = await worker(opened.cornerId);
  await expect(rootFixture.daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId: opened.cornerId,
    expectedRevision: 2, brief: { spec: 'Worker changes scope', change: 'No cited approval' },
  }, WORKER)).rejects.toMatchObject({ status: 403 });
  expect((await rootFixture.db.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1 AND revision=2`,
    [opened.cornerId])).rows[0]).toMatchObject({ approval_basis: { kind: 'commander-direct', approvedBy: RUBY } });
});
describe('a worker records a later waiver in its corner brief', () => {
const scope1 = fixtureScope1();


  it('reuses the approval stored on the current revision', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const stored = await scope1.approval(opened.cornerId);
    const revised = await scope1.revise(turn, opened.cornerId, 1, stored.sourceMessageId as string);
    expect(revised.revision).toBe(2);
    expect(await scope1.approval(opened.cornerId)).toMatchObject({ kind: stored.kind, approvedBy: HUMAN,
      sourceMessageId: stored.sourceMessageId, snapshot: 'Build the widget in the target Room' });
  });


  it('accepts the owner\'s waiver from a DM with the worker', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await scope1.directMessage(HUMAN, HUMAN, 'Waive the proof for this corner.');
    expect((await scope1.revise(turn, opened.cornerId, 1, waiver)).revision).toBe(2);
    expect(await scope1.approval(opened.cornerId)).toMatchObject({ kind: 'explicit-human-answer', approvedBy: HUMAN,
      sourceMessageId: waiver, snapshot: 'Waive the proof for this corner.' });
  });


  it('HUMAN-01: a worker accepts any shared-Room human approval and announces the change', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WS, ROOM, scope1.STRANGER]);
    const outside = randomBytes(32).toString('hex');
    await rootFixture.phone.execute('sendRoomMessage', { roomId: ROOM, messageId: outside, text: 'Approved: waive the proof.' }, scope1.STRANGER);
    const revision = (sourceMessageId: string) => rootFixture.daemon.execute('reviseCornerBrief', {
      ...authority(turn), cornerId: opened.cornerId, expectedRevision: 1,
      brief: { spec: 'Build the widget; proof waived', repositoryWork: false, change: 'Record approval', approval: { sourceMessageId } },
    }, WORKER);
    expect(await revision(outside)).toMatchObject({ revision: 2 });
    expect(await scope1.approval(opened.cornerId)).toMatchObject({ approvedBy: scope1.STRANGER, sourceMessageId: outside });
    await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: '@ruby Recorded the proof waiver approved by Stranger.' }, WORKER);
    expect((await rootFixture.phone.readRoom(opened.cornerId, HUMAN))?.messages.some(m => m.text === '@ruby Recorded the proof waiver approved by Stranger.')).toBe(true);
    console.log('HUMAN-01: shared-Room member approval saved as revision 2 and announced in the corner');
  });


  it('refuses a stored approval when its human author is not a Room member', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const outside = randomBytes(32).toString('hex');
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Approved')`, [outside, ROOM, scope1.STRANGER]);
    // A stored snapshot does not substitute for current membership.
    await rootFixture.db.query(`UPDATE corner_brief_revisions SET approval_basis=approval_basis || $2::jsonb WHERE corner_id=$1`,
      [opened.cornerId, JSON.stringify({ kind: 'explicit-human-answer', sourceMessageId: outside, approvedBy: scope1.STRANGER, snapshot: 'Approved' })]);
    await expect(scope1.revise(turn, opened.cornerId, 1, outside)).rejects.toThrow('brief.approval.sourceMessageId');
    expect((await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, WORKER)).brief?.revision).toBe(1);
  });


  it('refuses a DM approval after the human membership is removed', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await scope1.directMessage(scope1.STRANGER, scope1.STRANGER, 'Waive the proof.');
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [scope1.rooms.get(waiver), scope1.STRANGER]);
    await expect(scope1.revise(turn, opened.cornerId, 1, waiver)).rejects.toThrow('current Room member');
  });


  it('refuses approval from an unrelated Room even when the human belongs to it', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await scope1.directMessage(scope1.STRANGER, scope1.STRANGER, 'Waive the proof.');
    await rootFixture.db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`, [scope1.rooms.get(waiver)]);
    await expect(scope1.revise(turn, opened.cornerId, 1, waiver)).rejects.toThrow('brief.approval.sourceMessageId');
  });


  it('accepts an earlier private order from the corner\'s commander', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: opened.cornerId, text: 'Skip the proof.' }, RUBY);
    const waiver = (await commands(opened.cornerId, WORKER)).find((command) => command.reason === 'order')!;
    expect((await scope1.revise(turn, opened.cornerId, 1, waiver.sourceMessageId)).revision).toBe(2);
    expect(await scope1.approval(opened.cornerId)).toMatchObject({ kind: 'commander-order', approvedBy: RUBY,
      sourceMessageId: waiver.sourceMessageId, snapshot: 'Skip the proof.' });
  });


  it('APPROVAL-CITATIONS: accepts the commander order card seen in the transcript', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: opened.cornerId, text: 'Use the revised endpoint.' }, RUBY);
    const card = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND card_type='agent-command' AND card->>'text'=$2`,
      [opened.cornerId, 'Use the revised endpoint.'])).rows[0]!;
    expect((await scope1.revise(turn, opened.cornerId, 1, card.id)).revision).toBe(2);
    const restored = await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, WORKER);
    expect(restored.brief?.approval).toMatchObject({ sourceMessageId: card.id, text: 'Use the revised endpoint.',
      approvedBy: RUBY, approverName: 'Ruby' });
  });


  it('APPROVAL-CITATIONS: accepts a parent Room human message from a worker DM turn', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const id = randomBytes(32).toString('hex');
    await rootFixture.phone.execute('sendRoomMessage', { roomId: ROOM, messageId: id, text: 'Use the revised endpoint.' }, HUMAN);
    expect((await scope1.revise(turn, opened.cornerId, 1, id)).revision).toBe(2);
    const restored = await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, WORKER);
    expect(restored.brief?.approval).toMatchObject({ sourceMessageId: id, text: 'Use the revised endpoint.',
      approvedBy: HUMAN, approverName: 'Captain' });
  });


  it.each(['complete', 'cancelled'])('APPROVAL-CITATIONS: refuses a %s commander order', async (state) => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const command = await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null,
      reason: 'order', privatePayload: { text: 'Skip proof.', authorId: RUBY, fromRoomId: ROOM, kind: 'order' } });
    await rootFixture.db.query(`UPDATE agent_commands SET state=$2 WHERE id=$1`, [command!.id, state]);
    await expect(scope1.revise(turn, opened.cornerId, 1, command!.id)).rejects.toThrow('brief.approval.sourceMessageId');
  });


  it('APPROVAL-CITATIONS: rejects reuse of a stored order after cancellation', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const command = await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null,
      reason: 'order', privatePayload: { text: 'Skip proof.', authorId: RUBY, fromRoomId: ROOM, kind: 'order' } });
    expect((await scope1.revise(turn, opened.cornerId, 1, command!.id)).revision).toBe(2);
    await rootFixture.db.query(`UPDATE agent_commands SET state='cancelled' WHERE id=$1`, [command!.id]);
    await expect(scope1.revise(turn, opened.cornerId, 2, command!.id)).rejects.toThrow('brief.approval.sourceMessageId');
  });


  it('APPROVAL-CITATIONS: stored approval does not authorize another agent as commander', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const command = await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null,
      reason: 'order', privatePayload: { text: 'Skip proof.', authorId: scope1.OUTSIDER, fromRoomId: ROOM, kind: 'order' } });
    await rootFixture.db.query(`UPDATE corner_brief_revisions SET approval_basis=$2::jsonb WHERE corner_id=$1`, [opened.cornerId,
      JSON.stringify({ kind: 'commander-order', sourceMessageId: command!.id, approvedBy: scope1.OUTSIDER, snapshot: 'Skip proof.' })]);
    await expect(scope1.revise(turn, opened.cornerId, 1, command!.id)).rejects.toThrow('brief.approval.sourceMessageId');
  });


  it('APPROVAL-CITATIONS: refuses an agent-authored parent Room message', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const id = randomBytes(32).toString('hex');
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Approved')`, [id, ROOM, RUBY]);
    await expect(scope1.revise(turn, opened.cornerId, 1, id)).rejects.toThrow('brief.approval.sourceMessageId');
  });


  it('HUMAN-01: accepts any human member approval in a DM shared with the worker', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await scope1.directMessage(scope1.STRANGER, scope1.STRANGER, 'Waive the proof for this corner.');
    expect((await scope1.revise(turn, opened.cornerId, 1, waiver)).revision).toBe(2);
    expect(await scope1.approval(opened.cornerId)).toMatchObject({ approvedBy: scope1.STRANGER, sourceMessageId: waiver });
  });


  it('HUMAN-01: accepts any human member approval from the worker\'s active DM turn', async () => {
    const opened = await open();
    const waiver = await scope1.directMessage(scope1.STRANGER, scope1.STRANGER, 'Waive the proof for this corner.');
    expect((await scope1.revise(await scope1.dmTurn(waiver), opened.cornerId, 1, waiver)).revision).toBe(2);
    expect(await scope1.approval(opened.cornerId)).toMatchObject({ approvedBy: scope1.STRANGER, sourceMessageId: waiver });
  });


  it('accepts the owner\'s waiver from the worker\'s active DM turn', async () => {
    const opened = await open();
    const waiver = await scope1.directMessage(HUMAN, HUMAN, 'Waive the proof for this corner.');
    expect((await scope1.revise(await scope1.dmTurn(waiver), opened.cornerId, 1, waiver)).revision).toBe(2);
    expect(await scope1.approval(opened.cornerId)).toMatchObject({ approvedBy: HUMAN, sourceMessageId: waiver });
  });


  it('refuses an agent\'s DM message that is not an order', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await scope1.directMessage(RUBY, RUBY, 'Waive the proof for this corner.');
    await expect(scope1.revise(turn, opened.cornerId, 1, waiver)).rejects.toThrow('brief.approval.sourceMessageId');
  });


  it('refuses a private order to the corner from an agent that is not its commander', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WS, ROOM, scope1.OUTSIDER]);
    const outside = await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null,
      reason: 'order', privatePayload: { text: 'Skip the proof.', authorId: scope1.OUTSIDER, fromRoomId: ROOM, kind: 'order' } });
    await expect(scope1.revise(turn, opened.cornerId, 1, outside!.id)).rejects.toThrow('brief.approval.sourceMessageId');
  });
});


it('prepares the first brief of a human-opened corner from a member DM', async () => {
  const opened = await rootFixture.phone.execute('createHumanCorner', { roomId: ROOM, title: 'Widget' }, HUMAN);
  await expect(rootFixture.daemon.execute('renameCorner', { ...authority(rootFixture.order), cornerId: opened.id,
    name: 'Prepared', objective: 'Build the widget',
    brief: { spec: 'Build the widget', repositoryWork: false, approval: { sourceMessageId: rootFixture.order.sourceMessageId } } }, RUBY))
    .resolves.toMatchObject({ name: 'Prepared' });
  expect(await readCornerObjective(rootFixture.db, opened.id)).toBe('Build the widget');
});

it('private order IDs authorize child briefs without storing private text as messages', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const child = await rootFixture.daemon.execute('createCorner', { ...authority(turn), requestId: turn.turnRequestId,
    targetRoomId: ROOM, idempotencyKey: 'child-order', name: 'Child', objective: 'Build a child widget',
    brief: { spec: 'Child widget', approval: { sourceMessageId: turn.sourceMessageId } } }, WORKER);
  expect((await rootFixture.db.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1`, [child.cornerId])).rows[0])
    .toMatchObject({ approval_basis: { kind: 'commander-order', approvedBy: RUBY, snapshot: 'Build the widget' } });
});

it('opening from a report resumes the original order instead of treating the report as approval', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: widget ready for the next step' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(report);
  const next = await rootFixture.daemon.execute('createCorner', { ...authority(report), targetRoomId: ROOM,
    name: 'Next', objective: 'Continue the assigned widget',
    brief: { spec: 'Continue the assigned widget', approval: { sourceMessageId: report.sourceMessageId } } }, RUBY);
  expect((await rootFixture.db.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1`, [next.cornerId])).rows[0])
    .toMatchObject({ approval_basis: { approvedBy: HUMAN, snapshot: 'Build the widget in the target Room' } });
});


it('a green head whose reviewer command cannot be queued reports the reason to its commander', async () => {
  const opened = await open();
  await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, RUBY]);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [opened.cornerId,
    JSON.stringify({ lifecycle: 'in-review', checks: 'passing', pr: { number: 42, headSha: '9'.repeat(40) } })]);
  await advanceCorner(rootFixture.db, opened.cornerId, { kind: 'push', contents: { headSha: '9'.repeat(40) } });
  await rootFixture.db.query(`CREATE FUNCTION refuse_review_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.reason IN ('subscribed_event','corner_review_dispatch') THEN RAISE EXCEPTION 'review dispatch unavailable'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER refuse_review_command BEFORE INSERT ON agent_commands FOR EACH ROW EXECUTE FUNCTION refuse_review_command()`);
  try {
    await systemLine(rootFixture.db, { roomId: opened.cornerId, authorId: WORKER, subject: GITHUB_SUBJECT,
      verb: 'passed checks', kind: 'check-passed' });
    const report = (await commands(DM, RUBY)).find(c => c.reason === 'report');
    expect(report?.source.body).toMatch(/^blocked:.*reviewer/);
    expect(report?.private).toBe(true);
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text LIKE '%restore review dispatch%'`)).rowCount).toBe(0);
  } finally {
    await rootFixture.db.query(`DROP TRIGGER refuse_review_command ON agent_commands; DROP FUNCTION refuse_review_command()`);
  }
});


// Reproduction corner-subtree-175524: replay the reported recruitment path.
it('Reproduction corner-subtree-175524: the reported named parent order succeeds', async () => {
  const cornerId = 'f95aa673-2eb5-491a-930b-51dc1aa2d2ee';
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$2,$3,'truthful-corner-states',$4)`, [cornerId, WS, ROOM, WORKER]);
  await insertCornerFacts(rootFixture.db, { cornerId: cornerId, ownerAgentId: WORKER });
  const opening = await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: WORKER,
    sourceMessageId: null, reason: 'corner_objective',
    privatePayload: { text: 'Make corner state truthful', authorId: RUBY, fromRoomId: DM, kind: 'order' } });
  const turn = (await commands(cornerId, WORKER)).find(c => c.id === opening!.id)!;
  await claim(turn);
  const before = (await rootFixture.db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows;
  // Exact production payload retrieved read-only from the 17:55:24 order.
  const text = "Read-only adversarial implementation review for Jellybean's active truthful-corner-states corner f95aa673-2eb5-491a-930b-51dc1aa2d2ee, brief revision 1. Do not edit, commit, push, open a corner, change implementer, or report to Ruby. Read its brief via inspect_corner; report findings to me through this order. Step 0 file map is posted there. Need concrete smallest implementation plan for PR1 durable idle flags (commander only, once per span, worker schedule/subscription exclusions, excluding commander watch), WAITING blockers and persistent 24h reminders with human dismissal using existing approval/tray authority. Identify exact indexed writer/read paths and tests; avoid per-read messages scans. Also assess executing brief's two separate PRs when first merge archives this corner and only feature/corner-f95aa6732eb5 is authorized: propose compliant sequence. Current corner worktree has uncommitted draft state edits only in packages/api-contract/src/corner-state.ts and apps/server/src/chat-corner-counts.ts; do not treat them as finished. Include problems plus specific solutions. Report back once with findings, not progress.";
  await expect(rootFixture.daemon.execute('order', { ...authority(turn), address: ROOM, text }, WORKER))
    .rejects.toThrow('a Room order must name exactly one agent');
  expect((await rootFixture.db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual(before);
  await rootFixture.daemon.execute('order', { ...authority(turn), address: ROOM, agent: RUBY, text }, WORKER);
  expect((await commands(ROOM, RUBY)).find(c => c.reason === 'order')?.source.body).toBe(text);
  console.log('[corner-subtree-175524] named parent Room order delivered privately; unnamed broadcast refused');
});
