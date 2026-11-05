import { describe, expect, it } from 'vitest';
import { foldPrLifecycleRuns, lifecycleItem, lifecycleSummary } from './pr-lifecycle';
import type { NotificationLifecycleRun } from './pr-lifecycle';
import type { SystemLineMessage } from './system-lines';

function event(id: string, type: 'pull-request' | 'issue', action: string, number: number): SystemLineMessage {
  return {
    id, text: '', timestamp: 1,
    githubEvent: {
      type, action, actor: 'octocat', title: 'Requested work',
      url: `https://github.com/owner/widgets/${type === 'issue' ? 'issues' : 'pull'}/${number}`,
    },
  };
}

function subscription(id: string, verb: string, number: number): SystemLineMessage {
  return {
    id, text: '', timestamp: 2, isSystemNotice: true,
    systemEvent: {
      subject: { kind: 'github', name: 'owner/widgets' }, verb,
      object: { text: 'Requested work', url: `https://github.com/owner/widgets/pull/${number}` },
    },
  };
}

function run(messages: SystemLineMessage[]): NotificationLifecycleRun {
  const folded = foldPrLifecycleRuns(messages);
  expect(folded).toHaveLength(1);
  return (folded[0] as SystemLineMessage & { notificationLifecycleRun: NotificationLifecycleRun }).notificationLifecycleRun;
}

describe('lifecycle-1: stored GitHub lifecycle summaries', () => {
  it('counts a close once across stored event formats and orders groups consistently', () => {
    const messages = [
      event('issue-close', 'issue', 'closed', 10),
      subscription('subscription-close', 'closed pull request', 42),
      event('issue-open', 'issue', 'opened', 11),
      event('pr-merge', 'pull-request', 'merged', 43),
      event('pr-open', 'pull-request', 'opened', 42),
      event('pr-close', 'pull-request', 'closed', 42),
      subscription('legacy-close', 'closed a pull request', 42),
      event('another-close', 'pull-request', 'closed', 44),
    ];
    const items = run(messages).items;
    // Committed events remain available in the expanded run and for read cursors.
    expect(items).toHaveLength(messages.length);
    expect(lifecycleSummary(items)).toBe('1 PR opened · 1 PR merged · 2 PRs closed · 1 issue filed · 1 issue closed');
    expect(lifecycleSummary(run([...messages].reverse()).items)).toBe(lifecycleSummary(items));
    expect(lifecycleItem(messages[1])?.state.toLowerCase()).toBe('closed');
  });

  it.each([
    [4, 12, '4 PRs merged · 12 issues filed'],
    [1, 1, '1 PR merged · 1 issue filed'],
    [4, 0, '4 PRs merged'],
    [0, 1, '1 issue filed'],
  ] as const)('keeps the noun with %i merged PRs and %i filed issues when no PRs opened', (prs, issues, expected) => {
    const messages = [
      ...Array.from({ length: issues }, (_, index) => event(`issue-${index}`, 'issue', 'opened', index + 1)),
      ...Array.from({ length: prs }, (_, index) => event(`pr-${index}`, 'pull-request', 'merged', index + 1)),
    ];
    expect(lifecycleSummary(run(messages).items)).toBe(expected);
  });

  it('keeps repositories, lifecycle kinds and runs distinct', () => {
    const closed = event('closed', 'pull-request', 'closed', 42);
    const otherRepo = event('other-repo', 'pull-request', 'closed', 42);
    otherRepo.githubEvent!.url = 'https://github.com/owner/other/pull/42';
    expect(lifecycleSummary(run([
      closed, otherRepo, event('issue', 'issue', 'closed', 42),
      event('opened', 'pull-request', 'opened', 42),
      subscription('duplicate', 'closed pull request', 42),
    ]).items)).toBe('1 PR opened · 2 PRs closed · 1 issue closed');
    const folded = foldPrLifecycleRuns([closed, { id: 'chat', text: 'Hello', timestamp: 2 }, subscription('later', 'closed pull request', 42)]);
    expect(folded).toHaveLength(3);
    for (const index of [0, 2]) {
      const row = folded[index] as SystemLineMessage & { notificationLifecycleRun: NotificationLifecycleRun };
      expect(lifecycleSummary(row.notificationLifecycleRun.items)).toBe('1 PR closed');
    }
  });

  it('puts other groups after the fixed order and ignores URL fragments for duplicates', () => {
    const duplicate = subscription('duplicate', 'closed pull request', 42);
    duplicate.systemEvent!.object!.url += '/?tab=conversation#event';
    const items = run([
      event('reopened', 'issue', 'reopened', 9),
      event('commented', 'pull-request', 'commented', 43),
      event('closed', 'pull-request', 'closed', 42), duplicate,
    ]).items;
    expect(lifecycleSummary(items)).toBe('1 PR closed · 1 issue reopened · 1 PR commented');
    expect(lifecycleSummary([])).toBe('');
  });

});
