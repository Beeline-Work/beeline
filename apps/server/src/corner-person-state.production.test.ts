import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrate, PostgresDatabase } from './database.js';
import { migrateCornerPersonState } from './corner-person-state.js';
import { removeCornerMemberships } from './migrations/corner-memberships.js';

const postgresUrl = process.env.BEELINE_INVITE_TEST_POSTGRES_URL;
if (postgresUrl && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('migration proof requires isolated loopback PostgreSQL');

it.skipIf(!postgresUrl)(
  'batches the migration twice on a production-sized isolated data set',
  async () => {
    const schema = `corner_state_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new PostgresDatabase('', 3, {
      pool: new Pool({
        connectionString: postgresUrl,
        options: `-c search_path=${schema},public -c statement_timeout=30000`,
      }),
      mode: 'migration',
      transactionDeadlineMs: 30_000,
    });
    try {
      await migrate(db, { deferData: true });
      await db.query(`DROP TRIGGER IF EXISTS guard_corner_membership ON memberships`);
      const workspace = randomUUID(),
        room = randomUUID(),
        unrelated = randomUUID();
      await db.query(`INSERT INTO identities(id,kind,name,handle)
      SELECT repeat(md5('member-'||n),2),'human','Member '||n,'member'||n FROM generate_series(1,50) n`);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Migration copy')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Unrelated')`,
        [room, unrelated, workspace],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT $1,$2,id,'member' FROM identities WHERE handle LIKE 'member%'`,
        [workspace, room],
      );
      await db.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,name)
      SELECT md5('migration-corner-'||n)::uuid,$1,$2,'Corner '||n FROM generate_series(1,1033) n`,
        [workspace, room],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions)
      SELECT corner.workspace_id,corner.id,person.id,'member',
        CASE WHEN person.handle='member1' THEN '["joined"]'::jsonb ELSE '[]'::jsonb END
      FROM rooms corner CROSS JOIN identities person WHERE corner.parent_id=$1 AND person.handle LIKE 'member%'`,
        [room],
      );
      await db.query('ALTER TABLE messages DISABLE TRIGGER USER');
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text)
      SELECT 'migration-history-'||n,$1,repeat(md5('member-1'),2),'Historical conversation '||n
      FROM generate_series(1,333000) n`,
        [unrelated],
      );
      await db.query('ALTER TABLE messages ENABLE TRIGGER USER');
      await db.query('ANALYZE');
      const started = performance.now();
      expect(await migrateCornerPersonState(db)).toBe(1033);
      const elapsed = performance.now() - started;
      const retryStarted = performance.now();
      expect(await migrateCornerPersonState(db)).toBe(0);
      const retryElapsed = performance.now() - retryStarted;
      expect(await removeCornerMemberships(db)).toBe(51_650);
      expect(await removeCornerMemberships(db)).toBe(0);
      expect(
        (
          await db.query(`SELECT count(*)::int count FROM memberships member JOIN rooms corner
      ON corner.id=member.room_id WHERE corner.parent_id IS NOT NULL`)
        ).rows[0]!.count,
      ).toBe(0);
      expect(
        (await db.query('SELECT count(*)::int count FROM corner_person_state')).rows[0]!.count,
      ).toBe(1033);
      expect(
        (
          await db.query(
            `SELECT count(*)::int count FROM corner_person_state WHERE event_subscriptions='["joined"]'`,
          )
        ).rows[0]!.count,
      ).toBe(1033);
      console.log(
        `Migration proof: 333000 messages, 1033 corners, 51650 removed legacy memberships: ${elapsed.toFixed(0)} ms; retry ${retryElapsed.toFixed(0)} ms; 1033 sparse state rows`,
      );
      expect(elapsed).toBeLessThan(30_000);
    } finally {
      await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
  120_000,
);
