import { phoneFetch } from '../../../../tests/helpers/phone-operation.js';
import { cornerRequestSql } from '.././corner-opening.js';
import { cornerRunStateSql } from '.././corner-run.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cornerImplementerSql } from '.././corner-worker.js';
import { HelperDaemonService as DaemonService } from '.././test-fixtures/helper-daemon.js';
import { LiveHub } from '.././live.js';
import { MediaExpiryLoop } from '.././background.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: corner-briefs', () => {
const fixture = monolithFixture();


  it('prompts a conversation past one page with its newest rows, and recovers the objective from its oldest', async () => {
    // 250 ordered rows: row 1 is the parent-to-corner handoff the objective is
    // recovered from, and the newest rows are what a turn must be prompted with.
    const OBJECTIVE = [
      'Handoff from the parent Room: add a `--dry-run` flag to the importer CLI.',
      'It must print the plan it would apply and exit 0 without touching the database.',
      'Keep the existing default behaviour byte-for-byte when the flag is absent.',
    ].join(' ');
    const rowId = (index: number) =>
      createHash('sha256').update(`page-fixture-${index}`).digest('hex');
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let index = 1; index <= 250; index += 1) {
      // Heavy activity rows and human decisions ride the same page as ordinary
      // conversation, exactly as a long working Room carries them.
      const presentation = index % 25 === 0 ? 'system' : index % 3 === 0 ? 'activity' : 'message';
      await fixture.database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,activity,created_at)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,to_timestamp($7::bigint/1000.0))`,
        [
          rowId(index),
          ROOM,
          index % 2 === 0 ? HUMAN : AGENT,
          index === 1 ? OBJECTIVE : `row ${index}`,
          presentation,
          presentation === 'activity'
            ? JSON.stringify({
                calls: Array.from({ length: 12 }, (_, call) => ({ title: `call ${call}` })),
              })
            : null,
          base + index * 1000,
        ],
      );
    }
    const bodies = async (payload: unknown) =>
      (
        (await (await fixture.daemonOperation('getRoomConversation', payload)).json()) as {
          items: Array<{ body: string }>;
        }
      ).items.map((item) => item.body);

    // Before: the default read answered with rows 1..200 and the Room's final
    // 80 were rows 121..200. After: the default read is the newest page.
    const recent = await bodies({ roomId: ROOM, limit: 200 });
    expect(recent).toHaveLength(200);
    expect(recent[0]).toBe('row 51');
    expect(recent.at(-1)).toBe('row 250');
    // Ascending transcript order inside the page is what a prompt renders.
    expect(recent).toEqual(Array.from({ length: 200 }, (_, index) => `row ${index + 51}`));
    // The Room turn's own final-80 slice now ends on the newest message.
    const finalEighty = recent.slice(-80);
    expect(finalEighty[0]).toBe('row 171');
    expect(finalEighty.at(-1)).toBe('row 250');

    // Startup objective recovery still reads the oldest end.
    const earliest = await bodies({ roomId: ROOM, limit: 200, window: 'earliest' });
    expect(earliest).toHaveLength(200);
    expect(earliest[0]).toBe(OBJECTIVE);
    expect(earliest.at(-1)).toBe('row 200');
    // The whole handoff survives the trip, not just its first sentence.
    expect(earliest.find((body) => body.includes('--dry-run'))).toBe(OBJECTIVE);

    // A shorter page is still the newest rows, and the default limit too.
    expect(await bodies({ roomId: ROOM, limit: 5 })).toEqual([
      'row 246',
      'row 247',
      'row 248',
      'row 249',
      'row 250',
    ]);
    expect((await bodies({ roomId: ROOM })).at(-1)).toBe('row 250');

    // Transcript rows alone are never executable intake.
    expect(await (await fixture.daemonOperation('getRoomInbox', { roomId: ROOM })).json()).toMatchObject({
      items: [],
    });
    // A conversation read carrying a cursor is a forward walk, not a page.
    const walked = (await (
      await fixture.daemonOperation('getRoomConversation', {
        roomId: ROOM,
        limit: 100,
        after: `${base + 100 * 1000},${rowId(100)}`,
      })
    ).json()) as { items: Array<{ body: string }> };
    expect(walked.items.at(-1)!.body).not.toBe('row 250');

    // Nothing is dropped or duplicated across the two windows: together they
    // cover every one of the 250 rows exactly once.
    expect(new Set([...earliest, ...recent]).size).toBe(250);
    // A future-dated row is readable without swallowing intervening history.
    const future=rowId(251);
    await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      VALUES($1,$2,$3,'future row',now()+interval '30 seconds')`,[future,ROOM,HUMAN]);
    const futurePage=await (await fixture.daemonOperation('getRoomConversation',{roomId:ROOM,limit:5})).json() as {
      items:{id:string}[];cursor:string;
    };
    expect(futurePage.items.at(-1)?.id).toBe(future);
    expect(futurePage.cursor).toBe(`${base+250*1000},${rowId(250)}`);

  });


  it('counts only open corners in the Room list', async () => {
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at) VALUES
        ('33333333-3333-4333-8333-333333333333',$1,$2,'Done corner',now()),
        ('44444444-4444-4444-8444-444444444444',$1,$2,'Open corner',NULL)`,
      [WORKSPACE, ROOM],
    );
    const chat = (
      (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
        chats: Array<{
          room: { id: string };
          cornerCount: number;
          waitingCornerCount: number;
          openCorners: Array<{ id: string; name: string; state: string }>;
        }>;
      }
    ).chats.find((item) => item.room.id === ROOM);
    expect(chat?.cornerCount).toBe(1);
    // It owes nobody anything, so it is idle, not waiting.
    expect(chat?.waitingCornerCount).toBe(0);
    expect(chat?.openCorners).toEqual([
      { id: '44444444-4444-4444-8444-444444444444', name: 'Open corner', state: 'idle' },
    ]);
  });


  it('returns the active corner when the same originating task is opened repeatedly', async () => {
    const input = {
      roomId: ROOM,
      requestId: 'repeated-corner-open',
      idempotencyKey: 'repeated-corner-open:call-1',
      name: 'Ship-widget',
      objective: 'Ship the widget end to end',
      brief: { content: 'A1: ship the agreed widget behavior.' },
    };
    const sourceMessageId = createHash('sha256').update(input.requestId).digest('hex');
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Open a corner for the agreed widget work')`,
      [sourceMessageId, ROOM, HUMAN],
    );
    const first = await fixture.daemonOperation('createCorner', input);
    const second = await fixture.daemonOperation('createCorner', input);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstResult = (await first.json()) as { cornerId: string };
    expect(await second.json()).toEqual(firstResult);
    for (const changed of [
      { ...input, objective: 'Ship a different widget' },
      { ...input, brief: { content: 'A1: ship only a partial widget.' } },
      {
        ...input,
        brief: {
          ...input.brief,
          attachments: [
            {
              objectId: '65432109-0000-4000-8000-000000000001',
              purpose: 'Approved mock',
              required: true,
            },
          ],
        },
      },
    ]) {
      const retry = await fixture.daemonOperation('createCorner', changed);
      expect(retry.status).toBe(409);
      expect(await retry.text()).toContain('different assignment');
    }

    const stored = await fixture.database.query<{
      corners: number;
      cards: number;
      commands: number;
      briefs: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM rooms corner WHERE corner.parent_id IS NOT NULL AND ${cornerRequestSql('corner.id')}=$1) corners,
         (SELECT count(*)::integer FROM messages
          WHERE room_id=$2 AND card_type='daemon-fact' AND card->>'cornerId'=$3) cards,
         (SELECT count(*)::integer FROM agent_commands
          WHERE room_id=$4 AND reason='corner_objective') commands,
         (SELECT count(*)::integer FROM corner_brief_revisions WHERE corner_id=$4) briefs`,
      [input.requestId, ROOM, firstResult.cornerId, firstResult.cornerId],
    );
    expect(stored.rows[0]).toEqual({ corners: 1, cards: 1, commands: 1, briefs: 1 });
  });


  it('commits a full brief and its Room file before waking the worker, then preserves the bytes', async () => {
    const source = await mkdtemp(join(tmpdir(), 'beeline-brief-source-'));
    await writeFile(join(source, 'approved-mock.txt'), 'approved visual dimensions');
    const bytes = await readFile(join(source, 'approved-mock.txt'));
    const sha = createHash('sha256').update(bytes).digest('hex');
    const mediaId = '65432109-0000-4000-8000-000000000001';
    const key = `media/${HUMAN}/${sha}`;
    await fixture.objectStorage.putObject(key, bytes, 'text/plain');
    await rm(source, { recursive: true, force: true });
    await fixture.database.query(
      `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
       VALUES($1,$2,'media',$3,'text/plain','approved-mock.txt',$4,$5,'ready',now()+interval '1 hour')`,
      [mediaId, HUMAN, key, bytes.length, sha],
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,attachments)
       VALUES($1,$2,$3,'Approved reference',$4::jsonb)`,
      [
        'a'.repeat(64),
        ROOM,
        HUMAN,
        JSON.stringify([{ url: `${fixture.origin}/v1/media/${mediaId}`, name: 'approved-mock.txt' }]),
      ],
    );
    const brief = {
      content:
        'Outcome: match the approved dimensions.\nA1: render the specified size.\nA2: preserve existing labels.',
      attachments: [{ objectId: mediaId, purpose: 'approved visual dimensions', required: true }],
    };
    const input = {
      roomId: ROOM,
      requestId: 'durable-brief-open',
      name: 'Render-size',
      objective: 'Match the approved dimensions',
      brief,
    };
    const first = await fixture.daemonOperation('createCorner', input);
    expect(first.status).toBe(200);
    const { cornerId } = (await first.json()) as { cornerId: string };
    expect(await (await fixture.daemonOperation('createCorner', input)).json()).toEqual({ cornerId, watch: { roomId: ROOM, kinds: ['opened', 'merged'] } });
    const revisions = await fixture.database.query<{ revision: number }>(
      `SELECT revision FROM corner_brief_revisions WHERE corner_id=$1`,
      [cornerId],
    );
    expect(revisions.rows).toEqual([{ revision: 1 }]);
    const restore = await fixture.daemonOperation('getCornerRestoreState', { cornerId });
    expect(await restore.json()).toMatchObject({
      brief: {
        revision: 1,
        spec: brief.content,
        approval: { text: 'Fixture command', approvedBy: HUMAN, approverName: expect.any(String) },
        attachments: [
          { objectId: mediaId, sha256: sha, purpose: 'approved visual dimensions', required: true },
        ],
      },
    });
    const viewed = await fixture.phone.readRoom(cornerId, HUMAN);
    expect(viewed?.cornerBrief).toMatchObject({
      revision: 1,
      spec: brief.content,
      approval: { text: 'Fixture command' },
      attachments: [{ title: 'approved-mock.txt', purpose: 'approved visual dimensions' }],
    });
    expect(Object.keys(viewed!.cornerBrief!).sort()).toEqual([
      'approval',
      'attachments',
      'authorHandle',
      'revision',
      'spec',
    ]);
    // A new revision is the spec and its approval; every column the typed
    // brief used to fill stays empty, and the approval keeps the stored shape.
    expect(
      (
        await fixture.database.query(
          `SELECT spec,content,intent_verbatim,build_spec,criteria,non_goals,brief_references,
                  approval_basis->>'kind' approval_kind,approval_basis->>'snapshot' snapshot,
                  revision_hash IS NOT NULL hashed
           FROM corner_brief_revisions WHERE corner_id=$1`,
          [cornerId],
        )
      ).rows,
    ).toEqual([
      {
        spec: brief.content,
        content: null,
        intent_verbatim: null,
        build_spec: null,
        criteria: null,
        non_goals: null,
        brief_references: null,
        approval_kind: 'initiating-command',
        snapshot: 'Fixture command',
        hashed: true,
      },
    ]);
    await fixture.database.query(`UPDATE objects SET expires_at=now()-interval '1 minute' WHERE id=$1`, [
      mediaId,
    ]);
    expect(
      await new MediaExpiryLoop(fixture.database, 24, 0, {
        storage: fixture.objectStorage.asStorage(),
        service: fixture.objectService,
      }).runOnce(),
    ).toBe(0);
    expect((await phoneFetch(`${fixture.origin}/v1/media/${mediaId}`)).status).toBe(200);
    await fixture.database.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
      VALUES($1,$2,'presence','presence','{"status":"online"}')`, [ROOM, AGENT]);
    const revision = await fixture.daemonOperation('reviseCornerBrief', {
      roomId: ROOM,
      cornerId,
      requestId: 'brief-correction',
      expectedRevision: 1,
      brief: {
        content:
          'Outcome: keep the approved dimensions and use the corrected label.\nA1: render the specified size.\nA2: show Corrected.',
        change: 'The requester corrected the label.',
        attachments: brief.attachments,
      },
    });
    expect(revision.status).toBe(200);
    expect(await revision.json()).toMatchObject({
      revision: 2,
      change: 'The requester corrected the label.',
    });
    // A retry of the original open still names the same corner after a later
    // correction; the retry is compared with revision 1, not the latest brief.
    expect(await (await fixture.daemonOperation('createCorner', input)).json()).toEqual({ cornerId, watch: { roomId: ROOM, kinds: ['opened', 'merged'] } });
    expect(
      (
        await fixture.database.query<{ revision: number }>(
          `SELECT revision FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision`,
          [cornerId],
        )
      ).rows,
    ).toEqual([{ revision: 1 }, { revision: 2 }]);
    const history = await fixture.daemonOperation('listCornerBriefRevisions', { cornerId, limit: 20 });
    expect(await history.json()).toMatchObject({
      revisions: [
        { revision: 2, change: 'The requester corrected the label.' },
        { revision: 1, spec: brief.content },
      ],
    });
    expect(await (await fixture.daemonOperation('listCornerBriefRevisions', {
      cornerId, afterRevision: 1, limit: 1,
    })).json()).toMatchObject({ revisions: [{ revision: 2 }] });
    expect(await (await fixture.daemonOperation('listCornerBriefRevisions', {
      cornerId, afterRevision: 2, limit: 1,
    })).json()).toEqual({ revisions: [] });
    expect(await (await fixture.daemonOperation('listCornerBriefRevisions', {
      cornerId, afterRevision: 0, limit: 1,
    })).json()).toMatchObject({ revisions: [{ revision: 2 }] });
    for (const afterRevision of [-1, 1.5]) {
      expect((await fixture.daemonOperation('listCornerBriefRevisions', {
        cornerId, afterRevision, limit: 1,
      })).status).toBe(400);
    }
    const outsider = 'd'.repeat(64);
    const isolated = new DaemonService(fixture.database, new LiveHub());
    await expect(
      isolated.execute('listCornerBriefRevisions', { cornerId }, outsider),
    ).rejects.toThrow('access denied');
    await expect(
      isolated.execute(
        'reviseCornerBrief',
        {
          cornerId,
          requestId: 'unauthorized-brief',
          expectedRevision: 2,
          brief: { content: 'Remove the accepted criterion.' },
        },
        outsider,
      ),
    ).rejects.toThrow('access denied');
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='corner_brief_revision'`,
          [cornerId],
        )
      ).rows,
    ).toHaveLength(1);
    const stale = await fixture.daemonOperation('reviseCornerBrief', {
      roomId: ROOM,
      cornerId,
      requestId: 'stale-brief-correction',
      expectedRevision: 1,
      brief: { content: 'Stale replacement.' },
    });
    expect(stale.status).not.toBe(200);
    expect(
      (
        await fixture.daemonOperation('reviseCornerBrief', {
          roomId: ROOM,
          cornerId,
          requestId: 'brief-without-change',
          expectedRevision: 2,
          brief: { content: 'A replacement with no provenance note.' },
        })
      ).status,
    ).not.toBe(200);
    expect(
      (await fixture.database.query(`SELECT 1 FROM corner_brief_revisions WHERE corner_id=$1`, [cornerId]))
        .rows,
    ).toHaveLength(2);
  });


  it('does not open or wake a corner when a required brief file is unavailable', async () => {
    const response = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'missing-brief-file',
      name: 'Missing-reference',
      objective: 'Use the approved reference',
      brief: {
        content: 'A1: use the approved reference.',
        attachments: [
          {
            objectId: '65432109-0000-4000-8000-000000000002',
            purpose: 'approved reference',
            required: true,
          },
        ],
      },
    });
    expect(response.status).not.toBe(200);
    expect(
      (await fixture.database.query(`SELECT 1 FROM rooms corner WHERE ${cornerRequestSql('corner.id')}='missing-brief-file'`))
        .rows,
    ).toEqual([]);
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM agent_commands WHERE reason='corner_objective' AND turn_request_id='missing-brief-file'`,
        )
      ).rows,
    ).toEqual([]);
  });


  it('refuses new repository corners without a structured brief at the server boundary', async () => {
    const response = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'missing-code-brief',
      name: 'Missing-brief',
      objective: 'Do repository work',
      repository: 'example/repository',
      fixtureOmitBrief: true,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('a brief is required for repository corners');
    expect(
      (await fixture.database.query(`SELECT 1 FROM rooms corner WHERE ${cornerRequestSql('corner.id')}='missing-code-brief'`))
        .rows,
    ).toEqual([]);
  });


  it('folds a revision written before the trimmed brief into one Markdown spec', async () => {
    const opened = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'folded-brief-open',
      name: 'Folded-brief',
      objective: 'Keep the old assignment readable',
      brief: { content: 'Revision one.' },
    });
    expect(opened.status).toBe(200);
    const { cornerId } = (await opened.json()) as { cornerId: string };
    const approval = 'old-approval-message';
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Yes, build that.')`,
      [approval, ROOM, HUMAN],
    );
    // Exactly the row shape the structured brief wrote: no spec, every typed field.
    await fixture.database.query(
      `INSERT INTO corner_brief_revisions(
         corner_id,revision,content,intent_verbatim,build_spec,criteria,non_goals,
         brief_references,approval_basis,revision_hash,change,author_id,source_room_id,
         source_message_id,attachments
       ) VALUES($1,2,'Old build spec.',$2,'Old build spec.',$3,$4,$5,$6,$7,'Old change',$8,$9,$10,'[]')`,
      [
        cornerId,
        JSON.stringify([{ sourceMessageId: approval, snapshot: 'Yes, build that.' }]),
        JSON.stringify([
          { id: 'AC-1', text: 'The widget renders.' },
          { id: 'AC-2', text: 'Labels stay.' },
        ]),
        JSON.stringify(['No redesign.']),
        JSON.stringify([
          { label: 'Design doc', authority: 'approved-reference', description: 'The agreed mock.' },
        ]),
        JSON.stringify({
          kind: 'explicit-human-answer',
          sourceMessageId: approval,
          snapshot: 'Yes, build that.',
          approvedBy: HUMAN,
          briefHash: 'f'.repeat(64),
        }),
        'f'.repeat(64),
        AGENT,
        ROOM,
        approval,
      ],
    );
    // And a row from before structured briefs: opaque content only.
    await fixture.database.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
       VALUES($1,3,'Opaque legacy content.',$2,$3)`,
      [cornerId, AGENT, ROOM],
    );
    const human = (
      await fixture.database.query<{ name: string }>(`SELECT name FROM identities WHERE id=$1`, [HUMAN])
    ).rows[0]!.name;
    const folded = [
      '## Intent',
      '',
      '> Yes, build that.',
      '>',
      `> — message \`${approval}\``,
      '',
      '## Checklist',
      '',
      '- AC-1: The widget renders.',
      '- AC-2: Labels stay.',
      '',
      '## Non-goals',
      '',
      '- No redesign.',
      '',
      '## References',
      '',
      '- Design doc [approved-reference]: The agreed mock.',
      '',
      'Old build spec.',
    ].join('\n');
    const history = (await (
      await fixture.daemonOperation('listCornerBriefRevisions', { cornerId, limit: 20 })
    ).json()) as { revisions: Record<string, unknown>[] };
    expect(history.revisions).toEqual([
      expect.objectContaining({ revision: 3, spec: 'Opaque legacy content.' }),
      expect.objectContaining({
        revision: 2,
        spec: folded,
        change: 'Old change',
        approval: {
          kind: 'explicit-human-answer',
          sourceMessageId: approval,
          text: 'Yes, build that.',
          approvedBy: HUMAN,
          approverName: human,
        },
      }),
      expect.objectContaining({ revision: 1, spec: 'Revision one.' }),
    ]);
    expect(history.revisions[0]).not.toHaveProperty('approval');
    for (const field of ['replyToMessageId', 'replyToAttachmentIds', 'replyToCreatedAt', 'approvedAt'])
      expect(history.revisions[1].approval).not.toHaveProperty(field);
    await fixture.database.query(`DELETE FROM corner_brief_revisions WHERE corner_id=$1 AND revision=3`, [
      cornerId,
    ]);
    expect((await fixture.phone.readRoom(cornerId, HUMAN))?.cornerBrief).toEqual({
      authorHandle: 'bee',
      revision: 2,
      spec: folded,
      approval: { sourceMessageId: approval, text: 'Yes, build that.', approverName: human },
      attachments: [],
    });
  });


  it('rolls back the corner and worker command when brief persistence fails', async () => {
    await fixture.database.query(
      `ALTER TABLE corner_brief_revisions ADD CONSTRAINT reject_test_brief
       CHECK (spec <> 'reject-this-brief')`,
    );
    const response = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'brief-persistence-failure',
      name: 'Brief-failure',
      objective: 'Persist a complete assignment',
      brief: { content: 'reject-this-brief' },
    });
    expect(response.status).not.toBe(200);
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM rooms corner WHERE ${cornerRequestSql('corner.id')}='brief-persistence-failure'`,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM agent_commands WHERE reason='corner_objective' AND turn_request_id='brief-persistence-failure'`,
        )
      ).rows,
    ).toEqual([]);
  });


  it.each([
    ...['opened', 'implement', 'checks', 'review', 'ask_human', 'landed', 'closed']
      .map(state => ({ state, health: 'healthy' })),
    ...['implement', 'ask_human'].flatMap(state =>
      ['offline', 'removed', 'recent-failure', 'out-of-credit'].map(health => ({ state, health }))),
  ])(
    'Reproduction BR-01: brief revision from $state with $health worker', async ({ state, health }) => {
      const worker = 'd'.repeat(64);
      await fixture.database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Worker','worker')`, [worker]);
      await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [worker, HUMAN]);
      for (const roomId of [null, ROOM])
        await fixture.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, roomId, worker]);
      const opened = await fixture.daemonOperation('createCorner', {
        roomId: ROOM, requestId: 'worker-brief-open', name: 'Worker-brief',
        objective: 'Keep the approved behavior', repository: 'example/repo',
        brief: { content: 'Keep the approved behavior.' },
      });
      expect(opened.status).toBe(200);
      const { cornerId } = await opened.json() as { cornerId: string };
      await fixture.phone.execute('sendRoomMessage', {
        roomId: cornerId, messageId: createHash('sha256').update(`worker-${state}`).digest('hex'),
        text: '@worker please implement this corner',
      }, HUMAN);
      await fixture.database.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [ROOM, worker]);
      // Keep the opener out of credit while its already-claimed command revises the brief.
      await fixture.database.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'opener-failed',$2,'failed')`, [ROOM, AGENT]);
      await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card) VALUES($1,$2,$3,'Allowance spent','turn-failed',$4::jsonb)`, [
        createHash('sha256').update(`failure-${state}`).digest('hex'), ROOM, HUMAN,
        JSON.stringify({ requestId: 'opener-failed', agentId: AGENT, silenceKind: 'allowance-spent' }),
      ]);
      await fixture.database.query(`UPDATE messages SET card=jsonb_set(card,'{toState}',to_jsonb($2::text)) WHERE id=(SELECT id FROM messages WHERE room_id=$1 AND card_type='corner-workflow-handoff' ORDER BY (card->>'seq')::int DESC LIMIT 1)`, [cornerId, state]);
      if (health === 'offline')
        await fixture.database.query(`DELETE FROM live_outputs WHERE agent_id=$1`, [worker]);
      if (health === 'removed')
        await fixture.database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, worker]);
      if (health === 'recent-failure' || health === 'out-of-credit') {
        await fixture.database.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,created_at)
          VALUES($1,'worker-failed',$2,'failed',now()-$3::interval)`, [ROOM, worker, health === 'out-of-credit' ? '1 day' : '0 seconds']);
        await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card)
          VALUES($1,$2,$3,'Worker failed','turn-failed',$4::jsonb)`, [
          createHash('sha256').update(`worker-failure-${state}`).digest('hex'), ROOM, HUMAN,
          JSON.stringify({ requestId: 'worker-failed', agentId: worker, silenceKind: health === 'out-of-credit' ? 'allowance-spent' : 'hiccup' }),
        ]);
      }
      const revised = await fixture.daemonOperation('reviseCornerBrief', {
        roomId: ROOM, cornerId, requestId: 'worker-brief-correction', expectedRevision: 1,
        brief: { content: 'Keep the corrected behavior.', change: 'Corrected behavior' },
      });
      expect(revised.status).toBe(200);
      const result = await revised.json();
      const wakes = (await fixture.database.query<{ agent_id: string }>(
        `SELECT command.agent_id FROM agent_commands command JOIN messages note ON note.id=command.source_message_id
         WHERE command.room_id=$1 AND note.text LIKE '%revised the corner brief%'`, [cornerId],
      )).rows.map(row => row.agent_id);
      const terminal = state === 'landed' || state === 'closed';
      const shouldWake = !terminal && !['offline','removed'].includes(health);
      console.info(`Reproduction BR-01: HTTP reviseCornerBrief from ${state}, worker ${health}; expected=${shouldWake ? 'current worker' : 'none'}; observed=${wakes.map(id => id === worker ? 'current worker' : 'opener').join(',') || 'none'}; revision=${result.revision}`);
      expect(result).toMatchObject({ revision: 2, wake: shouldWake ? { queued: true, agentId: worker } : { queued: false, reason: expect.any(String) } });
      expect(wakes).toEqual(shouldWake ? [worker] : []);
      expect((await fixture.database.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%revised the corner brief%'`, [cornerId])).rows).toHaveLength(1);
      expect((await fixture.database.query<{ worker_agent_id: string; workflow_state: string }>(
        `SELECT ${cornerImplementerSql('fact', 'corner')} worker_agent_id,${cornerRunStateSql('fact.corner_id')} workflow_state FROM corner_facts fact
         JOIN rooms corner ON corner.id=fact.corner_id WHERE fact.corner_id=$1`, [cornerId],
      )).rows[0]).toEqual({ worker_agent_id: worker, workflow_state: state === 'ask_human' && shouldWake ? 'implement' : state });
    },
  );


  it('wakes the implementer, not the reviewer, with a revised brief on an already green head', async () => {
    const opened = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'reviewer-brief-open',
      name: 'Review-brief',
      objective: 'Keep the agreed behavior',
      repository: 'example/repo',
      brief: { content: 'A1: keep the agreed behavior.' },
    });
    expect(opened.status).toBe(200);
    const { cornerId } = (await opened.json()) as { cornerId: string };
    const reviewerId = 'e'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Reviewer','reviewer')`,
      [reviewerId],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [
      reviewerId,
      HUMAN,
    ]);
    for (const memberRoom of [null, ROOM])
      await fixture.database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WORKSPACE, memberRoom, reviewerId],
      );
    await fixture.database.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, reviewerId]);
    await fixture.database.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      cornerId,
      JSON.stringify({
        lifecycle: 'in-review',
        checks: 'passing',
        pr: { number: 77, url: 'https://github.com/example/repo/pull/77', headSha: '1'.repeat(40) },
      }),
    ]);
    const revised = await fixture.daemonOperation('reviseCornerBrief', {
      roomId: ROOM,
      cornerId,
      requestId: 'reviewer-brief-correction',
      expectedRevision: 1,
      brief: {
        content: 'A1: keep the agreed behavior. A2: retain the corrected label.',
        change: 'Corrected label',
      },
    });
    expect(revised.status).toBe(200);
    expect(await revised.json()).toMatchObject({ revision: 2, change: 'Corrected label' });
    const commands = await fixture.database.query<{ agent_id: string; reason: string }>(
      `SELECT agent_id,reason FROM agent_commands WHERE room_id=$1 AND reason IN ('corner_brief_revision','corner_check') ORDER BY agent_id`,
      [cornerId],
    );
    // A brief edit never sends the corner back to review: the reviewer is not
    // woken, and the run stays where it was.
    expect(commands.rows.filter((row) => row.agent_id === reviewerId)).toEqual([]);
    expect(
      (await fixture.database.query<{ workflow_state: string }>(
        `SELECT ${cornerRunStateSql('$1::uuid')} workflow_state`, [cornerId],
      )).rows[0]?.workflow_state,
    ).toBe('implement');
    expect(
      await (await fixture.daemonOperation('getCornerRestoreState', { cornerId })).json(),
    ).toMatchObject({
      brief: {
        revision: 2,
        spec: 'A1: keep the agreed behavior. A2: retain the corrected label.',
      },
    });
  });


  it('creates every independently keyed corner requested by one originating task', async () => {
    const requestId = 'multiple-corner-open';
    const sourceMessageId = createHash('sha256').update(requestId).digest('hex');
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Open corners for both independent problems')`,
      [sourceMessageId, ROOM, HUMAN],
    );
    const first = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId,
      idempotencyKey: `${requestId}:call-1`,
      name: 'First-fix',
      objective: 'Fix the first independent problem',
    });
    const second = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId,
      idempotencyKey: `${requestId}:call-2`,
      name: 'Second-fix',
      objective: 'Fix the second independent problem',
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstResult = (await first.json()) as { cornerId: string };
    const secondResult = (await second.json()) as { cornerId: string };
    expect(secondResult.cornerId).not.toBe(firstResult.cornerId);

    const stored = await fixture.database.query<{ corners: number; cards: number; commands: number }>(
      `SELECT
         (SELECT count(*)::integer FROM rooms corner WHERE corner.parent_id IS NOT NULL AND ${cornerRequestSql('corner.id')}=$1) corners,
         (SELECT count(*)::integer FROM messages
          WHERE room_id=$2 AND card_type='daemon-fact'
            AND card->>'cornerId' IN ($3,$4)) cards,
         (SELECT count(*)::integer FROM agent_commands
          WHERE room_id IN ($3::uuid,$4::uuid) AND reason='corner_objective') commands`,
      [requestId, ROOM, firstResult.cornerId, secondResult.cornerId],
    );
    expect(stored.rows[0]).toEqual({ corners: 2, cards: 2, commands: 2 });
  });


  it('serializes concurrent opens for the same originating task', async () => {
    const input = {
      roomId: ROOM,
      requestId: 'concurrent-corner-open',
      idempotencyKey: 'concurrent-corner-open:call-1',
      name: 'Ship-widget',
      objective: 'Ship the widget end to end',
    };
    // Seed and claim the single command both retries are authorized to serve;
    // the requests below then enter createCorner concurrently.
    await fixture.daemonOperation('postAgentActivity', {
      roomId: ROOM,
      requestId: input.requestId,
      activity: [],
    });
    const responses = await Promise.all([
      fixture.request(
        '/v1/daemon/operations/createCorner',
        'POST',
        {
          ...input,
          generationId: 'fixture-generation',
        },
        fixture.daemonToken,
      ),
      fixture.request(
        '/v1/daemon/operations/createCorner',
        'POST',
        {
          ...input,
          generationId: 'fixture-generation',
        },
        fixture.daemonToken,
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const results = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      cornerId: string;
    }>;
    expect(results[1]).toEqual(results[0]);
    const corners = await fixture.database.query<{ count: number }>(
      `SELECT count(*)::integer count FROM rooms child
       JOIN corner_facts fact ON fact.corner_id=child.id
       WHERE child.parent_id=$1 AND ${cornerRequestSql('child.id')}=$2 AND child.archived_at IS NULL`,
      [ROOM, input.requestId],
    );
    expect(corners.rows[0]!.count).toBe(1);
  });


  it('rejects an open-corner objective longer than 24 words, naming the count', async () => {
    const response = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-objective-too-long',
      name: 'Too-long',
      objective: Array.from({ length: 25 }, (_, index) => `word${index + 1}`).join(' '),
    });
    expect(response.status).toBe(503);
    // The refusal names the limit AND what arrived: nobody could see why the
    // old catch-all sentence fired, and the same turn failed twice (C90).
    expect(await response.json()).toEqual({
      error: 'the objective is 25 words; the limit is 24',
    });
    const corners = await fixture.database.query(
      `SELECT id FROM rooms WHERE parent_id=$1 AND name LIKE 'word1 %'`,
      [ROOM],
    );
    expect(corners.rows).toEqual([]);
  });
});
