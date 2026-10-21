import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFeedback, signature, followUp } from './feedback-signals.mjs';
const row = { id: 'one', source_kind: 'agent', category: 'bug', tool_name: 'read',
  error_excerpt: 'Request 404 https://example.test/a', created_at: '2026-10-20T10:00:00Z' };
test('dynamic URLs collapse but status and tool retain distinct causes', () => {
  assert.equal(signature(row), signature({ ...row, error_excerpt: 'Request 404 https://other.test/b' }));
  assert.notEqual(signature(row), signature({ ...row, error_excerpt: 'Request 403 https://example.test/a' }));
  assert.notEqual(signature(row), signature({ ...row, tool_name: 'write' }));
});
test('people outrank agent volume; owner alone is not an affected human', () => {
  const groups = groupFeedback([row, { ...row, id: 'two', occurrence_count: 100, reporter_owner_id: 'owner' },
    { ...row, id: 'human', source_kind: 'human', reporter_identity_id: 'person' }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].humanCount, 1);
  assert.equal(groups[1].humanCount, 0);
  assert.equal(groups[1].count, 101);
  assert.equal(groups[1].eligible, true);
  assert.equal(groupFeedback([row])[0].eligible, false);
});
test('groups retain first and last occurrence timestamps', () => {
  assert.equal(groupFeedback([{ ...row, last_occurrence_at: '2026-10-21T10:00:00Z' }])[0].lastSeen, '2026-10-21T10:00:00.000Z');
});
test('follow-up requires release and observes only post-release signals', () => {
  assert.equal(followUp({ occurrences: [] }), 'not yet released');
  const input = { releasedAt: '2026-10-20', observedThrough: '2026-10-21', occurrences: ['2026-10-19'] };
  assert.equal(followUp(input), 'stopped after release (fixed)');
  assert.equal(followUp({ ...input, occurrences: ['2026-10-20T12:00:00Z'] }), 'still occurring (reopen)');
});
test('incomplete observation never claims a fix and offset timestamps compare by instant', () => {
  assert.throws(() => followUp({releasedAt:'2026-10-20',observedThrough:'2026-10-20T12:00:00Z',occurrences:[]}), /incomplete/);
  assert.throws(() => followUp({releasedAt:'2026-10-20',occurrences:[]}), /timestamps/);
  assert.equal(followUp({releasedAt:'2026-10-20T10:00:00Z',observedThrough:'2026-10-21T10:00:00Z',
    occurrences:['2026-10-20T07:00:00-04:00']}), 'still occurring (reopen)');
});
test('first/last times compare normalized instants across SQL and ISO formats', () => {
  const group=groupFeedback([{...row,created_at:'2026-10-20 15:00:00+00'},
    {...row,id:'two',created_at:'2026-10-20T14:00:00Z',last_occurrence_at:'2026-10-20T10:30:00-04:00'}])[0];
  assert.equal(group.firstSeen,'2026-10-20T14:00:00.000Z');
  assert.equal(group.lastSeen,'2026-10-20T15:00:00.000Z');
});
