import { describe, expect, it } from 'vitest';
import {
  shortBranchName,
  targetBranchChangeIntent,
  targetBranchProposalText,
} from './target-branch.js';

describe('targetBranchChangeIntent', () => {
  it('recognizes a standing landing change', () => {
    for (const message of [
      'land to staging from now on',
      '@lena land to staging from now on',
      'hey @lena, can you please land to the staging branch from now on?',
      'from now on, land on staging',
      'going forward merge into staging',
      'ship to staging from here on out',
      'always land to staging',
    ]) {
      expect(targetBranchChangeIntent(message), message).toEqual({ branch: 'staging' });
    }
  });

  it('recognizes an explicit target-branch command with no standing marker', () => {
    for (const message of [
      'change the target branch to staging',
      'set the target branch to staging',
      'switch this Room’s target branch to staging',
      'the target branch should be staging',
      'target branch is now staging',
      'make staging the target branch',
      'retarget the default branch to staging',
    ]) {
      expect(targetBranchChangeIntent(message), message).toEqual({ branch: 'staging' });
    }
  });

  it('normalizes a fully-qualified ref and a nested branch name', () => {
    expect(targetBranchChangeIntent('set the target branch to refs/heads/release/2026-08')).toEqual({
      branch: 'release/2026-08',
    });
  });

  it('is not a change request for a question, a one-off land, or unrelated chat', () => {
    for (const message of [
      'what is the target branch?',
      'which branch do you land to?',
      'land this to staging',
      'can you merge into staging',
      'open a corner and add a haiku',
      'from now on please be more concise',
      'always run the tests before you commit',
    ]) {
      expect(targetBranchChangeIntent(message), message).toBeNull();
    }
  });

  it('refuses a branch token that is not a valid git branch name', () => {
    expect(targetBranchChangeIntent('set the target branch to ..')).toBeNull();
    expect(targetBranchChangeIntent('land to from now on')).toBeNull();
  });
});

describe('proposal copy', () => {
  it('states both ends of the change', () => {
    expect(targetBranchProposalText('main', 'staging')).toBe('Change target branch: main → staging');
  });
  it('shortens a full ref', () => {
    expect(shortBranchName('refs/heads/main')).toBe('main');
    expect(shortBranchName(undefined)).toBe('main');
  });
});
