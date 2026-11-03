// Temporary reproduction of the exact ordinary-file assignment from failing
// SERVER SUITE SHARD 4 runs 41610537977 and 41617778491. Current timing data
// splits this sequence across shards, so their normal reruns cannot replay it.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const files = [
  "src/database.test.ts",
  "src/free-agent-model-proxy.test.ts",
  "src/push-outbox.test.ts",
  "src/workflow-runs.handoffs.test.ts",
  "src/corner-owed.test.ts",
  "src/computer-session.test.ts",
  "src/auth.test.ts",
  "src/institutional-memory-shadow.test.ts",
  "src/agent-lifecycle-command.test.ts",
  "src/archived-corner-memberships.test.ts",
  "src/phone-service.message-search.test.ts",
  "src/daemon-live.test.ts",
  "src/solo-agent-routing.test.ts",
  "src/prompt-replay.test.ts",
  "src/phone-service.model-change-wake.test.ts",
  "src/workflow-admin.test.ts",
  "src/institutional-corner-authority.test.ts",
  "src/corner-open-implementer.test.ts",
  "src/corner-refusals.test.ts",
  "src/voice-tempo.test.ts",
  "src/voice-budget.test.ts",
  "src/agent-grant-inspect.test.ts",
  "src/github-webhook-order.test.ts",
  "src/voice-providers.test.ts",
  "src/object-storage.test.ts",
  "src/workbench-companies.test.ts",
  "src/apns-push.test.ts",
  "src/migration-retry.test.ts",
  "src/corner-brief-sentry.test.ts",
  "src/voice-speedy-eager.test.ts",
  "src/chat-corner-counts.test.ts",
  "src/tray-approval-ask.test.ts",
  "src/wallet.live.test.ts"
];
console.log('Replaying original timer-failure shard:', JSON.stringify(files));
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url)),
  'run', ...files, '--maxWorkers=2', '--minWorkers=1',
  '--poolOptions.forks.singleFork', '--isolate',
], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
  env: { ...process.env, SERVER_TIMER_DIAGNOSTICS: '1' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
