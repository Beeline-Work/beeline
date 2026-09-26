import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.env.BEELINE_REAL_CURSOR_TOOL_PROOF !== '1') {
  throw new Error(
    'BEELINE_REAL_CURSOR_TOOL_PROOF=1 is required: this acceptance proof must exercise a real native Cursor harness.',
  );
}

run('npm', ['run', 'build', '-w', '@beeline/api-contract']);
run('npm', ['run', 'build', '-w', '@beeline/auth']);

run('npm', [
  'test',
  '-w',
  '@beeline/server',
  '--',
  '--run',
  'src/integration.test.ts',
  '--reporter=dot',
  '-t',
  'commits a full brief|automatically binds a planning artifact|refuses new repository and research|rejects paraphrased human intent|wakes the configured reviewer with a revised brief',
]);

run('npm', [
  'test',
  '-w',
  '@beeline/server',
  '--',
  '--run',
  'src/agent-command.integration.test.ts',
  'src/pr-checks-status.test.ts',
]);

run('npm', [
  'test',
  '-w',
  '@beeline/body',
  '--',
  '--run',
  'src/beeline-skill.test.ts',
  'src/read-only-mcp.test.ts',
  'src/room-session.test.ts',
  'src/agent-home.test.ts',
  'src/monolith-corner-turn.test.ts',
  'src/corner-no-code-lane.test.ts',
  'src/no-code-lane.integration.test.ts',
]);

run('npm', [
  '--prefix',
  'apps/mobile',
  'test',
  '--',
  '--run',
  'sources/components/buzz/CornerBriefDisclosure.test.tsx',
]);

run(
  'npm',
  ['run', 'test:live', '-w', '@beeline/body', '--', 'src/proof-cursor-agent-tools.live.test.ts'],
  {
    BEELINE_REAL_CURSOR_TOOL_PROOF: '1',
    BEELINE_REAL_CURSOR_MODEL: process.env.BEELINE_REAL_CURSOR_MODEL ?? 'auto',
  },
);

console.log('durable corner acceptance: PASS');
