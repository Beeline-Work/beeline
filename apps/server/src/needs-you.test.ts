import { readWorkspaceListView } from '@beeline/api-contract/phone';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import {
  askSql,
  isNeedsYouAsk,
  keepEnd,
  needsYouRowText,
  needsYouSentence,
  withoutReaderTags,
} from './needs-you.js';
import { PgliteDatabase } from './test-support.js';

describe('the Needs-you ask rule', () => {
  it('asks when the text ends with a question mark or says please, approve or feedback', () => {
    expect(isNeedsYouAsk('@ada can you look at this?')).toBe(true);
    expect(isNeedsYouAsk('@ada can you look at this?  ')).toBe(true);
    expect(isNeedsYouAsk('@ada please look at this')).toBe(true);
    expect(isNeedsYouAsk('@ada Please look')).toBe(true);
    expect(isNeedsYouAsk('@ada approve the release')).toBe(true);
    expect(isNeedsYouAsk('@ada I would love your feedback.')).toBe(true);
    expect(isNeedsYouAsk('@ada this release train is cursed')).toBe(false);
    // A question in the middle is not the rule: the message must END with it.
    expect(isNeedsYouAsk('@ada is this ok? I think so.')).toBe(false);
    // Whole words only: "approved" reports, it does not ask.
    expect(isNeedsYouAsk('@ada I approved it')).toBe(false);
  });

  it('picks the asking sentence: the closing question, else the last trigger sentence', () => {
    expect(needsYouSentence('Build is green. @ada can you ship it?')).toBe('@ada can you ship it?');
    expect(needsYouSentence('@ada please review the copy. Thanks, it is short.')).toBe(
      '@ada please review the copy.',
    );
    expect(needsYouSentence('Line one\n@ada approve the deploy')).toBe('@ada approve the deploy');
  });

  it('drops only the reader tag and tidies what it leaves', () => {
    expect(withoutReaderTags('@ada please approve the release check command', 'ada')).toBe(
      'please approve the release check command',
    );
    expect(withoutReaderTags('@ada, can you ask @hoots to rerun it?', 'ada')).toBe(
      'can you ask @hoots to rerun it?',
    );
    expect(withoutReaderTags('Thanks @ada.', 'ada')).toBe('Thanks.');
    expect(withoutReaderTags('@channel please vote?', 'ada')).toBe('please vote?');
    expect(withoutReaderTags('@adam please', 'ada')).toBe('@adam please');
  });

  it('keeps the END of a long sentence behind a leading ellipsis, cut on a word', () => {
    const long =
      'thanks — one thing before I sign off after the long review: can you confirm the App Store review note before we ship?';
    const short = keepEnd(long, 60);
    expect(short.startsWith('… ')).toBe(true);
    expect(short.endsWith('before we ship?')).toBe(true);
    expect(Array.from(short).length).toBeLessThanOrEqual(60);
    expect(short.slice(2)).toBe(long.slice(long.length - (short.length - 2)));
    expect(long.charAt(long.length - (short.length - 2) - 1)).toBe(' ');
    expect(keepEnd('short enough?', 60)).toBe('short enough?');
    expect(
      needsYouRowText(
        `@ada thanks — one thing before I sign off: can you confirm the App Store review note before we ship?`,
        'ada',
      ),
    ).toBe('… before I sign off: can you confirm the App Store review note before we ship?');
  });
});

describe('the ask rule in SQL', () => {
  it('reads every message exactly as isNeedsYouAsk does', async () => {
    const database = new PgliteDatabase();
    const samples = [
      '@ada can you look?',
      '@ada can you look?  \n',
      '@ada is this ok? I think so.',
      '@ada please look',
      '@ada PLEASE look',
      '@ada Please.',
      'please',
      '@ada I approved it',
      '@ada approve the deploy',
      '@ada approves',
      '@ada feedback welcome',
      '@ada feedbacks',
      '@ada re-approve it',
      '@ada approve_now',
      '@ada approve2',
      '@ada this release train is cursed',
      '@ada ?!',
      '@ada ¿qué? please',
    ];
    for (const text of samples) {
      const row = (
        await database.query<{ asks: boolean }>(`SELECT ${askSql('$1::text')} asks`, [text])
      ).rows[0];
      expect({ text, asks: row?.asks }).toEqual({ text, asks: isNeedsYouAsk(text) });
    }
  });
});

const VIEWER = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const OTHER_ROOM = '44444444-4444-4444-8444-444444444444';
const GRANT = '55555555-5555-4555-8555-555555555555';

describe('PhoneService Needs-you tray', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;
  let sequence = 0;

  async function post(
    roomId: string,
    authorId: string,
    text: string,
    ageMinutes = 10,
  ): Promise<string> {
    sequence += 1;
    const id = sequence.toString(16).padStart(64, '0');
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES($1,$2,$3,$4,now() - $5 * interval '1 minute')`,
      [id, roomId, authorId, text, ageMinutes],
    );
    return id;
  }
  const read = () => phone.execute('readNeedsYou', { workspaceId: WORKSPACE }, VIEWER);
  const count = async () =>
    (await phone.execute('countNeedsYou', { workspaceId: WORKSPACE }, VIEWER)).count;

  beforeEach(async () => {
    sequence = 0;
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Ada','ada'),($2,'human','Juniper','juniper'),($3,'agent','Hoots','hoots')`,
      [VIEWER, PEER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, VIEWER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES
         ($1,$4,NULL,'Launch room'),($2,$4,$1,'release-ios-signing'),($3,$4,NULL,'Elsewhere')`,
      [ROOM, CORNER, OTHER_ROOM, WORKSPACE],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
         ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member'),
         ($1,$6,$2,'owner'),($1,$6,$4,'member'),
         ($1,$7,$3,'member')`,
      [WORKSPACE, VIEWER, PEER, AGENT, ROOM, CORNER, OTHER_ROOM],
    );
    phone = new PhoneService(database, 'https://server.example');
  });

  it('R12e: projects the switcher room count and unread/approval mark', async () => {
    expect((await phone.readWorkspaces(VIEWER)).workspaces[0]).toMatchObject({
      roomCount: 1,
      attention: false,
    });
    await post(ROOM, PEER, 'New message');
    const projected = readWorkspaceListView(await phone.readWorkspaces(VIEWER))!.workspaces[0];
    const deck = await phone.readChats(WORKSPACE, VIEWER);
    expect(projected).toMatchObject({
      roomCount: deck!.chats.length,
      attention: deck!.chats.some((room) => room.unread || room.agentState === 'needs-you'),
    });
    await database.query(
      `INSERT INTO room_read_marks(room_id,identity_id,message_id,message_created_at)
       SELECT room_id,$1,id,created_at FROM messages WHERE room_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [VIEWER, ROOM],
    );
    expect((await phone.readWorkspaces(VIEWER)).workspaces[0]?.attention).toBe(false);
    await database.query(
      `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
       VALUES('approval',$1,$2,'request','{}','pending')`,
      [CORNER, AGENT],
    );
    expect((await phone.readWorkspaces(VIEWER)).workspaces[0]?.attention).toBe(true);
  });

  it('holds a message only when it both tags the reader and asks', async () => {
    await post(ROOM, VIEWER, 'my own question @juniper?', 40);
    const question = await post(ROOM, PEER, '@ada can you confirm the review note?', 30);
    const please = await post(
      CORNER,
      AGENT,
      'The release check needs a grant — @ada please approve it.',
      20,
    );
    await post(ROOM, PEER, 'lol @ada this release train is cursed', 15);
    await post(ROOM, PEER, 'Should we ship before Friday?', 12);
    await post(OTHER_ROOM, PEER, '@ada are you in here?', 5);

    const { items } = await read();
    // Oldest first: nothing has started a clock yet.
    expect(items.map((item) => item.messageId)).toEqual([question, please]);
    expect(items[1]).toMatchObject({
      roomId: CORNER,
      roomName: 'release-ios-signing',
      roomKind: 'corner',
      parentRoomName: 'Launch room',
      text: 'The release check needs a grant — please approve it.',
      author: { name: 'Hoots' },
    });
    expect(items[0]).toMatchObject({
      roomKind: 'room',
      roomName: 'Launch room',
      text: 'can you confirm the review note?',
    });
    expect(items[0]!.approval).toBeUndefined();
  });

  it('starts the 24-hour clock on the first read, never on the badge count', async () => {
    const id = await post(ROOM, PEER, '@ada can you look?');
    expect(await count()).toBe(1);
    expect(
      (await database.query(`SELECT 1 FROM needs_you_marks WHERE message_id=$1`, [id])).rowCount,
    ).toBe(0);

    const first = (await read()).items[0]!;
    expect(first.expiresAt).toBeGreaterThan(Date.now() / 1000 + 23 * 3600);
    const again = (await read()).items[0]!;
    expect(again.expiresAt).toBe(first.expiresAt);

    // Seen 25 hours ago, on whatever device: gone everywhere.
    await database.query(
      `UPDATE needs_you_marks SET first_seen_at=now() - interval '25 hours' WHERE message_id=$1`,
      [id],
    );
    expect((await read()).items).toEqual([]);
    expect(await count()).toBe(0);
  });

  it('clears on tap or dismiss, and when the reader replies in that Room', async () => {
    const tapped = await post(ROOM, PEER, '@ada please check the build', 30);
    await post(CORNER, AGENT, '@ada which cohort?', 20);
    expect(await count()).toBe(2);

    await phone.execute('clearNeedsYou', { workspaceId: WORKSPACE, messageId: tapped }, VIEWER);
    await phone.execute('clearNeedsYou', { workspaceId: WORKSPACE, messageId: tapped }, VIEWER);
    expect((await read()).items.map((item) => item.roomId)).toEqual([CORNER]);

    await post(CORNER, VIEWER, 'the first one', 1);
    expect(await count()).toBe(0);
  });

  it('never lets newer near-miss messages crowd out an older real ask', async () => {
    const ask = await post(ROOM, PEER, '@ada please review the release notes', 60);
    // More near-misses than the query's candidate limit, all newer than the ask:
    // each tags the reader and holds "approved", which is not the word "approve".
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT lpad(to_hex(1000000 + series),64,'0'),$1,$2,'@ada I approved it',
         now() - interval '30 minutes' + series * interval '1 millisecond'
       FROM generate_series(1,600) series`,
      [ROOM, PEER],
    );
    expect((await read()).items.map((item) => item.messageId)).toEqual([ask]);
    expect(await count()).toBe(1);
  });

  it('refuses to clear a message the reader cannot see', async () => {
    const hidden = await post(OTHER_ROOM, PEER, 'secret');
    await expect(
      phone.execute('clearNeedsYou', { workspaceId: WORKSPACE, messageId: hidden }, VIEWER),
    ).rejects.toThrow('message is not available');
  });

  it('shows a pending grant card the reader can decide, with no expiry, until decided', async () => {
    await database.query(
      `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,created_at)
       VALUES($1,$2,$3,'command','gh pr checks','watch CI',$2,$4,'pending',now() - interval '3 days')`,
      [GRANT, AGENT, WORKSPACE, ROOM],
    );
    const card = 'e'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
       VALUES($1,$2,$3,'Hoots asks Ada','card','grant-request',$4::jsonb,now() - interval '3 days')`,
      [
        card,
        ROOM,
        AGENT,
        JSON.stringify({
          agent: { pubkey: AGENT, kind: 'agent', name: 'Hoots' },
          requester: { pubkey: PEER, kind: 'human', name: 'Juniper' },
          grants: [
            {
              grantId: GRANT,
              kind: 'command',
              target: 'gh pr checks',
              reason: 'watch CI',
              status: 'pending',
            },
          ],
        }),
      ],
    );
    const [item] = (await read()).items;
    expect(item).toMatchObject({
      messageId: card,
      text: 'Hoots asks to run gh pr checks',
      approval: {
        kind: 'grant',
        actor: 'Hoots',
        ask: 'asks to run',
        subject: 'gh pr checks',
        literal: true,
        detail: 'watch CI',
        forName: 'Juniper',
      },
    });
    expect(item!.expiresAt).toBeUndefined();

    // Opening it (the tray's tap) does not clear an approval.
    await phone.execute('clearNeedsYou', { workspaceId: WORKSPACE, messageId: card }, VIEWER);
    expect(await count()).toBe(1);

    // A person who cannot decide it never sees it.
    expect((await phone.execute('countNeedsYou', { workspaceId: WORKSPACE }, PEER)).count).toBe(0);

    await phone.execute('decideAgentGrant', { grantId: GRANT, decision: 'once' }, VIEWER);
    expect(await count()).toBe(0);
  });
  async function card(
    roomId: string,
    cardType: string,
    body: Record<string, unknown>,
    ageMinutes = 10,
    authorId = AGENT,
  ): Promise<string> {
    sequence += 1;
    const id = `card-${sequence}`.padEnd(64, '0');
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
       VALUES($1,$2,$3,'card','card',$4,$5::jsonb,now() - $6 * interval '1 minute')`,
      [id, roomId, authorId, cardType, JSON.stringify(body), ageMinutes],
    );
    return id;
  }
  const hoots = { pubkey: AGENT, kind: 'agent', name: 'Hoots' };
  const approvals = async (viewer = VIEWER) =>
    (await phone.execute('readNeedsYou', { workspaceId: WORKSPACE }, viewer)).items
      .filter((item) => item.approval)
      .map((item) => item.approval);

  it('shows a pending write-access request to the person asked, until it is decided', async () => {
    await database.query(
      `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
       VALUES('write-1',$1,$2,'request-1','{}','pending')`,
      [CORNER, VIEWER],
    );
    await card(CORNER, 'permission', {
      permissionId: 'write-1',
      requestId: 'request-1',
      agent: hoots,
      requester: { pubkey: VIEWER, kind: 'human', name: 'Ada' },
      tool: 'git',
      repository: 'owner/beeline',
      status: 'pending',
    });
    expect(await approvals()).toEqual([
      {
        kind: 'write-access',
        actor: 'Hoots',
        ask: 'asks for write access to',
        subject: 'owner/beeline',
        literal: true,
      },
    ]);
    expect(await approvals(PEER)).toEqual([]);
    await database.query(`UPDATE permission_authority SET status='authorized'`);
    expect(await approvals()).toEqual([]);
  });

  it('shows an open question addressed to the reader with its options and close time', async () => {
    const closesAt = Math.floor(Date.now() / 1000) + 6 * 3600;
    const id = await card(ROOM, 'choice', {
      choiceId: '66666666-6666-4666-8666-666666666666',
      mode: 'question',
      status: 'open',
      agent: hoots,
      prompt: 'Ship the OTA tonight?',
      options: [{ label: 'Ship now' }, { label: 'Wait for the voice fix' }],
      mentionIds: [VIEWER],
    });
    await database.query(
      `INSERT INTO room_choices(id,room_id,workspace_id,agent_id,message_id,mode,prompt,options,electorate,closes_at,status)
       VALUES('66666666-6666-4666-8666-666666666666',$1,$2,$3,$4,'question','Ship the OTA tonight?','[]',
         ARRAY[$5,$6],to_timestamp($7),'open')`,
      [ROOM, WORKSPACE, AGENT, id, VIEWER, PEER, closesAt],
    );
    const [item] = (await read()).items;
    expect(item).toMatchObject({
      messageId: id,
      expiresAt: closesAt,
      approval: {
        kind: 'choice',
        ask: 'asks you to choose',
        subject: 'Ship the OTA tonight?',
        detail: 'Ship now · Wait for the voice fix',
      },
    });
    // Addressed to the reader only.
    expect(await approvals(PEER)).toEqual([]);
    await database.query(`UPDATE room_choices SET status='answered'`);
    expect(await approvals()).toEqual([]);
  });

  it('shows a pending connector offer, webhook request and sign-in to the person who decides each', async () => {
    const offerMessage = await card(
      ROOM,
      'connector-offer',
      {
        agent: hoots,
        connectorName: 'Gmail',
        reason: 'Read the release thread.',
        status: 'pending',
      },
      30,
    );
    await database.query(
      `INSERT INTO connector_offers(id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id,message_id)
       VALUES('77777777-7777-4777-8777-777777777777',$1,$2,$3,$4,'gmail','Read the release thread.','machine',$5)`,
      [AGENT, WORKSPACE, ROOM, VIEWER, offerMessage],
    );
    const webhookMessage = await card(
      ROOM,
      'webhook-request',
      {
        agentName: 'Hoots',
        source: 'github',
        reason: 'Watch release tags.',
        status: 'pending',
      },
      20,
    );
    await database.query(
      `INSERT INTO room_webhook_requests(id,room_id,agent_id,source,reason,request_id,message_id)
       VALUES('88888888-8888-4888-8888-888888888888',$1,$2,'github','Watch release tags.','request',$3)`,
      [ROOM, AGENT, webhookMessage],
    );
    await card(
      ROOM,
      'agent-sign-in',
      {
        agentId: AGENT,
        ownerId: VIEWER,
        harness: 'claude',
        status: 'pending',
      },
      10,
      VIEWER,
    );

    const items = (await read()).items;
    // The webhook request expires, so it leads; then the oldest.
    expect(items.map((item) => item.approval?.kind)).toEqual(['webhook', 'connector', 'sign-in']);
    expect(items.map((item) => item.approval)).toEqual([
      {
        kind: 'webhook',
        actor: 'Hoots',
        ask: 'asks for a webhook from',
        subject: 'github',
        literal: true,
        detail: 'Watch release tags.',
      },
      {
        kind: 'connector',
        actor: 'Hoots',
        ask: 'asks to connect',
        subject: 'Gmail',
        literal: false,
        detail: 'Read the release thread.',
      },
      {
        kind: 'sign-in',
        actor: 'Hoots',
        ask: 'needs you to sign in to',
        subject: 'Claude',
        literal: false,
      },
    ]);
    expect(items[0]!.expiresAt).toBeGreaterThan(Date.now() / 1000 + 6 * 24 * 3600);
    // A plain member decides none of them.
    expect(await approvals(PEER)).toEqual([]);
  });

  it('holds a Trusty Squire approval until its decision lands in the source Room', async () => {
    await card(ROOM, 'squire-approval', {
      agent: hoots,
      tool: 'fetch_credential',
      title: 'Reveal GROQ_API_KEY',
      detail: 'Write it into the push gateway secret.',
      approvalUrl: 'https://squire.example/approve/1',
      approvalId: 'approval-1',
      linkKind: 'passkey',
      sourceRoomId: CORNER,
    });
    expect(await approvals()).toEqual([
      {
        kind: 'squire',
        actor: 'Hoots',
        ask: 'needs your passkey for',
        subject: 'Reveal GROQ_API_KEY',
        literal: false,
        detail: 'Write it into the push gateway secret.',
      },
    ]);
    await card(CORNER, 'squire-approval-decision', {
      approvalId: 'approval-1',
      status: 'approved',
    });
    expect(await approvals()).toEqual([]);
  });

  it('lists approvals before questions', async () => {
    const question = await post(ROOM, PEER, '@ada can you look?', 60);
    await database.query(
      `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
       VALUES('write-2',$1,$2,'request-2','{}','pending')`,
      [CORNER, VIEWER],
    );
    const approval = await card(
      CORNER,
      'permission',
      {
        permissionId: 'write-2',
        agent: hoots,
        repository: 'owner/beeline',
        status: 'pending',
      },
      5,
    );
    expect((await read()).items.map((item) => item.messageId)).toEqual([approval, question]);
  });
});
