import { describe, expect, it } from 'vitest';
import { foldPrLifecycleRuns, lifecycleSummary } from './pr-lifecycle';
import type { ChatDisplayMessage } from './room-view-presentation';
import { boundaryRowIndex, messageBoundaryIds } from './room-new-message-boundary';
import { newestVisibleMessageId } from './read-cursor-advance';

function event(id: string, type = 'pull-request', action = 'merged'): ChatDisplayMessage {
  return {
    id,
    text: action,
    timestamp: 100,
    isUser: false,
    githubEvent: {
      type,
      action,
      title: 'Change',
      actor: 'octocat',
      url: `https://github.com/acme/repo/${type === 'issue' ? 'issues' : 'pull'}/1`,
    },
  };
}
function corner(
  id: string,
  type: 'corner-open' | 'corner-complete' | 'worktree-cleaned',
): ChatDisplayMessage {
  return {
    id,
    text: '',
    timestamp: 100,
    isUser: false,
    daemonFact: {
      type,
      cornerId: id,
      objective: 'Make the transcript readable',
      outcome: 'abandoned',
    },
  };
}
describe('locked event row v2', () => {
  it('keeps every event in transcript order, including updates to the same PR', () => {
    const messages = [
      event('1', 'pull-request', 'opened'),
      event('2'),
      event('3', 'issue', 'opened'),
    ];
    const rows = foldPrLifecycleRuns(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].notificationLifecycleRun?.items.map((item) => item.id)).toEqual(['1', '2', '3']);
    expect(lifecycleSummary(rows[0].notificationLifecycleRun!.items)).toBe(
      '1 PR opened · 1 PR merged · 1 issue filed',
    );
    expect(messageBoundaryIds(rows[0])).toEqual(['1', '2', '3']);
    expect(boundaryRowIndex(rows, '3')).toBe(0);
    expect(newestVisibleMessageId(rows, rows)).toBe('3');
  });
  it('counts by type and action, retaining commented and reopened issue events', () => {
    const rows = foldPrLifecycleRuns([
      event('1'),
      event('2'),
      event('3', 'issue', 'opened'),
      event('4', 'issue', 'commented'),
      event('5', 'issue', 'closed'),
      event('6', 'issue', 'reopened'),
    ]);
    expect(lifecycleSummary(rows[0].notificationLifecycleRun!.items)).toBe(
      '2 PRs merged · 1 issue filed · 1 issue commented · 1 issue closed · 1 issue reopened',
    );
  });
  it.each([true, false])('ends at human/agent prose including decisions (human=%s)', (isUser) => {
    const decision = { id: 'decision', text: 'Please approve this change', timestamp: 101, isUser };
    const rows = foldPrLifecycleRuns([event('1'), decision, event('3')]);
    expect(rows.map((row) => row.id)).toEqual(['1', 'decision', '3']);
    expect(rows[1]).toBe(decision);
    expect(rows[1].notificationLifecycleRun).toBeUndefined();
  });
  it('keeps corner opens as markers, hides closes and cleanup, preserves merged PR facts', () => {
    const opened = corner('opened', 'corner-open');
    const merged = {
      ...corner('merged', 'corner-complete'),
      daemonFact: {
        ...corner('merged', 'corner-complete').daemonFact!,
        outcome: 'landed' as const,
        pullRequest: { number: 42, title: 'Ship it', url: 'https://github.com/acme/repo/pull/42' },
      },
    };
    const rows = foldPrLifecycleRuns([
      opened,
      merged,
      corner('closed', 'corner-complete'),
      corner('cleaned', 'worktree-cleaned'),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['opened', 'merged']);
    expect(rows[0]).toBe(opened);
    expect(lifecycleSummary(rows[1].notificationLifecycleRun!.items)).toBe('1 PR merged');
    expect(rows[1].notificationLifecycleRun?.items[0]).toMatchObject({
      cornerId: 'merged',
      url: merged.daemonFact.pullRequest.url,
    });
    expect(foldPrLifecycleRuns([corner('closed', 'corner-complete')])).toEqual([]);
  });
  it('preserves deleted messages and actionable cards as boundaries', () => {
    for (const boundary of [
      { id: 'deleted', text: 'Message deleted', timestamp: 100, isUser: false, deleted: true },
      { id: 'choice', text: 'Choose', timestamp: 100, isUser: false, choice: {} },
      { id: 'notice', text: 'Granted', timestamp: 100, isUser: false, isSystemNotice: true },
    ]) {
      expect(foldPrLifecycleRuns([event('1'), boundary, event('3')]).map((row) => row.id)).toEqual([
        '1',
        boundary.id,
        '3',
      ]);
    }
  });
  it('associates destinations by full PR URL, never a bare number across repositories', () => {
    const fact = {
      ...corner('link', 'checks-failing' as never),
      daemonFact: {
        type: 'checks-failing' as const,
        cornerId: 'corner',
        objective: 'Checks',
        pullRequest: { url: 'https://github.com/ACME/REPO/pull/1?tab=checks' },
      },
    };
    const other = event('other');
    other.githubEvent!.url = 'https://github.com/other/repo/pull/1';
    const items = foldPrLifecycleRuns([event('1'), fact, other])[0].notificationLifecycleRun!.items;
    expect(items[0].cornerId).toBe('corner');
    expect(items[2].cornerId).toBeUndefined();
  });
});

it('folds passive payment and wallet records but keeps an insufficient-funds action visible', () => {
  const receipt: ChatDisplayMessage = {
    id: 'tx',
    text: '',
    timestamp: 1,
    isUser: false,
    walletTx: {
      direction: 'out',
      amountText: '$5',
      counterparty: 'Merchant',
      chain: 'Base',
      balanceAfterUsd: '$10',
      txUrl: 'https://basescan.org/tx/abc',
    },
  };
  const grant: ChatDisplayMessage = {
    id: 'grant',
    text: '',
    timestamp: 2,
    isUser: false,
    walletDelegation: { standing: true },
  };
  const funds: ChatDisplayMessage = {
    id: 'funds',
    text: '',
    timestamp: 3,
    isUser: false,
    walletInsufficient: { needed: '5', asset: 'USDC', chain: 'Base' },
  };
  const rows = foldPrLifecycleRuns([receipt, grant, funds, receipt]);
  expect(rows.map((row) => row.id)).toEqual(['tx', 'funds', 'tx']);
  expect(lifecycleSummary(rows[0].notificationLifecycleRun!.items)).toBe(
    '1 payment sent · 1 wallet permission granted',
  );
  expect(rows[0].notificationLifecycleRun!.items[0].url).toBe(receipt.walletTx!.txUrl);
  expect(rows[1]).toBe(funds);
});

it('retains the original opening event when the server settles that card in place', () => {
  const opened = { id: 'opened', text: 'Opened a corner', timestamp: 1, isUser: false,
    daemonFact: { type: 'corner-complete' as const, cornerId: 'corner', objective: 'Task', outcome: 'abandoned' as const },
    systemEvent: { kind: 'corner-opened' as const, subject: { kind: 'agent' as const, name: '@ruby' }, verb: 'opened a corner' } };
  expect(foldPrLifecycleRuns([opened])).toEqual([opened]);
});
