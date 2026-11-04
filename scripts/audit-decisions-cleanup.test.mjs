import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { cleanup } from './audit-decisions-cleanup.mjs';

test('B1 dry-run changes nothing; apply detaches cascade and preserves skill versions', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE institutional_memory_jobs(id integer PRIMARY KEY);
      CREATE TABLE workspace_skill_versions(id integer PRIMARY KEY,source_job_id integer
        CONSTRAINT workspace_skill_versions_source_job_id_fkey REFERENCES institutional_memory_jobs(id) ON DELETE CASCADE);
      INSERT INTO institutional_memory_jobs VALUES(1),(2);
      INSERT INTO workspace_skill_versions VALUES(1,1),(2,2),(3,NULL);`);
    const queries = [];
    const client = { query: async (sql, params) => { queries.push(sql); return db.query(sql, params); } };
    const dry = await cleanup(client);
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.linkedVersionsPreserved, 2);
    assert.equal(dry.skillVersions, 3);
    assert.equal(dry.counts.find(row => row.table === 'institutional_memory_jobs').count, 2);
    assert.ok(queries.includes('BEGIN READ ONLY'));
    assert.ok(!queries.some(sql => /^(DELETE|UPDATE|ALTER)/.test(sql)));
    assert.equal((await db.query('SELECT count(*)::int count FROM institutional_memory_jobs')).rows[0].count, 2);
    const applied = await cleanup(client, true);
    assert.equal(applied.linkedVersionsPreserved, 2);
    assert.deepEqual((await db.query('SELECT id,source_job_id FROM workspace_skill_versions ORDER BY id')).rows,
      [{ id: 1, source_job_id: null }, { id: 2, source_job_id: null }, { id: 3, source_job_id: null }]);
    assert.equal((await cleanup(client, true)).linkedVersionsPreserved, 0);
  } finally { await db.close(); }
});
