import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

// The seven demonstration scenarios, each named with the real-database test that
// exercises it end to end. Every one of these tests builds its own disposable
// Workspace, so the demonstration never touches a real one.
const SCENARIOS = [
  {
    scenario: 'a person corrects agent A once, and agent B obeys on that person’s next task',
    file: 'src/institutional-memory-shadow.test.ts',
    name: 'compounds a correction across agents for its requester while shared facts reach everyone',
  },
  {
    scenario: 'another person’s agent is unaffected by that preference',
    file: 'src/institutional-memory-shadow.test.ts',
    name: 'compounds a correction across agents for its requester while shared facts reach everyone',
  },
  {
    scenario: 'a shared fact reaches everyone’s agents',
    file: 'src/institutional-memory-shadow.test.ts',
    name: 'compounds a correction across agents for its requester while shared facts reach everyone',
  },
  {
    scenario: 'authorized history search returns audience-correct results',
    file: 'src/institutional-history.test.ts',
    name: 'intersects the source with the requester, agent, and complete output audience',
  },
  {
    scenario: 'a completed corner’s review produces a restricted procedure another agent can load',
    file: 'src/institutional-skills.test.ts',
    name: 'synthesizes, indexes, authorizes, loads, and measures one procedure',
  },
  {
    scenario: 'the curator ages, consolidates and retains memory over one simulated cycle',
    file: 'src/institutional-curator.test.ts',
    name: 'ages, retains, partitions, consolidates, and records one simulated cycle',
  },
  {
    scenario: 'a DM preference never becomes a shared Workspace fact',
    file: 'src/institutional-memory-shadow.test.ts',
    name: 'keeps DM facts out of shared memory but accepts the requester profile exception',
  },
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * A vitest `-t` pattern that matches nothing still exits 0, so an exit code is
 * not proof. The verdict has to come from the run's own report: every expected
 * test must be present AND passed.
 */
export function passedTestNames(report) {
  const passed = new Set();
  for (const file of report.testResults ?? [])
    for (const assertion of file.assertionResults ?? [])
      if (assertion.status === 'passed') passed.add(assertion.title);
  return passed;
}

export function unproved(expectedNames, report) {
  const passed = passedTestNames(report);
  return expectedNames.filter((name) => !passed.has(name));
}

run('npx', ['turbo', 'run', 'build', '--filter=@beeline/server...']);

const reportDir = mkdtempSync(join(tmpdir(), 'prove-institutional-memory-'));
try {
  for (const file of [...new Set(SCENARIOS.map((entry) => entry.file))]) {
    const names = [
      ...new Set(SCENARIOS.filter((entry) => entry.file === file).map((entry) => entry.name)),
    ];
    const reportFile = join(reportDir, `${file.replace(/[^a-z0-9]+/gi, '-')}.json`);
    run('npm', [
      'test',
      '-w',
      '@beeline/server',
      '--',
      '--run',
      file,
      '--reporter=json',
      `--outputFile=${reportFile}`,
      '-t',
      names.join('|'),
    ]);
    const missing = unproved(names, JSON.parse(readFileSync(reportFile, 'utf8')));
    if (missing.length) {
      console.error(`\n${file} proved nothing for:`);
      for (const name of missing) console.error(`  ${name}`);
      console.error('\nThe scenario test was renamed, removed, skipped or failed.');
      process.exit(1);
    }
  }
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}

console.log('\ninstitutional memory demonstration');
for (const entry of SCENARIOS) console.log(`  proved: ${entry.scenario}`);
