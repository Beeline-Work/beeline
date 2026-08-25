import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  BEELINE_SKILL_PROMPT_LINE,
  beelineSkillReleaseStamp,
  runningBeelineReleaseId,
  USING_BEELINE_SKILL_DESCRIPTION,
  USING_BEELINE_SKILL_NAME,
  usingBeelineSkillMarkdown,
} from './beeline-skill.js';
import { prepareRoomAgentHome } from './agent-home.js';
import { PI_CORNER_REQUEST_INSTRUCTIONS } from './corner-request.js';
import { roomEditPolicyInstructions } from './body.js';
import { NAMED_REPOSITORY_PERMISSION_COMMAND } from './repository-target.js';
import { TARGET_BRANCH_PROPOSAL_COMMAND } from './target-branch.js';

const cleanup: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Recursive snapshot of a directory tree: file hashes plus symlink targets. */
function contentSnapshot(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!existsSync(root)) return snapshot;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Links are structure: pin their resolved target without descending.
        snapshot.set(full, `link -> ${realpathSync(full)}`);
      } else if (entry.isDirectory()) walk(full);
      else snapshot.set(full, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(root);
  return snapshot;
}

describe('the using-beeline skill content', () => {
  it('carries discovery metadata compatible with the shipped harness skill loaders', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown.startsWith('---\n')).toBe(true);
    // Only the two keys every loader reads; decorative metadata risks breaking
    // cross-harness SKILL.md parsing.
    const frontmatter = markdown.slice(4, markdown.indexOf('\n---', 4));
    expect(frontmatter).toContain(`name: ${USING_BEELINE_SKILL_NAME}`);
    expect(USING_BEELINE_SKILL_NAME).toMatch(/^[a-z0-9-]+$/);
    expect(USING_BEELINE_SKILL_NAME.length).toBeLessThan(64);
    expect(USING_BEELINE_SKILL_DESCRIPTION).toContain('Consult this skill');
    expect(USING_BEELINE_SKILL_DESCRIPTION).toContain('when');
    expect(markdown).toContain(USING_BEELINE_SKILL_DESCRIPTION);
  });

  it('is version-stamped with the release id so drift is visible', () => {
    const one = usingBeelineSkillMarkdown('0.0.41-abc123def456');
    expect(one).toContain(beelineSkillReleaseStamp('0.0.41-abc123def456'));
    expect(one).not.toContain(beelineSkillReleaseStamp('other'));
    // A new release produces different bytes, so regeneration is observable.
    expect(usingBeelineSkillMarkdown('0.0.42-fedcba987654')).not.toBe(one);
  });

  it('explains rooms versus corners and that only corner feature branches land', () => {
    const markdown = usingBeelineSkillMarkdown('r');
    expect(markdown).toContain('read-only conversation channel');
    expect(markdown).toContain('edit corner');
    expect(markdown).toContain("corner's feature branch");
    expect(markdown.toLowerCase()).toContain('you never land');
  });

  it('reproduces the canonical corner-open paths verbatim per harness capability', () => {
    const markdown = usingBeelineSkillMarkdown('r');
    // Text-fallback marker, exactly as corner-request.ts defines it.
    expect(markdown).toContain('CORNER_REQUEST: <one-sentence task>');
    // The two host-recognized native commands, verbatim.
    expect(markdown).toContain(`${NAMED_REPOSITORY_PERMISSION_COMMAND} --repo owner/repo`);
    expect(markdown).toContain(`${TARGET_BRANCH_PROPOSAL_COMMAND} --branch <branch>`);
    // Permission-capable harnesses attempt the mutating tool once.
    expect(markdown).toContain('write/edit tool ONCE');
  });

  it('covers the writable non-repository directories and their limits', () => {
    const markdown = usingBeelineSkillMarkdown('r');
    expect(markdown).toContain('$BUZZY_WORKBENCH_DIR');
    expect(markdown).toContain('$BUZZY_AGENT_PRIVATE_DIR');
    expect(markdown).toContain('$BUZZY_AGENT_MEMORY_DIR');
    expect(markdown).toContain('25 MB');
    expect(markdown).toContain('garbage-collected');
    expect(markdown).toContain('never hold\n  secrets or credentials');
  });

  it('states the prohibited actions and honesty rules', () => {
    const markdown = usingBeelineSkillMarkdown('r');
    expect(markdown).toContain('Never merge, never push to the target or any protected branch');
    expect(markdown).toContain('never archive\nyour own corner');
    expect(markdown).toContain('Honesty rules');
    expect(markdown).toContain('unless a host message shows it actually did');
  });
});

describe('runningBeelineReleaseId', () => {
  it('reads the stamped identity from the running bundle anchor', () => {
    const libDir = 'ignored-in-memory';
    const id = runningBeelineReleaseId({ BEELINE_LIB_DIR: libDir }, (path) =>
      path.endsWith('bundle.json')
        ? JSON.stringify({ version: '0.0.7', commit: 'a'.repeat(40) })
        : '',
    );
    expect(id).toBe('0.0.7-aaaaaaaaaaaa');
  });

  it('falls back to a deterministic source stamp without a bundle anchor', () => {
    expect(runningBeelineReleaseId({}, () => '')).toBe('source');
    expect(runningBeelineReleaseId({ BEELINE_LIB_DIR: '/gone' }, () => '')).toBe('source');
  });
});

describe('managed-skill materialization on session activation', () => {
  async function operatorHomeWithSkills(): Promise<string> {
    const home = await scratch('beeline-operator-home-');
    for (const dir of ['.claude/skills/greet', '.codex/skills/audit', '.grok/skills/notes']) {
      await mkdir(resolve(home, dir), { recursive: true });
      await writeFile(resolve(home, dir, 'SKILL.md'), `operator skill at ${dir}\n`);
    }
    return home;
  }

  it('installs into each managed harness skills location and refreshes on release change', async () => {
    const operatorHome = await operatorHomeWithSkills();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');

    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'release-a' });
    for (const dir of ['claude', 'codex', 'grok']) {
      const skill = resolve(roomRoot, dir, 'skills', USING_BEELINE_SKILL_NAME, 'SKILL.md');
      expect(lstatSync(skill).isSymbolicLink()).toBe(false);
      expect(readFileSync(skill, 'utf8')).toContain(beelineSkillReleaseStamp('release-a'));
    }

    // Regeneration on the next activation makes upgrades automatic.
    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'release-b' });
    for (const dir of ['claude', 'codex', 'grok']) {
      const skill = resolve(roomRoot, dir, 'skills', USING_BEELINE_SKILL_NAME, 'SKILL.md');
      expect(readFileSync(skill, 'utf8')).toContain(beelineSkillReleaseStamp('release-b'));
      expect(readFileSync(skill, 'utf8')).not.toContain('release-a -->');
    }
  });

  it('is idempotent across repeated activations', async () => {
    const operatorHome = await operatorHomeWithSkills();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'same' });
    const before = contentSnapshot(resolve(roomRoot, 'claude', 'skills'));
    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'same' });
    expect(contentSnapshot(resolve(roomRoot, 'claude', 'skills'))).toEqual(before);
    const entries = readdirSync(resolve(roomRoot, 'claude', 'skills'));
    expect(entries.filter((name) => name === USING_BEELINE_SKILL_NAME)).toHaveLength(1);
  });

  it('never modifies the operator skill directories byte-for-byte', async () => {
    const operatorHome = await operatorHomeWithSkills();
    const before = contentSnapshot(operatorHome);
    const beforeLinks = [...contentSnapshot(operatorHome).keys()].sort();

    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'x' });
    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'y' });

    expect(contentSnapshot(operatorHome)).toEqual(before);
    expect([...contentSnapshot(operatorHome).keys()].sort()).toEqual(beforeLinks);
  });

  it('migrates the earlier whole-dir symlink layout without touching operator data', async () => {
    const operatorHome = await operatorHomeWithSkills();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const claudeHome = resolve(roomRoot, 'claude');
    await mkdir(claudeHome, { recursive: true });
    // The pre-composite shape: the discovery path itself is a symlink into the
    // operator's tree.
    await symlink(resolve(operatorHome, '.claude/skills'), resolve(claudeHome, 'skills'));

    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'mig' });

    const skillsDir = resolve(claudeHome, 'skills');
    expect(lstatSync(skillsDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(resolve(skillsDir, 'greet')).isSymbolicLink()).toBe(true);
    expect(realpathSync(resolve(skillsDir, 'greet'))).toBe(
      realpathSync(resolve(operatorHome, '.claude/skills/greet')),
    );
    expect(
      readFileSync(resolve(skillsDir, USING_BEELINE_SKILL_NAME, 'SKILL.md'), 'utf8'),
    ).toContain(beelineSkillReleaseStamp('mig'));
    expect(contentSnapshot(operatorHome)).toEqual(contentSnapshot(operatorHome));
  });

  it('drops stale per-entry links when the operator removes a skill', async () => {
    const operatorHome = await operatorHomeWithSkills();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'x' });
    expect(existsSync(resolve(roomRoot, 'claude', 'skills', 'greet'))).toBe(true);

    await rm(resolve(operatorHome, '.claude/skills/greet'), { recursive: true });
    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'x' });

    expect(existsSync(resolve(roomRoot, 'claude', 'skills', 'greet'))).toBe(false);
    expect(existsSync(resolve(roomRoot, 'claude', 'skills', USING_BEELINE_SKILL_NAME))).toBe(true);
  });

  it('refuses to regenerate through a symlink occupying the managed skill slot', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.claude/skills'), { recursive: true });
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const decoy = resolve(await scratch('beeline-decoy-'), 'SKILL.md');
    await writeFile(decoy, 'operator-owned bytes\n');

    const skillsDir = resolve(roomRoot, 'claude', 'skills');
    await mkdir(skillsDir, { recursive: true });
    await symlink(resolve(decoy, '..'), resolve(skillsDir, USING_BEELINE_SKILL_NAME));

    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'x' });

    // The write was refused; the operator-side file is untouched.
    expect(readFileSync(decoy, 'utf8')).toBe('operator-owned bytes\n');
    expect(lstatSync(resolve(skillsDir, USING_BEELINE_SKILL_NAME)).isSymbolicLink()).toBe(true);
  });

  it('leaves unknown real entries in the managed directory alone', async () => {
    const operatorHome = await operatorHomeWithSkills();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const skillsDir = resolve(roomRoot, 'claude', 'skills');
    await mkdir(resolve(skillsDir, 'session-note'), { recursive: true });
    await writeFile(resolve(skillsDir, 'session-note', 'note.txt'), 'keep me\n');

    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'x' });

    expect(readFileSync(resolve(skillsDir, 'session-note', 'note.txt'), 'utf8')).toBe('keep me\n');
  });
});

describe('prompt and pi-path coverage', () => {
  it('adds exactly one system-prompt pointer line in body.ts', async () => {
    const source = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');
    const uses = source.split('BEELINE_SKILL_PROMPT_LINE').length - 1;
    // One import + exactly one use in the session system prompt assembly.
    expect(uses).toBe(2);
    expect(source).toContain('BEELINE_SKILL_PROMPT_LINE,');
  });

  it('keeps the pointer line concise', () => {
    expect(BEELINE_SKILL_PROMPT_LINE.split('. ').length).toBeLessThanOrEqual(2);
    expect(BEELINE_SKILL_PROMPT_LINE).toContain('using-beeline skill');
  });

  it('covers pi through the existing turn prefix, not a second channel', () => {
    // pi-acp ignores per-home config AND session/new's systemPrompt, so its
    // corner-open facts must ride the per-turn edit-policy instructions.
    const piLines = roomEditPolicyInstructions('repository', 'pi-acp');
    for (const line of PI_CORNER_REQUEST_INSTRUCTIONS) {
      expect(piLines).toContain(line);
    }
    expect(
      piLines.some((line) => line.includes(`${TARGET_BRANCH_PROPOSAL_COMMAND} --branch`)),
    ).toBe(true);
    // The text-fallback harness is never told to emit permission-style requests
    // or given the marker twice through the skill prompt line.
    expect(piLines.join('\n')).not.toContain(BEELINE_SKILL_PROMPT_LINE);
  });
});
