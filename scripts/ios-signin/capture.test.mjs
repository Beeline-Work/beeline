import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

test('Reproduction IOS-RUNNER-HOME: the dispatch workflow uses the service account home for tools', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/ios-signin-capture.yml', import.meta.url), 'utf8'));
  assert.ok(workflow.on.workflow_dispatch);
  const step = workflow.jobs.capture.steps.find(step => step.name === "Use the runner account's home for user tools");
  assert.ok(step);
  const root = mkdtempSync(resolve(tmpdir(), 'ios-runner-home-'));
  try {
    mkdirSync(resolve(root, 'bin'));
    const runnerHome = resolve(root, 'runner home');
    mkdirSync(runnerHome);
    writeFileSync(resolve(root, 'bin/ruby'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(runnerHome)});`, { mode: 0o755 });
    const environment = resolve(root, 'environment');
    const result = spawnSync('bash', ['-euc', step.run], { encoding: 'utf8',
      env: { ...process.env, PATH: resolve(root, 'bin') + delimiter + process.env.PATH, GITHUB_ENV: environment } });
    assert.equal(result.status, 0, result.stderr);
    const configured = readFileSync(environment, 'utf8');
    for (const entry of [`CP_HOME_DIR=${runnerHome}/.cocoapods`, `MAESTRO_CLI_HOME=${runnerHome}/.maestro`,
      `JAVA_TOOL_OPTIONS=-Duser.home="${runnerHome}"`, `npm_config_cache=${runnerHome}/.npm`]) assert.ok(configured.includes(entry), entry);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
