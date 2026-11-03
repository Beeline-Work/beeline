import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const runner = fileURLToPath(new URL('./nightly-host.sh', import.meta.url));
const repo = dirname(dirname(dirname(runner)));
const head = 'a'.repeat(40);
// Exercise the real selection loop without opening sockets in the test sandbox.
const netStub = `
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
const held = new Set();
net.createServer = () => {
  const server = new EventEmitter();
  let port;
  server.listen = (selected, host, callback) => {
    port = selected;
    appendFileSync(process.env.HOST_TEST + '/binds', JSON.stringify({ port, host, held: [...held] }) + '\\n');
    process.nextTick(() => {
      if (port === 18881 || held.has(port)) server.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' }));
      else { held.add(port); callback(); }
    });
  };
  server.close = (callback) => { held.delete(port); callback(); };
  return server;
};
`;
const stub = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const command = path.basename(process.argv[1]), args = process.argv.slice(2), dir = process.env.HOST_TEST;
const log = (value) => fs.appendFileSync(path.join(dir, 'commands'), JSON.stringify(value) + '\\n');
log({ command, args, cwd: process.cwd() });
if (command === 'git') {
  if (args.includes('get-url')) console.log('stub-origin');
  else if (args[0] === 'clone') {
    fs.mkdirSync(path.join(args.at(-1), '.git'), { recursive: true });
    fs.mkdirSync(path.join(args.at(-1), 'apps/mobile'), { recursive: true });
  } else if (args[0] === 'fetch') {
    fs.writeFileSync('package-lock.json', process.env.ROOT_LOCK ?? 'root-lock');
    fs.writeFileSync('apps/mobile/package-lock.json', process.env.MOBILE_LOCK ?? 'mobile-lock');
  } else if (args[0] === 'rev-parse') console.log(process.env.TEST_HEAD ?? '${head}');
} else if (command === 'npm') {
  if (process.env.INSTALL_FAIL) process.exit(8);
} else if (command === 'ss') {
  console.log('State Recv-Q Send-Q Local Address:Port Peer Address:Port');
  console.log('LISTEN 0 128 127.0.0.1:18880 0.0.0.0:*');
  if (process.env.CONSOLE_HELD) console.log('LISTEN 0 128 [::]:5556 [::]:*');
} else if (command === 'beeline') {
  fs.writeFileSync(path.join(dir, 'device'), 'emulator-5582');
  if (!process.env.NO_SERIAL_OUTPUT) console.log('emulator emulator-5582 started');
  setInterval(() => {}, 1000);
} else if (command === 'adb') {
  if (args[0] === 'devices') {
    console.log('List of devices attached');
    if (process.env.LANE_HELD) console.log('emulator-5554 offline');
    if (fs.existsSync(path.join(dir, 'device'))) console.log('emulator-5582 device');
  } else if (args.includes('kill')) fs.rmSync(path.join(dir, 'device'), { force: true });
}
`;
const nightly = `#!/usr/bin/env bash
set -euo pipefail
# A leftover fixture process must be stopped even after this wrapper fails.
sleep 120 &
echo $! >"$HOST_TEST/fixture.pid"
node --input-type=module <<'JS'
import { writeFileSync, mkdirSync } from 'node:fs';
const state = process.env.LATENCY_RIG_STATE;
writeFileSync(process.env.HOST_TEST + '/exports.json', JSON.stringify({
  device: process.env.LATENCY_RIG_DEVICE, server: Number(process.env.LATENCY_RIG_SERVER_PORT),
  proxy: Number(process.env.LATENCY_RIG_PORT), state, cwd: process.cwd()
}));
mkdirSync(state + '/night-stub', { recursive: true });
writeFileSync(state + '/night-stub/nightly.json', '{}');
console.log('Nightly result: ' + state + '/night-stub/nightly.json');
JS
exit "$NIGHTLY_EXIT"
`;

async function fixture(t) {
  // Keep all test writes inside this worktree; nothing invokes a host toolchain.
  const dir = await mkdtemp(join(repo, '.nightly-host-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), state = join(dir, 'state');
  await mkdir(bin); await mkdir(state);
  for (const name of ['git', 'npm', 'beeline', 'adb', 'ss']) await writeFile(join(bin, name), stub, { mode: 0o755 });
  const script = join(dir, 'nightly-run.sh');
  await writeFile(script, nightly);
  const preload = join(dir, 'net-stub.mjs');
  await writeFile(preload, netStub);
  const env = { ...process.env, HOST_TEST: dir, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    LATENCY_HOST_NIGHTLY_RUN: script, NIGHTLY_EXIT: '0', NODE_OPTIONS: `--import=${preload}` };
  for (const name of ['LATENCY_RIG_SERVER_PORT', 'LATENCY_RIG_PORT']) delete env[name];
  return { dir, state,
    run: (extra = {}, script = runner) => spawnSync('bash', [script, state], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 }),
    json: async (name) => JSON.parse(await readFile(join(state, name), 'utf8')),
    commands: async () => (await readFile(join(dir, 'commands'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse) };
}
function inactive(pid) {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

test('held host, verdict, capture and emulator lanes block before launching or installing', async (t) => {
  for (const lane of ['host.lock', 'nightly.lock', 'capture.lock', 'device', 'console']) {
    await t.test(lane, async (t) => {
      const f = await fixture(t);
      let holder;
      if (lane.endsWith('.lock') && lane !== 'capture.lock') await mkdir(join(f.state, lane));
      if (lane === 'capture.lock') {
        holder = spawn('flock', ['-n', join(f.state, lane), 'bash', '-c', 'echo ready; read -r line'], { stdio: ['pipe', 'pipe', 'pipe'] });
        await once(holder.stdout, 'data');
      }
      try {
        const result = f.run({ LANE_HELD: lane === 'device' ? '1' : '', CONSOLE_HELD: lane === 'console' ? '1' : '' });
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, /Blocked:/);
        assert.equal((await f.json('host-run.json')).exitCode, 2);
        assert.equal((await f.json('host-run.json')).nightlyJson, null);
        assert.ok(!(await f.commands()).some((row) => ['beeline', 'npm', 'git'].includes(row.command)));
        if (['host.lock', 'nightly.lock'].includes(lane)) assert.ok(existsSync(join(f.state, lane)));
        if (lane === 'capture.lock') {
          assert.equal(spawnSync('flock', ['-n', join(f.state, lane), 'true']).status, 1);
        }
      } finally {
        if (holder) { holder.stdin.end('\n'); await once(holder, 'exit'); }
      }
    });
  }
});

for (const code of [0, 7]) test(`nightly exit ${code}: choose/export bind-tested ports, save verdict and clean owned processes`, async (t) => {
  const f = await fixture(t);
  // ss reports 18880, while the simulated bind finds 18881 occupied too.
  const result = f.run({ NIGHTLY_EXIT: String(code), ...(code ? { LATENCY_RIG_SERVER_PORT: '18880', LATENCY_RIG_PORT: '18880' } : {}) });
  assert.equal(result.status, code, result.stderr);
  const exported = JSON.parse(await readFile(join(f.dir, 'exports.json')));
  assert.equal(exported.device, 'emulator-5582');
  assert.equal(exported.state, f.state);
  assert.equal(exported.cwd, join(f.state, 'checkout'));
  assert.equal(exported.server, 18882);
  assert.equal(exported.proxy, 18883);
  const binds = (await readFile(join(f.dir, 'binds'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(binds.map((row) => row.port), [18881, 18882, 18883]);
  assert.deepEqual(binds.at(-1).held, [18882]);
  assert.ok(binds.every((row) => row.host === '127.0.0.1'));
  const record = await f.json('host-run.json');
  assert.equal(record.head, head);
  assert.equal(record.exitCode, code);
  assert.ok(Number.isFinite(Date.parse(record.startedAt)));
  assert.equal(record.nightlyJson, join(f.state, 'night-stub/nightly.json'));
  assert.equal(record.error, code ? `nightly-run.sh failed (exit ${code})` : null);
  assert.equal((await readFile(join(f.state, 'host-nightly.exit'), 'utf8')).trim(), String(code));
  assert.match(await readFile(join(f.state, 'host-nightly.pid'), 'utf8'), /^\d+\n$/);
  assert.ok(!existsSync(join(f.dir, 'device')));
  assert.ok(!existsSync(join(f.state, 'host.lock')));
  assert.ok(inactive((await readFile(join(f.dir, 'fixture.pid'), 'utf8')).trim()));
  const commands = await f.commands();
  assert.deepEqual(commands.find((row) => row.command === 'beeline').args,
    ['emulator', '-avd', 'se_api35', '-no-window', '-gpu', 'swiftshader_indirect', '-no-snapshot', '-memory', '2560', '-cores', '4']);
  assert.ok(commands.some((row) => row.command === 'adb' && row.args.join(' ') === '-s emulator-5582 emu kill'));
  assert.ok(commands.some((row) => row.command === 'git' && row.args.join(' ') === 'fetch origin main'));
  assert.ok(commands.some((row) => row.command === 'git' && row.args.join(' ') === 'checkout --detach FETCH_HEAD'));
});

test('a delayed background launcher cannot race the first log read', async (t) => {
  const f = await fixture(t);
  // Delay scheduling of the whole background command, including its shell
  // redirection. Delaying the beeline stub itself would already open the log.
  const delayedDir = join(f.dir, 'scripts/latency-rig');
  await mkdir(delayedDir, { recursive: true });
  const delayedRunner = join(delayedDir, 'nightly-host.sh');
  const source = readFileSync(runner, 'utf8');
  const delayed = source.replace('setsid beeline emulator', '( sleep 0.2; exec setsid beeline emulator')
    .replace('2>&1 9>&- &', '2>&1 9>&- ) &');
  assert.notEqual(delayed, source);
  await writeFile(delayedRunner, delayed);
  const result = f.run({}, delayedRunner);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'exports.json'))).device, 'emulator-5582');
  assert.ok(!existsSync(join(f.dir, 'device')));
});

test('one-shot CLI without a serial uses the adb before/after diff', async (t) => {
  const f = await fixture(t);
  const result = f.run({ NO_SERIAL_OUTPUT: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'exports.json'))).device, 'emulator-5582');
  assert.ok(!existsSync(join(f.dir, 'device')));
});

test('install once per changed lock hash, irrespective of head; failed installs remain retryable', async (t) => {
  const f = await fixture(t);
  const installs = async () => (await f.commands()).filter((row) => row.command === 'npm');
  const initialRun = f.run();
  assert.equal(initialRun.status, 0, initialRun.stderr);
  const initial = await readFile(join(f.state, 'dependencies-head'), 'utf8');
  assert.equal((await installs()).length, 2);
  assert.equal(f.run({ TEST_HEAD: 'b'.repeat(40) }).status, 0);
  assert.equal((await installs()).length, 2);
  assert.equal((await f.json('host-run.json')).head, 'b'.repeat(40));
  assert.equal(f.run({ MOBILE_LOCK: 'new-mobile-lock', INSTALL_FAIL: '1' }).status, 8);
  assert.equal(await readFile(join(f.state, 'dependencies-head'), 'utf8'), initial);
  assert.match((await f.json('host-run.json')).error, /dependency installation failed/);
  assert.equal(f.run({ MOBILE_LOCK: 'new-mobile-lock' }).status, 0);
  assert.notEqual(await readFile(join(f.state, 'dependencies-head'), 'utf8'), initial);
  assert.equal((await installs()).length, 5);
  assert.equal(f.run({ MOBILE_LOCK: 'new-mobile-lock', ROOT_LOCK: 'new-root-lock' }).status, 0);
  assert.equal((await installs()).length, 7);
  assert.deepEqual((await installs()).slice(0, 2).map((row) => row.cwd), [join(f.state, 'checkout'), join(f.state, 'checkout/apps/mobile')]);
});

test('systemd units remain opt-in with Eastern schedule, no catch-up and a 31 GiB service limit', async () => {
  const service = await readFile(new URL('./systemd/beeline-latency-rig.service', import.meta.url), 'utf8');
  const timer = await readFile(new URL('./systemd/beeline-latency-rig.timer', import.meta.url), 'utf8');
  assert.match(service, /^EnvironmentFile=%h\/\.config\/beeline-latency-rig.env$/m);
  assert.match(service, /^MemoryMax=31G$/m);
  assert.match(service, /^KillMode=control-group$/m);
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:00:00 America\/New_York$/m);
  assert.match(timer, /^Persistent=false$/m);
});
