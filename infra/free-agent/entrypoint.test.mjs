import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import './reconcile-broker-marker.test.mjs';

for (const managerRunning of [true, false])
  test(`hosted recovery restores the broker with machine HOME (manager running: ${managerRunning})`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-hosted-recovery-'));
    try {
      const state = resolve(root, 'manager-ready');
      const log = resolve(root, 'calls');
      const bin = resolve(root, 'bin');
      await mkdir(bin);
      if (managerRunning) await writeFile(state, '');
      await writeFile(resolve(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(resolve(bin, 'systemctl'), `#!/bin/sh
echo "$HOME|$XDG_CONFIG_HOME|$XDG_RUNTIME_DIR|$*" >> '${log}'
if [ "$2" = show-environment ]; then test -f '${state}'; fi
`, { mode: 0o755 });
      const manager = resolve(bin, 'manager');
      await writeFile(manager, `#!/bin/sh
echo "manager:$HOME:$XDG_CONFIG_HOME:$DBUS_SESSION_BUS_ADDRESS" >> '${log}'
touch '${state}'
`, { mode: 0o755 });
      const source = await readFile(new URL('./hosted-services.sh', import.meta.url), 'utf8');
      const script = resolve(root, 'services.sh');
      await writeFile(script, source.replaceAll('/lib/systemd/systemd', manager)
        .replaceAll('/run/user/0', resolve(root, 'run'))
        .replaceAll('/run/systemd/system', resolve(root, 'system')));
      const child = spawn('/bin/sh', [script], { env: { ...process.env,
        PATH: `${bin}:${process.env.PATH}`, HOME: resolve(root, 'agent-home'),
        XDG_CONFIG_HOME: resolve(root, 'agent-config'), XDG_RUNTIME_DIR: '/wrong-runtime' } });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
      const calls = await readFile(log, 'utf8');
      assert.match(calls, /\/root\|\/root\/\.config\|.*\|--user start trusty-squire-broker.service/);
      assert.equal(calls.includes('agent-home'), false);
      assert.equal(calls.includes('agent-config'), false);
      assert.equal(calls.includes('manager:/root:/root/.config:'), !managerRunning);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('a failed hosted service manager stops boot before the helper or installer runs', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-hosted-services-'));
  try {
    await mkdir(resolve(root, '.local/bin'), { recursive: true });
    await writeFile(resolve(root, '.local/bin/beeline'), '#!/bin/sh\necho unexpected-helper\n', { mode: 0o755 });
    const service = resolve(root, 'services.sh');
    const installer = resolve(root, 'install.sh');
    await writeFile(service, '#!/bin/sh\necho manager-unavailable >&2\nexit 78\n');
    await writeFile(installer, '#!/bin/sh\necho unexpected-installer\n');
    const source = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
    const script = resolve(root, 'entrypoint.sh');
    await writeFile(script, source.replaceAll('/opt/beeline/hosted-services.sh', service)
      .replaceAll('/opt/beeline/install.sh', installer));
    const child = spawn('/bin/sh', [script], { env: { ...process.env, HOME: root, BEELINE_HOSTED_SERVICES: '1' } });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 78);
    assert.equal(output, '');
    assert.match(errors, /manager-unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const outdated of [false, true, 'offline'])
  test(`cold boot reconciles installed helper (${outdated})`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-entrypoint-'));
    let child;
    try {
      await mkdir(resolve(root, '.local/bin'), { recursive: true });
      const launcher = resolve(root, '.local/bin/beeline');
      const waitingHelper = '#!/bin/sh\necho ready\nexec sleep 60\n';
      await writeFile(
        launcher,
        outdated === true ? '#!/bin/sh\necho required-newer-helper\nexit 1\n' : waitingHelper,
        { mode: 0o755 },
      );
      const replacement = resolve(root, 'replacement');
      await writeFile(replacement, waitingHelper, { mode: 0o755 });
      const installer = resolve(root, 'install.sh');
      await writeFile(
        installer,
        outdated === 'offline' ? '#!/bin/sh\necho download\nexit 1\n' : '#!/bin/sh\necho download\ncp "$HOME/replacement" "$HOME/.local/bin/beeline"\n',
      );
      const source = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
      const script = resolve(root, 'entrypoint.sh');
      await writeFile(script, source.replaceAll('/opt/beeline/install.sh', installer));
      child = spawn('/bin/sh', [script], {
        env: { ...process.env, HOME: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error('helper did not start')), 10_000);
        child.on('error', reject);
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.includes('ready')) {
            clearTimeout(timer);
            accept();
          }
        });
      });
      assert.ok(output.indexOf('download') < output.indexOf('ready'));
      assert.equal(output.includes('required-newer-helper'), false);
    } finally {
      if (child) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await rm(root, { recursive: true, force: true });
    }
  });

test('startup watchdog exit stops this boot without refreshing or retrying', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-entrypoint-deadline-'));
  try {
    await mkdir(resolve(root, '.local/bin'), { recursive: true });
    await writeFile(resolve(root, '.local/bin/beeline'), '#!/bin/sh\necho attempted\nexit 78\n', { mode: 0o755 });
    const installer = resolve(root, 'install.sh');
    await writeFile(installer, '#!/bin/sh\necho refresh\n');
    const source = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
    const script = resolve(root, 'entrypoint.sh');
    await writeFile(script, source.replaceAll('/opt/beeline/install.sh', installer));
    const child = spawn('/bin/sh', [script], { env: { ...process.env, HOME: root } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 78);
    assert.equal(output, 'refresh\nattempted\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ['old helper', 'installer', 'repeated exits', 'serving']) {
  test(`boot deadline handles ${scenario}`, { timeout: scenario === 'serving' ? 18_000 : 8_000 }, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-entrypoint-budget-'));
    let child;
    try {
      await mkdir(resolve(root, '.local/bin'), { recursive: true });
      await writeFile(resolve(root, '.local/bin/beeline'), scenario === 'repeated exits'
        ? '#!/bin/sh\nexit 1\n'
        : `#!/bin/sh\n${scenario === 'serving' ? 'touch "$BEELINE_FREE_AGENT_READY_FILE"\n' : ''}exec sleep 60\n`, { mode: 0o755 });
      const installer = resolve(root, 'install.sh');
      await writeFile(installer, scenario === 'installer' ? '#!/bin/sh\nexec sleep 60\n' : '#!/bin/sh\nexit 1\n');
      const source = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
      const script = resolve(root, 'entrypoint.sh');
      await writeFile(script, source.replaceAll('/opt/beeline/install.sh', installer)
        // Serving must establish readiness before the wall-clock deadline. A
        // one-second budget can expire during process startup on a busy runner.
        // Keep failure cases short, but observe serving beyond its full budget.
        .replace('+ 300', scenario === 'serving' ? '+ 10' : '+ 1')
        .replace('START_DEADLINE + 10', 'START_DEADLINE + 1'));
      child = spawn('/bin/sh', [script], { env: { ...process.env, HOME: root } });
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      if (scenario === 'serving') {
        await new Promise(done => setTimeout(done, 12_000));
        assert.equal(child.exitCode, null);
      } else {
        const [code] = await once(child, 'exit');
        assert.equal(code, 78);
        assert.equal((errors.match(/stopping this boot/g) ?? []).length, 1);
      }
    } finally {
      if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
      await rm(root, { recursive: true, force: true });
    }
  });
}
