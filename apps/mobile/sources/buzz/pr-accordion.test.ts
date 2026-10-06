import { describe, expect, it } from 'vitest';
import { foldPrLifecycleRuns } from './pr-lifecycle';
import type { ChatDisplayMessage } from './room-view-presentation';

function pr(id: string, number: number, action = 'opened', repo = 'acme/repo'): ChatDisplayMessage {
  return {
    id,
    text: action,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    isUser: false,
    githubEvent: {
      type: 'pull-request',
      action,
      title: 'Same title',
      actor: 'octocat',
      branch: 'release',
      url: `https://github.com/${repo}/pull/${number}`,
    },
  };
}

describe('Reproduction PR-ACCORDION-1', () => {
  it('shows one shared card with twenty latest-state PRs for forty lifecycle events', () => {
    const messages = [
      ...Array.from({ length: 20 }, (_, i) => pr(`open${i + 1}`, i + 1)),
      ...Array.from({ length: 20 }, (_, i) => pr(`merge${i + 21}`, i + 1, 'merged')),
    ];
    const rows = foldPrLifecycleRuns(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].notificationLifecycleRun?.items).toHaveLength(20);
    expect(rows[0].notificationLifecycleRun?.items.every((item) => item.state === 'Merged')).toBe(
      true,
    );
    expect(rows[0].foldedIds).toEqual(messages.map((message) => message.id));
  });
});

describe('PR identity and transcript boundaries', () => {
  it('keeps same-title, same-branch and same-number PRs in different repos distinct', () => {
    const rows = foldPrLifecycleRuns([
      pr('1', 1),
      pr('2', 2),
      pr('3', 1, 'opened', 'other/repo'),
      pr('4', 1, 'merged'),
    ]);
    expect(rows[0].notificationLifecycleRun?.items.map((item) => [item.url, item.state])).toEqual([
      ['https://github.com/acme/repo/pull/1', 'Merged'],
      ['https://github.com/other/repo/pull/1', 'PR opened'],
      ['https://github.com/acme/repo/pull/2', 'PR opened'],
    ]);
  });
  it.each([true, false])('preserves intervening human/agent chat (isUser=%s)', (isUser) => {
    const chat = { id: 'chat', text: 'hello', timestamp: 3, isUser };
    expect(
      foldPrLifecycleRuns([pr('1', 1), pr('2', 2), chat, pr('4', 1, 'merged')]).map(
        (row) => row.id,
      ),
    ).toEqual(['1', 'chat', '4']);
  });
  it('preserves system notices and issue events without an issue URL as separate rows', () => {
    const notice = {
      id: 'notice',
      text: 'Important',
      timestamp: 2,
      isUser: false,
      isSystemNotice: true,
    };
    const issue = pr('3', 1);
    issue.githubEvent!.type = 'issue';
    expect(
      foldPrLifecycleRuns([pr('1', 1), notice, issue, pr('4', 1, 'merged')]).map((row) => row.id),
    ).toEqual(['1', 'notice', '3', '4']);
  });
  it('normalizes repository casing and URL suffixes while keeping latest title and event', () => {
    const opened = pr('1', 1);
    const merged = pr('2', 1, 'merged', 'ACME/REPO');
    merged.githubEvent!.url += '?source=event';
    merged.githubEvent!.title = 'Renamed';
    const item = foldPrLifecycleRuns([opened, merged])[0].notificationLifecycleRun!.items[0];
    expect(item).toMatchObject({ id: '1', title: 'Renamed', state: 'Merged', updatedBy: '2' });
  });
});

import {
  boundaryRowIndex,
  messageBoundaryIds,
  queueIncomingMessages,
  EMPTY_NEW_MESSAGE_QUEUE,
} from './room-new-message-boundary';
import { newestVisibleMessageId } from './read-cursor-advance';
it('retains folded message anchors, incoming counts and the newest read cursor', () => {
  const messages = [pr('1', 1), pr('2', 2), pr('3', 1, 'merged')];
  const rows = foldPrLifecycleRuns(messages);
  expect(boundaryRowIndex(rows, '3')).toBe(0);
  expect(messageBoundaryIds(rows[0])).toEqual(['1', '2', '3']);
  expect(newestVisibleMessageId(rows, rows)).toBe('3');
  expect(
    queueIncomingMessages(EMPTY_NEW_MESSAGE_QUEUE, {
      messages: rows,
      arrivingIds: new Set(['2', '3']),
      isPinnedToTail: false,
    }),
  ).toEqual({ boundaryId: '2', count: 2 });
  const boundary = 1;
  const partitioned = [
    ...foldPrLifecycleRuns(messages.slice(0, boundary)),
    ...foldPrLifecycleRuns(messages.slice(boundary)),
  ];
  expect(partitioned.map((row) => row.id)).toEqual(['1', '2']);
});

function issue(id: string, number: number, action = 'opened'): ChatDisplayMessage {
  const message = pr(id, number, action);
  message.githubEvent = {
    ...message.githubEvent!,
    type: 'issue',
    title: `Issue ${number}`,
    url: `https://github.com/acme/repo/issues/${number}`,
  };
  return message;
}

function corner(
  id: string,
  type: 'corner-open' | 'corner-complete' | 'checks-failing' | 'worktree-cleaned',
  cornerId = id,
  prNumber?: number,
  outcome: 'landed' | 'abandoned' = 'landed',
  repo = 'acme/repo',
): ChatDisplayMessage {
  return {
    id,
    text: `${type} ${id}`,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    isUser: false,
    authorIdentity: { kind: 'agent', name: 'Sol', handle: 'sol', pubkey: 'sol' },
    daemonFact: {
      type,
      cornerId,
      name: `Corner ${cornerId}`,
      objective: `Complete ${cornerId}`,
      ...(type === 'corner-complete' ? { outcome } : {}),
      ...(prNumber
        ? {
            pullRequest: {
              number: prNumber,
              title: `Change ${prNumber}`,
              url: `https://github.com/${repo}/pull/${prNumber}`,
            },
          }
        : {}),
    },
  };
}

// Ported from the pre-#2152 lifecycle fold tests (12eb7d163^ github-lifecycle-fold.test.ts).
describe('corner and issue lifecycle stacking', () => {
  it('stacks consecutive corner landings into one card', () => {
    const rows = foldPrLifecycleRuns([
      corner('1', 'corner-complete', 'a', 2190),
      corner('2', 'corner-complete', 'b', 2191),
      corner('3', 'corner-complete', 'c', 2192),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].foldedIds).toEqual(['1', '2', '3']);
    expect(
      rows[0].notificationLifecycleRun?.items.map(({ state, kindLine, cornerId }) => [
        state,
        kindLine,
        cornerId,
      ]),
    ).toEqual([
      ['Merged', 'corner · PR #2192', 'c'],
      ['Merged', 'corner · PR #2191', 'b'],
      ['Merged', 'corner · PR #2190', 'a'],
    ]);
  });

  it('puts a single issue on the same lifecycle card as a batch', () => {
    const rows = foldPrLifecycleRuns([issue('2', 2)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].foldedIds).toEqual(['2']);
    expect(rows[0].notificationLifecycleRun?.items).toMatchObject([
      { state: 'Opened', kindLine: 'issue', kind: 'issue' },
    ]);
  });

  it('stacks issue opened and closed events into one cell per issue', () => {
    const rows = foldPrLifecycleRuns([issue('1', 1), issue('2', 2), issue('3', 1, 'closed')]);
    expect(rows).toHaveLength(1);
    expect(
      rows[0].notificationLifecycleRun?.items.map(({ title, state }) => [title, state]),
    ).toEqual([
      ['Issue 1', 'Closed'],
      ['Issue 2', 'Opened'],
    ]);
  });

  it('leaves a single corner fact as it arrived so the dedicated card still paints', () => {
    const only = corner('2', 'corner-complete', 'c2', 2);
    expect(foldPrLifecycleRuns([only])).toEqual([only]);
    expect(foldPrLifecycleRuns([only])[0]).toBe(only);
  });

  it.each([2, 3, 5])('folds a mixed run of %i notifications into one stable card', (count) => {
    const fixtures = [
      pr('1', 1),
      corner('2', 'corner-open', 'corner-2'),
      issue('3', 3),
      corner('4', 'corner-complete', 'corner-4', 4),
      pr('5', 5, 'closed'),
    ].slice(0, count);
    const rows = foldPrLifecycleRuns(fixtures);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '1', timestamp: count });
    expect(rows[0].notificationLifecycleRun?.items).toHaveLength(count);
  });

  it('labels an abandoned corner closed and a checks-failing corner failed', () => {
    const run = foldPrLifecycleRuns([
      corner('1', 'corner-complete', 'closed-corner', undefined, 'abandoned'),
      corner('2', 'corner-open', 'open-corner'),
      corner('3', 'checks-failing', 'failing-corner'),
    ])[0].notificationLifecycleRun!;
    expect(run.items.map(({ title, state }) => [title, state])).toEqual([
      ['Corner failing-corner', 'Checks failed'],
      ['Corner open-corner', 'Opened'],
      ['Corner closed-corner', 'Closed'],
    ]);
  });

  it('deduplicates a corner and its PR transitively, keeps a standalone PR, and absorbs cleanup', () => {
    const rows = foldPrLifecycleRuns([
      corner('1', 'corner-open', 'corner-a'),
      pr('2', 42),
      corner('3', 'corner-complete', 'corner-a', 42),
      pr('4', 42, 'merged'),
      corner('5', 'worktree-cleaned', 'corner-a'),
      pr('6', 77),
    ]);
    expect(rows).toHaveLength(1);
    const run = rows[0].notificationLifecycleRun!;
    expect(run.items).toHaveLength(2);
    expect(run.items[0]).toMatchObject({ state: 'PR opened', kindLine: 'PR #77' });
    expect(run.items[1]).toMatchObject({
      id: '1',
      title: 'Corner corner-a',
      state: 'Merged',
      kindLine: 'corner · PR #42',
      cornerId: 'corner-a',
      updatedBy: '5',
    });
    expect(run.items[1]).not.toHaveProperty('url');
  });

  it('never joins a corner to a same-numbered PR in another repository', () => {
    const run = foldPrLifecycleRuns([
      corner('1', 'corner-complete', 'corner-a', 42, 'landed', 'other/repo'),
      pr('2', 42, 'merged'),
    ])[0].notificationLifecycleRun!;
    expect(run.items).toHaveLength(2);
  });

  it('never creates a row for a cleanup that has no corner cell', () => {
    const cleanup = corner('1', 'worktree-cleaned', 'gone');
    expect(foldPrLifecycleRuns([cleanup])[0]).toBe(cleanup);
    const rows = foldPrLifecycleRuns([cleanup, pr('2', 2)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].notificationLifecycleRun?.items.map(({ kind }) => kind)).toEqual([
      'pull-request',
    ]);
  });

  it('keeps a corner marker on its source message and a relay-report card on its own', () => {
    const marker = corner('2', 'corner-open', 'marked');
    marker.daemonFact!.sourceMessageId = 'source';
    const reported = corner('3', 'corner-complete', 'reported', 3);
    reported.relayReports = [{ id: 'report', text: 'done', timestamp: 3 }];
    const rows = foldPrLifecycleRuns([pr('1', 1), marker, reported, pr('4', 4)]);
    expect(rows.map((row) => row.id)).toEqual(['1', '2', '3', '4']);
    expect(rows[1]).toBe(marker);
    expect(rows[2]).toBe(reported);
  });

  it.each([true, false])('chat ends a corner run (isUser=%s)', (isUser) => {
    const rows = foldPrLifecycleRuns([
      pr('1', 1),
      corner('2', 'corner-open'),
      { id: 'message', text: 'hello', timestamp: 20, isUser },
      pr('3', 3),
      pr('4', 4, 'closed'),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['1', 'message', '3']);
    expect(rows[0].notificationLifecycleRun?.items).toHaveLength(2);
    expect(rows[2].notificationLifecycleRun?.items).toHaveLength(2);
  });

  it('reproduces the captain run as one card with duplicate PRs reduced to latest state', () => {
    const rows = foldPrLifecycleRuns([
      pr('1', 1124),
      pr('2', 1125),
      pr('3', 1124, 'merged'),
      corner('4', 'corner-complete', 'duplicate-draft-settle', 1126),
      pr('5', 1127),
      pr('6', 1128),
      pr('7', 1127, 'merged'),
      pr('8', 1128, 'merged'),
    ]);
    const run = rows[0].notificationLifecycleRun!;
    expect(rows).toHaveLength(1);
    expect(run.items).toHaveLength(5);
    expect(run.items.find((item) => item.cornerId === 'duplicate-draft-settle')).toMatchObject({
      state: 'Merged',
      kindLine: 'corner · PR #1126',
    });
  });

  it('collects each actor once and includes the full time span', () => {
    const run = foldPrLifecycleRuns([
      pr('1', 1),
      corner('2', 'corner-open'),
      pr('3', 3, 'merged'),
    ])[0].notificationLifecycleRun!;
    expect(run.subline).toMatch(/^by @octocat, @sol · \d\d:\d\d – \d\d:\d\d$/);
  });

  it('keeps transcript order newest-first when several notifications share a second', () => {
    const first = pr('first', 41);
    const second = corner('second', 'corner-open', 'corner-second');
    first.timestamp = 10;
    second.timestamp = 10;
    const items = foldPrLifecycleRuns([first, second])[0].notificationLifecycleRun!.items;
    expect(items.map(({ id }) => id)).toEqual(['second', 'first']);
  });
});
