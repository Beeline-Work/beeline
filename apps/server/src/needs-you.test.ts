import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import {
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
    expect(items.map((item) => item.messageId)).toEqual([please, question]);
    expect(items[0]).toMatchObject({
      roomId: CORNER,
      roomName: 'release-ios-signing',
      roomKind: 'corner',
      text: 'The release check needs a grant — please approve it.',
      author: { name: 'Hoots' },
    });
    expect(items[1]).toMatchObject({
      roomKind: 'room',
      roomName: 'Launch room',
      text: 'can you confirm the review note?',
    });
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
          grants: [{ grantId: GRANT, kind: 'command', target: 'gh pr checks', status: 'pending' }],
        }),
      ],
    );
    const [item] = (await read()).items;
    expect(item).toMatchObject({ messageId: card, text: 'Allow Hoots to run gh pr checks' });
    expect(item!.expiresAt).toBeUndefined();

    // A person who cannot decide it never sees it.
    expect((await phone.execute('countNeedsYou', { workspaceId: WORKSPACE }, PEER)).count).toBe(0);

    await phone.execute('decideAgentGrant', { grantId: GRANT, decision: 'once' }, VIEWER);
    expect(await count()).toBe(0);
  });
});
