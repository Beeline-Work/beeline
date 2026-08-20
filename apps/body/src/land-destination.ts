/**
 * Where a landed change actually went, said plainly enough to act on.
 *
 * The recap used to end at `Landed on main at 4ec0627ee559.` — true, and
 * useless to anyone who then goes looking for it, because Beeline runs three
 * different git realities at once and that line names none of them:
 *
 *   1. the operator's own checkout, where they paired and where they read code;
 *   2. the daemon's canonical checkout, cloned from origin, which is what the
 *      agent actually reads and what corners are worktrees of;
 *   3. the remote, which is where a land is pushed.
 *
 * A land moves (3). The captain's Room is exactly the shape that makes this
 * bite: its runtime record's repo root is `/home/lunchbox/proj-buzzy` — their
 * own tree — while the Room is served from
 * `~/.local/state/beeline/repositories/<key>`. So the commit is real, and it is
 * genuinely not in the checkout they are looking at.
 *
 * Everything here is derived from facts on disk or from the remote URL. The
 * "not fetched" line is only ever emitted after actually asking that checkout
 * whether it has the commit — never inferred from the paths differing, because
 * an operator who fetches regularly should not be told their tree is behind.
 */
import { parseGitHubRemoteUrl } from './ci-watch.js';

export interface LandDestination {
  /** Short branch name the change landed on. */
  branch: string;
  /** Full 40-hex landed commit. */
  tip: string;
  /** The corner's own `git remote get-url` value, when it has one. */
  remoteUrl?: string;
  /**
   * The operator's own checkout, when it is a DIFFERENT directory from the one
   * the daemon serves this Room from. Absent when they are the same tree —
   * there is then nothing to warn anyone about.
   */
  operatorCheckout?: string;
  /** Whether that checkout already contains the landed commit. */
  operatorHasCommit?: boolean;
}

/** The web URL for a landed commit, for a GitHub remote and nothing else. */
export function commitUrlForRemote(remoteUrl: string | undefined, tip: string): string | undefined {
  if (!remoteUrl || !/^[0-9a-f]{7,40}$/i.test(tip)) return undefined;
  const repo = parseGitHubRemoteUrl(remoteUrl);
  if (!repo) return undefined;
  return `https://github.com/${repo.owner}/${repo.repo}/commit/${tip}`;
}

/**
 * The closing lines of a land recap: what moved, where to look at it, and —
 * only when it is true — that the reader's own checkout does not have it yet.
 */
export function landDestinationLines(destination: LandDestination): string[] {
  const lines = [`Landed on ${destination.branch} at ${destination.tip.slice(0, 12)}.`];
  const url = commitUrlForRemote(destination.remoteUrl, destination.tip);
  if (url) lines.push(url);
  if (destination.operatorCheckout && destination.operatorHasCommit === false) {
    lines.push(
      `Your checkout at ${destination.operatorCheckout} has not fetched this yet — ` +
        `run \`git -C ${destination.operatorCheckout} fetch\` to see it.`,
    );
  }
  return lines;
}
