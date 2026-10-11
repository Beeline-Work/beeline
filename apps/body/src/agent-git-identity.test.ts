import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, afterAll, expect, it } from 'vitest';
import { agentGitIdentityEnv } from './agent-git-identity.js';
import { materializeCornerWorktree } from './room-runtime.js';

/**
 * A corner worktree is shared by every agent that works it, and its
 * `git config --worktree user.name/user.email` is rewritten by whichever
 * session prepared it last (Reproduction R-ID1 on PR #2318). Each session's
 * own environment must therefore decide its commits' author and committer.
 */
const git = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const AGENT_A = { name: 'Agent A', publicKey: 'a'.repeat(64) };
const AGENT_B = { name: 'Agent B', publicKey: 'b'.repeat(64) };

let remoteRoot: string;
let remote: string;
beforeAll(async () => {
  remoteRoot = await mkdtemp(resolve(tmpdir(), 'beeline-identity-remote-'));
  const seed = resolve(remoteRoot, 'seed');
  await git('git', ['init', '-b', 'main', seed]);
  await writeFile(join(seed, 'code.txt'), 'seed\n');
  await git('git', ['-C', seed, 'add', '.']);
  await git('git', ['-C', seed, 'commit', '-m', 'seed'], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Seed',
      GIT_AUTHOR_EMAIL: 'seed@example.com',
      GIT_COMMITTER_NAME: 'Seed',
      GIT_COMMITTER_EMAIL: 'seed@example.com',
    },
  });
  remote = resolve(remoteRoot, 'remote.git');
  await git('git', ['clone', '--bare', seed, remote]);
});
afterAll(async () => rm(remoteRoot, { recursive: true, force: true }));

function prepare(supervisorRoot: string, agent: { name: string; publicKey: string }) {
  return materializeCornerWorktree({
    cornerId: 'corner-identity',
    remote: `file://${remote}`,
    targetBranch: 'main',
    featureBranch: 'feature/widget',
    token: 'unused',
    supervisorRoot,
    committer: agent,
  });
}

it('commits as the session that made them, not the session that prepared the worktree last', async () => {
  const supervisorRoot = await scratch('beeline-identity-supervisor-');
  // Agent A prepares the shared worktree, then agent B prepares the same one.
  const { path } = await prepare(supervisorRoot, AGENT_A);
  await prepare(supervisorRoot, AGENT_B);

  // The worktree config now names B: that is the shared state the bug trusted.
  const configured = (
    await git('git', ['-C', path, 'config', '--worktree', 'user.name'])
  ).stdout.trim();
  expect(configured).toBe(AGENT_B.name);

  // Agent A commits from its own session environment.
  await writeFile(join(path, 'a.txt'), 'written by A\n');
  await git('git', ['-C', path, 'add', 'a.txt']);
  await git('git', ['-C', path, 'commit', '-m', 'A work'], {
    env: { ...process.env, ...agentGitIdentityEnv(AGENT_A) },
  });

  const identity = (
    await git('git', ['-C', path, 'show', '-s', '--format=%an <%ae>|%cn <%ce>', 'HEAD'])
  ).stdout.trim();
  const expected = agentGitIdentityEnv(AGENT_A);
  expect(identity).toBe(
    `${expected.GIT_AUTHOR_NAME} <${expected.GIT_AUTHOR_EMAIL}>|` +
      `${expected.GIT_COMMITTER_NAME} <${expected.GIT_COMMITTER_EMAIL}>`,
  );
});