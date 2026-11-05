import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { announceAgentLifecycle, recordAgentEvidence } from './connection-presence.js';
import { migrate, PostgresDatabase } from './database.js';
import { LiveHub } from './live.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Presence deadlock proof requires isolated loopback PostgreSQL');

it.skipIf(!url)('SERVER-31: evidence and a lifecycle update commit without a presence-row / owner-projection deadlock', async () => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const name = `presence_${randomUUID().replaceAll('-', '')}`;
  const isolated = new URL(url!); isolated.pathname = `/${name}`;
  const config = { connectionString: isolated.toString(), max: 1 };
  const first = new PostgresDatabase('', 1, { pool: new Pool({ ...config, application_name: 'presence-announcer-proof' }) });
  const second = new PostgresDatabase('', 1, { pool: new Pool(config) });
  const observerPool = new Pool(config);
  let announcement: Promise<void> | undefined, evidence: Promise<void> | undefined;
  await admin.query(`CREATE DATABASE ${name}`);
  const observer = await observerPool.connect();
  try {
    await migrate(first);
    const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Helper')`, [owner,agent]);
    await first.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent,owner]);
    await first.query(`INSERT INTO workspaces(id,name) VALUES($1,'Presence proof')`, [workspace]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room,workspace]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [workspace,agent,room]);
    const live = new LiveHub();
    await announceAgentLifecycle(first,live,room,agent,{ lifecycleId: 'boot-1' });
    const before = (await first.query<{ body: { observedAt: number } }>(
      `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [agent])).rows[0]!.body;
    const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    const observerPid = (await observer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    // UPDATE locks its tuple before BEFORE ROW triggers. Pause there, before
    // the production owner-projection trigger takes its existing lock.
    await observer.query(`CREATE FUNCTION pause_presence_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('application_name')='presence-announcer-proof' THEN
        PERFORM pg_advisory_xact_lock(730031,1);
      END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER aa_pause_presence_update BEFORE UPDATE ON live_outputs
      FOR EACH ROW EXECUTE FUNCTION pause_presence_update();
      SELECT pg_advisory_lock(730031,1);`);
    announcement = announceAgentLifecycle(first,live,room,agent,{ lifecycleId: 'boot-2', releaseVersion: 'proof-release' });
    void announcement.catch(() => {});
    await vi.waitFor(async () => {
      expect((await observer.query('SELECT pg_blocking_pids($1) blockers', [firstPid])).rows[0].blockers).toContain(observerPid);
    });
    evidence = recordAgentEvidence(second,live,room,agent);
    void evidence.catch(() => {});
    await vi.waitFor(async () => {
      expect((await observer.query('SELECT pg_blocking_pids($1) blockers', [secondPid])).rows[0].blockers).toContain(firstPid);
    });
    await observer.query('SELECT pg_advisory_unlock(730031,1)');
    const results = await Promise.allSettled([announcement,evidence]);
    for (const result of results) if (result.status === 'rejected') console.error('SERVER-31 lock cycle', result.reason);
    expect(results.map(result => result.status)).toEqual(['fulfilled','fulfilled']);
    const rows = (await first.query<{ body: { observedAt: number } }>(
      `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [agent])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toMatchObject({ status: 'online', lifecycleId: 'boot-2', releaseVersion: 'proof-release' });
    expect(rows[0]!.body.observedAt).toBeGreaterThan(before.observedAt);
  } finally {
    await observer.query('SELECT pg_advisory_unlock_all()');
    await Promise.allSettled([announcement,evidence]);
    await Promise.all([first.close(),second.close()]);
    observer.release(); await observerPool.end();
    await admin.query(`DROP DATABASE ${name}`); await admin.end();
  }
});
