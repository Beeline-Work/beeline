import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { anchorRelayReports, formatNotificationHeadlines } from './system-lines';

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

describe('separate lifecycle notifications', () => {
  it('preserves check starts, results, intervening prose, cleanup and PR events in order', () => {
    const messages = [
      corner('1', 'corner-open'),
      github('2', 'opened'),
      check('3', 'started', 2, 'Build', 'head'),
      prose('4', 'human'),
      check('5', 'passed', 2, 'Build', 'head'),
      check('6', 'failed', 2, 'Test', 'head'),
      github('7', 'merged', '2'),
      corner('8', 'corner-complete', '1', 2),
      corner('9', 'worktree-cleaned', '1'),
    ];
    expect(anchorRelayReports(messages)).toEqual(messages);
    expect(anchorRelayReports(messages).every((message) => !message.notificationLifecycleRun)).toBe(
      true,
    );
  });
});
