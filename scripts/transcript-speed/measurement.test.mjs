import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messages, rooms, agents, localDatabase } from './fixture.mjs';
import { percentile, summarize } from './metrics.mjs';

test('fixture refuses remote databases and libpq connection overrides', () => {
  assert.equal(localDatabase('postgresql://localhost/beeline_latency_rig_transcript_test'), 'postgresql://localhost/beeline_latency_rig_transcript_test');
  for (const value of ['postgresql://server.usebeeline.app/beeline_latency_rig_transcript_test',
    'postgresql://localhost/production',
    'postgresql://localhost/beeline_latency_rig_transcript_test?host=remote',
    'postgresql://localhost/beeline_latency_rig_transcript_test?connectionString=remote'])
    assert.throws(() => localDatabase(value));
});
test('fixture is deterministic and replies refer to existing messages', () => {
  const rows = messages(rooms[0], 'http://localhost:19882');
  assert.deepEqual(rows, messages(rooms[0], 'http://localhost:19882'));
  assert.equal(new Set(rows.map(row => row.id)).size, 1000);
  assert.ok(rows.filter(row => row.reply).every(row => rows.some(parent => parent.id === row.reply)));
  assert.ok(agents.every(agent => rows.some(row => row.author === agent)));
});
test('nearest-rank percentile preserves tail stalls and missing samples', () => {
  assert.equal(percentile([], .95), null);
  assert.equal(percentile([10, 10, 10, 10, 100], .95), 100);
  assert.throws(() => percentile([NaN], .95));
  const result = summarize({ name: 'typing', startMs: 0, endMs: 100,
    jsFrameIntervalsMs: [1000 / 60, 50], commits: [{ kind: 'row', id: 'a' }, { kind: 'row', id: 'a' }, { kind: 'transcript', id: 'room' }] }, 60);
  assert.equal(result.missedJsFrameOpportunities, 2);
  assert.equal(result.rowCommits, 2);
  assert.equal(result.distinctRowsCommitted, 1);
});
