import { describe, expect, it } from 'vitest';
import { summarizeGitFailure } from './git-failure.js';

const REAL_REJECTION_DUMP = [
  'Human-approved landing on refs/heads/main failed.',
  '! [rejected]        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -> main (fetch first)',
  'error: failed to push some refs to \'https://usebeeline.app/git/owner/repo\'',
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

  it('treats a local ref that moved under the compare-and-set as the same moved-target story', () => {
    const summary = summarizeGitFailure(
      `fatal: update_ref failed for ref 'refs/heads/master': cannot lock ref 'refs/heads/master': is at ${'b'.repeat(40)} but expected ${'a'.repeat(40)}`,
    );
    expect(summary).toBe(
      'The target branch has moved on since this change was prepared — it needs to be rebased before it can land.',
    );
    expect(summary).not.toMatch(/fatal:|update_ref|refs\/heads/i);
  });

  it('recognizes the operator’s own uncommitted edits blocking a local land', () => {
    const summary = summarizeGitFailure(
      [
        'error: Your local changes to the following files would be overwritten by merge:',
        '\tREADME.md',
        'Please commit your changes or stash them before you merge.',
        'Aborting',
      ].join('\n'),
    );
    expect(summary).toBe(
      'The repository checkout has uncommitted local changes in the way — they need to be committed or stashed before this can land.',
    );
    expect(summary).not.toMatch(/error:|Aborting|README\.md/);
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
    expect(summarizeGitFailure('ssh: Could not resolve hostname usebeeline.app')).toBe(
      "Couldn't reach the repository. It will keep retrying automatically.",
    );
  });

  it('falls back to a generic summary for unrecognized git-shaped stderr', () => {
    expect(summarizeGitFailure('error: something unexpected happened\ngit says no')).toBe(
      'The change could not be delivered automatically.',
    );
  });

  it('passes already human-written text through, shortening any bare 40-hex sha', () => {
    const reason = 'pull request creation failed: repository permission required';
    expect(summarizeGitFailure(reason)).toBe(reason);

    const withSha = `remote rejected owner/repo refs/heads/main -> ${'a'.repeat(40)}`;
    expect(summarizeGitFailure(withSha)).toBe(
      `remote rejected owner/repo refs/heads/main -> ${'a'.repeat(7)}`,
    );
  });

  it('handles an empty reason', () => {
    expect(summarizeGitFailure('   ')).toBe('The delivery failed for an unknown reason.');
  });
});
