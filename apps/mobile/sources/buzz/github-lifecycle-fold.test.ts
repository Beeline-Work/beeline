import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { foldSystemLines as foldGitHubLifecycleRuns } from './system-lines';

function github(
  id: string,
  action: 'opened' | 'closed' | 'merged',
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
      title: `Change ${id}`,
      url: `https://github.test/${type}/${id}`,
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

describe('GitHub lifecycle folding', () => {
  it('leaves a single event exactly as it arrived', () => {
    const only = github('1', 'opened');
    expect(foldGitHubLifecycleRuns([only])).toEqual([only]);
    expect(foldGitHubLifecycleRuns([only])[0]).toBe(only);
  });

  it.each([2, 3, 5])('folds a run of %i events into one stable row', (count) => {
    const messages = Array.from({ length: count }, (_, index) =>
      github(String(index + 1), index < 3 ? 'opened' : 'merged'),
    );
    const folded = foldGitHubLifecycleRuns(messages);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      id: '1',
      timestamp: count,
      githubLifecycleRun: {
        headline: count <= 3 ? `${count} PRs opened` : `3 PRs opened · ${count - 3} merged`,
      },
    });
    expect(folded[0]!.githubLifecycleRun!.items.map((item) => item.id)).toEqual(
      messages.map((message) => message.id).reverse(),
    );
  });

  it.each(['human', 'agent'] as const)('%s prose splits two GitHub runs', (kind) => {
    const folded = foldGitHubLifecycleRuns([
      github('1', 'opened'),
      github('2', 'merged'),
      prose('message', kind),
      github('3', 'opened'),
      github('4', 'closed'),
    ]);
    expect(folded.map((message) => message.id)).toEqual(['1', 'message', '3']);
    expect(folded[0]!.githubLifecycleRun?.items).toHaveLength(2);
    expect(folded[2]!.githubLifecycleRun?.items).toHaveLength(2);
  });

  it('extends the tail card in place when another event appends', () => {
    const before = foldGitHubLifecycleRuns([github('1', 'opened'), github('2', 'opened')]);
    const after = foldGitHubLifecycleRuns([
      github('1', 'opened'),
      github('2', 'opened'),
      github('3', 'merged'),
    ]);
    expect(before[0]!.id).toBe('1');
    expect(after[0]!.id).toBe('1');
    expect(after[0]!.githubLifecycleRun).toMatchObject({
      headline: '2 PRs opened · 1 merged',
    });
  });

  it('folds structured GitHub corner notes with repository cards', () => {
    const cornerNote: ChatDisplayMessage = {
      id: 'corner',
      text: 'GitHub passed a check Build',
      timestamp: 2,
      isUser: false,
      isSystemNotice: true,
      systemEvent: {
        subject: { kind: 'github', name: 'GitHub' },
        verb: 'passed a check',
        object: { text: 'Build', url: 'https://github.test/check/2' },
      },
    };
    const folded = foldGitHubLifecycleRuns([github('1', 'opened'), cornerNote]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.githubLifecycleRun).toMatchObject({
      headline: '1 PR opened · 1 check passed',
    });
  });
});
