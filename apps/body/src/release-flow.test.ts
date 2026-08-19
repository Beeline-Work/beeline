import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isReleaseConfirmation,
  releaseBriefing,
  releaseCornerIntent,
  releaseCornerPrompt,
  releaseCornerTaskPrompt,
  releaseRoomIntent,
  summarizeUnreleasedWork,
} from './release-flow.js';
import { taskSlugForCornerIntent } from './body.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

/** A repository with a tagged release and three commits landed after it. */
function taggedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'beeline-release-flow-'));
  cleanup.push(root);
  git(root, ['init', '-q', '-b', 'main', '.']);
  git(root, ['config', 'user.name', 'Release Test']);
  git(root, ['config', 'user.email', 'release@test.invalid']);
  writeFileSync(join(root, 'README.md'), '# widgets\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'seed']);
  git(root, ['tag', '-a', 'v1.1.0', '-m', 'v1.1.0']);
  for (const subject of ['add the widget picker', 'fix a crash on empty input', 'tidy the docs']) {
    writeFileSync(join(root, subject.replace(/\W+/g, '-')), `${subject}\n`);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', subject]);
  }
  return root;
}

describe('recognizing a release ask', () => {
  it('reads "what is unreleased" in the ways people actually write it', () => {
    for (const message of [
      "what's unreleased?",
      '@lena what is unreleased on main',
      'anything not released yet?',
      "what's changed since the last release?",
      'what has landed since our last tag?',
      'are we ready to ship?',
    ]) {
      expect(releaseRoomIntent(message), message).toEqual({ kind: 'unreleased' });
    }
  });

  it('reads a release ask, and picks up a named version when there is one', () => {
    expect(releaseRoomIntent('cut a release')).toEqual({ kind: 'release' });
    expect(releaseRoomIntent('@lena please cut a release')).toEqual({ kind: 'release' });
    expect(releaseRoomIntent("let's cut a release")).toEqual({ kind: 'release' });
    expect(releaseRoomIntent('can you prepare the next release')).toEqual({ kind: 'release' });
    expect(releaseRoomIntent('release v1.2')).toEqual({ kind: 'release', version: '1.2' });
    expect(releaseRoomIntent('cut v2.0.1')).toEqual({ kind: 'release', version: '2.0.1' });
    expect(releaseRoomIntent('tag a release as 3.4.0-rc.1')).toEqual({
      kind: 'release',
      version: '3.4.0-rc.1',
    });
  });

  it('leaves every other Room message alone', () => {
    for (const message of [
      '',
      'open a corner and add a haiku',
      'what changed in the merge gate?',
      'how does the release corner know what to do?',
      'fix the flaky presence test',
      'the release notes for v1.1 read well',
      // The near-miss that made the verb list narrower: an ordinary edit ask.
      'make the version bump in package.json',
      'update the version field to 2.0.0',
      'tag every function in this file with a doc comment',
    ]) {
      expect(releaseRoomIntent(message), message).toBeUndefined();
    }
  });
});

describe('confirming a proposal', () => {
  it('accepts a message that is nothing but agreement', () => {
    for (const message of [
      'yes',
      'Yes!',
      'yep',
      'ok',
      'go ahead',
      'do it',
      'ship it',
      '@lena yes please do',
      'sounds good',
      'lgtm',
    ]) {
      expect(isReleaseConfirmation(message), message).toBe(true);
    }
  });

  it('refuses anything that carries new instructions with it', () => {
    for (const message of [
      '',
      'yes, but bump the minor not the patch',
      'go ahead and fix the README first',
      'not yet',
      'no',
      'do it tomorrow',
      "yes I'd also like the changelog rewritten",
    ]) {
      expect(isReleaseConfirmation(message), message).toBe(false);
    }
  });
});

describe('reading what is unreleased out of git', () => {
  it('counts and names the commits since the newest tag', () => {
    const work = summarizeUnreleasedWork(taggedRepo(), 'refs/heads/main');
    expect(work).toMatchObject({ branch: 'main', lastTag: 'v1.1.0', commitCount: 3 });
    expect(work?.commits).toEqual([
      'tidy the docs',
      'fix a crash on empty input',
      'add the widget picker',
    ]);
    expect(work?.truncated).toBe(false);
  });

  it('reports zero rather than the whole history when the tag is the tip', () => {
    const root = taggedRepo();
    git(root, ['tag', '-a', 'v1.2.0', '-m', 'v1.2.0']);
    const work = summarizeUnreleasedWork(root, 'refs/heads/main');
    expect(work).toMatchObject({ lastTag: 'v1.2.0', commitCount: 0, commits: [] });
  });

  it('handles a repository that has never been tagged', () => {
    const root = mkdtempSync(join(tmpdir(), 'beeline-release-untagged-'));
    cleanup.push(root);
    git(root, ['init', '-q', '-b', 'main', '.']);
    git(root, ['config', 'user.name', 'Release Test']);
    git(root, ['config', 'user.email', 'release@test.invalid']);
    writeFileSync(join(root, 'README.md'), '# fresh\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'first']);

    const work = summarizeUnreleasedWork(root, 'refs/heads/main');
    expect(work).toMatchObject({ commitCount: 1, commits: ['first'] });
    expect(work?.lastTag).toBeUndefined();
  });

  it('falls back to the remote-tracking branch a canonical checkout actually has', () => {
    const root = taggedRepo();
    // A canonical checkout is reset to origin/<target>; it need not hold a
    // local branch of that name at all.
    git(root, ['branch', '-m', 'main', 'trunk']);
    git(root, ['update-ref', 'refs/remotes/origin/main', 'trunk']);
    expect(summarizeUnreleasedWork(root, 'refs/heads/main', 'origin')).toMatchObject({
      branch: 'main',
      commitCount: 3,
    });
  });

  it('answers undefined for a path that is not a usable repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'beeline-release-empty-'));
    cleanup.push(root);
    expect(summarizeUnreleasedWork(root, 'refs/heads/main')).toBeUndefined();
  });
});

describe('what the Room agent and the corner are told', () => {
  const work = {
    branch: 'main',
    lastTag: 'v1.1.0',
    commitCount: 3,
    commits: ['tidy the docs', 'fix a crash on empty input', 'add the widget picker'],
    truncated: false,
  };

  it('hands the agent the host-read commit list and asks it to offer a corner', () => {
    const briefing = releaseBriefing(work, { kind: 'unreleased' });
    expect(briefing).toContain('3 commits on main since v1.1.0');
    expect(briefing).toContain('- add the widget picker');
    expect(briefing).toContain('offer, in one sentence, to open a corner');
    expect(briefing).toContain('confirm');
    expect(briefing).toContain('Do not attempt the release yourself in this Room');
  });

  it('tells the agent to say so and stop when nothing is unreleased', () => {
    const briefing = releaseBriefing({ ...work, commitCount: 0, commits: [] }, { kind: 'unreleased' });
    expect(briefing).toContain('There is nothing unreleased.');
    expect(briefing).toContain('Do not offer a corner');
    expect(briefing).not.toContain('offer, in one sentence, to open a corner');
  });

  it('carries a named version into the briefing', () => {
    expect(releaseBriefing(work, { kind: 'release', version: '1.2.0' })).toContain(
      'The person named a version: 1.2.0',
    );
  });

  it("points the corner at the repository's own process and demands an annotated tag", () => {
    const brief = releaseCornerTaskPrompt({ work, version: '1.2.0' });
    expect(brief).toContain("Run this repository's own release process for main.");
    expect(brief).toContain('do not invent one');
    expect(brief).toContain('git tag -a <version>');
    expect(brief).toContain('ANNOTATED tag');
    expect(brief).toContain('Use the version the person asked for: 1.2.0.');
    expect(brief).toContain('Do NOT push anything');
    expect(brief).toContain('do not run anything that would announce the release');
    // The host-read change list rides along so the corner does not re-derive it.
    expect(brief).toContain('- add the widget picker');
  });

  it('lets the corner choose the version when the person did not name one', () => {
    const brief = releaseCornerTaskPrompt({ work });
    expect(brief).toContain('Choose the next version');
    expect(brief).not.toContain('Use the version the person asked for');
  });

  it('names the corner after the release, never after the corner-open imperative', () => {
    expect(releaseCornerIntent({ work, version: '1.2.0' })).toBe('release 1.2.0');
    expect(taskSlugForCornerIntent(releaseCornerIntent({ work, version: '1.2.0' }))).toBe(
      'release-1-2-0',
    );
    expect(taskSlugForCornerIntent(releaseCornerIntent({ work }))).toBe('release-from-main');
    expect(releaseCornerPrompt({ work, version: '1.2.0' })).toBe('cut release 1.2.0 from main');
  });
});
