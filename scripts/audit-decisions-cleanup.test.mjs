import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { cleanup, monitoredApply } from './audit-decisions-cleanup.mjs';

test('B1 dry-run changes nothing; apply detaches cascade and preserves skill versions', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE institutional_memory_jobs(id integer PRIMARY KEY);
      CREATE TABLE workspace_skill_versions(id integer PRIMARY KEY,source_job_id integer
        CONSTRAINT workspace_skill_versions_source_job_id_fkey REFERENCES institutional_memory_jobs(id) ON DELETE CASCADE);
      CREATE TABLE rooms_mcp_audit(id integer,created_at timestamptz DEFAULT now()); INSERT INTO rooms_mcp_audit(id) VALUES(1),(2);
      CREATE TABLE agent_turn_traces(id integer,created_at timestamptz DEFAULT now()); INSERT INTO agent_turn_traces(id) VALUES(1);
      CREATE TABLE messages(id text PRIMARY KEY,card_type text,card jsonb,created_at timestamptz DEFAULT now());
      INSERT INTO messages(id,card_type,card) VALUES('1','github-corner-note','{"source":"github","dedupe":"old","other":true}'),
        ('2','other-card','{"source":"github","dedupe":"keep"}');
      INSERT INTO messages(id,card_type,card) SELECT 'batch-'||lpad(n::text,4,'0'),'github-corner-note',
        '{"source":"github","dedupe":"strip"}' FROM generate_series(1,1001) n;
      INSERT INTO institutional_memory_jobs VALUES(1),(2);
      INSERT INTO workspace_skill_versions VALUES(1,1),(2,2),(3,NULL);`);
    const queries = [];
    let transactionOpen = false;
    const client = { query: async (sql, params) => {
      if (sql.startsWith('BEGIN')) transactionOpen = true;
      if (sql.startsWith('UPDATE messages')) assert.equal(transactionOpen, false, 'hot card batches must commit independently of the FK transaction');
      queries.push(sql);
      const result = await db.query(sql, params);
      if (sql === 'COMMIT' || sql === 'ROLLBACK') transactionOpen = false;
      return result;
    } };
    const dry = await cleanup(client);
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.linkedVersionsPreserved, 2);
    assert.equal(dry.skillVersions, 3);
    assert.equal(dry.counts.find(row => row.table === 'institutional_memory_jobs').count, 2);
    assert.ok(queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    assert.ok(!queries.some(sql => /^(DELETE|UPDATE|ALTER)/.test(sql)));
    assert.equal((await db.query('SELECT count(*)::int count FROM institutional_memory_jobs')).rows[0].count, 2);
    const applied = await cleanup(client, true);
    assert.equal(applied.linkedVersionsPreserved, 2);
    assert.equal(applied.changed.messages, 1002);
    assert.equal((await db.query("SELECT count(*)::int count FROM messages WHERE card_type='github-corner-note' AND (card ? 'source' OR card ? 'dedupe')")).rows[0].count, 0);
    assert.deepEqual({ before: applied.retainedTelemetry.before, after: applied.retainedTelemetry.after }, { before: { rooms_mcp_audit: 2, agent_turn_traces: 1 }, after: { rooms_mcp_audit: 2, agent_turn_traces: 1 } });
    assert.deepEqual((await db.query("SELECT card FROM messages WHERE id='1'")).rows, [{ card: { other: true } }]);
    assert.deepEqual((await db.query("SELECT card FROM messages WHERE id='2'")).rows, [{ card: { source: 'github', dedupe: 'keep' } }]);
    assert.deepEqual((await db.query('SELECT id,source_job_id FROM workspace_skill_versions ORDER BY id')).rows,
      [{ id: 1, source_job_id: null }, { id: 2, source_job_id: null }, { id: 3, source_job_id: null }]);
    assert.equal((await cleanup(client, true)).linkedVersionsPreserved, 0);
  } finally { await db.close(); }
});


test('B1 monitor refuses any write on the first observed blocking', async () => {
  let writes = 0;
  const client = { processID: 123, query: async () => { writes++; throw new Error('must not reach writes'); } };
  const observer = { query: async () => ({ rows: [{ blocked_clients: '1', waiting_locks: '0' }] }) };
  await assert.rejects(monitoredApply(client, observer), /stopped for blocking/);
  assert.equal(writes, 0);
});

test('B1 concurrent monitor cancels its own in-flight FK statement when a client waits', { timeout: 3000 }, async () => {
  const db = new PGlite();
  let inFlight = false, rejectStatement, cancelled = false;
  try {
    await db.exec(`CREATE TABLE institutional_memory_jobs(id integer PRIMARY KEY);
      CREATE TABLE workspace_skill_versions(id integer PRIMARY KEY,source_job_id integer REFERENCES institutional_memory_jobs(id));
      INSERT INTO institutional_memory_jobs VALUES(1); INSERT INTO workspace_skill_versions VALUES(1,1);`);
    const client = { processID: 123, query: async (sql, params) => {
      if (sql.startsWith('ALTER TABLE workspace_skill_versions DROP')) {
        inFlight = true;
        return new Promise((_, reject) => { rejectStatement = reject; });
      }
      if (sql === 'ROLLBACK') inFlight = false;
      return db.query(sql, params);
    } };
    const observer = { query: async (sql, params) => {
      assert.deepEqual(params, [123]);
      if (sql.includes('pg_cancel_backend')) {
        cancelled = true;
        rejectStatement(new Error('cancelled by blocking monitor'));
        return { rows: [{ pg_cancel_backend: true }] };
      }
      return { rows: [{ blocked_clients: inFlight ? '1' : '0', waiting_locks: '0' }] };
    } };
    await assert.rejects(monitoredApply(client, observer), /cancelled by blocking monitor/);
    assert.equal(cancelled, true);
    assert.deepEqual((await db.query('SELECT id,source_job_id FROM workspace_skill_versions')).rows,
      [{ id: 1, source_job_id: 1 }]);
  } finally { rejectStatement?.(new Error('test cleanup')); await db.close(); }
});
