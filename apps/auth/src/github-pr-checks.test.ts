import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAppClient } from './github.js';

const app = () =>
  new GitHubAppClient({
    appId: '1',
    privateKey: 'unused',
    slug: 'test',
    apiBaseUrl: 'https://api.github.test',
  });
afterEach(() => vi.unstubAllGlobals());

describe('GitHub PR check reads', () => {
  it('paginates latest runs so a failure beyond the first hundred is not hidden', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string) => {
      urls.push(input);
      return Response.json(
        new URL(input).searchParams.get('page') === '1'
          ? {
              check_runs: Array.from({ length: 100 }, (_, id) => ({
                id,
                status: 'completed',
                conclusion: 'success',
              })),
            }
          : new URL(input).searchParams.get('page') === '2'
            ? { check_runs: [{ id: 101, status: 'completed', conclusion: 'failure' }] }
            : { state: 'pending', total_count: 0 },
      );
    });
    const checks = await app().readCommitChecks('token', 'owner/widgets', 'a'.repeat(40));
    expect(Object.keys(checks)).toHaveLength(101);
    expect(checks['run:101']).toBe('failed');
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('filter=latest&per_page=100&page=1');
  });

  it('maps neutral/skipped to passing, queued/null to pending and terminal errors to failed', async () => {
    const runs = [
      { id: 1, status: 'completed', conclusion: 'neutral' },
      { id: 2, status: 'completed', conclusion: 'skipped' },
      { id: 3, status: 'queued', conclusion: null },
      { id: 4, status: 'completed', conclusion: null },
      { id: 5, status: 'completed', conclusion: 'cancelled' },
      { id: 6, status: 'completed', conclusion: 'timed_out' },
    ];
    vi.stubGlobal('fetch', async (url: string) =>
      Response.json(
        url.includes('check-runs') ? { check_runs: runs } : { state: 'failure', total_count: 200 },
      ),
    );
    expect(await app().readCommitChecks('token', 'owner/widgets', 'a'.repeat(40))).toEqual({
      'run:1': 'passed',
      'run:2': 'passed',
      'run:3': 'pending',
      'run:4': 'pending',
      'run:5': 'failed',
      'run:6': 'failed',
      'commit-status': 'failed',
    });
  });

  it.each(['success', 'pending'])(
    'includes nonempty combined status %s alongside runs',
    async (state) => {
      vi.stubGlobal('fetch', async (url: string) =>
        Response.json(url.includes('check-runs') ? { check_runs: [] } : { state, total_count: 1 }),
      );
      expect(await app().readCommitChecks('token', 'owner/widgets', 'a'.repeat(40))).toEqual({
        'commit-status': state === 'success' ? 'passed' : 'pending',
      });
    },
  );

  it('rejects unreadable checks and invalid PR heads rather than inventing a verdict', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 403 }));
    await expect(
      app().readCommitChecks('token', 'owner/widgets', 'a'.repeat(40)),
    ).rejects.toThrow();
    vi.stubGlobal('fetch', async () => Response.json({ head: { sha: '../main' } }));
    await expect(app().readPullRequest('token', 'owner/widgets', 614)).rejects.toThrow(
      'valid head',
    );
  });
});
