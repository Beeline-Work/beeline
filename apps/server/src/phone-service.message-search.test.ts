import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { messageSearchTerms, PhoneService } from './phone-service.js';

const VIEWER = 'a'.repeat(64);
const SOL = 'b'.repeat(64);
const STRANGER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '11111111-1111-4111-8111-111111111112';
const ROOM = '22222222-2222-4222-8222-222222222221';
const DIRECT = '22222222-2222-4222-8222-222222222222';
const NEVER_JOINED = '22222222-2222-4222-8222-222222222223';
const LEFT = '22222222-2222-4222-8222-222222222224';
const CORNER = '22222222-2222-4222-8222-222222222225';
const ARCHIVED = '22222222-2222-4222-8222-222222222226';
const ELSEWHERE = '22222222-2222-4222-8222-222222222227';

let database: PgliteDatabase;
let phone: PhoneService;
let sequence = 0;

async function message(
  roomId: string,
  text: string,
  createdAt: string,
  extra: { authorId?: string; presentation?: string; deleted?: boolean } = {},
) {
  sequence += 1;
  const id = sequence.toString(16).padStart(64, '0');
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at,deleted_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      roomId,
      extra.authorId ?? SOL,
      text,
      extra.presentation ?? 'message',
      createdAt,
      extra.deleted ? createdAt : null,
    ],
  );
  return id;
}

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Ada','ada'),($2,'agent','Sol','sol'),($3,'human','Eve','eve')`,
    [VIEWER, SOL, STRANGER],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive'),($2,'Other')`, [
    WORKSPACE,
    OTHER_WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,parent_id,archived_at,direct_participants) VALUES
      ($1,$8,$9,'mobile',NULL,NULL,NULL),
      ($2,$8,$9,'dm',NULL,NULL,jsonb_build_array($9::text,$10::text)),
      ($3,$8,$9,'private',NULL,NULL,NULL),
      ($4,$8,$9,'old-team',NULL,NULL,NULL),
      ($5,$8,$9,'corner',$1,NULL,NULL),
      ($6,$8,$9,'archived',NULL,now(),NULL),
      ($7,$11,$9,'elsewhere',NULL,NULL,NULL)`,
    [ROOM, DIRECT, NEVER_JOINED, LEFT, CORNER, ARCHIVED, ELSEWHERE, WORKSPACE, VIEWER, SOL, OTHER_WORKSPACE],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role,removed_at) VALUES
      ($1,NULL,$2,'member',NULL),($1,$3,$2,'member',NULL),($1,$4,$2,'member',NULL),
      ($1,$5,$2,'member',now()),($1,$6,$2,'member',NULL),($1,$7,$2,'member',NULL),
      ($1,$8,$9,'member',NULL),($10,NULL,$2,'member',NULL),($10,$11,$2,'member',NULL)`,
    [WORKSPACE, VIEWER, ROOM, DIRECT, LEFT, CORNER, ARCHIVED, NEVER_JOINED, STRANGER, OTHER_WORKSPACE, ELSEWHERE],
  );
  phone = new PhoneService(database, 'http://local.test');
});

describe('searchMessages', () => {
  it('finds a message in the Room list Rooms and direct messages, newest first, with the words marked', async () => {
    const older = await message(ROOM, 'Looks good on Android. The build number shows.', '2026-09-01T10:00:00Z');
    const newer = await message(DIRECT, 'Release proof for the Android build is attached.', '2026-09-02T10:00:00Z', {
      authorId: VIEWER,
    });
    await message(ROOM, 'Nothing to see', '2026-09-03T10:00:00Z');

    const view = await phone.searchMessages(WORKSPACE, VIEWER, 'andro bui');

    expect(view?.results.map((result) => result.messageId)).toEqual([newer, older]);
    expect(view?.nextBefore).toBeUndefined();
    const [direct, room] = view!.results;
    expect(direct).toMatchObject({
      roomId: DIRECT,
      roomName: 'sol',
      directMessage: true,
      authorName: 'Ada',
      createdAt: Date.parse('2026-09-02T10:00:00Z') / 1_000,
    });
    expect(direct!.snippet.map((part) => part.text).join('')).toBe(
      'Release proof for the Android build is attached.',
    );
    expect(room).toMatchObject({ roomId: ROOM, roomName: 'mobile', directMessage: false, authorName: 'Sol' });
    expect(room!.snippet.filter((part) => part.match).map((part) => part.text)).toEqual([
      'Android',
      'build',
    ]);
    expect(room!.snippet.map((part) => part.text).join('')).toBe(
      'Looks good on Android. The build number shows.',
    );
  });

  it('never searches a Room the viewer left or never joined, a corner, an archived Room, or another Workspace', async () => {
    const visible = await message(ROOM, 'release proof', '2026-09-01T10:00:00Z');
    await message(NEVER_JOINED, 'release proof', '2026-09-01T10:00:01Z', { authorId: STRANGER });
    await message(LEFT, 'release proof', '2026-09-01T10:00:02Z');
    await message(CORNER, 'release proof', '2026-09-01T10:00:03Z');
    await message(ARCHIVED, 'release proof', '2026-09-01T10:00:04Z');
    await message(ELSEWHERE, 'release proof', '2026-09-01T10:00:05Z');

    const view = await phone.searchMessages(WORKSPACE, VIEWER, 'release');

    expect(view?.results.map((result) => result.messageId)).toEqual([visible]);
  });

  it('skips deleted messages and rows that are not messages', async () => {
    const kept = await message(ROOM, 'deploy finished', '2026-09-01T10:00:00Z');
    await message(ROOM, 'deploy finished', '2026-09-01T10:00:01Z', { deleted: true });
    await message(ROOM, 'deploy finished', '2026-09-01T10:00:02Z', { presentation: 'system' });

    const view = await phone.searchMessages(WORKSPACE, VIEWER, 'deploy');

    expect(view?.results.map((result) => result.messageId)).toEqual([kept]);
  });

  it('pages 20 at a time, newest first, without repeating a result', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 25; index += 1)
      ids.push(await message(ROOM, `scrubber note ${index}`, `2026-09-01T10:00:${String(index).padStart(2, '0')}Z`));
    const newestFirst = [...ids].reverse();

    const first = await phone.searchMessages(WORKSPACE, VIEWER, 'scrubber');
    expect(first?.results.map((result) => result.messageId)).toEqual(newestFirst.slice(0, 20));
    expect(first?.nextBefore).toBe(newestFirst[19]);

    const second = await phone.searchMessages(WORKSPACE, VIEWER, 'scrubber', first!.nextBefore);
    expect(second?.results.map((result) => result.messageId)).toEqual(newestFirst.slice(20));
    expect(second?.nextBefore).toBeUndefined();
  });

  it('answers null outside the Workspace and an empty page for a query with no words', async () => {
    await message(ROOM, 'anything', '2026-09-01T10:00:00Z');
    expect(await phone.searchMessages(WORKSPACE, STRANGER, 'anything')).toBeNull();
    expect(await phone.searchMessages(WORKSPACE, VIEWER, '!!! ???')).toEqual({
      workspaceId: WORKSPACE,
      results: [],
    });
  });
});

describe('messageSearchTerms', () => {
  it('turns every word into a quoted prefix term and drops punctuation', () => {
    expect(messageSearchTerms("Android's  build!")).toBe("'android':* & 's':* & 'build':*");
    expect(messageSearchTerms("x' | y:* & !z")).toBe("'x':* & 'y':* & 'z':*");
    expect(messageSearchTerms('   ')).toBeNull();
    expect(messageSearchTerms('a b c d e f g h i j')?.split(' & ')).toHaveLength(8);
  });
});
