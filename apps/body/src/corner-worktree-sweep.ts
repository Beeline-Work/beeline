/**
 * What the periodic stray-worktree sweep is allowed to delete.
 *
 * The sweep exists because a corner worktree is ~84M of litter once its corner
 * is over, and reap-on-close cannot cover a corner that ended while the daemon
 * was down. But it deletes with `rm -rf`, and the shape it shipped with
 * ({@link Body.pruneStrayCornerWorktrees}) authorized that deletion from one
 * question — "does `git worktree list` still name this directory?" — with two
 * confirmed ways to answer it wrongly:
 *
 *  1. `registeredWorktrees` returned an EMPTY set when `git worktree list`
 *     itself failed, which reads as "git tracks nothing here" and so nominates
 *     *every* directory in the pool for deletion. A failed probe must never be
 *     read as a licence to delete.
 *  2. Even a genuinely unregistered directory can hold real work — commits on a
 *     feature branch that never landed, or an editor's worth of uncommitted
 *     changes — and nothing looked before deleting.
 *
 * Observed live: the captain's Room had five corners still non-terminal whose
 * worktrees and feature branches were both gone from the serving checkout, and
 * one agent reported its live corner worktree vanishing under it.
 *
 * So this module answers the question the sweep should have been asking: does
 * this directory still hold anything a person would miss? Everything it cannot
 * prove is disposable is kept, and every decision carries a reason the daemon
 * logs.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { git } from '@beeline/gate';

/** How a corner directory looks on disk, as far as git can be made to say. */
export interface CornerWorktreeProbe {
  /** The directory is the root of a git working tree. */
  isWorktree: boolean;
  /** `git status --porcelain` reported anything at all. */
  dirty: boolean;
  /** Commits on its HEAD that the target ref does not already contain. */
  unmergedCommits: number;
  /**
   * A probe that should have answered did not. Nothing below may be trusted,
   * and the directory must be kept: "I could not look" is not "there is
   * nothing there".
   */
  unknown: boolean;
}

export type CornerSweepAction = 'reap' | 'keep' | 'repair' | 'ask';

export interface CornerSweepDecision {
  action: CornerSweepAction;
  /** Logged verbatim next to the directory; plain enough to read in a daemon log. */
  reason: string;
}

type GitRunner = (
  cwd: string,
  args: string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * Look at one corner directory. Fails closed: any git invocation that does not
 * succeed marks the probe `unknown` rather than guessing an empty answer, which
 * is exactly the mistake that made the sweep destructive.
 *
 * `targetRef` is the branch the corner would land on. When it cannot be
 * resolved in this worktree the commit count is unknowable, not zero.
 */
export async function probeCornerWorktree(
  dir: string,
  targetRefs: readonly string[],
  run: GitRunner = git,
): Promise<CornerWorktreeProbe> {
  const path = resolve(dir);
  const empty: CornerWorktreeProbe = {
    isWorktree: false,
    dirty: false,
    unmergedCommits: 0,
    unknown: false,
  };
  // No `.git` entry at all is the one thing that needs no git command to
  // decide, and it is the only shape this module ever calls plain litter.
  if (!existsSync(resolve(path, '.git'))) return empty;

  const top = await run(path, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ...empty, unknown: true };
  if (resolve(top.stdout.trim()) !== path) {
    // A `.git` that resolves somewhere else means this directory is not its own
    // worktree root — reporting an enclosing repository's state as this
    // directory's would be a lie in either direction.
    return { ...empty, unknown: true };
  }

  const status = await run(path, ['status', '--porcelain']);
  if (!status.ok) return { isWorktree: true, dirty: false, unmergedCommits: 0, unknown: true };
  const dirty = status.stdout.trim().length > 0;

  // "Landed" can be true of the local target branch, of the remote-tracking
  // ref, or of neither if one of them is stale — so the answer is the SMALLEST
  // count any candidate reports. Asking only the first resolvable ref would let
  // a checkout that had not fetched hold a landed corner's worktree forever,
  // and asking only the freshest would need a fetch this sweep must not do.
  let unmergedCommits: number | undefined;
  for (const ref of targetRefs) {
    const ahead = await run(path, ['rev-list', '--count', `${ref}..HEAD`]);
    if (!ahead.ok) continue;
    const count = Number.parseInt(ahead.stdout.trim(), 10);
    if (!Number.isFinite(count)) continue;
    unmergedCommits = unmergedCommits === undefined ? count : Math.min(unmergedCommits, count);
  }
  if (unmergedCommits === undefined) {
    return { isWorktree: true, dirty, unmergedCommits: 0, unknown: true };
  }
  return { isWorktree: true, dirty, unmergedCommits, unknown: false };
}

/**
 * Which of `candidates` this worktree can actually resolve.
 *
 * A corner worktree shares its ref store with the checkout it was linked from,
 * so the target branch is normally right there — but a canonical checkout that
 * only ever tracks `origin/<branch>`, or a branch since renamed, resolves none
 * of them. An empty result means "unknowable", which `probeCornerWorktree`
 * turns into `unknown` rather than into a commit count of zero.
 */
export async function resolveTargetRefs(
  dir: string,
  candidates: readonly string[],
  run: GitRunner = git,
): Promise<string[]> {
  const resolved = await Promise.all(
    candidates.map(async (candidate) =>
      Boolean(candidate) &&
      (await run(dir, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])).ok
        ? candidate
        : undefined,
    ),
  );
  return resolved.filter((candidate): candidate is string => Boolean(candidate));
}

export interface CornerSweepInput {
  /** `git worktree list` still names this directory. */
  registered: boolean;
  /** A live ACP corner session is running in it right now. */
  live: boolean;
  /** The daemon still holds this corner in any of its maps (live or abandoned). */
  tracked: boolean;
  /**
   * Whether the corner channel is archived on the relay, when already known.
   * `undefined` means it has not been asked — the caller gets `ask` back and
   * comes round again with the answer. Deliberately the LAST question: it costs
   * a relay read, and no answer to it may override an on-disk guard above.
   */
  archived?: boolean;
  probe: CornerWorktreeProbe;
}

/**
 * Decide one directory's fate. Ordered most-protective first, so a directory
 * that trips several guards is reported by the strongest reason.
 *
 * `repair` is for the case the old sweep silently destroyed: a real worktree
 * git has stopped registering. Re-linking it costs nothing and turns an
 * invisible directory back into one `restoreSubchannels` can find, which is the
 * opposite of deleting it.
 */
export function cornerWorktreeSweepDecision(input: CornerSweepInput): CornerSweepDecision {
  if (input.live) return { action: 'keep', reason: 'a live corner session is running in it' };
  if (input.probe.unknown) {
    return { action: 'keep', reason: 'its contents could not be inspected' };
  }
  if (input.probe.dirty) return { action: 'keep', reason: 'it has uncommitted changes' };
  if (!input.probe.isWorktree) {
    return { action: 'reap', reason: 'it is not a git worktree, so it holds no recoverable work' };
  }
  // Deliberately absolute, closed corner or not. A closed corner's commits do
  // survive on its branch, but "the branch still has it" has been true of every
  // corner whose work went missing anyway — a re-cloned checkout takes the
  // branch with it. One worktree of disk is the cheap side of this trade.
  if (input.probe.unmergedCommits > 0) {
    return {
      action: 'keep',
      reason: `it holds ${input.probe.unmergedCommits} commit(s) not on the target branch`,
    };
  }
  if (!input.registered) {
    return { action: 'repair', reason: 'git no longer registers this worktree' };
  }
  if (input.tracked) {
    return { action: 'keep', reason: 'the daemon still tracks this corner' };
  }
  if (input.archived === undefined) {
    return {
      action: 'ask',
      reason: 'nothing on disk objects; only the corner’s state is left to check',
    };
  }
  if (input.archived) return { action: 'reap', reason: 'its corner is archived' };
  return { action: 'keep', reason: 'its corner is not archived' };
}
