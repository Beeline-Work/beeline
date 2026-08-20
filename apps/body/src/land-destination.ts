/**
 * Where a landed change actually went, said plainly enough to act on.
 *
 * The recap used to end at `Landed on main at 4ec0627ee559.` — true, and
 * useless to anyone who then goes looking for it. The repository-truth
 * resolver now supplies the current remote identity, so this surface names the
 * branch, commit, and GitHub page without consulting pairing-history paths.
 */
import { parseGitHubRemoteUrl } from './ci-watch.js';

export interface LandDestination {
  /** Short branch name the change landed on. */
  branch: string;
  /** Full 40-hex landed commit. */
  tip: string;
  /** The corner's own `git remote get-url` value, when it has one. */
  remoteUrl?: string;
}

/** The web URL for a landed commit, for a GitHub remote and nothing else. */
export function commitUrlForRemote(remoteUrl: string | undefined, tip: string): string | undefined {
  if (!remoteUrl || !/^[0-9a-f]{7,40}$/i.test(tip)) return undefined;
  const repo = parseGitHubRemoteUrl(remoteUrl);
  if (!repo) return undefined;
  return `https://github.com/${repo.owner}/${repo.repo}/commit/${tip}`;
}

/**
 * The closing lines of a land recap: what moved and where to look at it.
 */
export function landDestinationLines(destination: LandDestination): string[] {
  const lines = [`Landed on ${destination.branch} at ${destination.tip.slice(0, 12)}.`];
  const url = commitUrlForRemote(destination.remoteUrl, destination.tip);
  if (url) lines.push(url);
  return lines;
}
