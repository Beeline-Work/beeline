import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { foldSystemLines } from './system-lines';

function github(
  id: string,
  action: 'opened' | 'closed' | 'merged',
  subject = id,
  type: 'pull-request' | 'issue' = 'pull-request',
): ChatDisplayMessage {
  return {
    id,
    text: `${action} ${id}`,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    isUser: false,
    githubEvent: {
      type,
      action,
      actor: 'octocat',
      title: `Change ${subject}`,
      url: `https://github.test/acme/repo/${type === 'issue' ? 'issues' : 'pull'}/${subject}`,
      branch: `feature/${subject}`,
    },
  };
}

function corner(
  id: string,
  type: 'corner-open' | 'corner-complete' | 'checks-failing' | 'worktree-cleaned',
  cornerId = id,
  prNumber?: number,
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
      ...(type === 'corner-complete' ? { outcome: 'landed' as const } : {}),
      ...(prNumber
        ? {
            pullRequest: {
              number: prNumber,
              title: `Change ${prNumber}`,
              url: `https://github.test/acme/repo/pull/${prNumber}`,
            },
          }
        : {}),
    },
  };
}

function check(id: string, result: 'passed' | 'failed', prNumber: number): ChatDisplayMessage {
  return {
    id,
    text: `GitHub ${result} a check Build`,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    isUser: false,
    isSystemNotice: true,
    systemEvent: {
      subject: { kind: 'github', name: 'GitHub' },
      verb: `${result} a check`,
      object: { text: 'Build', url: `https://github.test/acme/repo/pull/${prNumber}` },
    },
  };
}

function prose(id: string, kind: 'human' | 'agent'): ChatDisplayMessage {
  return {
    id,
    text: `${kind} message`,
    timestamp: 20,
    isUser: kind === 'human',
    ...(kind === 'agent' ? { isAgentAuthor: true } : {}),
  };
}

describe('notification lifecycle folding', () => {
  it('leaves a single notification exactly as it arrived', () => {
    for (const only of [github('1', 'opened'), corner('2', 'corner-complete', 'c2', 2)]) {
      expect(foldSystemLines([only])).toEqual([only]);
      expect(foldSystemLines([only])[0]).toBe(only);
    }
  });

  it.each([2, 3, 6])('folds a mixed run of %i notifications into one stable card', (count) => {
    const fixtures = [
      github('1', 'opened', '1'),
      corner('2', 'corner-open', 'corner-2'),
      check('3', 'failed', 3),
      github('4', 'opened', '4', 'issue'),
      corner('5', 'corner-complete', 'corner-5', 5),
      github('6', 'closed', '6'),
    ].slice(0, count);
    const folded = foldSystemLines(fixtures);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ id: '1', timestamp: count });
    expect(folded[0]!.notificationLifecycleRun?.items).toHaveLength(count);
  });

  it('deduplicates a corner and its PR transitively, keeps a standalone PR, and absorbs cleanup', () => {
    const folded = foldSystemLines([
      corner('1', 'corner-open', 'corner-a'),
      github('2', 'opened', '42'),
      corner('3', 'corner-complete', 'corner-a', 42),
      github('4', 'merged', '42'),
      corner('5', 'worktree-cleaned', 'corner-a'),
      github('6', 'opened', '77'),
    ]);
    const run = folded[0]!.notificationLifecycleRun!;
    expect(run.headline).toBe('1 PR opened · 1 merged');
    expect(run.items).toHaveLength(2);
    expect(run.items[0]).toMatchObject({ state: 'PR opened', kindLine: 'PR #77' });
    expect(run.items[1]).toMatchObject({
      state: 'Merged',
      kindLine: 'corner · PR #42',
      cornerId: 'corner-a',
    });
    expect(run.items.every((item) => item.title !== 'worktree-cleaned 5')).toBe(true);
  });

  it('uses the latest of all six states and marks check failure as danger', () => {
    const folded = foldSystemLines([
      github('1', 'opened', '42'),
      check('2', 'failed', 42),
      check('3', 'passed', 42),
      github('4', 'merged', '42'),
      github('5', 'closed', '77'),
      github('6', 'opened', '88', 'issue'),
      check('7', 'failed', 99),
    ]);
    const run = folded[0]!.notificationLifecycleRun!;
    expect(run.items.map(({ state }) => state)).toEqual([
      'Checks failed',
      'Opened',
      'Closed',
      'Merged',
    ]);
    expect(run.items[0]).toMatchObject({ danger: true });
    expect(run.headline).toBe('1 checks failed · 1 opened · 1 closed · 1 merged');
  });

  it.each(['human', 'agent'] as const)('%s prose ends a notification run', (kind) => {
    const folded = foldSystemLines([
      github('1', 'opened'),
      corner('2', 'corner-open'),
      prose('message', kind),
      github('3', 'opened'),
      github('4', 'closed'),
    ]);
    expect(folded.map((message) => message.id)).toEqual(['1', 'message', '3']);
    expect(folded[0]!.notificationLifecycleRun?.items).toHaveLength(2);
    expect(folded[2]!.notificationLifecycleRun?.items).toHaveLength(2);
  });

  it('keeps membership folding unchanged and lets a membership line end the card run', () => {
    const joined = (id: string, name: string): ChatDisplayMessage => ({
      id,
      text: `${name} joined`,
      timestamp: Number(id),
      isUser: false,
      isSystemNotice: true,
      systemEvent: { subject: { kind: 'human', id: name, name }, verb: 'joined' },
    });
    const folded = foldSystemLines([
      github('1', 'opened'),
      github('2', 'merged'),
      joined('3', 'Ada'),
      joined('4', 'Lin'),
      github('5', 'opened'),
      github('6', 'merged'),
    ]);
    expect(folded.map(({ id }) => id)).toEqual(['1', '3', '5']);
    expect(folded[1]).toMatchObject({ text: 'Ada and Lin joined', foldedIds: ['3', '4'] });
  });

  it('reproduces the captain run as one card with duplicate PRs reduced to latest state', () => {
    const folded = foldSystemLines([
      github('1', 'opened', '1124'),
      github('2', 'opened', '1125'),
      github('3', 'merged', '1124'),
      corner('4', 'corner-complete', 'duplicate-draft-settle', 1126),
      github('5', 'opened', '1127'),
      github('6', 'opened', '1128'),
      github('7', 'merged', '1127'),
      github('8', 'merged', '1128'),
    ]);
    const run = folded[0]!.notificationLifecycleRun!;
    expect(folded).toHaveLength(1);
    expect(run.items).toHaveLength(5);
    expect(run.items.filter((item) => item.title === 'Change 1124')).toHaveLength(1);
    expect(run.items.filter((item) => item.title === 'Change 1127')).toHaveLength(1);
    expect(run.items.filter((item) => item.title === 'Change 1128')).toHaveLength(1);
    expect(run.items.find((item) => item.cornerId === 'duplicate-draft-settle')).toMatchObject({
      state: 'Merged',
      kindLine: 'corner · PR #1126',
    });
  });

  it('collects each actor once and includes the full time span', () => {
    const run = foldSystemLines([
      github('1', 'opened'),
      corner('2', 'corner-open'),
      github('3', 'merged', '3'),
    ])[0]!.notificationLifecycleRun!;
    expect(run.subline).toMatch(/^by @octocat, @sol · \d\d:\d\d – \d\d:\d\d$/);
  });

  it('keeps transcript order newest-first when several notifications share a second', () => {
    const first = github('first', 'opened', '41');
    const second = corner('second', 'corner-open', 'corner-second');
    first.timestamp = 10;
    second.timestamp = 10;
    const items = foldSystemLines([first, second])[0]!.notificationLifecycleRun!.items;
    expect(items.map(({ id }) => id)).toEqual(['second', 'first']);
  });
});
