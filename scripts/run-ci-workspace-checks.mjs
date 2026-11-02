import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspaceChecks = {
  typecheck: 'RUN_TYPECHECK',
  'mobile-suite': 'RUN_MOBILE',
  'dead-code': 'RUN_DEAD_CODE',
  'native-fingerprint': 'RUN_NATIVE_FINGERPRINT',
  'mobile-export-reachability': 'RUN_MOBILE_EXPORT',
};

// Mobile has two isolated workers in its lane; all other checks run
// sequentially in another with at most one. The listener caps the job at
// three CPUs, and the parent still shares ten CPUs across the whole pool.
export async function runWorkspaceChecks(enabled, execute) {
  const results = Object.fromEntries(Object.keys(workspaceChecks).map(name => [name, 'skipped']));
  async function run(name) {
    if (!enabled[name]) return;
    try {
      results[name] = await execute(name) === 0 ? 'success' : 'failure';
    } catch {
      results[name] = 'failure';
    }
  }
  const mobile = run('mobile-suite');
  for (const name of Object.keys(workspaceChecks).filter(name => name !== 'mobile-suite')) await run(name);
  await mobile;
  return results;
}

async function main() {
  const enabled = Object.fromEntries(Object.entries(workspaceChecks).map(([name, flag]) => {
    const value = process.env[flag] || 'false';
    assert.ok(['true', 'false'].includes(value), `${flag} must be true or false`);
    return [name, value === 'true'];
  }));
  if (['pull_request', 'merge_group'].includes(process.env.GITHUB_EVENT_NAME)) {
    assert.equal(enabled.typecheck, true, 'TYPECHECK must execute on every PR and merge group');
  }
  const children = new Set();
  const timings = [];
  let cancelled = false;
  function cancel(signal) {
    cancelled = true;
    for (const child of children) {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  const onInterrupt = () => cancel('SIGINT');
  const onTerminate = () => cancel('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const results = await runWorkspaceChecks(enabled, name => {
    if (cancelled) return 130;
    console.log(`Starting workspace check: ${name}`);
    const startedAt = new Date().toISOString();
    return new Promise(resolveResult => {
      const minutes = { typecheck: 30, 'mobile-suite': 20, 'dead-code': 15,
        'native-fingerprint': 15, 'mobile-export-reachability': 30 };
      const child = spawn('timeout', [`${minutes[name]}m`, 'bash', '--noprofile', '--norc', '-e', '-o', 'pipefail',
        fileURLToPath(new URL('./ci-workspace-tasks.sh', import.meta.url)), name], {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: { ...process.env, CI_TEST_WORKERS: '1' },
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      children.add(child);
      child.once('error', error => { console.error(`${name}: ${error.message}`); });
      child.once('close', (code, signal) => {
        children.delete(child);
        timings.push({ name, startedAt, completedAt: new Date().toISOString(), code, signal });
        console.log(`Workspace check ${name}: ${code ?? signal}`);
        resolveResult(code ?? 1);
      });
    });
  });
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
  assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required to publish verdicts');
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(results).map(([name, result]) => `${name}=${result}\n`).join(''));
  if (process.env.RUNNER_TEMP) writeFileSync(resolve(process.env.RUNNER_TEMP, 'workspace-check-timings.json'), JSON.stringify(timings, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '| Workspace check | Result | Wall seconds |\n| --- | --- | ---: |\n' + timings.map(row =>
      `| ${row.name} | ${results[row.name]} | ${((Date.parse(row.completedAt) - Date.parse(row.startedAt)) / 1000).toFixed(1)} |\n`).join(''));
  console.log(JSON.stringify(results));
  // The other required contexts take their individual verdicts from outputs.
  process.exitCode = cancelled ? 130 : results.typecheck === 'failure' ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
