import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir as mkdirAsync, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { beelineSkillReleaseStamp, USING_BEELINE_SKILL_NAME } from './beeline-skill.js';
import {
  MISSION_BRIEF_SKILL_DESCRIPTION,
  MISSION_BRIEF_SKILL_NAME,
  missionBriefSkillMarkdown,
  MISSION_FILES,
} from './mission-skill.js';
import { prepareRoomAgentHome } from './agent-home.js';

const cleanup: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('the mission-brief skill content', () => {
  const markdown = (releaseId = 'test-release') => missionBriefSkillMarkdown(releaseId);

  it('carries discovery metadata compatible with the shipped harness skill loaders', () => {
    expect(markdown().startsWith('---\n')).toBe(true);
    // Only the two keys every loader reads; decorative metadata risks breaking
    // cross-harness SKILL.md parsing.
    const frontmatter = markdown().slice(4, markdown().indexOf('\n---', 4));
    expect(frontmatter).toContain(`name: ${MISSION_BRIEF_SKILL_NAME}`);
    expect(MISSION_BRIEF_SKILL_NAME).toMatch(/^[a-z0-9-]+$/);
    expect(MISSION_BRIEF_SKILL_NAME.length).toBeLessThan(64);
    // The description is the trigger surface: it must clearly cover turning a
    // one-sentence objective into an operating mission brief.
    expect(MISSION_BRIEF_SKILL_DESCRIPTION).toContain('one-sentence mission objective');
    expect(MISSION_BRIEF_SKILL_DESCRIPTION).toContain('mission brief');
    expect(markdown()).toContain(MISSION_BRIEF_SKILL_DESCRIPTION);
  });

  it('is version-stamped with the release id so drift is visible', () => {
    const one = markdown('0.0.41-abc123def456');
    expect(one).toContain(beelineSkillReleaseStamp('0.0.41-abc123def456'));
    expect(one).not.toContain(beelineSkillReleaseStamp('other'));
    // A new release produces different bytes, so regeneration is observable.
    expect(missionBriefSkillMarkdown('0.0.42-fedcba987654')).not.toBe(one);
  });

  it('teaches the three-file convention and which durable information belongs in each', () => {
    const text = markdown();
    expect(text).toContain('`objective.md`');
    expect(text).toContain('`state.md`');
    expect(text).toContain('`org-chart.md`');
    expect(text).toContain('durable WHY');
    expect(text).toContain('current WHERE');
    // Durable intent vs mutable now vs people/authority sorting rule.
    expect(text).toContain('durable intent → `objective.md`');
    expect(text).toContain('mutable now → `state.md`');
    expect(text).toContain('people and authority → `org-chart.md`');
    expect(text).toContain('book of record');
    for (const name of MISSION_FILES) {
      expect(text).toContain(name);
    }
  });

  it('conducts a bounded bootstrap interview from a one-sentence objective', () => {
    const text = markdown();
    expect(text).toContain('bootstrap interview');
    expect(text.toLowerCase()).toContain('at most five questions');
    expect(text.toLowerCase()).toContain('one\nround');
    expect(text).toContain('skip anything the objective already answers');
    // Bounded: the interview must never stall the mission.
    expect(text).toContain('Never hold the mission hostage');
  });

  it('teaches hub-and-spoke coordination with pointers over payloads and roll-ups', () => {
    const text = markdown();
    expect(text).toContain('ONLY with you');
    expect(text).toContain('You communicate with the\n  human');
    expect(text).toContain('broker requests');
    expect(text).toContain('POINTERS, not payloads');
    expect(text).toContain('Roll UP, not out');
    expect(text).toContain('stays in\n  the repo');
  });

  it('states the cron cadence floors accurately per the FINAL charter', () => {
    const text = markdown();
    expect(text).toContain('15 MINUTES apart');
    expect(text).toContain('**Script-fired crons** may run tighter');
    expect(text.toLowerCase()).toContain('script-fired is the\n  default');
    // The dead capabilities stay dead: no webhook ingress, no cross-channel
    // messaging, no condition DSL — script-fired crons cover polling needs.
    expect(text.toLowerCase()).not.toContain('webhook');
    expect(text.toLowerCase()).not.toContain('condition dsl');
  });

  it('gives concrete escalation criteria for the chief of staff', () => {
    const text = markdown();
    expect(text).toContain('When to escalate to the human');
    expect(text).toContain('Decisions');
    expect(text).toContain('Authority, budget, or scope conflicts');
    expect(text).toContain('Safety or integrity concerns');
    expect(text).toContain('Blocked work');
    expect(text).toContain('Material mission-state changes');
    // Routine coordination stays internal; escalations recommend, not just report.
    expect(text).toContain('Everything else stays in the repo');
    expect(text).toContain('your recommendation');
  });

  it('makes the first-corner flow explicit and keeps provisioning human-owned', () => {
    const text = markdown();
    expect(text).toContain('First corner: bootstrap');
    expect(text).toContain('beeline mission-scaffold .');
    expect(text).toContain('never overwrites existing ones');
    // The human provisions/binds once; the CoS never provisions, binds,
    // authorizes, or lands the mission repo itself.
    expect(text).toContain('The HUMAN provisions and binds the mission repo once');
    expect(text).toContain(
      'You never provision, bind,\nauthorize, or land the mission repo yourself',
    );
    expect(text).toContain('normal\n   signed review and landing flow');
  });
});

describe('mission-brief materialization on session activation', () => {
  it('installs beside using-beeline in every managed harness skills dir', async () => {
    const operatorHome = await scratch('mission-operator-home-');
    await mkdirAsync(resolve(operatorHome, '.claude/skills/greet'), { recursive: true });
    await writeFile(resolve(operatorHome, '.claude/skills/greet/SKILL.md'), 'operator\n');
    const roomRoot = resolve(await scratch('mission-room-'), 'agent-home');

    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'rel-1' });

    for (const dir of ['claude', 'codex', 'grok']) {
      const skillsDir = resolve(roomRoot, dir, 'skills');
      expect(existsSync(resolve(skillsDir, USING_BEELINE_SKILL_NAME, 'SKILL.md'))).toBe(true);
      const missionSkill = resolve(skillsDir, MISSION_BRIEF_SKILL_NAME, 'SKILL.md');
      expect(existsSync(missionSkill)).toBe(true);
      // A real regenerated file, not a link into operator data.
      expect(lstatSync(missionSkill).isSymbolicLink()).toBe(false);
      expect(readFileSync(missionSkill, 'utf8')).toContain(beelineSkillReleaseStamp('rel-1'));
      // The operator's own entry stays an untouched link alongside both skills
      // (only the claude operator home seeded one for this test).
      if (dir === 'claude') {
        expect(lstatSync(resolve(skillsDir, 'greet')).isSymbolicLink()).toBe(true);
      }
    }
  });

  it('refreshes on release change and stays idempotent across repeated activations', async () => {
    const operatorHome = await scratch('mission-operator-home-');
    const roomRoot = resolve(await scratch('mission-room-'), 'agent-home');

    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'rel-a' });
    const claudeSkills = resolve(roomRoot, 'claude', 'skills');
    expect(
      readFileSync(resolve(claudeSkills, MISSION_BRIEF_SKILL_NAME, 'SKILL.md'), 'utf8'),
    ).toContain('release: rel-a -->');

    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'rel-b' });
    const refreshed = readFileSync(
      resolve(claudeSkills, MISSION_BRIEF_SKILL_NAME, 'SKILL.md'),
      'utf8',
    );
    expect(refreshed).toContain('release: rel-b -->');
    expect(refreshed).not.toContain('rel-a');

    const snapshot = (): string[] => readdirSync(claudeSkills).sort().join(',');
    const before = snapshot();
    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'rel-b' });
    expect(snapshot()).toBe(before);
    expect(
      readdirSync(claudeSkills).filter((name) => name === MISSION_BRIEF_SKILL_NAME),
    ).toHaveLength(1);
  });

  it('refuses to regenerate through a symlink occupying the mission-brief slot', async () => {
    const operatorHome = await scratch('mission-operator-home-');
    const roomRoot = resolve(await scratch('mission-room-'), 'agent-home');
    const decoy = resolve(await scratch('mission-decoy-'), 'SKILL.md');
    await writeFile(decoy, 'operator-owned bytes\n');

    const skillsDir = resolve(roomRoot, 'claude', 'skills');
    await mkdirAsync(skillsDir, { recursive: true });
    await symlink(resolve(decoy, '..'), resolve(skillsDir, MISSION_BRIEF_SKILL_NAME));

    await prepareRoomAgentHome({ root: roomRoot, operatorHome, skillReleaseId: 'x' });

    // The write was refused; the operator-side file is untouched.
    expect(readFileSync(decoy, 'utf8')).toBe('operator-owned bytes\n');
    expect(lstatSync(resolve(skillsDir, MISSION_BRIEF_SKILL_NAME)).isSymbolicLink()).toBe(true);
  });
});
