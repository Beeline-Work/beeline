import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { anchorRelayReports } from './system-lines';

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
  });
});
