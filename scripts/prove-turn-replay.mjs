// Build workspaces first. Run the same complete user paths through built services
// and turn loops, with an isolated PGlite database and scripted harness responses.
import { spawnSync } from 'node:child_process';
const result = spawnSync('npm', ['exec', '-w', '@beeline/server', '--', 'vitest', 'run', 'src/turn-replay.integration.test.ts'], {
  stdio: 'inherit', env: { ...process.env, BEELINE_REPLAY_BUILT_PROOF: '1' },
});
process.exit(result.status ?? 1);
