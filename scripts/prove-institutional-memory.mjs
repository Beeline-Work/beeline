import { spawnSync } from 'node:child_process';

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

run('npx', ['turbo', 'run', 'build', '--filter=@beeline/server...']);

for (const file of [...new Set(SCENARIOS.map((entry) => entry.file))]) {
  const names = [
    ...new Set(SCENARIOS.filter((entry) => entry.file === file).map((entry) => entry.name)),
  ];
  run('npm', [
    'test',
    '-w',
    '@beeline/server',
    '--',
    '--run',
    file,
    '--reporter=dot',
    '-t',
    names.join('|'),
  ]);
}

console.log('\ninstitutional memory demonstration');
for (const entry of SCENARIOS) console.log(`  proved: ${entry.scenario}`);
