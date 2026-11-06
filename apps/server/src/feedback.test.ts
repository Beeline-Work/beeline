import { describe, expect, it, SYSTEM_IDENTITY_ID, DAEMON_OPERATION_NAMES, feedbackConfigFromEnv, FEEDBACK_TRIAGE_PULL_SQL, groupFeedback, hasSystemReportMention, taggedIdentityIdsSql, PhoneService, ensureSystemIdentity, PERSON, OTHER, AGENT, TRIAGE, OUTSIDER, CREATOR, WORKSPACE, ROOM, CORNER, TRIAGE_CORNER, REPOSITORY, CONFIG, FIX_URL, merged, database, message, openTurn, daemon, report, items, rootFixture, fixtureScope3, fixtureScope5 } from './test-support-feedback.test-support.js';

describe('report_feedback (agent path)', () => {
  it('stores the item with room, trigger, request and prompt sections, in a Room and a corner', async () => {
    await message('earlier context');
    const inRoom = await report({
      category: 'tooling_gap',
      summary: 'No tool lists open corners by lane',
      tool_name: 'inspect_corner',
      promptSectionIds: ['core.identity', 'room.place'],
    });
    const inCorner = await report({ category: 'contradiction', summary: 'Rules disagree' }, CORNER);
    expect(inRoom).toMatchObject({ duplicate: false, itemId: expect.stringMatching(/^fb_/) });
    expect(inCorner.itemId).toMatch(/^fb_/);
    const stored = await items();
    expect(stored[0]).toMatchObject({
      source_kind: 'agent',
      room_id: ROOM,
      request_id: expect.stringMatching(/^request-/),
      prompt_section_ids: ['core.identity', 'room.place'],
    });
    expect(stored[0]!.message_ids[0]).toBe(stored[0]!.trigger_message_id);
    expect(stored[0]!.message_ids).toHaveLength(2);
    expect(stored[1]).toMatchObject({ room_id: CORNER });
  });


  it('Reproduction R1: stores the fifty-first distinct report through the daemon route', async () => {
    for (let index = 0; index < 50; index++) await report({ summary: `distinct problem ${index}` });
    const result = await report({ summary: 'fifty-first' });
    expect(result.duplicate).toBe(false);
    expect(await items()).toHaveLength(51);
    expect((await rootFixture.database.query('SELECT summary FROM feedback_items WHERE id=$1', [result.itemId])).rows)
      .toEqual([{ summary: 'fifty-first' }]);
  });


  it('Reproduction R1: bounds daily rows and keeps the latest overflow visible to triage', async () => {
    const first = await report({ summary: 'The grant card never resolves.' });
    for (let index = 1; index < 200; index++) await report({ summary: `distinct problem ${index}` });
    expect(await report({ summary: 'the GRANT card never resolves' }))
      .toEqual({ itemId: first.itemId, duplicate: true });
    const overflow = await report({ summary: 'overflow first', detail: 'first context' });
    await rootFixture.database.query("UPDATE feedback_items SET status='dismissed' WHERE id=$1", [overflow.itemId]);
    const latest = await report({ summary: 'overflow latest', detail: 'latest context', toolName: 'read' }, CORNER);
    expect(latest.itemId).toBe(overflow.itemId);
    expect(await items()).toHaveLength(201);
    const visible = await rootFixture.database.query(
      "SELECT summary,detail,occurrence_count,status,room_id,tool_name,occurrences FROM feedback_items WHERE status='new' AND id=$1",
      [overflow.itemId],
    );
    expect(visible.rows).toEqual([{
      summary: 'overflow latest', detail: 'latest context', occurrence_count: 2,
      status: 'new', room_id: CORNER, tool_name: 'read', occurrences: [],
    }]);
    // A separate agent retains its own allowance.
    expect((await report({ summary: 'another agent problem' }, ROOM, OUTSIDER)).duplicate).toBe(false);
    // Moving yesterday's rows out of today restores the ordinary daily allowance.
    await rootFixture.database.query("UPDATE feedback_items SET created_at=now()-interval '1 day' WHERE reporter_identity_id=$1", [AGENT]);
    const tomorrow = await report({ summary: 'new day problem' });
    expect(tomorrow.itemId).not.toBe(overflow.itemId);
    expect(tomorrow.duplicate).toBe(false);
  });


  it('Reproduction duplicate-cap: shares open items across agents without spending their cap', async () => {
    const first = await report({ summary: 'Grant card never resolves', toolName: 'request_grant' });
    const second = await report(
      { summary: 'GRANT card never resolves.', toolName: 'request_grant' },
      CORNER,
      OUTSIDER,
    );
    expect(second).toEqual({ itemId: first.itemId, duplicate: true });
    expect(await items()).toHaveLength(1);
    const counts = await rootFixture.database.query<{ occurrence_count: number; occurrences: unknown[] }>(
      'SELECT occurrence_count,occurrences FROM feedback_items WHERE id=$1',
      [first.itemId],
    );
    expect(counts.rows[0]!.occurrence_count).toBe(2);
    expect(counts.rows[0]!.occurrences).toEqual([
      expect.objectContaining({ agentId: OUTSIDER, roomId: CORNER, createdAt: expect.any(String) }),
    ]);
    for (let index = 0; index < 200; index++)
      await report({ summary: `other problem ${index}` }, ROOM, OUTSIDER);
    await expect(report({ summary: 'past safety ceiling' }, ROOM, OUTSIDER)).resolves.toMatchObject({ duplicate: false });
    await rootFixture.database.query(
      "UPDATE feedback_items SET created_at=now()-interval '2 hours', occurrences='[]', occurrence_count=1 WHERE id=$1",
      [first.itemId],
    );
    await expect(
      report({ summary: 'Grant card never resolves', toolName: 'request_grant' }, CORNER, OUTSIDER),
    ).resolves.toEqual(second);
    expect(
      (
        await rootFixture.database.query<{ occurrence_count: number }>(
          'SELECT occurrence_count FROM feedback_items WHERE id=$1',
          [first.itemId],
        )
      ).rows[0]!.occurrence_count,
    ).toBe(2);
    console.log(
      'Demonstrated Reproduction duplicate-cap: matching reports share one item with count 2; duplicate at cap succeeds; only new items spend cap',
    );
  });


  it('suppresses same-agent repeats for one hour and counts later occurrences on old open items', async () => {
    const first = await report({ summary: 'Same issue' });
    await report({ summary: 'Same issue' }, CORNER);
    expect(
      (await rootFixture.database.query('SELECT occurrence_count FROM feedback_items')).rows[0]!
        .occurrence_count,
    ).toBe(1);
    await rootFixture.database.query(
      "UPDATE feedback_items SET created_at=now()-interval '2 days' WHERE id=$1",
      [first.itemId],
    );
    expect(await report({ summary: 'Same issue' }, CORNER)).toEqual({
      itemId: first.itemId,
      duplicate: true,
    });
    await report({ summary: 'Same issue' });
    const stored = (
      await rootFixture.database.query(
        'SELECT occurrence_count,occurrences,last_occurrence_at FROM feedback_items',
      )
    ).rows[0]!;
    expect(stored.occurrence_count).toBe(2);
    expect(stored.occurrences).toHaveLength(1);
    expect(stored.last_occurrence_at).toBeTruthy();
  });


  it('keeps distinct tools, categories and terminal items separate', async () => {
    const first = await report({ summary: 'Same issue', toolName: 'read' });
    await report({ summary: 'Same issue', toolName: 'order' });
    await report({ summary: 'Same issue', toolName: 'read', category: 'tooling_gap' });
    await report({ summary: 'A different issue', toolName: 'read' });
    for (const status of ['resolved', 'dismissed', 'closed']) {
      await rootFixture.database.query('UPDATE feedback_items SET status=$2 WHERE id=$1', [
        first.itemId,
        status,
      ]);
      const next = await report({ summary: 'Same issue', toolName: 'read' });
      expect(next.duplicate).toBe(false);
      await rootFixture.database.query('DELETE FROM feedback_items WHERE id=$1', [next.itemId]);
    }
    expect(await items()).toHaveLength(4);
  });


  it('rejects secret-shaped values and unknown categories', async () => {
    await expect(
      report({ summary: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123' }),
    ).rejects.toThrow('secret-shaped');
    await expect(report({ category: 'human_report' })).rejects.toThrow('category must be one of');
    expect(await items()).toEqual([]);
  });
});
describe('@system and Report issue (human path)', () => {
  it('files a report for a standalone @system, never for code or quoted lines', () => {
    expect(hasSystemReportMention('@system the send button froze')).toBe(true);
    expect(hasSystemReportMention('this froze @System')).toBe(true);
    expect(hasSystemReportMention('run `@system` here')).toBe(false);
    expect(hasSystemReportMention('```\n@system\n```')).toBe(false);
    expect(hasSystemReportMention('> @system said so')).toBe(false);
    expect(hasSystemReportMention('mail me@system.test')).toBe(false);
  });


  it('turns an @system message into one human_report without membership, wake, or push', async () => {
    const phone = new PhoneService(rootFixture.database, 'http://local.test');
    for (let index = 0; index < 22; index++) await message(`context ${index}`, OTHER);
    const sent = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system the send button froze' },
      PERSON,
    );
    const [item] = await items();
    expect(item).toMatchObject({
      source_kind: 'human',
      trigger_message_id: sent.messageId,
      room_id: ROOM,
    });
    expect(item!.message_ids).toHaveLength(21);
    // The person's own report text rides the item, for the triage workflow.
    expect(item!.detail).toBe('@system the send button froze');
    // Pushes go to the identities a message tags; @system tags nobody.
    const side = await rootFixture.database.query<{ members: number; commands: number; tagged: string[] }>(
      `SELECT (SELECT count(*)::int FROM memberships WHERE identity_id=$1 AND room_id=$2) members,
              (SELECT count(*)::int FROM agent_commands WHERE source_message_id=$3) commands,
              ${taggedIdentityIdsSql('m')} tagged
       FROM messages m WHERE m.id=$3`,
      [SYSTEM_IDENTITY_ID, ROOM, sent.messageId],
    );
    expect(side.rows[0]).toEqual({ members: 0, commands: 0, tagged: [] });
    const view = await phone.readRoom(ROOM, OTHER);
    expect(view?.messages.find((row) => row.id === sent.messageId)?.feedbackReported).toBe(true);
    await phone.execute('sendRoomMessage', { roomId: ROOM, text: 'see `@system`' }, PERSON);
    expect(await items()).toHaveLength(1);
  });


  it('does not wake the agent of a DM when the message only reports to @system', async () => {
    const phone = new PhoneService(rootFixture.database, 'http://local.test');
    const dm = await phone.execute(
      'resolveDirectMessage',
      { workspaceId: WORKSPACE, participantId: AGENT },
      PERSON,
    );
    const reported = await phone.execute(
      'sendRoomMessage',
      { roomId: dm.id, text: '@system your tools keep timing out' },
      PERSON,
    );
    const commands = await rootFixture.database.query(
      `SELECT 1 FROM agent_commands WHERE source_message_id=$1`,
      [reported.messageId],
    );
    expect(commands.rowCount).toBe(0);
    expect((await items())[0]).toMatchObject({ trigger_message_id: reported.messageId });
  });


  it('files Report issue once per message with an optional note, refusing secrets', async () => {
    const phone = new PhoneService(rootFixture.database, 'http://local.test');
    const target = await message('the agent posted a broken card', AGENT);
    const first = await phone.execute(
      'reportMessageIssue',
      { roomId: ROOM, messageId: target, note: 'Card never rendered' },
      OTHER,
    );
    expect(first).toMatchObject({ duplicate: false, itemId: expect.stringMatching(/^fb_/) });
    await expect(
      phone.execute('reportMessageIssue', { roomId: ROOM, messageId: target }, PERSON),
    ).resolves.toEqual({ itemId: first.itemId, duplicate: true });
    const other = await message('another');
    await expect(
      phone.execute(
        'reportMessageIssue',
        { roomId: ROOM, messageId: other, note: 'AKIAABCDEFGHIJKLMNOP' },
        OTHER,
      ),
    ).rejects.toThrow('secret-shaped');
    const view = await phone.readRoom(ROOM, PERSON);
    expect(view?.messages.find((row) => row.id === target)?.feedbackReported).toBe(true);
    expect(view?.messages.find((row) => row.id === other)?.feedbackReported).toBeUndefined();
  });
});
describe('report versions', () => {
const scope3 = fixtureScope3();


  it('stores the helper version and harness the server already knows, and leaves the rest null', async () => {
    await rootFixture.database.query(`UPDATE agents SET harness='claude' WHERE agent_id=$1`, [AGENT]);
    await scope3.presence(AGENT, 'v0.1.94');
    const filed = await report({ summary: 'the socket dropped during send' });
    expect(await scope3.versions(filed.itemId)).toEqual({
      helper_version: 'v0.1.94',
      app_version: null,
      app_platform: null,
      harness: 'claude',
      harness_version: null,
    });
    await rootFixture.database.query(`UPDATE feedback_items SET created_at=now()-interval '2 hours' WHERE id=$1`, [filed.itemId]);
    await report({ summary: 'the socket dropped during send' });
    const later = (await rootFixture.database.query<{ occurrences: Array<{ helperVersion: string | null; harness: string | null; harnessVersion: string | null }> }>(
      `SELECT occurrences FROM feedback_items WHERE id=$1`,
      [filed.itemId],
    )).rows[0]!.occurrences;
    expect(later).toEqual([
      expect.objectContaining({ helperVersion: 'v0.1.94', harness: 'claude', harnessVersion: null }),
    ]);
  });


  it('stores null when the connection version or harness is not one the server understands', async () => {
    await rootFixture.database.query(`UPDATE agents SET harness='Claude Code' WHERE agent_id=$1`, [AGENT]);
    await scope3.presence(AGENT, 'latest');
    const filed = await report({ summary: 'unreadable connection version' });
    expect(await scope3.versions(filed.itemId)).toEqual({
      helper_version: null,
      app_version: null,
      app_platform: null,
      harness: null,
      harness_version: null,
    });
  });


  it('stores the app release and platform a person already reported, and leaves helper fields null', async () => {
    await scope3.runningUpdate(PERSON, scope3.PERSON_SESSION, 'phone', { platform: 'ios', releaseVersion: 'v0.1.94' });
    const phone = new PhoneService(rootFixture.database, 'http://local.test');
    const sent = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system the keyboard covers send' },
      PERSON,
      undefined,
      scope3.PERSON_SESSION,
    );
    const item = (await items()).find((row) => row.trigger_message_id === sent.messageId)!;
    expect(await scope3.versions(item.id)).toEqual({
      helper_version: null,
      app_version: 'v0.1.94',
      app_platform: 'ios',
      harness: null,
      harness_version: null,
    });
  });


  it('uses the reporting session when the person\'s other devices disagree', async () => {
    await scope3.runningUpdate(PERSON, scope3.PERSON_SESSION, 'phone', { platform: 'ios', releaseVersion: 'v0.1.90' });
    await scope3.runningUpdate(PERSON, scope3.OTHER_SESSION, 'tablet', { platform: 'ios', releaseVersion: 'v0.1.94' });
    const phone = new PhoneService(rootFixture.database, 'http://local.test');
    const sent = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system two phones disagree' },
      PERSON,
      undefined,
      scope3.PERSON_SESSION,
    );
    const item = (await items()).find((row) => row.trigger_message_id === sent.messageId)!;
    expect(await scope3.versions(item.id)).toEqual({
      helper_version: null,
      app_version: 'v0.1.90',
      app_platform: 'ios',
      harness: null,
      harness_version: null,
    });
  });


  it('does not copy an app installation onto a report filed by another client', async () => {
    await rootFixture.database.query(
      `INSERT INTO helper_release_notifications(singleton,version,sha) VALUES(true,'v0.1.94',$1)`,
      ['c'.repeat(40)],
    );
    const phone = new PhoneService(rootFixture.database, 'http://local.test');
    const external = { id: 'mcp-local-reviewer', name: 'Local MCP reviewer' };
    await scope3.runningUpdate(PERSON, scope3.PERSON_SESSION, '44444444-4444-4444-8444-444444444444', {
      platform: 'ios', releaseVersion: 'v0.1.94',
    });
    const externalReport = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system external client send failed' },
      PERSON,
      external,
      scope3.PERSON_SESSION,
    );
    const browserReport = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system browser send is broken' },
      PERSON,
    );
    const appReport = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system the keyboard covers send on this phone' },
      PERSON,
      undefined,
      scope3.PERSON_SESSION,
    );
    const externalIssue = await phone.execute(
      'reportMessageIssue',
      { roomId: ROOM, messageId: await message('card from another client') },
      PERSON,
      external,
      scope3.PERSON_SESSION,
    );
    const browserIssue = await phone.execute(
      'reportMessageIssue',
      { roomId: ROOM, messageId: await message('card from the browser') },
      PERSON,
    );
    const appIssue = await phone.execute(
      'reportMessageIssue',
      { roomId: ROOM, messageId: await message('card from this phone') },
      PERSON,
      undefined,
      scope3.PERSON_SESSION,
    );
    const stored = await items();
    const externalId = stored.find((row) => row.trigger_message_id === externalReport.messageId)!.id;
    const browserId = stored.find((row) => row.trigger_message_id === browserReport.messageId)!.id;
    const appId = stored.find((row) => row.trigger_message_id === appReport.messageId)!.id;
    const rows = (await rootFixture.database.query<{
      id: string;
      app_version: string | null;
      app_platform: string | null;
      app_is_latest: boolean | null;
      helper_version: string | null;
      harness: string | null;
      harness_version: string | null;
    }>(FEEDBACK_TRIAGE_PULL_SQL)).rows;
    const row = (id: string) => rows.find((item) => item.id === id)!;
    expect(row(externalId)).toMatchObject({
      app_version: null,
      app_platform: null,
      app_is_latest: null,
      helper_version: null,
      harness: null,
      harness_version: null,
    });
    expect(row(browserId)).toMatchObject({
      app_version: null,
      app_platform: null,
      app_is_latest: null,
    });
    expect(row(appId)).toMatchObject({
      app_version: 'v0.1.94',
      app_platform: 'ios',
      app_is_latest: true,
    });
    expect(await scope3.versions(externalIssue.itemId)).toEqual({
      helper_version: null,
      app_version: null,
      app_platform: null,
      harness: null,
      harness_version: null,
    });
    expect(await scope3.versions(browserIssue.itemId)).toEqual({
      helper_version: null,
      app_version: null,
      app_platform: null,
      harness: null,
      harness_version: null,
    });
    expect(await scope3.versions(appIssue.itemId)).toEqual({
      helper_version: null,
      app_version: 'v0.1.94',
      app_platform: 'ios',
      harness: null,
      harness_version: null,
    });
    const groups = groupFeedback(rows);
    expect(groups.find((group) => group.itemIds.includes(externalId))).toMatchObject({
      count: 0, humanCount: 0, eligible: false,
    });
    expect(groups.find((group) => group.itemIds.includes(browserId))).toMatchObject({
      count: 0, humanCount: 0, eligible: false,
    });
    expect(groups.find((group) => group.itemIds.includes(appId))).toMatchObject({
      count: 1, humanCount: 1, eligible: true,
    });
  });


  it('marks a report from an older helper not latest and a current one latest', async () => {
    await rootFixture.database.query(
      `INSERT INTO helper_release_notifications(singleton,version,sha) VALUES(true,'v0.1.94',$1)`,
      ['a'.repeat(40)],
    );
    await rootFixture.database.query(`UPDATE agents SET harness='codex' WHERE agent_id=$1`, [AGENT]);
    await scope3.presence(AGENT, 'v0.1.90');
    const older = await report({ summary: 'old helper dropped the socket' });
    await scope3.presence(AGENT, 'v0.1.94');
    const current = await report({ summary: 'current helper dropped the socket' });
    const quiet = await report({ summary: 'helper never announced a version' }, ROOM, OUTSIDER);
    await scope3.runningUpdate(PERSON, scope3.PERSON_SESSION, 'phone', { platform: 'android', releaseVersion: 'v0.1.90' });
    await scope3.runningUpdate(OTHER, scope3.OTHER_SESSION, 'phone', { platform: 'android', releaseVersion: 'v0.1.94' });
    const phone = new PhoneService(rootFixture.database, 'http://local.test');
    const oldApp = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system old app froze' },
      PERSON,
      undefined,
      scope3.PERSON_SESSION,
    );
    const newApp = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system current app froze' },
      OTHER,
      undefined,
      scope3.OTHER_SESSION,
    );
    const rows = (await rootFixture.database.query<{
      id: string;
      helper_version: string | null;
      helper_is_latest: boolean | null;
      app_version: string | null;
      app_is_latest: boolean | null;
      harness: string | null;
      harness_version: string | null;
      latest_released_version: string | null;
    }>(FEEDBACK_TRIAGE_PULL_SQL)).rows;
    const row = (id: string) => rows.find((item) => item.id === id)!;
    expect(row(older.itemId)).toMatchObject({
      helper_version: 'v0.1.90', helper_is_latest: false, harness: 'codex', harness_version: null, app_is_latest: null,
    });
    expect(row(current.itemId)).toMatchObject({ helper_version: 'v0.1.94', helper_is_latest: true });
    expect(row(quiet.itemId)).toMatchObject({ helper_version: null, helper_is_latest: null });
    const oldHuman = (await items()).find((item) => item.trigger_message_id === oldApp.messageId)!.id;
    const newHuman = (await items()).find((item) => item.trigger_message_id === newApp.messageId)!.id;
    expect(row(oldHuman)).toMatchObject({ app_version: 'v0.1.90', app_is_latest: false, helper_is_latest: null });
    expect(row(newHuman)).toMatchObject({ app_version: 'v0.1.94', app_is_latest: true });
    expect(row(current.itemId).latest_released_version).toBe('v0.1.94');
  });


  it('counts latest occurrences on a mixed-version item and leaves older reports out of eligibility', async () => {
    await rootFixture.database.query(
      `INSERT INTO helper_release_notifications(singleton,version,sha) VALUES(true,'v0.1.94',$1)`,
      ['b'.repeat(40)],
    );
    await rootFixture.database.query(`UPDATE agents SET harness='codex' WHERE agent_id=ANY($1::text[])`, [[AGENT, OUTSIDER, TRIAGE]]);
    const errorExcerpt = 'socket reset while sending';
    await scope3.presence(AGENT, 'v0.1.90');
    const older = await report({ summary: 'old helper lost the send', errorExcerpt, toolName: 'read' });
    await rootFixture.database.query(
      `UPDATE feedback_items SET occurrence_count=40, occurrences=$2::jsonb WHERE id=$1`,
      [older.itemId, JSON.stringify([{ helperVersion: 'v0.1.90', harness: 'codex', harnessVersion: null }])],
    );
    const mixed = await report({ summary: 'current and old helpers lost the send', errorExcerpt, toolName: 'read' });
    await rootFixture.database.query(`UPDATE feedback_items SET created_at=now()-interval '2 hours' WHERE id=$1`, [mixed.itemId]);
    await scope3.presence(OUTSIDER, 'v0.1.90');
    expect((await report(
      { summary: 'current and old helpers lost the send', errorExcerpt, toolName: 'read' },
      ROOM,
      OUTSIDER,
    )).itemId).toBe(mixed.itemId);
    await scope3.presence(TRIAGE, 'v0.1.94');
    expect((await report(
      { summary: 'current and old helpers lost the send', errorExcerpt, toolName: 'read' },
      ROOM,
      TRIAGE,
    )).itemId).toBe(mixed.itemId);
    await rootFixture.database.query(
      `UPDATE feedback_items SET created_at=now()-interval '3 hours',
         occurrences=(
           SELECT jsonb_agg(occurrence || jsonb_build_object('createdAt', now()-interval '3 hours'))
           FROM jsonb_array_elements(occurrences) occurrence
         )
       WHERE id=$1`,
      [mixed.itemId],
    );
    await scope3.presence(AGENT, 'v0.1.94');
    expect((await report({ summary: 'current and old helpers lost the send', errorExcerpt, toolName: 'read' })).itemId)
      .toBe(mixed.itemId);
    await scope3.runningUpdate(PERSON, scope3.PERSON_SESSION, 'phone', { platform: 'android', releaseVersion: 'v0.1.90' });
    await scope3.runningUpdate(OTHER, scope3.OTHER_SESSION, 'tablet', { platform: 'android', releaseVersion: 'v0.1.94' });
    const phone = new PhoneService(rootFixture.database, 'http://local.test');
    const oldApp = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system old app froze the composer' },
      PERSON,
      undefined,
      scope3.PERSON_SESSION,
    );
    const newApp = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system current app froze the composer' },
      OTHER,
      undefined,
      scope3.OTHER_SESSION,
    );
    const rows = (await rootFixture.database.query<Record<string, unknown>>(FEEDBACK_TRIAGE_PULL_SQL)).rows;
    const mixedRow = rows.find((item) => item.id === mixed.itemId)!;
    expect(mixedRow).toMatchObject({
      helper_version: 'v0.1.90',
      helper_is_latest: false,
      latest_released_version: 'v0.1.94',
      occurrence_count: 4,
    });
    const occurred = (mixedRow.occurrences as Array<{ helperVersion: string }>).map((item) => item.helperVersion);
    expect(occurred.filter((version) => version === 'v0.1.94')).toHaveLength(2);
    expect(occurred.filter((version) => version === 'v0.1.90')).toHaveLength(1);
    const groups = groupFeedback(rows);
    const agents = groups.find((group) => group.itemIds.includes(mixed.itemId))!;
    expect(agents.itemIds).toEqual(expect.arrayContaining([mixed.itemId, older.itemId]));
    expect(agents.count).toBe(2);
    expect(agents.agentCount).toBe(2);
    expect(agents.eligible).toBe(true);
    expect(agents.humanCount).toBe(0);
    expect(agents.versionReports.map((report) => report.id)).toEqual(expect.arrayContaining([mixed.itemId, older.itemId]));
    const stored = await items();
    const oldHumanId = stored.find((item) => item.trigger_message_id === oldApp.messageId)!.id;
    const newHumanId = stored.find((item) => item.trigger_message_id === newApp.messageId)!.id;
    expect(groups.find((group) => group.itemIds.includes(oldHumanId))).toMatchObject({
      count: 0, humanCount: 0, eligible: false, itemIds: [oldHumanId],
    });
    expect(groups.find((group) => group.itemIds.includes(newHumanId))).toMatchObject({
      count: 1, humanCount: 1, eligible: true, itemIds: [newHumanId],
    });
  });
});
describe('no triage tools or setting', () => {
  it('has no daemon route for the retired triage operations', () => {
    for (const retired of [
      'listFeedback',
      'getFeedback',
      'listFeedbackIssues',
      'fileFeedbackIssue',
      'attachFeedbackToIssue',
      'dismissFeedback',
      'setCornerFeedbackTriage',
    ])
      expect(DAEMON_OPERATION_NAMES.has(retired as never)).toBe(false);
    expect(DAEMON_OPERATION_NAMES.has('notifyFeedbackFixed')).toBe(true);
  });
});
describe('notify_feedback_fixed (close the loop)', () => {
const scope5 = fixtureScope5();


  it('resolves without a notice request, then sends only on a later explicit order', async () => {
    const { actionItem } = await scope5.reported();
    await expect(scope5.notify({ itemIds: [actionItem], notify: undefined })).resolves.toEqual({ resolved: 1, notified: 0 });
    expect(await scope5.fixedDms()).toEqual([]);
    expect((await rootFixture.database.query(`SELECT resolved_notified_at FROM feedback_items WHERE id=$1`, [actionItem])).rows)
      .toEqual([{ resolved_notified_at: null }]);
    await expect(scope5.notify({ itemIds: [actionItem] })).resolves.toEqual({ resolved: 0, notified: 1 });
    expect(await scope5.fixedDms()).toHaveLength(1);
    console.log('DM-1: merged feedback resolution creates zero System messages; explicit sender-rooted notice order creates one Fixed DM');
  });


  it('resolves a system-rooted sweep silently and refuses its opt-in notice', async () => {
    const { actionItem } = await scope5.reported();
    await ensureSystemIdentity(rootFixture.database);
    const turn = await openTurn(await message('scheduled feedback sweep', SYSTEM_IDENTITY_ID, TRIAGE_CORNER), TRIAGE_CORNER, TRIAGE);
    const input = { ...turn, itemIds: [actionItem], title: 'Slow tools', prUrl: FIX_URL };
    await expect(daemon().execute('notifyFeedbackFixed', input as never, TRIAGE)).resolves.toEqual({ resolved: 1, notified: 0 });
    expect(await scope5.fixedDms()).toEqual([]);
    await expect(daemon().execute('notifyFeedbackFixed', { ...input, notify: true } as never, TRIAGE)).rejects.toThrow('explicit order');
  });


  it('refuses opt-in notices from another human root', async () => {
    const { actionItem } = await scope5.reported();
    const turn = await openTurn(await message('@sweeper notify', PERSON, TRIAGE_CORNER), TRIAGE_CORNER, TRIAGE);
    await expect(daemon().execute('notifyFeedbackFixed', { ...turn, notify: true, itemIds: [actionItem], title: 'Slow tools', prUrl: FIX_URL } as never, TRIAGE))
      .rejects.toThrow('explicit order');
    expect(await scope5.fixedDms()).toEqual([]);
  });


  it("has System DM each person who reported an item once, resolves agent items silently, and repeats nothing", async () => {
    const ids = Object.values(await scope5.reported());
    await expect(scope5.notify({ itemIds: ids })).resolves.toEqual({ resolved: 4, notified: 2 });
    expect((await items()).map((item) => item.status)).toEqual([
      'resolved',
      'resolved',
      'resolved',
      'resolved',
    ]);
    const dms = await scope5.fixedDms();
    expect(dms.map((dm) => dm.text)).toEqual([`Fixed: Slow tools ${FIX_URL}`, `Fixed: Slow tools ${FIX_URL}`]);
    // PERSON reported two items and owns the reporting agent: one DM. OTHER: one.
    expect(dms.flatMap((dm) => dm.participants).filter((id) => id !== SYSTEM_IDENTITY_ID).sort()).toEqual(
      [PERSON, OTHER].sort(),
    );
    await expect(scope5.notify({ itemIds: ids })).resolves.toEqual({ resolved: 0, notified: 0 });
    expect(await scope5.fixedDms()).toHaveLength(2);
  });


  it('sends no DM when only agent reports are fixed', async () => {
    const { agentItem } = await scope5.reported();
    await expect(scope5.notify({ itemIds: [agentItem] })).resolves.toEqual({ resolved: 1, notified: 0 });
    expect(await scope5.fixedDms()).toEqual([]);
  });


  it('refuses an agent whose owner is not a System sender, or a call outside its own turn', async () => {
    const { actionItem } = await scope5.reported();
    await expect(scope5.notify({ itemIds: [actionItem] }, AGENT, ROOM)).rejects.toThrow(
      'System DM access denied',
    );
    await expect(
      daemon().execute(
        'notifyFeedbackFixed',
        { roomId: TRIAGE_CORNER, itemIds: [actionItem], title: 'Slow tools', prUrl: FIX_URL } as never,
        TRIAGE,
      ),
    ).rejects.toThrow('command output authority rejected');
    await expect(
      daemon({ repository: REPOSITORY, systemSenders: [] }).execute(
        'notifyFeedbackFixed',
        {
          ...(await openTurn(await message('@sweeper notify', PERSON, TRIAGE_CORNER), TRIAGE_CORNER, TRIAGE)),
          itemIds: [actionItem],
          title: 'Slow tools',
          prUrl: FIX_URL,
        } as never,
        TRIAGE,
      ),
    ).rejects.toThrow('System DM access denied');
    expect((await items()).map((item) => item.status)).not.toContain('resolved');
    expect(await scope5.fixedDms()).toEqual([]);
  });


  it('leaves items a refused sender could not report for a later run by a System sender', async () => {
    const { taggedItem, actionItem } = await scope5.reported();
    await expect(scope5.notify({ itemIds: [taggedItem, actionItem] }, AGENT, ROOM)).rejects.toThrow(
      'System DM access denied',
    );
    expect((await items()).map((item) => item.status)).not.toContain('resolved');
    await expect(scope5.notify({ itemIds: [taggedItem, actionItem] })).resolves.toEqual({ resolved: 2, notified: 2 });
    expect(await scope5.fixedDms()).toHaveLength(2);
  });


  it('refuses a link outside the repository pulls, a multi-line or secret title, and unknown items', async () => {
    const { actionItem } = await scope5.reported();
    for (const prUrl of [
      'https://github.com/someone/else/pull/7',
      `https://github.com/${REPOSITORY}/issues/7`,
      `https://evil.test/${REPOSITORY}/pull/7`,
      `${FIX_URL}?next=https://evil.test`,
    ])
      await expect(scope5.notify({ itemIds: [actionItem], prUrl })).rejects.toThrow(
        `pr_url must be a pull request in ${REPOSITORY}`,
      );
    await expect(scope5.notify({ itemIds: [actionItem], title: 'Slow\nclick here' })).rejects.toThrow('one line');
    await expect(scope5.notify({ itemIds: [actionItem], title: 'x'.repeat(121) })).rejects.toThrow('one line');
    await expect(
      scope5.notify({ itemIds: [actionItem], title: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }),
    ).rejects.toThrow('secret-shaped');
    await expect(scope5.notify({ itemIds: [actionItem, 'fb_missing'] })).rejects.toThrow('unknown feedback item');
    await expect(scope5.notify({ itemIds: [] })).rejects.toThrow('item_ids must list');
    expect((await items()).map((item) => item.status)).not.toContain('resolved');
    expect(await scope5.fixedDms()).toEqual([]);
  });


  it('refuses a pull request GitHub does not report as merged, or when GitHub is not configured', async () => {
    const { actionItem } = await scope5.reported();
    rootFixture.merged.clear();
    await expect(scope5.notify({ itemIds: [actionItem] })).rejects.toThrow(`${FIX_URL} has not merged`);
    rootFixture.merged.add(7);
    await expect(
      daemon(CONFIG, null).execute(
        'notifyFeedbackFixed',
        {
          ...(await openTurn(await message('@sweeper notify', PERSON, TRIAGE_CORNER), TRIAGE_CORNER, TRIAGE)),
          itemIds: [actionItem],
          title: 'Slow tools',
          prUrl: FIX_URL,
        } as never,
        TRIAGE,
      ),
    ).rejects.toThrow('Beeline GitHub App is not configured');
    expect((await items()).map((item) => item.status)).not.toContain('resolved');
    expect(await scope5.fixedDms()).toEqual([]);
  });


  it('accepts the repository name in any case and links the configured spelling', async () => {
    const { actionItem } = await scope5.reported();
    await scope5.notify({ itemIds: [actionItem], prUrl: 'https://github.com/beeline-work/BEELINE/pull/7' });
    expect((await scope5.fixedDms()).map((dm) => dm.text)).toEqual([`Fixed: Slow tools ${FIX_URL}`]);
  });


  it('skips the DM for a reporter with no Workspace left', async () => {
    const { actionItem, taggedItem } = await scope5.reported();
    await rootFixture.database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [OTHER]);
    await expect(scope5.notify({ itemIds: [actionItem, taggedItem] })).resolves.toEqual({
      resolved: 2,
      notified: 1,
    });
  });
});
describe('feedback config', () => {
  it('defaults the repository and has no System sender unless configured', () => {
    expect(feedbackConfigFromEnv({})).toEqual({ repository: 'Beeline-Work/beeline', systemSenders: [] });
    expect(
      feedbackConfigFromEnv({
        BEELINE_FEEDBACK_REPOSITORY: 'o/r',
        BEELINE_SYSTEM_SENDERS: ` ${CREATOR}, ,${PERSON} `,
      }),
    ).toEqual({ repository: 'o/r', systemSenders: [CREATOR, PERSON] });
  });
});
