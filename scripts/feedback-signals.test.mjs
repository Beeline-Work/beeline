import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFeedback, signature, followUp, versionReport } from './feedback-signals.mjs';
const row = { id: 'one', source_kind: 'agent', category: 'bug', tool_name: 'read',
  error_excerpt: 'Request 404 https://example.test/a', created_at: '2026-10-20T10:00:00Z' };
test('dynamic URLs collapse but status and tool retain distinct causes', () => {
  assert.equal(signature(row), signature({ ...row, error_excerpt: 'Request 404 https://other.test/b' }));
  assert.notEqual(signature(row), signature({ ...row, error_excerpt: 'Request 403 https://example.test/a' }));
  assert.notEqual(signature(row), signature({ ...row, tool_name: 'write' }));
});
test('people outrank agent volume; owner alone is not an affected human', () => {
  const latest = { helper_version: 'v0.1.94', helper_is_latest: true, latest_released_version: 'v0.1.94' };
  const burst = Array.from({ length: 99 }, () => ({ helperVersion: 'v0.1.94', harness: null, harnessVersion: null }));
  const groups = groupFeedback([
    { ...row, ...latest },
    { ...row, ...latest, id: 'two', occurrence_count: 1000, occurrences: burst, reporter_owner_id: 'owner' },
    { ...row, id: 'human', source_kind: 'human', reporter_identity_id: 'person', app_version: 'v0.1.94', app_is_latest: true, latest_released_version: 'v0.1.94' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].humanCount, 1);
  assert.equal(groups[1].humanCount, 0);
  assert.equal(groups[1].count, 101);
  assert.equal(groups[1].agentCount, 101);
  assert.equal(groups[1].eligible, true);
  const once = groupFeedback([{ ...row, ...latest }])[0];
  assert.equal(once.count, 1);
  assert.equal(once.eligible, false);
  const unknown = groupFeedback([row])[0];
  assert.equal(unknown.count, 0);
  assert.equal(unknown.eligible, false);
  assert.deepEqual(unknown.itemIds, ['one']);
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
test('printed groups keep each report version and whether it is latest', () => {
  const printed = groupFeedback([{
    ...row,
    helper_version: 'v0.1.90',
    harness: 'codex',
    helper_is_latest: false,
    occurrences: [{ helperVersion: 'v0.1.94', harness: 'codex', harnessVersion: null }],
  }])[0];
  assert.deepEqual(printed.versionReports, [{
    id: 'one',
    helperVersion: 'v0.1.90',
    appVersion: null,
    appPlatform: null,
    harness: 'codex',
    harnessVersion: null,
    helperIsLatest: false,
    appIsLatest: null,
    latestReleasedVersion: null,
    later: [{ helperVersion: 'v0.1.94', harness: 'codex', harnessVersion: null }],
  }]);
  assert.deepEqual(versionReport({ id: 'bare' }), {
    id: 'bare', helperVersion: null, appVersion: null, appPlatform: null,
    harness: null, harnessVersion: null, helperIsLatest: null, appIsLatest: null,
    latestReleasedVersion: null,
  });
});
test('mixed-version occurrences count only the delivered release and keep older reports', () => {
  const released = 'v0.1.94';
  const oldOnly = {
    ...row,
    id: 'old-only',
    helper_version: 'v0.1.90',
    helper_is_latest: false,
    latest_released_version: released,
    occurrence_count: 40,
    occurrences: [
      { helperVersion: 'v0.1.90', harness: 'codex', harnessVersion: null },
      { helperVersion: 'v0.1.89', harness: 'codex', harnessVersion: null },
    ],
    affected_human_ids: ['stale-person'],
  };
  const mixed = {
    ...row,
    id: 'mixed',
    helper_version: 'v0.1.90',
    helper_is_latest: false,
    latest_released_version: released,
    occurrence_count: 4,
    occurrences: [
      { helperVersion: 'v0.1.90', harness: 'codex', harnessVersion: null },
      { helperVersion: released, harness: 'codex', harnessVersion: null },
      { helperVersion: released, harness: 'claude', harnessVersion: null },
    ],
  };
  const current = {
    ...row,
    id: 'current',
    helper_version: released,
    helper_is_latest: true,
    latest_released_version: released,
    occurrence_count: 8,
    occurrences: [{ helperVersion: 'v0.1.90', harness: 'codex', harnessVersion: null }],
    affected_human_ids: ['current-person'],
  };
  const oldHuman = {
    ...row,
    id: 'old-human',
    source_kind: 'human',
    reporter_identity_id: 'old-person',
    app_version: 'v0.1.90',
    app_is_latest: false,
    latest_released_version: released,
    occurrence_count: 3,
  };
  const newHuman = {
    ...row,
    id: 'new-human',
    source_kind: 'human',
    reporter_identity_id: 'new-person',
    app_version: released,
    app_is_latest: true,
    latest_released_version: released,
  };
  const groups = groupFeedback([oldOnly, mixed, current, oldHuman, newHuman]);
  const agents = groups.find((group) => group.itemIds.includes('mixed'));
  assert.deepEqual(agents.itemIds, ['old-only', 'mixed', 'current']);
  // old-only contributes 0. mixed contributes its two later releases. current contributes the original only.
  assert.equal(agents.count, 3);
  assert.equal(agents.agentCount, 3);
  assert.equal(agents.humanCount, 1);
  assert.equal(agents.eligible, true);
  assert.ok(agents.versionReports.some((report) => report.id === 'old-only' && report.helperIsLatest === false));
  const oldHumanGroup = groups.find((group) => group.itemIds.includes('old-human'));
  assert.equal(oldHumanGroup.count, 0);
  assert.equal(oldHumanGroup.humanCount, 0);
  assert.equal(oldHumanGroup.eligible, false);
  assert.deepEqual(oldHumanGroup.itemIds, ['old-human']);
  const newHumanGroup = groups.find((group) => group.itemIds.includes('new-human'));
  assert.equal(newHumanGroup.count, 1);
  assert.equal(newHumanGroup.humanCount, 1);
  assert.equal(newHumanGroup.eligible, true);
  const alone = groupFeedback([oldOnly])[0];
  assert.equal(alone.count, 0);
  assert.equal(alone.humanCount, 0);
  assert.equal(alone.eligible, false);
  assert.deepEqual(alone.itemIds, ['old-only']);
  const oneLatest = groupFeedback([{
    ...mixed,
    occurrences: [{ helperVersion: released, harness: 'codex', harnessVersion: null }],
  }])[0];
  assert.equal(oneLatest.count, 1);
  assert.equal(oneLatest.eligible, false);
  assert.deepEqual(oneLatest.itemIds, ['mixed']);
});
test('first/last times compare normalized instants across SQL and ISO formats', () => {
  const group=groupFeedback([{...row,created_at:'2026-10-20 15:00:00+00'},
    {...row,id:'two',created_at:'2026-10-20T14:00:00Z',last_occurrence_at:'2026-10-20T10:30:00-04:00'}])[0];
  assert.equal(group.firstSeen,'2026-10-20T14:00:00.000Z');
  assert.equal(group.lastSeen,'2026-10-20T15:00:00.000Z');
});
