import { expect, it } from 'vitest';
import { foldPrLifecycleRuns, lifecycleSummary } from './pr-lifecycle';
import type { ChatDisplayMessage } from './room-view-presentation';
function note(
  id: string,
  verb: string,
  url = 'https://github.com/acme/repo/actions/runs/1',
): ChatDisplayMessage {
  return {
    id,
    text: `GitHub ${verb} Build`,
    timestamp: 100,
    isUser: false,
    isSystemNotice: true,
    systemEvent: {
      subject: { kind: 'github', name: 'GitHub' },
      verb,
      object: { text: 'Build', url, headSha: 'a'.repeat(40) },
    },
  };
}
it('folds check events and repository notices together, preserving each posted state', () => {
  const messages = [
    note('1', 'started a check'),
    note('2', 'passed a check'),
    note('3', 'opened a pull request', 'https://github.com/acme/repo/pull/1'),
    note('4', 'pushed', 'https://github.com/acme/repo/compare/a...b'),
  ];
  const rows = foldPrLifecycleRuns(messages);
  expect(rows).toHaveLength(1);
  expect(rows[0].foldedIds).toEqual(['1', '2', '3', '4']);
  expect(lifecycleSummary(rows[0].notificationLifecycleRun!.items)).toBe(
    '1 check running · 1 check passed · 1 PR opened · 1 notice pushed',
  );
});
it('converts legacy GitHub API check destinations into navigable links', () => {
  const item = foldPrLifecycleRuns([
    note('1', 'passed a check', 'https://api.github.com/repos/acme/repo/check-suites/42'),
  ])[0].notificationLifecycleRun!.items[0];
  expect(item.url).toBe(`https://github.com/acme/repo/commit/${'a'.repeat(40)}/checks`);
});
it('never folds an agent-authored decision just because it mentions GitHub', () => {
  const decision = { ...note('decision', 'asked for approval'), isSystemNotice: false };
  expect(
    foldPrLifecycleRuns([note('1', 'started a check'), decision, note('3', 'failed a check')]).map(
      (row) => row.id,
    ),
  ).toEqual(['1', 'decision', '3']);
});
