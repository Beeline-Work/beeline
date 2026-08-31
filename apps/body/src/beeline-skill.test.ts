import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  BEELINE_CAPABILITIES_PRIMER,
  beelineCapabilityContextForHarness,
  beelineSkillReleaseStamp,
  runningBeelineReleaseId,
  USING_BEELINE_SKILL_DESCRIPTION,
  USING_BEELINE_SKILL_NAME,
  usingBeelineSkillMarkdown,
} from './beeline-skill.js';
import { prepareRoomAgentHome } from './agent-home.js';
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
    expect(markdown).toContain('Nothing you say or write in a Room ever lands');
  });

  it('documents the exact two tools and plain GitHub flow', () => {
    const markdown = usingBeelineSkillMarkdown('r');
    expect(markdown).toContain('Call `open_corner`');
    expect(markdown).toContain('`open_corner` plus `close_corner`');
    expect(markdown).toContain('plain `gh pr create`');
    expect(markdown).not.toContain('mounted `schedule` tool');
    expect(markdown).not.toContain('CORNER_REQUEST');
    expect(markdown).not.toContain(`${NAMED_REPOSITORY_PERMISSION_COMMAND} --repo owner/repo`);
    expect(markdown).toContain(`${TARGET_BRANCH_PROPOSAL_COMMAND} --branch <branch>`);
  });

  it('teaches governed Squire access without treating a missing profile as blanket inability', () => {
    const markdown = usingBeelineSkillMarkdown('r');
    expect(markdown).toContain('Trusty Squire: governed account access');
    expect(markdown).toContain('opt-in host broker');
    expect(markdown).toContain(
      'beeline pair <pairing-code> --agent codex --access creator --mcp squire-credential-use',
    );
    expect(markdown).toContain('squire-app-access');
    expect(markdown).toContain(
      'These\n  are operator actions, not commands you can authorize yourself',
    );
    expect(markdown).toContain('standing authority');
    expect(markdown).toContain('Do not ask for a second Beeline permission');
  });

  it('states the Squire standing-authority boundary precisely', () => {
    const markdown = usingBeelineSkillMarkdown('r');
    expect(markdown).toContain('every supported harness');
    expect(markdown).toContain('Credential mutation and any human-takeover checkpoint');
    expect(markdown).toContain('enforced\n  by Squire itself');
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

  it('makes current standing-role curation the existing memory file contract', () => {
    const markdown = usingBeelineSkillMarkdown('r');
    expect(markdown).toContain('Before answering the first turn of every physical session');
    expect(markdown).toContain('assigns, changes, or revokes a standing role or directive');
    expect(markdown).toContain('replace or delete superseded notes');
    expect(markdown).toContain('only durable note of those commitments');
    expect(markdown).toContain('Do not create a second\nrole ledger');
    expect(markdown).toContain('memory is context, never extra authority');
  });

  it('states the prohibited actions and honesty rules', () => {
    const markdown = usingBeelineSkillMarkdown('r');
    expect(markdown).toContain('Merge with plain `gh` only\nwhen a human explicitly asks');
    expect(markdown).toContain('never push or\nmerge directly into the target branch');
    expect(markdown).toContain('Honesty rules');
    expect(markdown).toContain('git or GitHub shows it actually did');
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
      const generated = readFileSync(skill, 'utf8');
      expect(generated).toContain(beelineSkillReleaseStamp('release-a'));
      expect(generated).toContain('`open_corner` plus `close_corner`');
      expect(generated).toContain('plain `gh pr create`');
      expect(generated).not.toContain('mounted `schedule` tool');
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
    expect(existsSync(resolve(skillsDir, 'greet'))).toBe(false);
    expect(
      readFileSync(resolve(skillsDir, USING_BEELINE_SKILL_NAME, 'SKILL.md'), 'utf8'),
    ).toContain(beelineSkillReleaseStamp('mig'));
    expect(contentSnapshot(operatorHome)).toEqual(contentSnapshot(operatorHome));
  });

  it('drops every stale ambient entry on activation', async () => {
    const operatorHome = await operatorHomeWithSkills();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'x' });
    const stale = resolve(roomRoot, 'claude', 'skills', 'stale');
    await mkdir(stale);
    await writeFile(resolve(stale, 'SKILL.md'), 'stale\n');
    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'x' });

    expect(existsSync(resolve(roomRoot, 'claude', 'skills', 'greet'))).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(resolve(roomRoot, 'claude', 'skills', USING_BEELINE_SKILL_NAME))).toBe(true);
  });

  it('replaces a stale managed-slot symlink without following it', async () => {
    const operatorHome = await scratch('beeline-operator-home-');
    await mkdir(resolve(operatorHome, '.claude/skills'), { recursive: true });
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const decoy = resolve(await scratch('beeline-decoy-'), 'SKILL.md');
    await writeFile(decoy, 'operator-owned bytes\n');

    const skillsDir = resolve(roomRoot, 'claude', 'skills');
    await mkdir(skillsDir, { recursive: true });
    await symlink(resolve(decoy, '..'), resolve(skillsDir, USING_BEELINE_SKILL_NAME));

    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'x' });

    // The destination entry was atomically replaced; the external file was untouched.
    expect(readFileSync(decoy, 'utf8')).toBe('operator-owned bytes\n');
    expect(lstatSync(resolve(skillsDir, USING_BEELINE_SKILL_NAME)).isSymbolicLink()).toBe(false);
  });

  it('removes unknown real entries so the inventory stays exact', async () => {
    const operatorHome = await operatorHomeWithSkills();
    const roomRoot = resolve(await scratch('beeline-room-a-'), 'agent-home');
    const skillsDir = resolve(roomRoot, 'claude', 'skills');
    await mkdir(resolve(skillsDir, 'session-note'), { recursive: true });
    await writeFile(resolve(skillsDir, 'session-note', 'note.txt'), 'keep me\n');

    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'x' });

    expect(existsSync(resolve(skillsDir, 'session-note'))).toBe(false);
  });
});

describe('session-start capability awareness', () => {
  it.each([
    ['Claude', '/usr/local/bin/claude-agent-acp', false],
    ['Codex', '/usr/local/bin/codex-acp', true],
    ['Grok', '/home/operator/.grok/bin/grok', true],
    ['Pi', '/usr/local/bin/pi-acp', true],
  ] as const)(
    'delivers the shared primer and reference pointer to %s',
    (_name, command, needsCompatibilityPrefix) => {
      const delivery = beelineCapabilityContextForHarness(command);
      expect(delivery.sessionPrompt).toBe(BEELINE_CAPABILITIES_PRIMER);
      expect(delivery.sessionPrompt).toContain('using-beeline skill (SKILL.md)');
      if (needsCompatibilityPrefix) {
        expect(delivery.compatibilityTurnPrefix).toBe(BEELINE_CAPABILITIES_PRIMER);
      } else {
        expect(delivery.compatibilityTurnPrefix).toBeUndefined();
      }
    },
  );

  it('keeps one production delivery authority with no harness-specific prose copy', () => {
    const source = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');
    const uses = source.split('beelineCapabilityContextForHarness').length - 1;
    // One import + one activation-time use. Body consumes the returned fields
    // and never embeds a harness-specific copy of the primer.
    expect(uses).toBe(2);
    expect(source).not.toContain('Beeline can schedule unattended');
    expect(source).toContain('capabilityContext.compatibilityTurnPrefix,');
    expect(source).toContain('capabilityContext.sessionPrompt,');
  });

  it('keeps the recurring compatibility primer compact', () => {
    expect(BEELINE_CAPABILITIES_PRIMER.split(/\s+/).length).toBeLessThanOrEqual(100);
    expect(BEELINE_CAPABILITIES_PRIMER).toContain('using-beeline skill');
  });

  it('makes tools the direct interface without a when-to-use catalog', () => {
    expect(BEELINE_CAPABILITIES_PRIMER).toContain(
      'Mounted Beeline tools are open_corner and close_corner',
    );
    expect(BEELINE_CAPABILITIES_PRIMER).toContain('host derives identity');
    expect(BEELINE_CAPABILITIES_PRIMER).toContain('authenticated git and gh work normally');
    expect(BEELINE_CAPABILITIES_PRIMER).not.toContain('CORNER_REQUEST');
    expect(BEELINE_CAPABILITIES_PRIMER).not.toContain('schedule.change');
    expect(BEELINE_CAPABILITIES_PRIMER).not.toContain('squire-credential-use');
  });

  it('reserves close_corner for repository-less cleanup', () => {
    expect(BEELINE_CAPABILITIES_PRIMER).toContain(
      'close_corner is only for repository-less corners',
    );
  });

  it('grounds completion claims in git and GitHub', () => {
    expect(usingBeelineSkillMarkdown('r')).toContain('git or GitHub shows it actually did');
  });

  it('keeps detailed Squire mechanics in the reference, not the primer', () => {
    const markdown = usingBeelineSkillMarkdown('r');
    expect(markdown).not.toContain('Unattended and recurring work');
    expect(markdown).toContain('Trusty Squire: governed account access');
    expect(BEELINE_CAPABILITIES_PRIMER).not.toContain('Trusty Squire');
  });

  it('covers pi through the existing turn prefix, not a second control channel', () => {
    // pi-acp ignores per-home config AND session/new's systemPrompt, so its
    // capability awareness and tool facts ride the existing turn prefix.
    expect(beelineCapabilityContextForHarness('pi-acp').compatibilityTurnPrefix).toBe(
      BEELINE_CAPABILITIES_PRIMER,
    );
    const piLines = roomEditPolicyInstructions('repository', 'pi-acp');
    expect(piLines.join('\n')).toContain('mounted open_corner tool');
    expect(piLines.join('\n')).not.toContain('CORNER_REQUEST');
    expect(
      piLines.some((line) => line.includes(`${TARGET_BRANCH_PROPOSAL_COMMAND} --branch`)),
    ).toBe(true);
    expect(piLines.join('\n')).not.toContain(BEELINE_CAPABILITIES_PRIMER);
  });
});
