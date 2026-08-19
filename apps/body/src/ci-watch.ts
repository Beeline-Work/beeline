/**
 * What happened to a corner's change AFTER it landed.
 *
 * A corner's story used to end at the land: the parent Room got the
 * land summary (#248) and nothing else, so "did it actually go green?" was a
 * question every reader had to leave Beeline to answer. This module resolves
 * that one fact for a landed commit on a GitHub remote and nothing else — it
 * owns no polling policy of its own beyond the bounds its caller passes, holds
 * no relay concepts, and never throws for a repository that simply has no CI.
 *
 * Deliberately narrow:
 *   - GitHub remotes only. A local-only repo, a relay-origin repo, or any
 *     other host resolves to `undefined` at `parseGitHubRemoteUrl` and the
 *     caller stays silent — an unwatchable repo is not an error.
 *   - Read-only. Nothing here mutates a repository, a ref, or a check.
 *   - Two terminal answers (`success`/`failure`) are worth a message; `none`
 *     (this commit has no CI at all) and `pending` (still running when the
 *     watch budget ran out) are not, because neither is news.
 */
import { spawnSync } from 'node:child_process';

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/**
 * The one fact this module resolves for a commit.
 *
 * `none` and `pending` are deliberately distinct from each other and from a
 * failure: "this repository runs no CI" and "CI is still running" are both
 * honest non-answers, and reporting either as a verdict would be a claim the
 * daemon cannot support.
 */
export type CiConclusion =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'success'; checks: number }
  | { kind: 'failure'; check: string; url?: string };

/** GitHub check-run conclusions that are a genuine red, not a skip or a wash. */
const FAILED_CHECK_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'startup_failure',
  'action_required',
]);

/**
 * `owner/repo` for a github.com remote, in any form git writes one:
 * `https://github.com/o/r(.git)`, `git@github.com:o/r.git` (scp-like),
 * `ssh://git@github.com/o/r.git`, `git://github.com/o/r`. Anything else —
 * GitLab, a Buzz relay origin, a bare path — is `undefined`, which is what
 * keeps every non-GitHub repository silent rather than erroring.
 */
export function parseGitHubRemoteUrl(url: string): GitHubRepoRef | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  const scpLike = /^(?:[\w.-]+@)?github\.com:(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?\/?$/i;
  const urlLike =
    /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?github\.com\/(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?\/?$/i;
  const match = scpLike.exec(trimmed) ?? urlLike.exec(trimmed);
  const owner = match?.groups?.owner;
  const repo = match?.groups?.repo;
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

/** The GitHub identity of a checkout's remote, or `undefined` for anything else. */
export function resolveGitHubRepo(cwd: string, remoteName: string): GitHubRepoRef | undefined {
  const result = spawnSync('git', ['remote', 'get-url', remoteName], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) return undefined;
  return parseGitHubRemoteUrl(result.stdout ?? '');
}

/**
 * A token for the GitHub API, or `undefined` to read anonymously.
 *
 * The land push this watch follows already used the operator's ambient git
 * credentials, so the same credentials are the honest source here: an explicit
 * token in the environment first, then whatever `git credential` already holds
 * for github.com (which is where `gh auth login` puts its token). Prompting is
 * disabled outright — a daemon has no terminal, and a helper that wants to ask
 * a question must fail rather than hang. A public repository needs no token at
 * all, so `undefined` stays a working answer.
 */
export function resolveGitHubToken(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const result = spawnSync('git', ['credential', 'fill'], {
    cwd,
    encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\n\n',
    timeout: 5_000,
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) return undefined;
  const password = /^password=(.*)$/m.exec(result.stdout ?? '')?.[1]?.trim();
  return password || undefined;
}

export interface CiStatusReadOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  /** Ends an in-flight request too, so shutdown never waits on the network. */
  signal?: AbortSignal;
}

async function readJson(
  url: string,
  options: CiStatusReadOptions,
): Promise<Record<string, unknown> | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'beeline-body',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
  });
  // A 404 is the answer for a private repo we cannot read, or a commit GitHub
  // has not seen; a 403 is a rate limit. Neither is a CI verdict, and neither
  // is worth failing a best-effort watch over.
  if (!response.ok) return undefined;
  return (await response.json()) as Record<string, unknown>;
}

/**
 * The combined CI verdict for one commit, from BOTH GitHub surfaces: the
 * legacy commit-status API (what most external CI providers still write) and
 * check-runs (what GitHub Actions writes). Either alone misses a whole class
 * of repository, so a commit is only `none` when both are genuinely empty.
 */
export async function readCommitCiStatus(
  ref: GitHubRepoRef,
  sha: string,
  options: CiStatusReadOptions = {},
): Promise<CiConclusion> {
  const base = options.apiBaseUrl ?? 'https://api.github.com';
  const commit = `${base}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits/${encodeURIComponent(sha)}`;
  const [combined, checks] = await Promise.all([
    readJson(`${commit}/status`, options).catch(() => undefined),
    readJson(`${commit}/check-runs?per_page=100`, options).catch(() => undefined),
  ]);

  const statuses = Array.isArray(combined?.statuses)
    ? (combined!.statuses as Array<Record<string, unknown>>)
    : [];
  const runs = Array.isArray(checks?.check_runs)
    ? (checks!.check_runs as Array<Record<string, unknown>>)
    : [];
  if (statuses.length === 0 && runs.length === 0) return { kind: 'none' };

  // A red anywhere is the answer, and the FIRST red is the one worth naming —
  // a reader chasing a failure needs one check and one link, not a list.
  for (const run of runs) {
    const conclusion = String(run.conclusion ?? '');
    if (String(run.status ?? '') === 'completed' && FAILED_CHECK_CONCLUSIONS.has(conclusion)) {
      return {
        kind: 'failure',
        check: String(run.name ?? 'check'),
        ...(typeof run.html_url === 'string' ? { url: run.html_url } : {}),
      };
    }
  }
  for (const status of statuses) {
    const state = String(status.state ?? '');
    if (state === 'failure' || state === 'error') {
      return {
        kind: 'failure',
        check: String(status.context ?? 'check'),
        ...(typeof status.target_url === 'string' && status.target_url
          ? { url: status.target_url }
          : {}),
      };
    }
  }

  const stillRunning =
    runs.some((run) => String(run.status ?? '') !== 'completed') ||
    statuses.some((status) => String(status.state ?? '') === 'pending');
  if (stillRunning) return { kind: 'pending' };
  return { kind: 'success', checks: runs.length + statuses.length };
}

export interface CiWatchOptions extends CiStatusReadOptions {
  /** Spacing between polls. */
  pollMs: number;
  /** Hard cap on the whole watch — a still-pending CI past this reports nothing. */
  timeoutMs: number;
  /**
   * How long an EMPTY result is tolerated before concluding the commit has no
   * CI at all. A freshly pushed commit routinely has no checks registered for
   * a few seconds, so giving up on the first empty read would silently miss
   * every repository whose CI starts slightly slower than our first poll.
   */
  noneGraceMs: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    // Unref so a pending CI watch can never hold a daemon's event loop open.
    timer.unref?.();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Poll one commit's CI until it is genuinely decided, or the budget runs out.
 *
 * Bounded three ways on purpose: `timeoutMs` caps the whole watch, an aborted
 * signal ends it immediately (daemon shutdown), and a commit that never grows
 * any checks resolves `none` after `noneGraceMs` instead of burning the full
 * budget on a repository that has no CI to report.
 */
export async function watchCommitCi(
  ref: GitHubRepoRef,
  sha: string,
  options: CiWatchOptions,
): Promise<CiConclusion> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let last: CiConclusion = { kind: 'pending' };
  while (!options.signal?.aborted) {
    const seen = await readCommitCiStatus(ref, sha, options).catch(
      () => ({ kind: 'pending' }) as CiConclusion,
    );
    if (seen.kind === 'success' || seen.kind === 'failure') return seen;
    last = seen;
    const elapsed = now() - startedAt;
    if (seen.kind === 'none' && elapsed >= options.noneGraceMs) return seen;
    if (elapsed + options.pollMs > options.timeoutMs) break;
    await sleep(options.pollMs, options.signal);
  }
  // Out of budget (or shutting down) with nothing decided: `none` if that is
  // all we ever saw, otherwise still-pending. Neither is reported to a Room.
  return last.kind === 'none' ? { kind: 'none' } : { kind: 'pending' };
}

/**
 * The Room-facing sentence for a decided CI outcome, or `undefined` when there
 * is nothing worth saying (`none`/`pending`). One line, no plumbing: a reader
 * gets the verdict, the check that produced it, and a link to go look.
 */
export function describeCiOutcome(
  conclusion: CiConclusion,
  context: { branch: string; tip: string },
): string | undefined {
  const branch = context.branch.replace(/^refs\/heads\//, '');
  const at = `${branch} (${context.tip.slice(0, 12)})`;
  if (conclusion.kind === 'success') {
    return `CI ✓ — every check passed for the change that landed on ${at}.`;
  }
  if (conclusion.kind === 'failure') {
    return (
      `CI ✗ — ${conclusion.check} failed for the change that landed on ${at}.` +
      (conclusion.url ? ` ${conclusion.url}` : '')
    );
  }
  return undefined;
}
