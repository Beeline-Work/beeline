/**
 * A land recap has to survive the three-git-realities problem.
 *
 * `Landed on main at 4ec0627ee559.` is true and unusable: Beeline runs the
 * operator's own checkout, the daemon's canonical clone, and the remote at the
 * same time, and a land moves only the last of those. The captain's Room is the
 * exact shape that bites — its runtime record's repo root is
 * `/home/lunchbox/proj-buzzy` (their own tree) while it is served out of
 * `~/.local/state/beeline/repositories/<key>` — so the commit is genuinely
 * absent from the checkout they are looking at.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commitUrlForRemote, landDestinationLines } from './land-destination.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

const tip = '4ec0627ee55999821d2d65969134156e8c63b789';

describe('the commit URL', () => {
  it('is built from the remote the corner actually has', () => {
    // Every shape a real `git remote get-url` returns for the same repository.
    for (const remote of [
      'https://github.com/lunchboxfortwo/buzzy.git',
      'https://github.com/lunchboxfortwo/buzzy',
      'git@github.com:lunchboxfortwo/buzzy.git',
      'ssh://git@github.com/lunchboxfortwo/buzzy',
    ]) {
      expect(commitUrlForRemote(remote, tip)).toBe(
        `https://github.com/lunchboxfortwo/buzzy/commit/${tip}`,
      );
    }
  });

  it('is absent rather than invented for anything that is not GitHub', () => {
    expect(commitUrlForRemote('https://gitlab.com/someone/thing.git', tip)).toBeUndefined();
    expect(commitUrlForRemote('/home/lunchbox/proj-buzzy', tip)).toBeUndefined();
    expect(commitUrlForRemote(undefined, tip)).toBeUndefined();
    // A relay-origin remote is a Buzz smart-HTTP URL, not a browsable page.
    expect(
      commitUrlForRemote('https://relay.buzzrouter.com/git/deadbeef/buzzy', tip),
    ).toBeUndefined();
  });

  it('refuses a tip that is not a commit id', () => {
    expect(commitUrlForRemote('https://github.com/a/b', 'refs/heads/main')).toBeUndefined();
    expect(commitUrlForRemote('https://github.com/a/b', '')).toBeUndefined();
  });
});

describe('what the recap tells a reader about where to look', () => {
  it('names the branch, the commit, and the page it can be read on', () => {
    expect(
      landDestinationLines({
        branch: 'main',
        tip,
        remoteUrl: 'https://github.com/lunchboxfortwo/buzzy.git',
      }),
    ).toEqual([
      'Landed on main at 4ec0627ee559.',
      `https://github.com/lunchboxfortwo/buzzy/commit/${tip}`,
    ]);
  });

  it('warns about the operator checkout only when it really is behind', () => {
    const lines = landDestinationLines({
      branch: 'main',
      tip,
      operatorCheckout: '/home/lunchbox/proj-buzzy',
      operatorHasCommit: false,
    });
    expect(lines[1]).toContain('/home/lunchbox/proj-buzzy has not fetched this yet');
    expect(lines[1]).toContain('git -C /home/lunchbox/proj-buzzy fetch');
  });

  it('says nothing about a checkout that already has the commit', () => {
    expect(
      landDestinationLines({
        branch: 'main',
        tip,
        operatorCheckout: '/home/lunchbox/proj-buzzy',
        operatorHasCommit: true,
      }),
    ).toEqual(['Landed on main at 4ec0627ee559.']);
  });

  it('says nothing when the daemon serves the operator’s own tree', () => {
    // A local-only Room is served out of the operator's checkout itself, so
    // there is no second reality to warn about.
    expect(landDestinationLines({ branch: 'master', tip })).toEqual([
      'Landed on master at 4ec0627ee559.',
    ]);
  });
});

describe('"has not fetched this" is asked, never assumed', () => {
  it('is decided by whether the checkout actually holds the commit', () => {
    // Two real repositories: one that fetched the landed commit and one that
    // did not. The paths differ in both cases, which is exactly why the paths
    // differing must not be what decides the message.
    const root = mkdtempSync(join(tmpdir(), 'beeline-land-destination-'));
    cleanup.push(root);
    const origin = resolve(root, 'origin.git');
    const canonical = resolve(root, 'canonical');
    const operator = resolve(root, 'operator');
    git(root, ['init', '--bare', '-q', origin]);
    git(root, ['clone', '-q', origin, canonical]);
    git(canonical, ['config', 'user.name', 'Agent']);
    git(canonical, ['config', 'user.email', 'agent@buzzy.local']);
    writeFileSync(resolve(canonical, 'LANDED.txt'), 'landed\n');
    git(canonical, ['add', 'LANDED.txt']);
    git(canonical, ['commit', '-qm', 'landed work']);
    git(canonical, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    const landed = git(canonical, ['rev-parse', 'HEAD']);

    git(root, ['clone', '-q', origin, operator]);
    const has = (cwd: string): boolean =>
      spawnSync('git', ['cat-file', '-e', `${landed}^{commit}`], { cwd }).status === 0;

    // Cloned after the push: it already has it, and must not be nagged.
    expect(has(operator)).toBe(true);
    expect(
      landDestinationLines({
        branch: 'main',
        tip: landed,
        operatorCheckout: operator,
        operatorHasCommit: has(operator),
      }),
    ).toHaveLength(1);

    // A tree that predates the push does not, and must be told.
    const stale = resolve(root, 'stale');
    git(root, ['init', '-q', '-b', 'main', stale]);
    expect(has(stale)).toBe(false);
    expect(
      landDestinationLines({
        branch: 'main',
        tip: landed,
        operatorCheckout: stale,
        operatorHasCommit: has(stale),
      }).join('\n'),
    ).toContain('has not fetched this yet');
  });
});
