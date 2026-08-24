/**
 * Post-merge auto-realign for corner worktrees.
 *
 * When a merge lands on the target branch, every open corner bound to the
 * same repository is expected to pick the new main up WITHOUT its human
 * having to ask each agent. The canonical checkout the Room reads from is
 * already refreshed by `refreshRepositoryTruth` at every land point, so the
 * remaining surface is the corners themselves:
 *
 *   - a clean corner whose feature branch has fallen behind the new target
 *     is rebased onto it automatically;
 *   - a corner that would conflict (or that holds uncommitted work an
 *     automatic rebase must not mix into) ANNOUNCES that plainly instead of
 *     silently diverging;
 *   - a corner with a live review target (`mergeTarget` set) is left alone;
 *     its own target-move path coordinates the rebase and visible landing
 *     state under that corner's standing approval.
 *
 * Pure git mechanics live here; policy (which corners, which repo, what to
 * publish) stays in `body.ts`.
 */

import { git } from '@beeline/gate';

export type CornerRealignStatus =
  | 'up-to-date'
  | 'rebased'
  | 'conflict'
  | 'dirty'
  | 'error';

export interface CornerRealignResult {
  status: CornerRealignStatus;
  /** Human-readable detail for announcements and logs. */
  detail?: string;
  /** The tip the feature branch sat at BEFORE the realign. */
  previousTip?: string;
}

const shortSha = (sha: string | undefined): string =>
  sha && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 12) : (sha ?? '?');

/**
 * Rebase one corner worktree onto the newest target branch.
 *
 * `remoteName` fetches the freshest target ref first; a local-only
 * repository (no remote) shares its ref store with the corner's linked
 * worktree, so the just-landed ref is already visible here.
 */
export function realignWorktreeOntoTarget(
  worktreePath: string,
  opts: { remoteName?: string; targetBranch: string },
): CornerRealignResult {
  const branch = opts.targetBranch.replace(/^refs\/heads\//, '');
  const upstream = opts.remoteName ? `${opts.remoteName}/${branch}` : branch;

  if (opts.remoteName) {
    const fetched = git(worktreePath, ['fetch', '--prune', opts.remoteName]);
    if (!fetched.ok) {
      return {
        status: 'error',
        detail: `could not fetch ${opts.remoteName}: ${fetched.stderr.trim()}`,
      };
    }
  }
  if (!git(worktreePath, ['rev-parse', '--verify', '--quiet', upstream]).ok) {
    return { status: 'error', detail: `${upstream} does not resolve in this worktree` };
  }

  const head = git(worktreePath, ['rev-parse', 'HEAD']).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    return { status: 'error', detail: 'worktree HEAD could not be read' };
  }
  if (git(worktreePath, ['merge-base', '--is-ancestor', upstream, head]).ok) {
    return { status: 'up-to-date', previousTip: head };
  }

  // Never mix uncommitted work into an automatic rebase.
  const status = git(worktreePath, ['status', '--porcelain=v1']);
  if (!status.ok || status.stdout.trim().length > 0) {
    return {
      status: 'dirty',
      previousTip: head,
      detail: status.ok
        ? 'the worktree holds uncommitted changes'
        : `git status failed: ${status.stderr.trim()}`,
    };
  }

  const rebase = git(worktreePath, ['rebase', upstream]);
  if (rebase.ok) {
    const newTip = git(worktreePath, ['rev-parse', 'HEAD']).stdout.trim();
    return { status: 'rebased', previousTip: head, detail: newTip };
  }
  // A conflicted rebase must leave the corner exactly where it was.
  git(worktreePath, ['rebase', '--abort']);
  return {
    status: 'conflict',
    previousTip: head,
    detail:
      summarizeRebaseFailure(rebase.stdout + '\n' + rebase.stderr) ||
      `rebasing onto ${upstream} conflicts`,
  };
}

/** Reduce git's rebase output to the few conflicting paths, when given. */
export function summarizeRebaseFailure(output: string): string {
  const paths = new Set<string>();
  for (const line of output.split('\n')) {
    const conflict =
      /^CONFLICT \([^)]*\):\s*Merge conflict in (.+)$/.exec(line.trim()) ??
      /^Auto-merging\s+(.+)$/.exec(line.trim());
    if (conflict?.[1]) paths.add(conflict[1].trim());
    const bothModified = /^both modified:\s+(.+)$/.exec(line.trim());
    if (bothModified?.[1]) paths.add(bothModified[1].trim());
  }
  const list = [...paths].slice(0, 3);
  if (list.length === 0) return '';
  return list.join(', ');
}

/** Human sentence for a realign announcement; '' when nothing needs saying. */
export function realignAnnouncement(
  result: CornerRealignResult,
  featureBranch: string,
  targetBranch: string,
): string | undefined {
  const branch = targetBranch.replace(/^refs\/heads\//, '');
  switch (result.status) {
    case 'conflict':
      return (
        `After the latest merge on ${branch}, this corner could not be brought up to date ` +
        `automatically: rebasing ${featureBranch} onto ${branch} conflicts` +
        (result.detail ? ` (${result.detail})` : '') +
        '. Nothing was changed — the work is intact at ' +
        `${shortSha(result.previousTip)} and needs a human decision on how to proceed.`
      );
    case 'dirty':
      return (
        `The latest merge on ${branch} was noticed, but this corner was NOT rebased ` +
        `automatically because ${result.detail ?? 'it holds uncommitted changes'}. ` +
        'Commit or clean up here and ask to be brought up to date.'
      );
    case 'error':
      return (
        `Tried to bring this corner up to date with the latest merge on ${branch}, ` +
        `but it failed: ${result.detail ?? 'unknown git error'}. The work is untouched.`
      );
    case 'up-to-date':
    case 'rebased':
      return undefined;
  }
}
