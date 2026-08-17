/**
 * Turn a raw git/relay failure (stderr, or an internal `MergeOutcome.reason`)
 * into the plain sentence a human sees. A person steering an agent from
 * their phone must never see `git`/`hint:`/`! [rejected]`/`fetch first`
 * plumbing — only what happened and what to do about it.
 *
 * Text that doesn't look like git plumbing (e.g. an authorization refusal
 * already written for humans) passes through unchanged, aside from
 * shortening any stray 40-hex commit id so a sha never becomes the
 * headline.
 */
function shortenShas(text: string): string {
  return text.replace(/\b[0-9a-f]{40}\b/gi, (sha) => sha.slice(0, 7));
}

export function summarizeGitFailure(raw: string): string {
  const text = raw.trim();
  if (!text) return 'The delivery failed for an unknown reason.';

  if (/non-fast-forward|\[rejected\]|fetch first|would clobber/i.test(text)) {
    return 'The target branch has moved on since this change was prepared — it needs to be rebased before it can land.';
  }
  if (/hook declined|pre-receive hook/i.test(text)) {
    return "The repository's branch rules blocked this change.";
  }
  if (/permission denied|\b403\b|authentication failed|could not read username|forbidden/i.test(text)) {
    return 'The delivery was refused — a repository permissions issue.';
  }
  if (/could not resolve host|connection refused|timed out|network is unreachable/i.test(text)) {
    return "Couldn't reach the repository. It will keep retrying automatically.";
  }
  if (/\bgit\b|hint:|error: failed to push|remote:/i.test(text)) {
    return 'The change could not be delivered automatically.';
  }

  return shortenShas(text);
}
