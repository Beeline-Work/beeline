import { describe, expect, it } from 'vitest';
import {
  TARGET_BRANCH_PROPOSAL_COMMAND,
  shortBranchName,
  targetBranchChangeIntent,
  targetBranchProposalFromPermission,
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

  // The confirmed live miss: the article and the noun stood between the
  // preposition and the branch name, the capture stopped on `a`, and the whole
  // ask fell through to an ordinary conversational turn.
  it('recognizes the branch behind an article and a "branch called" noun phrase', () => {
    for (const message of [
      'from now on land changes to a branch called staging instead of master',
      '@lena from now on land changes to a branch called staging instead of master',
      'land changes to a branch called staging from now on',
      'from now on, land changes to the branch staging instead of master',
      'always land changes to a branch named staging',
      'going forward, ship to a new branch called staging',
      'from now on merge into the staging branch',
      'set the target branch to a branch called staging',
    ]) {
      expect(targetBranchChangeIntent(message), message).toEqual({ branch: 'staging' });
    }
  });

  it('still refuses the noun phrase with no branch name after it', () => {
    for (const message of [
      'from now on land changes to a branch',
      'from now on land to the branch',
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

describe('the agent-attempted proposal marker', () => {
  const command = (line: string) => ({ toolCall: { title: line, kind: 'execute' } });

  it('uses the shipped slash command so the native permission request reaches this parser', () => {
    expect(TARGET_BRANCH_PROPOSAL_COMMAND).toBe('/change-target-branch');
    expect(
      targetBranchProposalFromPermission(command('/change-target-branch --branch staging')),
    ).toBe('staging');
  });

  it('reads the branch out of the exact documented command', () => {
    expect(
      targetBranchProposalFromPermission(
        command(`${TARGET_BRANCH_PROPOSAL_COMMAND} --branch staging`),
      ),
    ).toBe('staging');
    expect(
      targetBranchProposalFromPermission(
        command(`${TARGET_BRANCH_PROPOSAL_COMMAND} --branch=refs/heads/release/2026-08`),
      ),
    ).toBe('release/2026-08');
  });

  it('tolerates a harness wrapping the command and quoting the branch', () => {
    for (const line of [
      `bash -lc ${TARGET_BRANCH_PROPOSAL_COMMAND} --branch staging`,
      `${TARGET_BRANCH_PROPOSAL_COMMAND} --branch "staging"`,
      `${TARGET_BRANCH_PROPOSAL_COMMAND} --branch 'staging'`,
    ]) {
      expect(targetBranchProposalFromPermission(command(line)), line).toBe('staging');
    }
  });

  it('keeps accepting the pre-slash marker from an already-running Room session', () => {
    expect(
      targetBranchProposalFromPermission(
        command('beeline-propose-target-branch --branch staging'),
      ),
    ).toBe('staging');
  });

  it('finds it wherever the adapter puts the command line', () => {
    expect(
      targetBranchProposalFromPermission({
        toolCall: {
          title: 'Run shell command',
          kind: 'execute',
          rawInput: { command: `${TARGET_BRANCH_PROPOSAL_COMMAND} --branch staging` },
        },
      }),
    ).toBe('staging');
  });

  it('is undefined for anything that is not the exact marker', () => {
    for (const line of [
      'echo hello',
      `${TARGET_BRANCH_PROPOSAL_COMMAND}`,
      `${TARGET_BRANCH_PROPOSAL_COMMAND} staging`,
      `${TARGET_BRANCH_PROPOSAL_COMMAND} --branch ..`,
      `${TARGET_BRANCH_PROPOSAL_COMMAND} --branch `,
      // A chained shell payload is not this marker; it is an ordinary command.
      `${TARGET_BRANCH_PROPOSAL_COMMAND} --branch staging && rm -rf /tmp/x`,
      `${TARGET_BRANCH_PROPOSAL_COMMAND} --branch staging; rm -rf /tmp/x`,
      'beeline-request-edit-corner --repo owner/repo',
    ]) {
      expect(targetBranchProposalFromPermission(command(line)), line).toBeUndefined();
    }
  });
});
