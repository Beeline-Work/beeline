import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAppClient } from './github.js';

const app = () =>
  new GitHubAppClient({
    appId: '1',
    privateKey: 'unused',
    slug: 'test',
    apiBaseUrl: 'https://api.github.test',
  });
const sha = 'a'.repeat(40);
const response = (state: string, nodes: Record<string, unknown>[], totalCount = nodes.length) => ({
  data: {
    repository: {
      object: { oid: sha, statusCheckRollup: { state, contexts: { totalCount, nodes } } },
    },
  },
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('zero-check registration evidence', () => {
  it('confirms a repository with no workflows without a settle delay', async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json({ total_count: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await app().confirmNoChecks('token', 'owner/widgets', sha)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.github.test/repos/owner/widgets/actions/workflows?per_page=1');
  });

  it.each([[0, 0, true], [1, 0, false], [0, 1, false], [undefined, undefined, false]])(
    'requires settled absence of suites (%s) and workflow runs (%s)', async (suites, runs, expected) => {
      vi.useFakeTimers();
      const requests: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        requests.push(url);
        return Response.json({ total_count: url.includes('/actions/workflows?') ? 2 : url.includes('/check-suites?') ? suites : runs });
      });
      const verdict = app().confirmNoChecks('token', 'owner/widgets', sha);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await verdict).toBe(expected);
      expect(requests).toContain(`https://api.github.test/repos/owner/widgets/commits/${sha}/check-suites?per_page=1`);
      expect(requests).toContain(`https://api.github.test/repos/owner/widgets/actions/runs?head_sha=${sha}&per_page=1`);
    },
  );

  it('refuses missing workflow evidence', async () => {
    vi.stubGlobal('fetch', async () => Response.json({}));
    await expect(app().confirmNoChecks('token', 'owner/widgets', sha)).rejects.toThrow('workflow count is invalid');
  });
});

describe('GitHub PR check reads', () => {
  it('reads a completed job log through the installation-token REST endpoint', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response('context\n##[error]failed\n'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(app().readJobLog('installation-token', 'owner/widgets', 123)).resolves.toContain('##[error]failed');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.github.test/repos/owner/widgets/actions/jobs/123/logs');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer installation-token' });
  });

  it("uses GitHub's combined rollup instead of reconstructing a verdict", async () => {
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) =>
      Response.json(
        response('SUCCESS', [
          {
            __typename: 'CheckRun',
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            detailsUrl: 'https://github.com/owner/widgets/actions/runs/1',
          },
          {
            __typename: 'StatusContext',
            context: 'deploy',
            state: 'SUCCESS',
            description: 'deployed',
            targetUrl: 'https://example.test/deploy',
          },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(app().readCommitCheckRollup('token', 'owner/widgets', sha)).resolves.toEqual({
      state: 'passed',
      total: 2,
      failing: [],
      checks: [
        {
          name: 'test',
          status: 'passed',
          conclusion: 'SUCCESS',
          url: 'https://github.com/owner/widgets/actions/runs/1',
        },
        {
          name: 'deploy',
          status: 'passed',
          conclusion: 'deployed',
          url: 'https://example.test/deploy',
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.github.test/graphql');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      variables: { owner: 'owner', name: 'widgets', expression: sha },
    });
  });

  it.each([
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
    ['FAILURE', 'failed'],
    ['ERROR', 'failed'],
  ] as const)('maps GitHub rollup %s to %s', async (githubState, state) => {
    vi.stubGlobal('fetch', async () =>
      Response.json(
        response(githubState, [
          {
            __typename: 'CheckRun',
            name: 'build',
            status: githubState === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED',
            conclusion: githubState === 'FAILURE' ? 'FAILURE' : null,
          },
        ]),
      ),
    );
    expect(await app().readCommitCheckRollup('token', 'owner/widgets', sha)).toMatchObject({
      state,
    });
  });

  it('classifies a job GitHub cancelled as cancelled, not failed', async () => {
    // A job cancelled before a runner picked it up has no code verdict. The
    // combined rollup GitHub returns is still FAILURE, but the run itself is
    // reported as cancelled and must not read as a repair-waking failure.
    vi.stubGlobal('fetch', async () =>
      Response.json(
        response('FAILURE', [
          {
            __typename: 'CheckRun',
            name: 'Deploy',
            status: 'COMPLETED',
            conclusion: 'CANCELLED',
          },
        ]),
      ),
    );
    await expect(app().readCommitCheckRollup('token', 'owner/widgets', sha)).resolves.toMatchObject({
      state: 'failed',
      checks: [{ name: 'Deploy', status: 'cancelled', conclusion: 'CANCELLED' }],
      failing: [],
    });
  });

  it('treats a head with no rollup as pending rather than passing', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ data: { repository: { object: { oid: sha, statusCheckRollup: null } } } }),
    );
    await expect(app().readCommitCheckRollup('token', 'owner/widgets', sha)).resolves.toEqual({
      state: 'pending',
      total: 0,
      failing: [],
      checks: [],
    });
  });

  it('rejects errors and a response for a different head', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ errors: [{ message: 'forbidden' }] }));
    await expect(app().readCommitCheckRollup('token', 'owner/widgets', sha)).rejects.toThrow(
      'returned errors',
    );
    vi.stubGlobal('fetch', async () =>
      Response.json({ data: { repository: { object: { oid: 'b'.repeat(40) } } } }),
    );
    await expect(app().readCommitCheckRollup('token', 'owner/widgets', sha)).rejects.toThrow(
      'head mismatch',
    );
  });
});
