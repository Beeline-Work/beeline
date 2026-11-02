import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SqlDatabase } from './database.js';
import { addressedToPersonSql, cornerOwedItemsSql, cornerOwedSchemaSql } from './corner-owed.js';
import { PhoneService } from './phone-service.js';
import { seedCornerOpening, PgliteDatabase, migratedDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const LATE = 'd'.repeat(64);
const ORIGIN = 'https://server.usebeeline.app';

type Facts = {
  /** The chat list's corner: state, and whether it pulls the dropdown open. */
  list: { state: string; attention: boolean };
  /** The Corners page row. */
  page: { state: string };
  /** The corner header's `cornerOwed`. */
  header: boolean | undefined;
};

describe('OWED-DERIVED', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;
  let clock = 0;

  /** One message in the corner, a second after the previous one. */
  const post = async (
    id: string,
    author: string,
    text: string,
    extra: {
      presentation?: string;
      cardType?: string;
      card?: object;
      replyTo?: string;
      attachments?: object[];
      at?: string;
    } = {},
  ) => {
    clock += 1;
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,
         reply_to_message_id,attachments,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,${extra.at ?? `now()+$10::interval`})`,
      [
        id,
        CORNER,
        author,
        text,
        extra.presentation ?? 'message',
        extra.cardType ?? null,
        extra.card ? JSON.stringify(extra.card) : null,
        extra.replyTo ?? null,
        JSON.stringify(extra.attachments ?? []),
        ...(extra.at ? [] : [`${clock} seconds`]),
      ],
    );
  };

  const facts = async (viewer = OWNER): Promise<Facts> => {
    const chats = await phone.readChats(WORKSPACE, viewer);
    const listed = chats?.chats
      .find((chat) => chat.room.id === ROOM)
      ?.openCorners?.find((corner) => corner.id === CORNER);
    const page = (await phone.readCorners(ROOM, viewer))?.corners.find(
      (item) => item.corner.id === CORNER,
    );
    const header = (await phone.readRoom(CORNER, viewer))?.cornerOwed;
    return {
      list: { state: listed?.state ?? 'missing', attention: listed?.attention === true },
      page: { state: page?.state ?? 'missing' },
      header,
    };
  };
  const idle: Facts = {
    list: { state: 'idle', attention: false },
    page: { state: 'idle' },
    header: false,
  };
  const owedToViewer: Facts = {
    list: { state: 'idle', attention: false },
    page: { state: 'idle' },
    header: true,
  };
  const owedToViewerSeen: Facts = {
    list: { state: 'idle', attention: false },
    page: { state: 'idle' },
    header: true,
  };
  const owedToSomeoneElse: Facts = {
    list: { state: 'idle', attention: false },
    page: { state: 'idle' },
    header: true,
  };
  const blockingToViewer: Facts = {
    list: { state: 'waiting', attention: true }, page: { state: 'waiting' }, header: true,
  };

  const step = async (expected: Facts, viewer = OWNER) => {
    expect(await facts(viewer)).toEqual(expected);
    expect((await database.query('SELECT * FROM corner_owed')).rows).toEqual([]);
  };

  beforeEach(async () => {
    clock = 0;
    database = await migratedDatabase();
    phone = new PhoneService(database, ORIGIN);
    for (const [id, kind, name, handle] of [
      [OWNER, 'human', 'Owner', 'owner'],
      [OTHER, 'human', 'Other', 'other'],
      [AGENT, 'agent', 'Bee', 'bee'],
      [LATE, 'human', 'Late', 'late'],
    ])
      await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,$2,$3,$4)`, [
        id,
        kind,
        name,
        handle,
      ]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Owed')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Corner')`,
      [CORNER, WORKSPACE, ROOM],
    );
    for (const id of [OWNER, OTHER, AGENT])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,$3),($1,$4,$2,$3)`,
        [WORKSPACE, id, id === OWNER ? 'owner' : 'member', ROOM],
      );
    await database.query(`INSERT INTO corner_facts(corner_id,owner_agent_id) VALUES($1,$2)`, [CORNER, AGENT]);
    await seedCornerOpening(database, { cornerId: CORNER, agentId: AGENT, commissionedBy: OWNER });
  });

  it('refreshes existing deliverables when the opening order records their commissioner', async () => {
    await database.query(`DELETE FROM agent_commands WHERE room_id=$1 AND reason='corner_objective'`, [CORNER]);
    await post('deliverable', AGENT, 'Here it is.', {
      attachments: [{ name: 'finish.png', url: '/files/finish.png', mimeType: 'image/png' }],
    });
    await step(idle);
    await seedCornerOpening(database, { cornerId: CORNER, agentId: AGENT, commissionedBy: OWNER });
    await step(owedToViewer);
  });

  it('keeps push commissioner probes on the opening-order index', async () => {
    await database.transaction(async db => {
      await db.query(`SET LOCAL enable_seqscan=off`);
      const plan = await db.query(`EXPLAIN (FORMAT JSON)
        SELECT ${addressedToPersonSql('m', 'person.id', 'person.handle', 'person.kind')}
        FROM messages m JOIN identities person ON person.id=$1 WHERE m.id='push-message'`, [OWNER]);
      expect(JSON.stringify(plan.rows)).toContain('agent_commands_corner_opening');
      expect(JSON.stringify(plan.rows)).toContain('corner_facts_pkey');
    });
  });

  it('OWED-DERIVED: reads a tag owed until the person posts, and attention only until they open the corner', async () => {
    await post('done', AGENT, 'Done for now.');
    await step(idle);
    await post('tag', AGENT, '@owner matte or gloss?');
    await step(owedToViewer);
    await database.query(
      `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
       SELECT room_id,$2,created_at,id FROM messages WHERE id=$1`,
      ['tag', OWNER],
    );
    await step(owedToViewerSeen);
    // Someone else's post answers nothing owed to the viewer.
    await post('other-says', OTHER, 'I like matte.');
    await step(owedToViewerSeen);
    await post('answer', OWNER, 'Matte.');
    await step(idle);
  });

  it('reads a reply owed to the person replied to', async () => {
    await post('ask', OWNER, 'Which finish?');
    await post('reply', AGENT, 'Matte, I think.', { replyTo: 'ask' });
    await step(owedToViewer);
    await post('thanks', OWNER, 'Thanks.');
    await step(idle);
  });

  it('retains what is owed to another member without making an ordinary tag a blocker', async () => {
    await post('tag-other', AGENT, '@other matte or gloss?');
    await step(owedToSomeoneElse);
    await step(
      {
        list: { state: 'idle', attention: false },
        page: { state: 'idle' },
        header: true,
      },
      OTHER,
    );
    await post('other-answers', OTHER, 'Gloss.');
    await step(idle);
  });

  it('keeps a question card owed until it is answered or closed, whatever the person posts', async () => {
    const question = (status: string) => ({
      mode: 'question',
      status,
      requester: { pubkey: OWNER },
    });
    await post('question', AGENT, 'Matte or gloss?', {
      presentation: 'card',
      cardType: 'choice',
      card: question('open'),
    });
    await step(blockingToViewer);
    await post('chatter', OWNER, 'Let me think.');
    await step(blockingToViewer);
    await database.query(
      `UPDATE messages SET card=jsonb_set(card,'{status}','"answered"') WHERE id='question'`,
    );
    await step(idle);

    await post('question-2', AGENT, 'Hinged or loose?', {
      presentation: 'card',
      cardType: 'choice',
      card: question('open'),
    });
    await step(blockingToViewer);
    await database.query(
      `UPDATE messages SET card=jsonb_set(card,'{status}','"closed"') WHERE id='question-2'`,
    );
    await step(idle);
  });

  it('keeps a grant card owed to whoever can decide it until it is decided', async () => {
    const grantId = '99999999-9999-4999-8999-999999999999';
    await database.query(
      `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
       VALUES($1,$2,$3,'host','example.com','fetch docs',$2,$4,'pending')`,
      [grantId, AGENT, WORKSPACE, CORNER],
    );
    await post('grant', AGENT, 'Allow Bee to reach example.com', {
      presentation: 'card',
      cardType: 'grant-request',
      card: { grants: [{ grantId, kind: 'host', target: 'example.com' }] },
      at: `now()-interval '3 days'`,
    });
    await step(blockingToViewer);
    await post('chatter', OWNER, 'Looking.');
    await step(blockingToViewer);
    await database.query(`UPDATE agent_grants SET status='approved' WHERE id=$1`, [grantId]);
    await step(idle);
  });

  it('owes a repo-less corner\'s deliverable to its commissioner for a day, until they post', async () => {
    const files = [{ name: 'finish.png', url: '/files/finish.png', mimeType: 'image/png' }];
    await post('deliverable', AGENT, 'Here it is.', { attachments: files });
    await step(owedToViewer);
    await post('got-it', OWNER, 'Got it.');
    await step(idle);
    await post('old-deliverable', AGENT, 'An old one.', {
      attachments: files,
      at: `now()-interval '25 hours'`,
    });
    await step(idle);
  });

  it('matches commissioner completion only to its named corner', async () => {
    const otherCorner = '44444444-4444-4444-8444-444444444444';
    await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,name)
      VALUES($1,$2,$3,'Other corner')`, [otherCorner, WORKSPACE, ROOM]);
    await database.query(`INSERT INTO corner_facts(corner_id,owner_agent_id) VALUES($1,$2)`, [otherCorner, AGENT]);
    await seedCornerOpening(database, { cornerId: otherCorner, agentId: AGENT, commissionedBy: OTHER });
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES
      ('own-complete',$1,$2,'Done','card','daemon-fact',$3::jsonb),
      ('other-complete',$1,$2,'Done','card','daemon-fact',$4::jsonb),
      ('invalid-complete',$1,$2,'Done','card','daemon-fact',$5::jsonb)`, [
      ROOM, AGENT,
      JSON.stringify({ type: 'corner-complete', cornerId: CORNER }),
      JSON.stringify({ type: 'corner-complete', cornerId: otherCorner }),
      JSON.stringify({ type: 'corner-complete', cornerId: 'invalid' }),
    ]);
    await post('own-deliverable', AGENT, 'File', { attachments: [{ name: 'file' }] });
    await post('plain', AGENT, 'No file');
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,attachments)
      VALUES('other-deliverable',$1,$2,'File','[{"name":"file"}]'::jsonb)`, [otherCorner, AGENT]);
    const ids = ['own-complete', 'other-complete', 'invalid-complete',
      'own-deliverable', 'plain', 'other-deliverable'];
    const rows = await database.query<{ id: string; addressed: boolean; direct: boolean }>(
      `SELECT m.id,${addressedToPersonSql('m', 'person.id', 'person.handle', 'person.kind')} addressed,
        ${addressedToPersonSql('m', 'person.id', 'person.handle', 'person.kind', false)} direct
       FROM messages m CROSS JOIN identities person
       WHERE person.id=$1 AND m.id=ANY($2) ORDER BY m.id`, [OWNER, ids]);
    expect(rows.rows.filter((row) => row.addressed).map((row) => row.id))
      .toEqual(['own-complete', 'own-deliverable']);
    expect(rows.rows.every((row) => !row.direct)).toBe(true);
  });

  it.each(['corner-checks-blocked', 'corner-review-deadlock', 'corner-merge-yes'])(
    'keeps a historical %s line readable without asking a person to act',
    async (cardType) => {
      await post('line', AGENT, 'Checks still fail.', {
        presentation: 'system',
        cardType,
        card: { approverIds: [OWNER] },
        at: `now()-interval '3 days'`,
      });
      await step(idle);
      await post('answer', OWNER, 'On it.');
      await step(idle);
    },
  );

  it('leaves legacy rows inert while removing all maintenance functions', async () => {
    await post('stale', AGENT, 'No request');
    await database.query(`INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,answerable,blocking)
      VALUES($1,$2,'stale',now(),true,true)`, [CORNER,OWNER]);
    await database.query(cornerOwedSchemaSql());
    expect(await facts()).toEqual(idle);
    expect((await database.query('SELECT * FROM corner_owed')).rowCount).toBe(1);
    expect((await database.query(`SELECT proname FROM pg_proc
      WHERE proname IN ('corner_owed_refresh','corner_owed_recompute_message','corner_owed_message_changed',
        'corner_owed_member_changed','corner_owed_handle_changed','corner_owed_facts_changed',
        'corner_owed_grant_changed','corner_owed_permission_changed')`)).rows).toEqual([]);
  });

  it('expires a tag after a day, including one moved back in time', async () => {
    await post('old-tag', AGENT, '@owner big or small?', { at: `now()-interval '25 hours'` });
    await step(idle);
    await post('fresh-tag', AGENT, '@owner round or square?');
    await step(owedToViewer);
    await database.query(
      `UPDATE messages SET created_at=now()-interval '25 hours' WHERE id='fresh-tag'`,
    );
    await step(idle);
  });

  it('drops a deleted tag, and owes again what a deleted answer had answered', async () => {
    await post('tag', AGENT, '@owner matte or gloss?');
    await post('answer', OWNER, 'Matte.');
    await step(idle);
    await database.query(`UPDATE messages SET deleted_at=now() WHERE id='answer'`);
    await step(owedToViewer);
    await database.query(`UPDATE messages SET deleted_at=now() WHERE id='tag'`);
    await step(idle);
  });

  it('retains a forwarded question when membership refreshes its source corner', async () => {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES('forwarded-question',$1,$2,'Choose a value','card','choice',$3::jsonb)`,
      [
        ROOM, AGENT,
        JSON.stringify({
          sourceRoomId: CORNER, mode: 'question', status: 'open', mentionIds: [OWNER],
        }),
      ],
    );
    const question = () =>
      database.query(
        `SELECT message_id FROM (${cornerOwedItemsSql('$1::uuid')}) owed WHERE person_id=$2`,
        [CORNER, OWNER],
      );
    expect((await question()).rows).toEqual([{ message_id: 'forwarded-question' }]);
    await database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, OWNER]);
    expect((await question()).rows).toEqual([]);
    await database.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [ROOM, OWNER]);
    expect((await question()).rows).toEqual([{ message_id: 'forwarded-question' }]);
    expect((await database.query('SELECT * FROM corner_owed')).rows).toEqual([]);
  });

  it('owes a later joiner what was already addressed to them, and nothing once they leave', async () => {
    await post('tag-late', AGENT, '@late can you check?');
    await step(idle);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, ROOM, LATE],
    );
    await step(owedToSomeoneElse);
    await database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, LATE],
    );
    await step(idle);
  });

  it('follows an edit that adds or removes a tag', async () => {
    await post('edited', AGENT, 'Matte or gloss?');
    await step(idle);
    await database.query(`UPDATE messages SET text='@owner matte or gloss?' WHERE id='edited'`);
    await step(owedToViewer);
    await database.query(`UPDATE messages SET text='Never mind.' WHERE id='edited'`);
    await step(idle);
  });

  it('OWED-DERIVED: a blocking tag waits for its person and clears when answered', async () => {
    await post('blocking-tag', AGENT, 'needs-decision: @owner matte or gloss?');
    await step(blockingToViewer);
    await post('blocking-answer', OWNER, 'Matte');
    await step(idle);
  });

  it('OWED-DERIVED: keeps a question older than 24 hours owed with zero stored rows', async () => {
    await post('old-question', AGENT, 'Pick one', { presentation: 'card', cardType: 'choice',
      card: { mode: 'question', status: 'open', requester: { pubkey: OWNER } },
      at: `now()-interval '3 days'` });
    await step(blockingToViewer);
  });

  it('OWED-DERIVED: expires an item at its explicit deadline', async () => {
    await post('expiring', AGENT, 'needs-decision: @owner choose', {
      card: { expiresAt: Date.now()+60_000 },
    });
    await step(blockingToViewer);
    await database.query(`UPDATE messages SET card=jsonb_set(card,'{expiresAt}',to_jsonb($1::bigint))
      WHERE id='expiring'`, [Date.now()-1]);
    await step(idle);
  });

  it('OWED-DERIVED: counts a report from another Room and clears it when answered there', async () => {
    await database.query(`INSERT INTO agent_commands(id,room_id,agent_id,reason,private_payload,turn_request_id,root_command_id,root_source_message_id,agent_depth,action,state)
      VALUES('report-command',$1,$2,'report',$3::jsonb,'report-command','report-command','report-command',0,'input','complete')`, [CORNER,AGENT,
      JSON.stringify({ kind: 'report', originCornerId: CORNER })]);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,request_id)
      VALUES('cross-room-report',$1,$2,'needs-decision: @owner choose','report-command')`, [ROOM,AGENT]);
    await step(blockingToViewer);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      VALUES('cross-room-answer',$1,$2,'Choose matte',now()+interval '1 second')`, [ROOM,OWNER]);
    await step(idle);
    await database.query(`UPDATE messages SET deleted_at=now() WHERE id='cross-room-answer'`);
    await step(blockingToViewer);
  });

  it('OWED-DERIVED: archived corners owe nothing and derive again when reopened', async () => {
    await post('open-ask', AGENT, 'needs-decision: @owner choose');
    await step(blockingToViewer);
    await database.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [CORNER]);
    expect((await phone.readRoom(CORNER,OWNER))?.cornerOwed).toBe(false);
    expect((await database.query(`SELECT * FROM (${cornerOwedItemsSql('$1::uuid')}) owed`, [CORNER])).rows).toEqual([]);
    await database.query('UPDATE rooms SET archived_at=NULL WHERE id=$1', [CORNER]);
    await step(blockingToViewer);
  });

  it('OWED-DERIVED: uses indexed message probes for the corner-list owed read', async () => {
    const queries: { sql: string; values: unknown[] }[] = [];
    const spy = new PhoneService({
      query: (sql: string, values?: unknown[]) => {
        queries.push({ sql, values: values ?? [] });
        return database.query(sql, values);
      },
      transaction: (work) => database.transaction(work),
    } as SqlDatabase, ORIGIN);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text)
      SELECT 'history-' || n,$1,$2,'Unrelated history' FROM generate_series(1,2500) n`, [ROOM,AGENT]);
    await post('tag', AGENT, 'needs-decision: @owner matte or gloss?');
    await database.query('ANALYZE messages');
    await spy.readChats(WORKSPACE, OWNER);
    const corners = queries.find(query => query.sql.includes('candidate_items'))!;
    expect(corners).toBeDefined();
    const plan = await database.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON) ${corners.sql}`, corners.values);
    const scans: Record<string, unknown>[] = [];
    const indexes: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (node['Relation Name'] === 'messages') scans.push(node);
      if (typeof node['Index Name'] === 'string') indexes.push(node['Index Name']);
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    const root = plan.rows[0]!['QUERY PLAN'];
    walk((typeof root === 'string' ? JSON.parse(root) : root)[0].Plan);
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.filter(scan => scan['Node Type'] === 'Seq Scan')).toEqual([]);
    expect(indexes).toContain('messages_room_page_idx');
    expect(indexes).toContain('messages_source_room_idx');
    expect(scans.some(scan => String(scan['Index Cond']).includes('request_id = report'))).toBe(true);
    expect(scans.filter(scan => scan['Index Name'] === 'messages_pkey' && !scan['Index Cond'])).toEqual([]);
    expect(indexes).toContain('messages_room_author_answer_idx');
    expect((await database.query('SELECT * FROM corner_owed')).rows).toEqual([]);
  });
  afterEach(async () => { await database.close(); });
});
