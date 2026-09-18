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

afterEach(() => vi.unstubAllGlobals());

describe('GitHub PR check reads', () => {
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
