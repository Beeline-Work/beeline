import { beforeEach, describe, expect, it } from 'vitest';
import { backfillCornerOwed, migrate, type SqlDatabase } from './database.js';
import { cornerOwedBackfillSql } from './corner-owed.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

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
  page: { state: string; awaitsViewer: boolean };
  /** The corner header's `cornerOwed`. */
  header: boolean | undefined;
};

describe('corner_owed', () => {
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
      page: { state: page?.state ?? 'missing', awaitsViewer: page?.awaitsViewer === true },
      header,
    };
  };
  const idle: Facts = {
    list: { state: 'idle', attention: false },
    page: { state: 'idle', awaitsViewer: false },
    header: false,
  };
  const owedToViewer: Facts = {
    list: { state: 'waiting', attention: true },
    page: { state: 'waiting', awaitsViewer: true },
    header: true,
  };
  const owedToViewerSeen: Facts = {
    list: { state: 'waiting', attention: false },
    page: { state: 'waiting', awaitsViewer: true },
    header: true,
  };
  const owedToSomeoneElse: Facts = {
    list: { state: 'waiting', attention: false },
    page: { state: 'waiting', awaitsViewer: false },
    header: true,
  };

  /**
   * The triggers' incremental rows equal the rows recomputed from scratch
   * by the rule the backfill reads (the old per-read scan's rule).
   */
  const expectTableMatchesMessages = async () => {
    const owed = `SELECT corner_id::text,person_id,message_id FROM %s
      WHERE expires_at IS NULL OR expires_at>now() ORDER BY 1,2,3`;
    await database.query(`DROP TABLE IF EXISTS corner_owed_expected`);
    await database.query(`CREATE TEMP TABLE corner_owed_expected (LIKE corner_owed)`);
    await database.query(
      cornerOwedBackfillSql().replace(
        'INSERT INTO corner_owed(',
        'INSERT INTO corner_owed_expected(',
      ),
    );
    const actual = await database.query(owed.replace('%s', 'corner_owed'));
    const expected = await database.query(owed.replace('%s', 'corner_owed_expected'));
    expect(actual.rows).toEqual(expected.rows);
  };

  const step = async (expected: Facts, viewer = OWNER) => {
    expect(await facts(viewer)).toEqual(expected);
    await expectTableMatchesMessages();
  };

  beforeEach(async () => {
    clock = 0;
    database = new PgliteDatabase();
    await migrate(database);
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
    for (const id of [OWNER, OTHER, AGENT, LATE])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,$3),($1,$4,$2,$3)`,
        [WORKSPACE, id, id === OWNER ? 'owner' : 'member', ROOM],
      );
    for (const id of [OWNER, OTHER, AGENT])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WORKSPACE, CORNER, id],
      );
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,lane)
       VALUES($1,$2,$3,'no_code')`,
      [CORNER, AGENT, OWNER],
    );
  });

  it('reads a tag owed until the person posts, and attention only until they open the corner', async () => {
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

  it('reads what is owed to another member as waiting, without pulling the viewer', async () => {
    await post('tag-other', AGENT, '@other matte or gloss?');
    await step(owedToSomeoneElse);
    await step(
      {
        list: { state: 'waiting', attention: true },
        page: { state: 'waiting', awaitsViewer: true },
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
    await step(owedToViewer);
    await post('chatter', OWNER, 'Let me think.');
    await step(owedToViewer);
    await database.query(
      `UPDATE messages SET card=jsonb_set(card,'{status}','"answered"') WHERE id='question'`,
    );
    await step(idle);

    await post('question-2', AGENT, 'Hinged or loose?', {
      presentation: 'card',
      cardType: 'choice',
      card: question('open'),
    });
    await step(owedToViewer);
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
    await step(owedToViewer);
    await post('chatter', OWNER, 'Looking.');
    await step(owedToViewer);
    await database.query(`UPDATE agent_grants SET status='approved' WHERE id=$1`, [grantId]);
    await step(idle);
  });

  it('owes a no-code deliverable to its commissioner for a day, until they post', async () => {
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

  it.each(['corner-checks-blocked', 'corner-review-deadlock'])(
    'keeps a %s line owed past a day, until the person posts',
    async (cardType) => {
      await post('line', AGENT, 'Checks still fail.', {
        presentation: 'system',
        cardType,
        at: `now()-interval '3 days'`,
      });
      await step(owedToViewer);
      await post('answer', OWNER, 'On it.');
      await step(idle);
    },
  );

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

  it('owes a later joiner what was already addressed to them, and nothing once they leave', async () => {
    await post('tag-late', AGENT, '@late can you check?');
    await step(idle);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, CORNER, LATE],
    );
    await step(owedToSomeoneElse);
    await database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [CORNER, LATE],
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

  it('backfills what is already owed when the release adds the table', async () => {
    await post('tag', AGENT, '@owner matte or gloss?');
    await post('tag-other', AGENT, '@other gloss?');
    await database.query(`DELETE FROM corner_owed`);
    expect(await facts()).toEqual(idle);
    await backfillCornerOwed(database);
    await step(owedToViewer);
  });

  it('reads chat-list owed facts from corner_owed without reading messages', async () => {
    const queries: { sql: string; values: unknown[] }[] = [];
    const spy = new PhoneService(
      {
        query: (sql: string, values?: unknown[]) => {
          queries.push({ sql, values: values ?? [] });
          return database.query(sql, values);
        },
        transaction: (work) => database.transaction(work),
      } as SqlDatabase,
      ORIGIN,
    );
    await post('tag', AGENT, '@owner matte or gloss?');
    await spy.readChats(WORKSPACE, OWNER);
    const corners = queries.find((query) => query.sql.includes('FROM corner_owed'));
    expect(corners).toBeDefined();
    const plan = await database.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON) ${corners!.sql}`,
      corners!.values,
    );
    const scans: { relation: string; alias: string }[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (typeof node['Relation Name'] === 'string')
        scans.push({ relation: node['Relation Name'], alias: String(node.Alias) });
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    const root = plan.rows[0]!['QUERY PLAN'];
    walk((typeof root === 'string' ? JSON.parse(root) : root)[0].Plan);
    expect(scans).toContainEqual({ relation: 'corner_owed', alias: 'owed_item' });
    // The only messages read is each corner's latest message, for its state.
    expect(scans.filter((scan) => scan.relation === 'messages')).toEqual([
      { relation: 'messages', alias: 'messages' },
    ]);
  });
});
