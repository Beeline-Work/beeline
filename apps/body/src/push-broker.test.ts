/**
 * The ref-policy push broker — the structural half of "an agent can never
 * land on main without the owner's signed approval".
 *
 * Proved against real git repositories and real signed approval events, not
 * mocks of this module's own code:
 *   - a feature-branch push is allowed and performed;
 *   - a protected-ref (main) push without a valid owner signature is refused,
 *     before git is ever invoked, with a plain-language reason;
 *   - a protected-ref push WITH a verified corner signature is performed;
 *   - every other destination is refused.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApproval, newIdentity, verifyApproval } from '@beeline/gate';
import {
  brokerAuditLine,
  classifyRefspec,
  evaluateBrokeredPush,
  performBrokeredPush,
  type BrokerApproval,
  type PushBrokerPolicy,
} from './push-broker.js';

const reviewer = newIdentity('reviewer');
const channel = '11111111-1111-1111-1111-111111111111';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

/** A repo with a bare file remote, one seed commit on main, on a feature branch. */
function fixture(): {
  root: string;
  worktree: string;
  bare: string;
  featureTip: string;
  mainTip: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'beeline-push-broker-'));
  cleanup.push(root);
  const bare = resolve(root, 'remote.git');
  const checkout = resolve(root, 'checkout');
  const worktree = resolve(root, 'corner');
  git(root, ['init', '--bare', '-q', bare]);
  git(root, ['init', '-q', '-b', 'main', checkout]);
  git(checkout, ['config', 'user.name', 'Operator']);
  git(checkout, ['config', 'user.email', 'operator@example.com']);
  writeFileSync(resolve(checkout, 'README.md'), '# scratch\n');
  git(checkout, ['add', 'README.md']);
  git(checkout, ['commit', '-qm', 'seed']);
  git(checkout, ['remote', 'add', 'origin', bare]);
  git(checkout, ['push', '-q', '-u', 'origin', 'main']);
  git(checkout, ['worktree', 'add', '-q', '-b', 'feature/corner', worktree, 'main']);
  writeFileSync(resolve(worktree, 'WORK.txt'), 'agent work\n');
  git(worktree, ['add', 'WORK.txt']);
  git(worktree, ['commit', '-qm', 'Add agent work']);
  return {
    root,
    worktree,
    bare,
    featureTip: git(worktree, ['rev-parse', 'HEAD']),
    mainTip: git(checkout, ['rev-parse', 'HEAD']),
  };
}

function realGitRunner(
  cwd: string,
): (
  args: string[],
) => Promise<{ ok: boolean; status: number | null; stdout: string; stderr: string }> {
  return async (args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

function approvalFor(input: {
  tip: string;
  branch?: string;
  repo?: string;
  cornerId?: string;
}): BrokerApproval {
  const cornerId = input.cornerId ?? channel;
  const target = {
    repo: input.repo ?? `${reviewer.publicKey}/demo`,
    branch: input.branch ?? 'refs/heads/main',
    tip: input.tip,
  };
  // Verify through the same gate verifier Body uses, so the fixture proves
  // the whole artifact path rather than trusting our own shape.
  const event = buildApproval(reviewer, cornerId, target);
  expect(verifyApproval(event, reviewer.publicKey, target, cornerId)).toBe(true);
  return {
    cornerId,
    repo: target.repo,
    branch: target.branch,
    approvedTip: target.tip,
    reviewerPubkey: reviewer.publicKey,
  };
}

const policy = (featureBranch = 'feature/corner'): PushBrokerPolicy => ({
  featureBranch,
  protectedRefs: ['refs/heads/main'],
});

describe('classifyRefspec', () => {
  it("recognises the corner's own feature branch in both shapes", () => {
    expect(classifyRefspec('feature/corner', policy())).toBe('feature');
    expect(classifyRefspec('abc:refs/heads/feature/corner', policy())).toBe('feature');
  });

  it('recognises listed protected refs and main by name even when unlisted', () => {
    expect(classifyRefspec(`${'a'.repeat(40)}:refs/heads/main`, policy())).toBe('protected');
    expect(
      classifyRefspec(`${'a'.repeat(40)}:refs/heads/master`, {
        featureBranch: 'feature/x',
        protectedRefs: [],
      }),
    ).toBe('protected');
  });

  it('classifies everything else as other', () => {
    expect(classifyRefspec('feature/corner:refs/heads/other', policy())).toBe('other');
    expect(classifyRefspec('refs/tags/v1', policy())).toBe('other');
  });
});

describe('evaluateBrokeredPush — decision only', () => {
  it('allows a plain feature-branch push and a lease-scoped rewrite of it', () => {
    const base = { remote: 'origin', policy: policy() };
    expect(evaluateBrokeredPush({ ...base, refspecs: ['feature/corner'] }).action).toBe('allow');
    expect(
      evaluateBrokeredPush({
        ...base,
        refspecs: [`${'b'.repeat(40)}:refs/heads/feature/corner`],
        forceArgs: [`--force-with-lease=refs/heads/feature/corner:${'c'.repeat(40)}`],
      }).action,
    ).toBe('allow');
  });

  it('refuses a main push with no approval at all, in plain language', () => {
    const decision = evaluateBrokeredPush({
      remote: 'origin',
      policy: policy(),
      refspecs: [`${'b'.repeat(40)}:refs/heads/main`],
    });
    expect(decision.action).toBe('refuse');
    if (decision.action === 'refuse') {
      expect(decision.reason).toMatch(/protected/i);
      expect(decision.reason).toMatch(/signed approval/i);
    }
  });

  it('refuses a main push whose presented approval belongs to a different corner', () => {
    const decision = evaluateBrokeredPush({
      remote: 'origin',
      policy: policy(),
      cornerId: channel,
      refspecs: [`${'b'.repeat(40)}:refs/heads/main`],
      approval: {
        verified: true,
        approval: approvalFor({ tip: 'a'.repeat(40), cornerId: 'corner-other' }),
      },
    });
    expect(decision.action).toBe('refuse');
  });

  it('honors a standing corner approval when the protected push advances to a later tip', () => {
    const tip = 'b'.repeat(40);
    const decision = evaluateBrokeredPush({
      remote: 'origin',
      policy: policy(),
      cornerId: channel,
      refspecs: [`${tip}:refs/heads/main`],
      approval: { verified: true, approval: approvalFor({ tip: 'a'.repeat(40) }) },
    });
    expect(decision.action).toBe('perform-with-approval');
  });

  it('accepts mission standing land only for the fresh Room repository and ref', () => {
    const authorization = {
      kind: 'mission-standing-land' as const,
      verified: true as const,
      missionId: 'mission-one',
      grantEventId: 'a'.repeat(64),
      roomId: 'room-one',
      controllerAgentPubkey: 'b'.repeat(64),
      repositoryKey: 'github:123',
      targetRef: 'refs/heads/main',
      cornerId: channel,
      sourceSha: 'c'.repeat(40),
    };
    const base = {
      remote: 'origin',
      policy: policy(),
      refspecs: [`${'c'.repeat(40)}:refs/heads/main`],
      authorization,
    };
    expect(
      evaluateBrokeredPush({
        ...base,
        repository: {
          roomId: 'room-one',
          repositoryKey: 'github:123',
          controllerAgentPubkey: 'b'.repeat(64),
        },
        cornerId: channel,
      }).action,
    ).toBe('perform-with-mission-grant');
    expect(
      evaluateBrokeredPush({
        ...base,
        repository: {
          roomId: 'room-one',
          repositoryKey: 'github:not-the-mission-repo',
          controllerAgentPubkey: 'b'.repeat(64),
        },
        cornerId: channel,
      }).action,
    ).toBe('refuse');
    expect(
      evaluateBrokeredPush({
        ...base,
        repository: {
          roomId: 'another-room',
          repositoryKey: 'github:123',
          controllerAgentPubkey: 'b'.repeat(64),
        },
        cornerId: channel,
      }).action,
    ).toBe('refuse');
    expect(
      evaluateBrokeredPush({
        ...base,
        cornerId: 'another-corner',
        repository: {
          roomId: 'room-one',
          repositoryKey: 'github:123',
          controllerAgentPubkey: 'b'.repeat(64),
        },
      }).action,
    ).toBe('refuse');
    expect(
      evaluateBrokeredPush({
        ...base,
        cornerId: channel,
        refspecs: [`${'d'.repeat(40)}:refs/heads/main`],
        repository: {
          roomId: 'room-one',
          repositoryKey: 'github:123',
          controllerAgentPubkey: 'b'.repeat(64),
        },
      }).action,
    ).toBe('refuse');
  });

  it('refuses force and deletes against anything but the feature branch', () => {
    const base = {
      remote: 'origin',
      policy: policy(),
      refspecs: [`${'b'.repeat(40)}:refs/heads/main`],
    };
    expect(evaluateBrokeredPush({ ...base, forceArgs: ['--force'] }).action).toBe('refuse');
    expect(
      evaluateBrokeredPush({
        ...base,
        refspecs: ['feature/corner'],
        forceArgs: ['--delete'],
      }).action,
    ).toBe('refuse');
  });

  it('is all-or-nothing across a mixed batch', () => {
    const decision = evaluateBrokeredPush({
      remote: 'origin',
      policy: policy(),
      refspecs: ['feature/corner', `${'b'.repeat(40)}:refs/heads/main`],
    });
    expect(decision.action).toBe('refuse');
  });
});

describe('performBrokeredPush — against a real repository', () => {
  it('performs a feature-branch push', async () => {
    const fx = fixture();
    const result = await performBrokeredPush({
      remote: 'origin',
      refspecs: [`feature/corner:refs/heads/feature/corner`],
      policy: policy(),
      runGit: realGitRunner(fx.worktree),
    });
    expect(result.ok).toBe(true);
    expect(git(fx.bare, ['rev-parse', 'refs/heads/feature/corner'])).toBe(fx.featureTip);
  });

  it('never invokes git for a refused main push and reports a plain reason', async () => {
    const fx = fixture();
    let gitCalls = 0;
    const result = await performBrokeredPush({
      remote: 'origin',
      refspecs: [`${fx.featureTip}:refs/heads/main`],
      policy: policy(),
      cornerId: 'corner-channel',
      sessionId: 'session-1',
      runGit: async () => {
        gitCalls += 1;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.decision?.action).toBe('refuse');
    expect(result.stderr).toMatch(/signed approval/i);
    expect(gitCalls).toBe(0);
    expect(git(fx.bare, ['rev-parse', 'refs/heads/main'])).toBe(fx.mainTip);
  });

  it('performs a protected landing of the current tip under the standing corner approval', async () => {
    const fx = fixture();
    const result = await performBrokeredPush({
      remote: 'origin',
      refspecs: [`${fx.featureTip}:refs/heads/main`],
      policy: policy(),
      cornerId: channel,
      extraArgs: ['--follow-tags'],
      approval: { verified: true, approval: approvalFor({ tip: fx.mainTip }) },
      runGit: realGitRunner(fx.worktree),
    });
    expect(result.ok).toBe(true);
    expect(git(fx.bare, ['rev-parse', 'refs/heads/main'])).toBe(fx.featureTip);
  });

  it('audits every decision as one greppable line', () => {
    const line = brokerAuditLine({
      decision: {
        action: 'allow',
        refClass: 'feature',
        reason: "push to the corner's own feature branch",
      },
      remote: 'origin',
      refspecs: ['feature/corner'],
      cornerId: 'corner-channel',
      sessionId: 'session-1',
    });
    expect(line).toContain('[body] push-broker:');
    expect(line).toContain('action=allow');
    expect(line).toContain('corner=corner-channel');
    expect(line).toContain('session=session-1');
  });
});
