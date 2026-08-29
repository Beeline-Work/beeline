import { describe, expect, it } from 'vitest';
import {
  TARGET_BRANCH_PROPOSAL_COMMAND,
  shortBranchName,
  targetBranchProposalFromPermission,
  targetBranchProposalText,
} from './target-branch.js';

describe('proposal copy', () => {
  it('states both ends of the change', () => {
    expect(targetBranchProposalText('main', 'staging')).toBe(
      'Change target branch: main → staging',
    );
  });
  it('shortens a full ref', () => {
    expect(shortBranchName('refs/heads/main')).toBe('main');
    expect(shortBranchName(undefined)).toBe('main');
  });
});

describe('the agent-attempted proposal marker', () => {
  const command = (line: string) => ({ toolCall: { title: line, kind: 'execute' } });

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

  it('keeps the retired private marker working for an already-running session', () => {
    expect(
      targetBranchProposalFromPermission(command('beeline-propose-target-branch --branch staging')),
    ).toBe('staging');
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
