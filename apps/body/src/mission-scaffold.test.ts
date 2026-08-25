import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  applyMissionScaffoldPlan,
  objectiveMarkdown,
  orgChartMarkdown,
  planMissionScaffold,
  scaffoldMissionRepo,
  stateMarkdown,
} from './mission-scaffold.js';
import { runMissionScaffoldCommand } from './mission-scaffold-command.js';
import { MISSION_FILES } from './mission-skill.js';

const cleanup: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const FULL_INPUT = {
  missionName: 'Fund ops',
  objective: 'Run the fund demo end to end',
  principal: '@captain',
  chiefOfStaff: '@atlas',
};

describe('the three-file convention content', () => {
  it('gives each file its durable role and useful structure, never placeholders', () => {
    const files = [
      ['objective.md', objectiveMarkdown(FULL_INPUT)],
      ['state.md', stateMarkdown(FULL_INPUT)],
      ['org-chart.md', orgChartMarkdown(FULL_INPUT)],
    ] as const;
    for (const [name, text] of files) {
      // Non-placeholder structure: real headings and convention guidance.
      expect(text).toContain(
        `# ${name === 'objective.md' ? 'Mission objective' : name === 'state.md' ? 'Mission state' : 'Mission org chart'} — Fund ops`,
      );
      // No lorem/TODO-style placeholders anywhere in generated output.
      for (const banned of ['TODO', 'TBD', 'lorem', 'FIXME', 'XXX']) {
        expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
      }
      // Deterministic: no dates or timestamps baked into the bytes.
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    expect(objectiveMarkdown(FULL_INPUT)).toContain('Run the fund demo end to end');
    expect(orgChartMarkdown(FULL_INPUT)).toContain('@captain');
    expect(stateMarkdown(FULL_INPUT)).toContain('@captain');
  });

  it('marks unknown fields as bootstrap-interview work instead of inventing facts', () => {
    const text = objectiveMarkdown({});
    expect(text).toMatch(/capture during the bootstrap interview/i);
    expect(text).not.toContain('Run the fund demo');
  });
});

describe('scaffold generation into a mission repo directory', () => {
  it('creates exactly the three missing convention files', async () => {
    const dir = await scratch('mission-repo-');
    const plan = await scaffoldMissionRepo(dir, FULL_INPUT);

    expect(plan.writes.map((write) => write.path.split('/').pop()).sort()).toEqual(
      [...MISSION_FILES].sort(),
    );
    for (const name of MISSION_FILES) {
      expect(existsSync(resolve(dir, name))).toBe(true);
    }
    expect(plan.skipped).toEqual([]);
  });

  it('is deterministic: same input produces byte-identical files', async () => {
    const one = await scratch('mission-det-a-');
    const two = await scratch('mission-det-b-');
    await scaffoldMissionRepo(one, FULL_INPUT);
    await scaffoldMissionRepo(two, FULL_INPUT);
    for (const name of MISSION_FILES) {
      expect(await readFile(resolve(one, name), 'utf8')).toBe(
        await readFile(resolve(two, name), 'utf8'),
      );
    }
  });

  it('is idempotent: a second run writes nothing and changes nothing', async () => {
    const dir = await scratch('mission-idem-');
    await scaffoldMissionRepo(dir, FULL_INPUT);
    const before = new Map(
      await Promise.all(
        MISSION_FILES.map(
          async (name) => [name, await readFile(resolve(dir, name), 'utf8')] as const,
        ),
      ),
    );

    const second = await scaffoldMissionRepo(dir, FULL_INPUT);

    expect(second.writes).toEqual([]);
    expect(second.skipped.map((path) => path.split('/').pop()).sort()).toEqual(
      [...MISSION_FILES].sort(),
    );
    for (const name of MISSION_FILES) {
      expect(await readFile(resolve(dir, name), 'utf8')).toBe(before.get(name));
    }
  });

  it('never overwrites existing human mission state, even partial scaffolds', async () => {
    const dir = await scratch('mission-nooverwrite-');
    await mkdir(dir, { recursive: true });
    const existingObjective = '# Mission objective — mine\n\nHuman-authored.\n';
    await writeFile(resolve(dir, 'objective.md'), existingObjective);
    await writeFile(resolve(dir, 'notes.md'), 'unrelated file\n');

    const plan = await planMissionScaffold(dir, FULL_INPUT);
    expect(plan.skipped.some((path) => path.endsWith('objective.md'))).toBe(true);
    expect(plan.writes.some((write) => write.path.endsWith('objective.md'))).toBe(false);
    await applyMissionScaffoldPlan(plan);

    // Human state wins, unrelated files untouched, only gaps filled.
    expect(await readFile(resolve(dir, 'objective.md'), 'utf8')).toBe(existingObjective);
    expect(await readFile(resolve(dir, 'notes.md'), 'utf8')).toBe('unrelated file\n');
    expect(await readFile(resolve(dir, 'state.md'), 'utf8')).toBeTruthy();
    expect(await readFile(resolve(dir, 'org-chart.md'), 'utf8')).toBeTruthy();
  });

  it('refuses to write outside the planned mission repo directory', async () => {
    const dir = await scratch('mission-escape-');
    await expect(
      applyMissionScaffoldPlan({
        dir,
        writes: [{ path: resolve(dir, '..', 'escaped.md'), content: 'nope\n' }],
        skipped: [],
      }),
    ).rejects.toThrow(/outside the mission repo/);
    expect(existsSync(resolve(dir, '..', 'escaped.md'))).toBe(false);
  });

  it('fails with an actionable error when the target directory does not exist', async () => {
    const missing = resolve(await scratch('mission-missing-'), 'not-created');
    await expect(planMissionScaffold(missing, {})).rejects.toThrow(/not readable/);
  });
});

describe('beeline mission-scaffold command', () => {
  function capturingDeps() {
    const logs: string[] = [];
    return {
      deps: {
        cwd: process.cwd,
        log: (message: string): void => void logs.push(message),
        error: (message: string): void => void logs.push(message),
      },
      logs,
    };
  }

  it('creates the convention files and reports what it did', async () => {
    const dir = await scratch('mission-cli-');
    const { deps, logs } = capturingDeps();
    const code = await runMissionScaffoldCommand(
      [dir, '--name', 'Ops', '--objective', 'Ship'],
      deps,
    );
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('created');
    expect(await readFile(resolve(dir, 'state.md'), 'utf8')).toContain('# Mission state — Ops');
  });

  it('preserves existing files on rerun and says so', async () => {
    const dir = await scratch('mission-cli-rerun-');
    await runMissionScaffoldCommand([dir], capturingDeps().deps);
    const before = await readFile(resolve(dir, 'objective.md'), 'utf8');

    const { deps, logs } = capturingDeps();
    const code = await runMissionScaffoldCommand([dir], deps);

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('already present; nothing written');
    expect(await readFile(resolve(dir, 'objective.md'), 'utf8')).toBe(before);
  });

  it('rejects unknown options with a nonzero exit', async () => {
    const dir = await scratch('mission-cli-badopt-');
    const { deps, logs } = capturingDeps();
    const code = await runMissionScaffoldCommand([dir, '--bind', 'x'], deps);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('unknown option');
    // The generator never attempts provisioning/binding of any kind.
    expect(existsSync(resolve(dir, 'objective.md'))).toBe(false);
  });
});
