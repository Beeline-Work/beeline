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
  it('preserves system notices and issue events as separate rows', () => {
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
