import type { BoundRepo } from './body.js';
import type {
  CornerCheckState,
  CornerPullRequestFact,
  CornerRemoteState,
} from '@beeline/buzz-client';

const API_VERSION = '2022-11-28';
const DEFAULT_API_BASE = 'https://api.github.com';

type GitHubPull = {
  number?: unknown;
  html_url?: unknown;
  title?: unknown;
  base?: unknown;
  head?: unknown;
  state?: unknown;
  merged_at?: unknown;
  merged_by?: unknown;
};

export interface ObserveCornerRemoteInput {
  repo: BoundRepo;
  cornerId: string;
  featureBranch: string;
  token: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => number;
  targetContainsChange?: (candidate: {
    branchTip: string;
    pull?: CornerPullRequestFact;
  }) => Promise<boolean>;
}

function repoCoordinates(repo: BoundRepo): { owner: string; name: string } | undefined {
  const remote = repo.truth?.binding.remote ?? repo.remoteUrl;
  const marker = remote?.match(/^git:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (marker) return { owner: marker[1]!, name: marker[2]!.replace(/\.git$/i, '') };
  const identity = repo.repositoryId ?? repo.repo;
  const parts = identity.split('/');
  return parts.length === 2 && parts[0] && parts[1]
    ? { owner: parts[0], name: parts[1].replace(/\.git$/i, '') }
    : undefined;
}

function headers(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'beeline-body',
  };
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

function pullFact(value: GitHubPull): CornerPullRequestFact | undefined {
  const base = value.base as { ref?: unknown } | undefined;
  const head = value.head as { sha?: unknown } | undefined;
  const mergedBy = value.merged_by as { login?: unknown } | undefined;
  if (
    !Number.isSafeInteger(value.number) ||
    Number(value.number) <= 0 ||
    typeof value.html_url !== 'string' ||
    !/^https:\/\/github\.com\/[^\s]+$/i.test(value.html_url) ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    typeof base?.ref !== 'string' ||
    !base.ref ||
    typeof head?.sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(head.sha)
  )
    return undefined;
  return {
    number: Number(value.number),
    url: value.html_url,
    title: value.title.trim(),
    targetBranch: base.ref,
    headSha: head.sha,
    ...(typeof value.merged_at === 'string' && value.merged_at.trim()
      ? { mergedAt: value.merged_at }
      : {}),
    ...(typeof mergedBy?.login === 'string' && mergedBy.login.trim()
      ? { mergedBy: mergedBy.login.trim().slice(0, 100) }
      : {}),
  };
}

export function landedCornerSummary(state: CornerRemoteState): string {
  const pr = state.pr;
  if (!pr) return `Merged externally: ${state.branch}.`;
  const actor = pr.mergedBy ? ` by ${pr.mergedBy}` : '';
  return `Merged externally${actor}: “${pr.title}” into ${pr.targetBranch}: ${pr.url}.`;
}

async function checkState(input: {
  apiBase: string;
  path: string;
  sha: string;
  token: string;
  fetchImpl: typeof fetch;
}): Promise<CornerCheckState> {
  try {
    const [checksResponse, statusResponse] = await Promise.all([
      input.fetchImpl(`${input.apiBase}${input.path}/commits/${input.sha}/check-runs?per_page=100`, {
        headers: headers(input.token),
      }),
      input.fetchImpl(`${input.apiBase}${input.path}/commits/${input.sha}/status`, {
        headers: headers(input.token),
      }),
    ]);
    if (!checksResponse.ok || !statusResponse.ok) return 'unknown';
    const checks = (await json(checksResponse)) as { check_runs?: unknown } | undefined;
    const status = (await json(statusResponse)) as { state?: unknown } | undefined;
    const runs = Array.isArray(checks?.check_runs)
      ? (checks!.check_runs as Array<{ status?: unknown; conclusion?: unknown }>)
      : [];
    const failed = runs.some(
      (run) =>
        run.status === 'completed' &&
        ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(
          String(run.conclusion),
        ),
    );
    if (failed || status?.state === 'failure' || status?.state === 'error') return 'failing';
    const pending =
      runs.some((run) => run.status !== 'completed') ||
      status?.state === 'pending' ||
      status?.state === 'expected';
    if (pending) return 'pending';
    if (runs.length > 0 || status?.state === 'success') return 'passing';
    return 'pending';
  } catch {
    return 'unknown';
  }
}

export async function observeCornerRemote(
  input: ObserveCornerRemoteInput,
): Promise<CornerRemoteState> {
  const observedAt = Math.floor((input.now ?? Date.now)() / 1_000);
  const coordinates = repoCoordinates(input.repo);
  if (!coordinates) {
    return {
      version: 1,
      cornerId: input.cornerId,
      branch: input.featureBranch,
      state: 'unknown',
      checks: 'unknown',
      observedAt,
      reason: 'GitHub repository identity is unavailable.',
    };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiBase = (input.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const path = `/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.name)}`;
  try {
    const [branchResponse, pullsResponse] = await Promise.all([
      fetchImpl(
        `${apiBase}${path}/git/ref/heads/${input.featureBranch
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`,
        { headers: headers(input.token) },
      ),
      fetchImpl(
        `${apiBase}${path}/pulls?state=all&head=${encodeURIComponent(
          `${coordinates.owner}:${input.featureBranch}`,
        )}&sort=updated&direction=desc&per_page=20`,
        { headers: headers(input.token) },
      ),
    ]);
    if ((branchResponse.status !== 404 && !branchResponse.ok) || !pullsResponse.ok) {
      throw new Error(`GitHub lifecycle read failed (${branchResponse.status}/${pullsResponse.status})`);
    }
    const pulls = await json(pullsResponse);
    if (!Array.isArray(pulls)) throw new Error('GitHub pull request response is invalid');
    const normalized = (pulls as GitHubPull[]).flatMap((pull) => {
      const fact = pullFact(pull);
      return fact ? [{ pull, fact }] : [];
    });
    const open = normalized.find(({ pull }) => pull.state === 'open' && pull.merged_at == null);
    const merged = normalized.find(({ pull }) => typeof pull.merged_at === 'string');
    if (branchResponse.status === 404) {
      const selected = merged ?? open;
      return {
        version: 1,
        cornerId: input.cornerId,
        branch: input.featureBranch,
        state: 'gone',
        checks: 'unknown',
        observedAt,
        ...(selected ? { pr: selected.fact } : {}),
        outcome: merged ? 'landed' : 'abandoned',
      };
    }
    const branchBody = (await json(branchResponse)) as
      | { object?: { sha?: unknown } }
      | undefined;
    const branchTip = branchBody?.object?.sha;
    if (typeof branchTip !== 'string' || !/^[0-9a-f]{40}$/i.test(branchTip)) {
      throw new Error('GitHub branch response is invalid');
    }
    const checks = open
      ? await checkState({
          apiBase,
          path,
          sha: open.fact.headSha,
          token: input.token,
          fetchImpl,
        })
      : 'unknown';
    if (
      !open &&
      input.targetContainsChange &&
      (await input.targetContainsChange({
        branchTip,
        ...(merged ? { pull: merged.fact } : {}),
      }))
    ) {
      return {
        version: 1,
        cornerId: input.cornerId,
        branch: input.featureBranch,
        state: 'gone',
        checks: 'unknown',
        observedAt,
        branchTip,
        ...(merged ? { pr: merged.fact } : {}),
        outcome: 'landed',
      };
    }
    return {
      version: 1,
      cornerId: input.cornerId,
      branch: input.featureBranch,
      state: open ? 'in-review' : 'working',
      checks,
      observedAt,
      branchTip,
      ...(open ? { pr: open.fact } : merged ? { pr: merged.fact } : {}),
    };
  } catch (error) {
    return {
      version: 1,
      cornerId: input.cornerId,
      branch: input.featureBranch,
      state: 'unknown',
      checks: 'unknown',
      observedAt,
      reason: error instanceof Error ? error.message.slice(0, 240) : 'GitHub is unreachable.',
    };
  }
}

export async function enableDeleteBranchOnMerge(input: {
  repo: BoundRepo;
  token: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}): Promise<boolean> {
  const coordinates = repoCoordinates(input.repo);
  if (!coordinates) return false;
  const response = await (input.fetchImpl ?? fetch)(
    `${(input.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')}/repos/${encodeURIComponent(
      coordinates.owner,
    )}/${encodeURIComponent(coordinates.name)}`,
    {
      method: 'PATCH',
      headers: headers(input.token),
      body: JSON.stringify({ delete_branch_on_merge: true }),
    },
  );
  return response.ok;
}
