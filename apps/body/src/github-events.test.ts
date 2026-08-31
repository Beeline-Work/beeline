import { describe, expect, it, vi } from 'vitest';
import { GitHubEventsApiSource, normalizeGitHubEvent } from './github-events.js';

function raw(
  type: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: '100',
    type,
    actor: { login: 'lena', type: 'User' },
    repo: { name: 'acme/widget', url: 'https://api.github.com/repos/acme/widget' },
    created_at: '2026-08-24T12:00:00Z',
    payload,
    ...overrides,
  };
}

describe('normalizeGitHubEvent', () => {
  it('normalizes only typed pull-request and issue lifecycle cards', () => {
    const events = [
      raw('PushEvent', { ref: 'refs/heads/main', commits: [{}, {}] }),
      raw('PullRequestEvent', {
        action: 'opened',
        number: 7,
        pull_request: {
          number: 7,
          title: 'Open it',
          html_url: 'https://github.com/acme/widget/pull/7',
        },
      }),
      raw('PullRequestEvent', {
        action: 'closed',
        number: 7,
        pull_request: {
          number: 7,
          title: 'Land it',
          merged: true,
          html_url: 'https://github.com/acme/widget/pull/7',
        },
      }),
      raw('IssuesEvent', {
        action: 'opened',
        issue: { number: 9, title: 'Broken', html_url: 'https://github.com/acme/widget/issues/9' },
      }),
      raw('IssuesEvent', {
        action: 'closed',
        issue: { number: 10, title: 'Fixed', html_url: 'https://github.com/acme/widget/issues/10' },
      }),
      raw('WorkflowRunEvent', {
        action: 'completed',
        workflow_run: {
          name: 'CI',
          conclusion: 'success',
          head_branch: 'main',
          html_url: 'https://github.com/acme/widget/actions/runs/1',
        },
      }),
      raw('PullRequestReviewCommentEvent', {
        action: 'created',
        pull_request: { number: 7, title: 'Land it' },
        comment: { html_url: 'https://github.com/acme/widget/pull/7#discussion_r1' },
      }),
      raw('CheckRunEvent', {
        action: 'completed',
        check_run: {
          name: 'Typecheck',
          conclusion: 'success',
          html_url: 'https://github.com/acme/widget/runs/2',
        },
      }),
    ].map(normalizeGitHubEvent);

    expect(events.map((event) => event && [event.type, event.action])).toEqual([
      ['lifecycle-hint', 'target-push'],
      ['pull-request', 'opened'],
      ['pull-request', 'merged'],
      ['issue', 'opened'],
      ['issue', 'closed'],
      undefined,
      undefined,
      undefined,
    ]);
    expect(events[2]).toMatchObject({
      type: 'pull-request',
      action: 'merged',
      title: 'Land it',
      url: 'https://github.com/acme/widget/pull/7',
    });
  });

  it('turns branch pushes and PR synchronize events into lifecycle hints', () => {
    expect(
      normalizeGitHubEvent(raw('PushEvent', { ref: 'refs/heads/main', commits: [] })),
    ).toMatchObject({ type: 'lifecycle-hint', action: 'target-push' });
    expect(
      normalizeGitHubEvent(
        raw('PullRequestEvent', {
          action: 'synchronize',
          pull_request: { number: 7, title: 'Land it' },
        }),
      ),
    ).toMatchObject({ type: 'lifecycle-hint', action: 'synchronize' });
  });
});

describe('GitHubEventsApiSource', () => {
  const target = { owner: 'acme', repo: 'widget', roomId: 'room' };

  it('walks newest-first results only to the durable cursor', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            raw('PushEvent', { ref: 'refs/heads/main', commits: [{}] }, { id: '103' }),
            raw(
              'IssuesEvent',
              {
                action: 'closed',
                issue: {
                  number: 2,
                  title: 'Done',
                  html_url: 'https://github.com/acme/widget/issues/2',
                },
              },
              { id: '102' },
            ),
            raw('PushEvent', { ref: 'refs/heads/main', commits: [{}] }, { id: '101' }),
          ]),
          { status: 200 },
        ),
    );
    const source = new GitHubEventsApiSource(async () => 'installation-token', {
      fetch: fetchMock as typeof fetch,
    });

    const result = await source.read(target, '101');

    expect(result.head).toBe('103');
    expect(result.sourceEventIds).toEqual(['103', '102']);
    expect(result.events.map((event) => event.id)).toEqual(['103', '102']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enforces an abort deadline on a stalled GitHub request', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        }),
    );
    const source = new GitHubEventsApiSource(async () => 'installation-token', {
      fetch: fetchMock as typeof fetch,
      requestTimeoutMs: 20,
    });

    await expect(source.read(target, '101')).rejects.toThrow(/timeout|aborted/i);
  });

  it('caps cold and expired-cursor catch-up at the newest twenty raw events', async () => {
    const page = Array.from({ length: 25 }, (_, index) =>
      raw('PushEvent', { ref: 'refs/heads/main', commits: [{}] }, { id: String(100 - index) }),
    );
    const source = new GitHubEventsApiSource(async () => 'installation-token', {
      fetch: vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })) as typeof fetch,
    });

    await expect(source.read(target, undefined)).resolves.toMatchObject({
      head: '100',
      sourceEventIds: Array.from({ length: 20 }, (_, index) => String(100 - index)),
    });
    await expect(source.read(target, 'missing-old-cursor')).resolves.toMatchObject({
      head: '100',
      sourceEventIds: Array.from({ length: 20 }, (_, index) => String(100 - index)),
    });
  });

  it('walks multiple pages when the durable cursor is older than page one', async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      raw('PushEvent', { ref: 'refs/heads/main', commits: [{}] }, { id: String(300 - index) }),
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(first), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            raw('PushEvent', { ref: 'refs/heads/main', commits: [{}] }, { id: '200' }),
            raw('PushEvent', { ref: 'refs/heads/main', commits: [{}] }, { id: '199' }),
          ]),
          { status: 200 },
        ),
      );
    const source = new GitHubEventsApiSource(async () => 'installation-token', {
      fetch: fetchMock,
    });

    const result = await source.read(target, '199');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.head).toBe('300');
    expect(result.sourceEventIds.at(-1)).toBe('200');
  });
});
