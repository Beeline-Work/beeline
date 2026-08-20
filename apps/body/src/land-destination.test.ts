/**
 * A land recap uses the resolved remote identity and never pairing history.
 */
import { describe, expect, it } from 'vitest';
import { commitUrlForRemote, landDestinationLines } from './land-destination.js';

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

  it('does not expose pairing-history checkout paths', () => {
    expect(landDestinationLines({ branch: 'master', tip })).toEqual([
      'Landed on master at 4ec0627ee559.',
    ]);
  });
});
