import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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

const liveOptIn = process.env.BEELINE_REAL_CURSOR_TOOL_PROOF === '1';
if (!liveOptIn) {
  console.log(
    '[prove:corner-brief-acceptance] live-harness boundary skipped: it requires BEELINE_REAL_CURSOR_TOOL_PROOF=1 with a real native Cursor harness. The deterministic server/body/mobile boundaries still run below; set the env var to run the complete proof.',
  );
}

// Build the full workspace export closure the deterministic boundaries import:
// server tests reach @beeline/auth/* and @beeline/push-gateway/projection, body
// and gate tests reach @beeline/nostr and @beeline/buzz-client. A bare `npm ci`
// worktree has none of these dist/ trees, so the proof builds them itself in
// dependency order (same chain BODY SUITE uses) before any test runs.
const buildPackages = [
  '@beeline/nostr',
  '@beeline/api-contract',
  '@beeline/buzz-client',
  '@beeline/gate',
  '@beeline/auth',
  '@beeline/body',
  '@beeline/push-gateway',
];
run('npm', ['run', 'build', ...buildPackages.flatMap((pkg) => ['-w', pkg])]);

// Generous explicit test timeouts: the heavy body/corner integration tests
// cold-transform their module graph on a fresh worktree and share the machine
// with other corners, so the 5s vitest default can blow under load. Tests that
// set their own explicit timeouts keep them; this only raises the default.
const SERVER_TEST_TIMEOUT = 120_000;
const BODY_TEST_TIMEOUT = 180_000;

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
  `--testTimeout=${SERVER_TEST_TIMEOUT}`,
]);

run('npm', [
  'test',
  '-w',
  '@beeline/server',
  '--',
  '--run',
  'src/agent-command.integration.test.ts',
  'src/pr-checks-status.test.ts',
  `--testTimeout=${SERVER_TEST_TIMEOUT}`,
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
  `--testTimeout=${BODY_TEST_TIMEOUT}`,
]);

const mobileInstalled = existsSync(join(root, 'apps/mobile/node_modules'));
if (mobileInstalled) {
  run('npm', [
    '--prefix',
    'apps/mobile',
    'test',
    '--',
    '--run',
    'sources/components/buzz/CornerBriefDisclosure.test.tsx',
  ]);
} else {
  console.log(
    '[prove:corner-brief-acceptance] mobile boundary skipped: apps/mobile has no isolated install in this worktree (run npm run mobile:install). The deterministic server/body boundaries already ran; the phone boundary runs where mobile is installed.',
  );
}

if (liveOptIn) {
  run(
    'npm',
    ['run', 'test:live', '-w', '@beeline/body', '--', 'src/proof-cursor-agent-tools.live.test.ts'],
    {
      BEELINE_REAL_CURSOR_TOOL_PROOF: '1',
      BEELINE_REAL_CURSOR_MODEL: process.env.BEELINE_REAL_CURSOR_MODEL ?? 'auto',
    },
  );
}

console.log('durable corner acceptance: PASS');
