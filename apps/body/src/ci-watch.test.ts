import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeCiOutcome,
  parseGitHubRemoteUrl,
  readCommitCiStatus,
  resolveGitHubRepo,
  watchCommitCi,
  type CiConclusion,
} from './ci-watch.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repoWithRemote(url: string): string {
  const root = mkdtempSync(join(tmpdir(), 'beeline-ci-watch-'));
  cleanup.push(root);
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  spawnSync('git', ['remote', 'add', 'origin', url], { cwd: root });
  return root;
}

/** One canned API response per URL fragment; anything unmatched is a 404. */
function stubApi(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((fragment) => url.includes(fragment));
    if (!key) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

describe('recognizing a GitHub remote', () => {
  it('reads owner/repo out of every form git writes a github.com remote', () => {
    for (const url of [
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets',
      'https://token@github.com/acme/widgets.git',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
      'git://github.com/acme/widgets',
    ]) {
      expect(parseGitHubRemoteUrl(url), url).toEqual({ owner: 'acme', repo: 'widgets' });
    }
  });

  it('is undefined for everything that is not github.com', () => {
    for (const url of [
      '',
      'https://gitlab.com/acme/widgets.git',
      'https://relay.buzzrouter.com/git/abc123/scratch',
      '/home/operator/proj-buzzy',
      'git@example.com:acme/widgets.git',
      'https://github.example.com/acme/widgets.git',
    ]) {
      expect(parseGitHubRemoteUrl(url), url).toBeUndefined();
    }
  });

  it('resolves a real checkout by its configured remote, and only that remote', () => {
    const github = repoWithRemote('git@github.com:acme/widgets.git');
    expect(resolveGitHubRepo(github, 'origin')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(resolveGitHubRepo(github, 'upstream')).toBeUndefined();

    const local = repoWithRemote('/srv/mirrors/widgets.git');
    expect(resolveGitHubRepo(local, 'origin')).toBeUndefined();
  });
});

describe('the CI verdict for a landed commit', () => {
  const ref = { owner: 'acme', repo: 'widgets' };
  const sha = 'a'.repeat(40);

  it('is `none` when the commit carries neither a status nor a check run', async () => {
    const conclusion = await readCommitCiStatus(ref, sha, {
      fetchImpl: stubApi({
        '/status': { state: 'pending', statuses: [], total_count: 0 },
        '/check-runs': { total_count: 0, check_runs: [] },
      }),
    });
    expect(conclusion).toEqual({ kind: 'none' });
  });

  it('reads a green from either surface — check runs or legacy commit statuses', async () => {
    await expect(
      readCommitCiStatus(ref, sha, {
        fetchImpl: stubApi({
          '/status': { state: 'pending', statuses: [], total_count: 0 },
          '/check-runs': {
            total_count: 1,
            check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }],
          },
        }),
      }),
    ).resolves.toEqual({ kind: 'success', checks: 1 });

    await expect(
      readCommitCiStatus(ref, sha, {
        fetchImpl: stubApi({
          '/status': {
            state: 'success',
            total_count: 1,
            statuses: [{ context: 'ci/circleci', state: 'success' }],
          },
          '/check-runs': { total_count: 0, check_runs: [] },
        }),
      }),
    ).resolves.toEqual({ kind: 'success', checks: 1 });
  });

  it('names the failing check and its link, and never calls a skip a failure', async () => {
    await expect(
      readCommitCiStatus(ref, sha, {
        fetchImpl: stubApi({
          '/status': { state: 'success', statuses: [], total_count: 0 },
          '/check-runs': {
            total_count: 3,
            check_runs: [
              { name: 'lint', status: 'completed', conclusion: 'skipped' },
              { name: 'typecheck', status: 'completed', conclusion: 'neutral' },
              {
                name: 'deploy',
                status: 'completed',
                conclusion: 'failure',
                html_url: 'https://github.com/acme/widgets/runs/9',
              },
            ],
          },
        }),
      }),
    ).resolves.toEqual({
      kind: 'failure',
      check: 'deploy',
      url: 'https://github.com/acme/widgets/runs/9',
    });

    // Skips and neutrals alone are a pass, not a red.
    await expect(
      readCommitCiStatus(ref, sha, {
        fetchImpl: stubApi({
          '/status': { state: 'success', statuses: [], total_count: 0 },
          '/check-runs': {
            total_count: 1,
            check_runs: [{ name: 'lint', status: 'completed', conclusion: 'skipped' }],
          },
        }),
      }),
    ).resolves.toMatchObject({ kind: 'success' });
  });

  it('is `pending` while any check is still running', async () => {
    await expect(
      readCommitCiStatus(ref, sha, {
        fetchImpl: stubApi({
          '/status': { state: 'success', statuses: [], total_count: 0 },
          '/check-runs': {
            total_count: 2,
            check_runs: [
              { name: 'build', status: 'completed', conclusion: 'success' },
              { name: 'e2e', status: 'in_progress', conclusion: null },
            ],
          },
        }),
      }),
    ).resolves.toEqual({ kind: 'pending' });
  });

  it('never turns an unreadable API into a verdict', async () => {
    const conclusion = await readCommitCiStatus(ref, sha, {
      fetchImpl: (async () => new Response('rate limited', { status: 403 })) as typeof fetch,
    });
    expect(conclusion).toEqual({ kind: 'none' });
  });
});

describe('the bounded watch', () => {
  const ref = { owner: 'acme', repo: 'widgets' };
  const sha = 'b'.repeat(40);

  /** A virtual clock: no real waiting, and the elapsed budget is exact. */
  function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let current = 0;
    return {
      now: () => current,
      sleep: async (ms: number) => {
        current += ms;
      },
    };
  }

  it('keeps polling a pending pipeline until it decides', async () => {
    const seen: CiConclusion[] = [
      { kind: 'pending' },
      { kind: 'pending' },
      { kind: 'success', checks: 2 },
    ];
    let call = 0;
    const conclusion = await watchCommitCi(ref, sha, {
      ...clock(),
      pollMs: 30_000,
      timeoutMs: 900_000,
      noneGraceMs: 120_000,
      fetchImpl: (async (input: string | URL | Request) => {
        const next = seen[Math.min(call, seen.length - 1)]!;
        // Both surfaces are read per poll; count one poll per status read.
        if (String(input).includes('/status')) call++;
        const runs =
          next.kind === 'success'
            ? [{ name: 'build', status: 'completed', conclusion: 'success' }]
            : [{ name: 'build', status: 'in_progress', conclusion: null }];
        return new Response(
          JSON.stringify(
            String(input).includes('/status')
              ? { state: 'pending', statuses: [], total_count: 0 }
              : { total_count: runs.length, check_runs: runs },
          ),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(conclusion).toMatchObject({ kind: 'success' });
    expect(call).toBeGreaterThan(1);
  });

  it('gives up on an empty commit once the no-CI grace elapses, not on the first read', async () => {
    let polls = 0;
    const conclusion = await watchCommitCi(ref, sha, {
      ...clock(),
      pollMs: 30_000,
      timeoutMs: 900_000,
      noneGraceMs: 120_000,
      fetchImpl: (async (input: string | URL | Request) => {
        if (String(input).includes('/status')) polls++;
        return new Response(
          JSON.stringify(
            String(input).includes('/status')
              ? { state: 'pending', statuses: [], total_count: 0 }
              : { total_count: 0, check_runs: [] },
          ),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(conclusion).toEqual({ kind: 'none' });
    // 0s, 30s, 60s, 90s, 120s — the grace is a window, not a single look.
    expect(polls).toBe(5);
  });

  it('stops at the budget with a pipeline that never finishes', async () => {
    const virtual = clock();
    const conclusion = await watchCommitCi(ref, sha, {
      ...virtual,
      pollMs: 30_000,
      timeoutMs: 900_000,
      noneGraceMs: 120_000,
      fetchImpl: stubApi({
        '/status': { state: 'pending', statuses: [], total_count: 0 },
        '/check-runs': {
          total_count: 1,
          check_runs: [{ name: 'e2e', status: 'queued', conclusion: null }],
        },
      }),
    });
    expect(conclusion).toEqual({ kind: 'pending' });
    expect(virtual.now()).toBeLessThanOrEqual(900_000);
  });

  it('ends immediately when the daemon is shutting down', async () => {
    const controller = new AbortController();
    controller.abort();
    const conclusion = await watchCommitCi(ref, sha, {
      ...clock(),
      pollMs: 30_000,
      timeoutMs: 900_000,
      noneGraceMs: 120_000,
      signal: controller.signal,
      fetchImpl: (async () => {
        throw new Error('the watch must not reach the network after abort');
      }) as typeof fetch,
    });
    expect(conclusion).toEqual({ kind: 'pending' });
  });
});

describe('what a Room is told', () => {
  const context = { branch: 'refs/heads/main', tip: 'c'.repeat(40) };

  it('says nothing at all when nothing was decided', () => {
    expect(describeCiOutcome({ kind: 'none' }, context)).toBeUndefined();
    expect(describeCiOutcome({ kind: 'pending' }, context)).toBeUndefined();
  });

  it('reports a pass and a failure in one line each, the failure with its link', () => {
    expect(describeCiOutcome({ kind: 'success', checks: 4 }, context)).toBe(
      `CI ✓ — every check passed for the change that landed on main (${'c'.repeat(12)}).`,
    );
    expect(
      describeCiOutcome(
        { kind: 'failure', check: 'deploy', url: 'https://github.com/acme/widgets/runs/9' },
        context,
      ),
    ).toBe(
      `CI ✗ — deploy failed for the change that landed on main (${'c'.repeat(12)}). ` +
        'https://github.com/acme/widgets/runs/9',
    );
  });
});
