import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import {
  agentPrivateStateInstructions,
  isBodyOwnedPrivateStateLink,
  prepareCornerAgentPrivateState,
  projectDirtyStatus,
} from './agent-private-state.js';

const cleanup: string[] = [];

async function fixture(): Promise<{ root: string; worktree: string; privateRoot: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-private-state-'));
  cleanup.push(root);
  const worktree = resolve(root, 'corner');
  const privateRoot = resolve(root, 'room-state/private');
  await mkdir(worktree, { recursive: true });
  execFileSync('git', ['init', '--quiet', worktree]);
  return { root, worktree, privateRoot };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('corner agent-private state', () => {
  it('routes persona bookkeeping out of the repository through a Body-owned link', async () => {
    const { worktree, privateRoot } = await fixture();
    const state = await prepareCornerAgentPrivateState({
      root: privateRoot,
      worktreePath: worktree,
      channelId: 'corner-1234',
    });
    await mkdir(resolve(state.worktreePath, 'memory'), { recursive: true });
    await writeFile(resolve(state.worktreePath, 'memory/episodes.json'), '{"learned":true}\n');

    expect(isBodyOwnedPrivateStateLink(worktree, state)).toBe(true);
    expect(await readFile(resolve(privateRoot, 'memory/episodes.json'), 'utf8')).toContain(
      'learned',
    );
    const status = execFileSync(
      'git',
      ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      { encoding: 'utf8' },
    );
    expect(projectDirtyStatus(worktree, status, state)).toEqual([]);
    execFileSync('git', ['-C', worktree, 'add', '.']);
    expect(
      execFileSync('git', ['-C', worktree, 'diff', '--cached', '--name-only'], {
        encoding: 'utf8',
      }),
    ).toBe('');
    expect(agentPrivateStateInstructions(state)).toMatch(/project-owned memory\//i);
  });

  it('never replaces a project-owned path that uses the preferred private-link name', async () => {
    const { worktree, privateRoot } = await fixture();
    const projectPath = resolve(worktree, '.beeline-agent-private-corner12');
    await writeFile(projectPath, 'project content\n');

    const state = await prepareCornerAgentPrivateState({
      root: privateRoot,
      worktreePath: worktree,
      channelId: 'corner-1234',
    });

    expect(await readFile(projectPath, 'utf8')).toBe('project content\n');
    expect(basename(state.worktreePath)).toBe('.beeline-agent-private-corner12-2');
    expect((await lstat(state.worktreePath)).isSymbolicLink()).toBe(true);
    const status = execFileSync(
      'git',
      ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
      { encoding: 'utf8' },
    );
    expect(projectDirtyStatus(worktree, status, state)).toEqual([
      '?? .beeline-agent-private-corner12',
    ]);
  });

  it('does not trust a stored path after the Body-owned symlink is replaced', async () => {
    const { worktree, privateRoot } = await fixture();
    const state = await prepareCornerAgentPrivateState({
      root: privateRoot,
      worktreePath: worktree,
      channelId: 'corner-1234',
    });
    await rm(state.worktreePath);
    await writeFile(state.worktreePath, 'project replacement\n');
    expect(isBodyOwnedPrivateStateLink(worktree, state)).toBe(false);
    expect(projectDirtyStatus(worktree, `?? ${basename(state.worktreePath)}\0`, state)).toEqual([
      `?? ${basename(state.worktreePath)}`,
    ]);
  });
});
