import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

// Optional production-sized proof uses only a disposable loopback database.
const postgresUrl = process.env.BEELINE_INVITE_TEST_POSTGRES_URL;
if (postgresUrl && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('invite proof requires isolated loopback PostgreSQL');

it('redeems an invite with historical corners without scanning unrelated message history per join', async () => {
  const schema = `invite_${randomUUID().replaceAll('-', '')}`;
  const admin = postgresUrl ? new Pool({ connectionString: postgresUrl }) : undefined;
  await admin?.query(`CREATE SCHEMA ${schema}`);
  const db = postgresUrl
    ? new PostgresDatabase('', 3, {
        pool: new Pool({
          connectionString: postgresUrl,
          options: `-c search_path=${schema},public -c statement_timeout=30000`,
        }),
        mode: 'migration',
        transactionDeadlineMs: 30_000,
      })
    : new PgliteDatabase();
  try {
    await migrate(db);
    const workspace = randomUUID(),
      room = randomUUID(),
      unrelated = randomUUID();
    const owner = 'a'.repeat(64),
      viewer = 'b'.repeat(64);
    await db.query(
      `INSERT INTO identities(id,kind,name,handle)
      VALUES($1,'human','Owner','owner'),($2,'human','Joiner','joiner')`,
      [owner, viewer],
    );
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Invite target')`, [workspace]);
    await db.query(
      `INSERT INTO rooms(id,workspace_id,name,visibility)
      VALUES($1,$3,'General','public'),($2,$3,'Unrelated','invite-only')`,
      [room, unrelated, workspace],
    );
    await db.query(
      `INSERT INTO rooms(id,workspace_id,name,visibility)
       SELECT md5('invite-public-room-'||n)::uuid,$1,'Public '||n,'public'
       FROM generate_series(1,10) n`,
      [workspace],
    );
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [
      workspace,
      owner,
    ]);
    const corners = 10;
    const messages = postgresUrl ? 565000 : 10000;
    await db.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
      SELECT md5('invite-corner-'||n)::uuid,$1,$2,'History '||n,now()
      FROM generate_series(1,$3::int) n`,
      [workspace, room, corners],
    );
    // Seed history directly: these rows are unrelated to any owed corner item.
    await db.query('ALTER TABLE messages DISABLE TRIGGER USER');
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
      SELECT 'history-'||n,$1,$2,'Old conversation '||n,
        CASE WHEN n<=18000 THEN now()-interval '1 hour' ELSE now()-interval '2 days' END
      FROM generate_series(1,$3::int) n`,
      [(await db.query(`SELECT id FROM rooms WHERE parent_id=$1 ORDER BY id LIMIT 1`, [room])).rows[0]!.id, owner, messages],
    );
    await db.query('ALTER TABLE messages ENABLE TRIGGER USER');
    await db.query('ANALYZE');
    // This is the bulk corner-attention query run by a membership INSERT.
    // A newcomer has no answers: finding that fact must not scan another
    // person's entire Room history once for each candidate message.
    const answerPlan = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT max(answer.created_at) FROM messages answer
      WHERE answer.room_id=$1 AND answer.author_id=$2
        AND answer.presentation='message' AND answer.deleted_at IS NULL`,
      [(await db.query(`SELECT id FROM rooms WHERE parent_id=$1 ORDER BY id LIMIT 1`, [room])).rows[0]!.id, viewer])).rows[0]!['QUERY PLAN'][0].Plan;
    // Buffer work, rather than elapsed time, makes the regression independent
    // of the host's load. The date-leading operator index scans history even
    // when this person has never answered; a keyed lookup touches a few pages.
    const answerBuffers = answerPlan['Shared Hit Blocks'] + answerPlan['Shared Read Blocks'];
    console.log(`Absent joiner answer lookup: ${answerBuffers} buffers`);
    expect(answerBuffers).toBeLessThan(20);
    let queryCount = 0;
    const counted = (database: SqlDatabase): SqlDatabase => ({
      query: (sql, values) => {
        queryCount++;
        return database.query(sql, values);
      },
      transaction: (work) => database.transaction((tx) => work(counted(tx))),
    });
    const phone = new PhoneService(counted(db), 'https://server.example');
    const samples: { corners: number; queries: number; elapsed: number }[] = [];
    for (const size of [10, 1000]) {
      if (size === 1000)
        await db.query(
          `INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
         SELECT md5('invite-corner-'||n)::uuid,$1,$2,'History '||n,now()
         FROM generate_series(11,1000) n`,
          [workspace, room],
        );
      const joiner = size === 10 ? viewer : 'c'.repeat(64);
      if (size === 1000)
        await db.query(
          `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Second joiner','second')`,
          [joiner],
        );
      await db.query('ANALYZE');
      const invite = await phone.execute('createInvite', { workspaceId: workspace }, owner);
      queryCount = 0;
      const started = performance.now();
      const result = await phone.execute('redeemInvite', { token: invite.token }, joiner);
      const elapsed = performance.now() - started;
      samples.push({ corners: size, queries: queryCount, elapsed });
      console.log(
        `Reproduction invite-join-corner-rows: ${messages} messages, ${size} corners: ${elapsed.toFixed(0)} ms, ${queryCount} queries`,
      );
      expect(result).toMatchObject({ joined: true, workspaceId: workspace, roomId: room });
      expect(elapsed).toBeLessThan(10_000);
      expect(
        (
          await db.query(`SELECT count(*)::int count FROM memberships member
        JOIN rooms corner ON corner.id=member.room_id WHERE corner.parent_id IS NOT NULL`)
        ).rows[0]?.count,
      ).toBe(0);
      expect(
        (
          await db.query(`SELECT count(*)::int count FROM memberships WHERE identity_id=$1`, [
            joiner,
          ])
        ).rows[0]?.count,
      ).toBe(12);
      expect(
        (await db.query(`SELECT count(*)::int count FROM corner_person_state`)).rows[0]?.count,
      ).toBe(0);
      const archivedCorner = (await db.query(`SELECT id FROM rooms WHERE parent_id=$1 LIMIT 1`, [room])).rows[0]!.id;
      expect((await phone.canReadRooms(
        ['00000000-0000-0000-0000-000000000000', archivedCorner], joiner,
      )).size).toBe(0);
      expect(await phone.canReadRoom(archivedCorner, joiner)).toBe(true);
      expect((await phone.execute('redeemInvite', { token: invite.token }, joiner)).joined).toBe(
        false,
      );
    }
    expect(samples[1]!.queries).toBe(samples[0]!.queries);
    // Allow scheduling noise, but reject the old per-corner refresh cost.
    expect(samples[1]!.elapsed).toBeLessThan(Math.max(250, samples[0]!.elapsed * 3));
  } finally {
    await db.close();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  }
}, 120_000);
