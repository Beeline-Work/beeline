import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrate, PostgresDatabase } from './database.js';
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
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [
      workspace,
      owner,
    ]);
    const corners = postgresUrl ? 1033 : 240;
    const messages = postgresUrl ? 333000 : 100000;
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
      SELECT 'history-'||n,$1,$2,'Old conversation '||n,now()-interval '2 days'
      FROM generate_series(1,$3::int) n`,
      [unrelated, owner, messages],
    );
    await db.query('ALTER TABLE messages ENABLE TRIGGER USER');
    await db.query('ANALYZE');
    const phone = new PhoneService(db, 'https://server.example');
    const invite = await phone.execute('createInvite', { workspaceId: workspace }, owner);
    const started = performance.now();
    const result = await phone.execute('redeemInvite', { token: invite.token }, viewer);
    const elapsed = performance.now() - started;
    console.log(
      `Reproduction invite-join-deadline: ${messages} messages, ${corners} corners: ${elapsed.toFixed(0)} ms`,
    );
    expect(result).toMatchObject({ joined: true, workspaceId: workspace, roomId: room });
    expect(elapsed).toBeLessThan(10_000);
    expect(
      (
        await db.query(
          `SELECT count(*)::int count FROM memberships
      WHERE identity_id=$1 AND room_id IN (SELECT id FROM rooms WHERE parent_id=$2)
        AND removed_at IS NULL`,
          [viewer, room],
        )
      ).rows[0]?.count,
    ).toBe(corners);
    expect((await phone.execute('redeemInvite', { token: invite.token }, viewer)).joined).toBe(
      false,
    );
  } finally {
    await db.close();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  }
}, 120_000);
