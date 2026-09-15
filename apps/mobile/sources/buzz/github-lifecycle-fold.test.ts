import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { foldSystemLines, formatNotificationHeadlines } from './system-lines';

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
  outcome: 'landed' | 'abandoned' = 'landed',
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
              url: `https://github.test/acme/repo/pull/${prNumber}`,
            },
          }
        : {}),
    },
  };
}

describe('notification headline grammar', () => {
  const row = (
    id: string,
    state: Parameters<typeof formatNotificationHeadlines>[0][number]['state'],
    kindLine: string,
  ) => ({ id, state, kindLine, title: id });

  it('formats a single kind in lifecycle order and omits zeros', () => {
    expect(
      formatNotificationHeadlines([
        row('opened', 'PR opened', 'PR #2'),
        row('merged-1', 'Merged', 'PR #1'),
        row('merged-2', 'Merged', 'PR #3'),
      ]),
    ).toEqual(['PR 1 opened, 2 merged']);
  });

  it('orders mixed kinds as PR, Issue, Star, Workflow', () => {
    expect(
      formatNotificationHeadlines([
        row('workflow-failed', 'Failed', 'run #4 · smoke check'),
        row('star-1', 'Starred', 'star'),
        row('issue-closed', 'Closed', 'issue'),
        row('pr-opened', 'PR opened', 'PR #7'),
        row('workflow-ran', 'Ran', 'workflow'),
        row('workflow-succeeded', 'Succeeded', 'run #3'),
        row('star-2', 'Starred', 'star'),
        row('issue-opened', 'Opened', 'issue'),
      ]),
    ).toEqual([
      'PR 1 opened',
      'Issue 1 opened, 1 closed',
      'Star 2',
      'Workflow 1 ran, 1 succeeded, 1 failed',
    ]);
  });

  it('uses the same fold grammar for one row', () => {
    expect(formatNotificationHeadlines([row('merged', 'Merged', 'corner · PR #1156')])).toEqual([
      'PR 1 merged',
    ]);
  });
});

function check(
  id: string,
  result: 'started' | 'passed' | 'failed',
  prNumber: number,
  name = 'Build',
  headSha?: string,
): ChatDisplayMessage {
  return {
    id,
    text: `GitHub ${result} a check ${name}`,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    isUser: false,
    isSystemNotice: true,
    systemEvent: {
      subject: { kind: 'github', name: 'GitHub' },
      verb: `${result} a check`,
      object: {
        text: name,
        url: `https://github.test/acme/repo/pull/${prNumber}/checks/${name}`,
        ...(headSha ? { headSha } : {}),
      },
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
  it('uses check nouns and passed, failed, running grammar for check batches', () => {
    const allPassed = foldSystemLines([
      check('1', 'passed', 42, 'Build'),
      check('2', 'passed', 42, 'Lint'),
      check('3', 'passed', 42, 'Test'),
      check('4', 'passed', 42, 'Mobile'),
      check('5', 'passed', 42, 'Server'),
    ])[0]!.notificationLifecycleRun!;
    expect(allPassed.headline).toBe('Check 5 passed');

    const mixed = foldSystemLines([
      check('1', 'passed', 42, 'Build'),
      check('2', 'passed', 42, 'Lint'),
      check('3', 'passed', 42, 'Test'),
      check('4', 'passed', 42, 'Mobile'),
      check('5', 'failed', 42, 'Server'),
    ])[0]!.notificationLifecycleRun!;
    expect(mixed.headline).toBe('Check 4 passed, 1 failed');

    const running = foldSystemLines([
      check('1', 'started', 42, 'Build'),
      check('2', 'started', 42, 'Lint'),
      check('3', 'started', 42, 'Test'),
    ])[0]!.notificationLifecycleRun!;
    expect(running.headline).toBe('Check 3 running');
  });

  it('folds started and completed check system lines into the same batch', () => {
    const folded = foldSystemLines([
      check('1', 'started', 42, 'Build'),
      check('2', 'started', 42, 'Lint'),
      check('3', 'passed', 42, 'Build'),
      check('4', 'failed', 42, 'Lint'),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.foldedIds).toEqual(['1', '2', '3', '4']);
    expect(folded[0]!.notificationLifecycleRun?.headline).toBe('Check 1 passed, 1 failed');
  });

  it('updates one check batch across webhook bursts and starts a new batch for a new head', () => {
    const firstHead = 'a'.repeat(40);
    const secondHead = 'b'.repeat(40);
    const names = ['Build', 'Lint', 'Typecheck', 'Mobile', 'Server', 'Body', 'Auth', 'Docs'];
    const started = names.map((name, index) =>
      check(`start-${index}`, 'started', 42, name, firstHead),
    );
    const firstResults = names
      .slice(0, 3)
      .map((name, index) => check(`pass-${index}`, 'passed', 42, name, firstHead));
    const betweenBursts = prose('between-bursts', 'agent');
    const midRun = foldSystemLines([...started, betweenBursts, ...firstResults]);
    expect(midRun.filter((message) => message.notificationLifecycleRun)).toHaveLength(1);
    expect(midRun[0]!.notificationLifecycleRun?.headline).toBe('Check 3 passed, 5 running');
    expect(midRun.map((message) => message.id)).toEqual(['start-0', 'between-bursts']);

    const finalResults = names
      .slice(3)
      .map((name, index) => check(`pass-${index + 3}`, 'passed', 42, name, firstHead));
    const nextPush = check('next-head', 'started', 42, 'Build', secondHead);
    const complete = foldSystemLines([
      ...started,
      betweenBursts,
      ...firstResults,
      prose('later-burst', 'human'),
      ...finalResults,
      nextPush,
    ]);
    const batches = complete.flatMap((message) =>
      message.notificationLifecycleRun ? [message.notificationLifecycleRun] : [],
    );
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.headline)).toEqual([
      'Check 8 passed',
      'Check 1 running',
    ]);
  });

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

  it('labels an abandoned corner closed when lifecycle cards fold', () => {
    const run = foldSystemLines([
      corner('1', 'corner-complete', 'closed-corner', undefined, 'abandoned'),
      corner('2', 'corner-open', 'open-corner'),
    ])[0]!.notificationLifecycleRun!;

    expect(run.items.map(({ title, state }) => [title, state])).toEqual([
      ['Corner open-corner', 'Opened'],
      ['Corner closed-corner', 'Closed'],
    ]);
    expect(run.headline).toBe('PR 1 opened, 1 closed');
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
    expect(run.headline).toBe('PR 1 opened, 1 merged');
    expect(run.items).toHaveLength(2);
    expect(run.items[0]).toMatchObject({ state: 'PR opened', kindLine: 'PR #77' });
    expect(run.items[1]).toMatchObject({
      state: 'Merged',
      kindLine: 'corner · PR #42',
      cornerId: 'corner-a',
    });
    expect(run.items.every((item) => item.title !== 'worktree-cleaned 5')).toBe(true);
  });

  it('keeps check subjects separate from their PR and marks check failure as danger', () => {
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
      'Checks passed',
    ]);
    expect(run.items[0]).toMatchObject({ danger: true });
    expect(run.headline).toBe('PR 1 closed, 1 merged · Check 1 passed, 1 failed · Issue 1 opened');
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
