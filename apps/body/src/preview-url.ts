/**
 * Branch/PR preview deployment URLs for a corner's pushed feature tip.
 *
 * `publishMergeReady` already pushes the feature branch to origin, which is
 * what makes a host's preview deployment exist at all. This reads that tip's
 * commit statuses / check runs back off the same git remote and, when one of
 * them is a preview deployment, hands the URL to the review card.
 *
 * Everything here is best-effort and never throws: no remote, a non-GitHub
 * remote, no credentials, a rate limit, no statuses, or statuses that are only
 * ordinary CI all resolve to `undefined` — which renders no row at all, rather
 * than a broken or invented link.
 */

export interface CommitStatusLike {
  context?: string | null;
  state?: string | null;
  target_url?: string | null;
  description?: string | null;
}

export interface CheckRunLike {
  name?: string | null;
  conclusion?: string | null;
  status?: string | null;
  details_url?: string | null;
  output?: { title?: string | null; summary?: string | null } | null;
}

/** Hosts and words that mean "this link is a deployed preview of the branch". */
const PREVIEW_SIGNAL =
  /\b(?:preview|deploy(?:ment|ed)?|vercel|netlify|cloudflare\s*pages|render|surge|fly\.io|amplify|heroku|staging)\b/i;

/** A status must be green (or at least not failed) before its URL is offered. */
function isUsableState(state: string | null | undefined): boolean {
  const value = (state ?? '').toLowerCase();
  return value === '' || value === 'success' || value === 'pending' || value === 'neutral';
}

function httpsUrl(value: string | null | undefined): string | undefined {
  const raw = (value ?? '').trim();
  if (!/^https:\/\/[^\s"'<>]+$/i.test(raw)) return undefined;
  return raw;
}

/**
 * The one preview URL among a commit's statuses, or undefined.
 *
 * Ordinary CI (a test run, a lint job) also carries a `target_url`, so a bare
 * "first status with a URL" would put a link to a build log behind a button
 * labelled PREVIEW. Only a status whose context/description actually names a
 * preview deployment qualifies.
 */
export function selectPreviewStatusUrl(
  statuses: readonly CommitStatusLike[] | undefined,
): string | undefined {
  for (const status of statuses ?? []) {
    if (!isUsableState(status.state)) continue;
    const url = httpsUrl(status.target_url);
    if (!url) continue;
    if (!PREVIEW_SIGNAL.test(`${status.context ?? ''} ${status.description ?? ''}`)) continue;
    return url;
  }
  return undefined;
}

/** The check-runs equivalent of {@link selectPreviewStatusUrl}. */
export function selectPreviewCheckRunUrl(
  runs: readonly CheckRunLike[] | undefined,
): string | undefined {
  for (const run of runs ?? []) {
    if (!isUsableState(run.conclusion)) continue;
    const url = httpsUrl(run.details_url);
    if (!url) continue;
    const haystack = `${run.name ?? ''} ${run.output?.title ?? ''} ${run.output?.summary ?? ''}`;
    if (!PREVIEW_SIGNAL.test(haystack)) continue;
    return url;
  }
  return undefined;
}

/** `owner/repo` of a GitHub git remote in any of its usual spellings. */
export function parseGitHubRemote(remote: string | undefined): { owner: string; repo: string } | null {
  const value = (remote ?? '').trim();
  if (!value) return null;
  const match = value.match(
    /^(?:https?:\/\/|git:\/\/|ssh:\/\/git@|git@)(?:[^@/]*@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i,
  );
  if (!match) return null;
  const owner = match[1]!;
  const repo = match[2]!;
  if (!owner || !repo || repo.includes('/')) return null;
  return { owner, repo };
}

/**
 * Total budget for the whole lookup, shared by both reads — not per request.
 * This sits on the corner-completion path, so a slow or unreachable host must
 * cost the review card a bounded wait, never one deadline per endpoint.
 */
export const PREVIEW_LOOKUP_TIMEOUT_MS = 4_000;

export interface PreviewLookupOptions {
  remote?: string;
  tip: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask the remote's host whether the pushed tip has a preview deployment.
 *
 * GitHub only for now — that is where `publishMergeReady`'s pushed feature
 * branches actually live for user-hosted origins. A Buzz relay origin has no
 * checks API and resolves to `undefined` by falling out of the remote parse.
 */
export async function resolvePreviewUrl(
  options: PreviewLookupOptions,
): Promise<string | undefined> {
  const target = parseGitHubRemote(options.remote);
  if (!target || !/^[0-9a-f]{40}$/.test(options.tip)) return undefined;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return undefined;
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'beeline-body',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const base = `https://api.github.com/repos/${target.owner}/${target.repo}/commits/${options.tip}`;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? PREVIEW_LOOKUP_TIMEOUT_MS,
  );
  const read = async (path: string): Promise<unknown> => {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  };

  try {
    const status = (await read('/status')) as { statuses?: CommitStatusLike[] } | undefined;
    const fromStatuses = selectPreviewStatusUrl(status?.statuses);
    if (fromStatuses) return fromStatuses;
    const checks = (await read('/check-runs')) as { check_runs?: CheckRunLike[] } | undefined;
    return selectPreviewCheckRunUrl(checks?.check_runs);
  } finally {
    clearTimeout(timer);
  }
}
