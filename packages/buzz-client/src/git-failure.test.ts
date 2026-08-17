import { describe, expect, it } from 'vitest';
import { summarizeGitFailure } from './git-failure.js';

const REAL_REJECTION_DUMP = [
  'Human-approved landing on refs/heads/main failed.',
  '! [rejected]        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -> main (fetch first)',
  'error: failed to push some refs to \'https://relay.buzzrouter.com/git/owner/repo\'',
  "hint: Updates were rejected because the remote contains work that you do",
  "hint: not have locally. This is usually caused by another repository pushing",
  "hint: to the same ref. You may want to first integrate the remote changes",
  "hint: (e.g., 'git pull ...') before pushing again.",
  "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
].join('\n');

describe('summarizeGitFailure', () => {
  it('turns a real non-fast-forward rejection dump into a plain, actionable sentence', () => {
    const summary = summarizeGitFailure(REAL_REJECTION_DUMP);
    expect(summary).toBe(
      'The target branch has moved on since this change was prepared — it needs to be rebased before it can land.',
    );
    expect(summary).not.toMatch(/git|hint:|\[rejected\]|fetch first/i);
  });

  it('recognizes a branch-protection hook rejection', () => {
    const summary = summarizeGitFailure(
      '! [remote rejected] main -> main (pre-receive hook declined)',
    );
    expect(summary).toBe("The repository's branch rules blocked this change.");
  });

  it('recognizes a permissions refusal', () => {
    expect(summarizeGitFailure('remote: Permission denied (403)')).toBe(
      'The delivery was refused — a repository permissions issue.',
    );
  });

  it('recognizes a network failure', () => {
    expect(summarizeGitFailure('ssh: Could not resolve hostname relay.buzzrouter.com')).toBe(
      "Couldn't reach the repository. It will keep retrying automatically.",
    );
  });

  it('falls back to a generic summary for unrecognized git-shaped stderr', () => {
    expect(summarizeGitFailure('error: something unexpected happened\ngit says no')).toBe(
      'The change could not be delivered automatically.',
    );
  });

  it('passes already human-written text through, shortening any bare 40-hex sha', () => {
    const reason =
      'merge approval REFUSED: human admin role required (signer role=none)';
    expect(summarizeGitFailure(reason)).toBe(reason);

    const withSha = `no valid approval binding owner/repo refs/heads/main -> ${'a'.repeat(40)}`;
    expect(summarizeGitFailure(withSha)).toBe(
      `no valid approval binding owner/repo refs/heads/main -> ${'a'.repeat(7)}`,
    );
  });

  it('handles an empty reason', () => {
    expect(summarizeGitFailure('   ')).toBe('The delivery failed for an unknown reason.');
  });
});
