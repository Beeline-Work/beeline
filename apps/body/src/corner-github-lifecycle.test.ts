import { describe, expect, it, vi } from 'vitest';
import type { BoundRepo } from './body.js';
import {
  enableDeleteBranchOnMerge,
  landedCornerSummary,
  observeCornerRemote,
} from './corner-github-lifecycle.js';

const repo = {
  repo: 'acme/widget',
  repositoryId: 'acme/widget',
  remoteUrl: 'git://github.com/acme/widget',
  targetBranch: 'refs/heads/main',
} as BoundRepo;

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const pull = (mergedAt: string | null = null) => ({
  number: 7,
  html_url: 'https://github.com/acme/widget/pull/7',
  title: 'Ship the lifecycle',
  base: { ref: 'main' },
  head: { sha: 'b'.repeat(40) },
  state: mergedAt ? 'closed' : 'open',
  merged_at: mergedAt,
  merged_by: mergedAt ? { login: 'octocat' } : null,
});

describe('GitHub corner lifecycle observation', () => {
  it('reports an open PR and red checks from GitHub facts', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ object: { sha: 'a'.repeat(40) } }))
      .mockResolvedValueOnce(response([pull()]))
      .mockResolvedValueOnce(
        response({ check_runs: [{ status: 'completed', conclusion: 'failure' }] }),
      )
      .mockResolvedValueOnce(response({ state: 'success' }));

    await expect(
      observeCornerRemote({
        repo,
        cornerId: 'corner',
        featureBranch: 'fm/change',
        token: 'token',
        fetchImpl,
        apiBaseUrl: 'https://api.test',
        now: () => 5_000,
      }),
    ).resolves.toMatchObject({
      state: 'in-review',
      checks: 'failing',
      observedAt: 5,
      pr: {
        number: 7,
        url: 'https://github.com/acme/widget/pull/7',
        targetBranch: 'main',
      },
    });
  });

  it('classifies branch death as landed only when GitHub reports a merged PR', async () => {
    const mergedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response([pull('2026-08-31T00:00:00Z')]));
    await expect(
      observeCornerRemote({
        repo,
        cornerId: 'corner',
        featureBranch: 'fm/change',
        token: 'token',
        fetchImpl: mergedFetch,
      }),
    ).resolves.toMatchObject({ state: 'gone', outcome: 'landed' });

    const deletedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response([]));
    await expect(
      observeCornerRemote({
        repo,
        cornerId: 'corner',
        featureBranch: 'fm/change',
        token: 'token',
        fetchImpl: deletedFetch,
      }),
    ).resolves.toMatchObject({ state: 'gone', outcome: 'abandoned' });
  });

  it('classifies a branch-alive external squash as landed after patch-identity proof', async () => {
    const targetContainsChange = vi.fn().mockResolvedValue(true);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ object: { sha: 'a'.repeat(40) } }))
      .mockResolvedValueOnce(response([pull('2026-08-31T00:00:00Z')]));

    await expect(
      observeCornerRemote({
        repo,
        cornerId: '9958a1da',
        featureBranch: 'feature/remove-model-unavailable-model-validation-9958a1da',
        token: 'token',
        fetchImpl,
        targetContainsChange,
      }),
    ).resolves.toMatchObject({
      state: 'gone',
      outcome: 'landed',
      pr: {
        mergedAt: '2026-08-31T00:00:00Z',
        mergedBy: 'octocat',
      },
    });
    expect(targetContainsChange).toHaveBeenCalledWith({
      branchTip: 'a'.repeat(40),
      pull: expect.objectContaining({ headSha: 'b'.repeat(40), mergedBy: 'octocat' }),
    });
  });

  it('states an external merger plainly in the landed summary', async () => {
    expect(
      landedCornerSummary({
        version: 1,
        cornerId: 'corner',
        branch: 'feature/corner',
        state: 'gone',
        checks: 'unknown',
        observedAt: 1,
        outcome: 'landed',
        pr: {
          number: 7,
          url: 'https://github.com/acme/widget/pull/7',
          title: 'Ship the lifecycle',
          targetBranch: 'main',
          headSha: 'b'.repeat(40),
          mergedAt: '2026-08-31T00:00:00Z',
          mergedBy: 'octocat',
        },
      }),
    ).toBe(
      'Merged externally by octocat: “Ship the lifecycle” into main: https://github.com/acme/widget/pull/7.',
    );
  });

  it('degrades to unknown instead of treating a failed GitHub read as completion', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(
      observeCornerRemote({
        repo,
        cornerId: 'corner',
        featureBranch: 'fm/change',
        token: 'token',
        fetchImpl,
      }),
    ).resolves.toMatchObject({ state: 'unknown', checks: 'unknown', reason: 'offline' });
  });

  it('enables GitHub branch auto-delete on merge', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({}));
    await expect(
      enableDeleteBranchOnMerge({
        repo,
        token: 'token',
        fetchImpl,
        apiBaseUrl: 'https://api.test',
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.test/repos/acme/widget',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ delete_branch_on_merge: true }),
      }),
    );
  });
});
