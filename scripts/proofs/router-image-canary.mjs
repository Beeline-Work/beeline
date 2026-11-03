// Execute the checked-in promotion shell unchanged. Its two external commands
// are closed local adapters; no Fly API or production HTTP request is possible.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { evaluateServerCanaryPromotion, SERVER_CANARY_WINDOW_SECONDS } from '../unified-release.mjs';

const execute = promisify(execFile);
export async function proveImageCanaryAutoRevert({ plan, historical, candidate, machineNames,
  socketDirectory, token, room, docker, start, stop }) {
  await mkdir('.beeline-proof', { recursive: true });
  const directory = await mkdtemp(path.resolve('.beeline-proof/canary-shell-'));
  const socketPath = path.join(socketDirectory, `c-${randomUUID().slice(0, 8)}`);
  assert.ok(Buffer.byteLength(socketPath) < 104, 'Use the task-owned short PostgreSQL socket directory');
  const images = new Map([[plan.previousImageRef, historical], [plan.newImageRef, candidate]]);
  const running = new Map([['a', plan.previousImageRef], ['b', plan.previousImageRef]]);
  const updates = [], requests = [], errors = [];
  const connections = new Set();
  const runDockerFetch = async (name, pathname, headers) => JSON.parse(await docker('exec', name,
    'node', '--input-type=module', '-e', `
      const [path,headers]=JSON.parse(process.argv[1]);
      const response=await fetch('http://127.0.0.1:8080'+path,{headers,signal:AbortSignal.timeout(10000)});
      console.log(JSON.stringify({status:response.status,body:await response.text()}));`, JSON.stringify([pathname, headers])));
  async function dispatch({ tool, args }) {
    assert.ok(Array.isArray(args) && args.every(arg => typeof arg === 'string'));
    if (tool === 'flyctl') {
      assert.deepEqual(args.slice(0, 1), ['machine']);
      if (args[1] === 'list') {
        assert.deepEqual(args, ['machine', 'list', '--app', 'beeline-server', '--json']);
        return { code: 0, stdout: JSON.stringify([...running].map(([id, image]) => ({ id, config: { image } }))) };
      }
      assert.equal(args[1], 'update');
      const machine = args[2], imageRef = args[args.indexOf('--image') + 1];
      assert.ok(Object.hasOwn(machineNames, machine));
      assert.ok(images.has(imageRef));
      // Admit only the arguments used by the checked-in promotion step.
      const tail = args.slice(3);
      assert.equal(tail.shift(), '--app'); assert.equal(tail.shift(), 'beeline-server');
      assert.equal(tail.shift(), '--image'); assert.equal(tail.shift(), imageRef);
      if (tail[0] === '--metadata') {
        tail.shift(); assert.match(tail.shift(), /^beeline_replaced_image=registry\.fly\.io\/beeline-server:/);
      }
      assert.deepEqual(tail, ['--wait-timeout', '300', '--yes']);
      await stop(machineNames[machine]);
      await start(machineNames[machine], images.get(imageRef));
      running.set(machine, imageRef); updates.push({ machine, imageRef });
      return { code: 0, stdout: `Updated local fixture ${machine}\n` };
    }
    assert.equal(tool, 'curl');
    let output, statusFormat = false, failHttp = false, target;
    const headers = {};
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '-sS') continue;
      if (arg === '-fsS') { failHttp = true; continue; }
      if (arg === '--max-time') { assert.ok(Number(args[++index]) > 0 && Number(args[index]) <= 12); continue; }
      if (arg === '-o') { output = path.resolve(args[++index]); continue; }
      if (arg === '-w') { assert.equal(args[++index], '%{http_code}'); statusFormat = true; continue; }
      if (arg === '-H') {
        const header = args[++index], colon = header.indexOf(':');
        assert.ok(colon > 0); const key = header.slice(0, colon).toLowerCase();
        assert.ok(['fly-force-instance-id', 'authorization'].includes(key));
        headers[key] = header.slice(colon + 1).trim(); continue;
      }
      assert.equal(target, undefined); target = new URL(arg);
    }
    assert.equal(target?.origin, 'https://server.usebeeline.app');
    assert.equal(target.search, '');
    assert.ok(['/health', '/readyz', '/version', `/v1/phone/rooms/${room}`].includes(target.pathname));
    assert.ok(output?.startsWith(`${directory}${path.sep}`));
    const machine = headers['fly-force-instance-id'];
    assert.ok(Object.hasOwn(machineNames, machine));
    delete headers['fly-force-instance-id'];
    const isRoom = target.pathname.startsWith('/v1/phone/rooms/');
    if (isRoom) assert.equal(headers.authorization, `Bearer ${token}`);
    const actual = await runDockerFetch(machineNames[machine], target.pathname, headers);
    assert.equal(actual.status, 200, `Actual local ${target.pathname} must work before injected failure`);
    // Exercise the unchanged watcher and ERR trap with a transport-side outage.
    // The real authenticated Room read above remains part of every sample.
    const observed = isRoom ? { status: 503, body: '{"error":"synthetic_canary_transport_failure"}' } : actual;
    requests.push({ machine, path: target.pathname, actualStatus: actual.status, observedStatus: observed.status });
    await writeFile(output, observed.body);
    return { code: failHttp && observed.status >= 400 ? 22 : 0,
      stdout: statusFormat ? String(observed.status) : '' };
  }
  const bridge = net.createServer(socket => {
    connections.add(socket); socket.once('close', () => connections.delete(socket));
    let input = '', dispatched = false;
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 64 * 1024) { socket.destroy(); return; }
      if (dispatched || !input.includes('\n')) return;
      dispatched = true;
      void dispatch(JSON.parse(input.trim())).then(result => socket.end(JSON.stringify(result)), error => {
        errors.push(error.message); socket.end(JSON.stringify({ code: 1, stderr: error.stack }));
      });
    });
  });
  try {
    await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(socketPath, resolve); });
    const bin = path.join(directory, 'bin'); await mkdir(bin);
    const shim = `#!/usr/bin/env node
const net=require('node:net'),path=require('node:path');
const socket=net.createConnection(process.env.BEELINE_CANARY_PROOF_SOCKET);let result='';
socket.setTimeout(120000,()=>{socket.destroy();process.exit(1)});
socket.on('connect',()=>socket.write(JSON.stringify({tool:path.basename(process.argv[1]),args:process.argv.slice(2)})+'\\n'));
socket.on('data',chunk=>result+=chunk);
socket.on('end',()=>{const value=JSON.parse(result);if(value.stdout)process.stdout.write(value.stdout);if(value.stderr)process.stderr.write(value.stderr);process.exit(value.code)});
socket.on('error',error=>{console.error(error.message);process.exit(1)});
`;
    for (const tool of ['flyctl', 'curl']) await writeFile(path.join(bin, tool), shim, { mode: 0o755 });
    const actionText = await readFile('.github/actions/server-leg/action.yml', 'utf8');
    const action = parse(actionText);
    const step = action.runs.steps.find(item => typeof item.run === 'string' && item.run.includes('server-canary-promotion'));
    assert.ok(step); assert.ok(!step.run.includes('${{'), 'Only the self-contained shell step may run');
    await mkdir(path.join(directory, 'server-release'));
    await writeFile(path.join(directory, 'server-release/server-deploy-plan.json'), JSON.stringify(plan));
    const shell = path.join(directory, 'promotion.sh'); await writeFile(shell, step.run);
    console.error('[image-proof] execute actual seven-sample canary shell; inject Room transport failure');
    let result;
    try {
      await execute('bash', [shell], { timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
        env: { PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: '--max-old-space-size=4096',
          RUNNER_TEMP: directory, RELEASE_SHA: candidate.sourceSha, RELEASE_VERSION: candidate.version,
          SERVER_CANARY_ROOM_ID: room, SERVER_CANARY_PHONE_TOKEN: token, SERVER_CANARY_REVIEW_SECRET: '',
          BEELINE_CANARY_PROOF_SOCKET: socketPath } });
      assert.fail('The injected failed canary must fail the release');
    } catch (error) { result = error; }
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(errors, []);
    assert.match(result.stdout, /Rollback confirmed: every Machine runs its previous image/);
    assert.deepEqual(updates, [
      { machine: 'a', imageRef: plan.newImageRef }, { machine: 'a', imageRef: plan.previousImageRef },
    ]);
    assert.deepEqual([...running], [['a', plan.previousImageRef], ['b', plan.previousImageRef]]);
    const samples = (await readFile(path.join(directory, 'server-release/canary-samples.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(samples.length, 7);
    const elapsedSeconds = (Date.parse(samples.at(-1).at) - Date.parse(samples[0].at)) / 1000;
    assert.ok(elapsedSeconds >= SERVER_CANARY_WINDOW_SECONDS);
    const verdict = evaluateServerCanaryPromotion(samples); assert.equal(verdict.clean, false);
    assert.equal(requests.filter(request => request.path.startsWith('/v1/phone/rooms/')).length, 7);
    return { status: 'PASS', actionSha256: createHash('sha256').update(actionText).digest('hex'),
      shellSha256: createHash('sha256').update(step.run).digest('hex'), shellUnmodified: true,
      elapsedSeconds, samples, verdict, updates, requests, releaseExitCode: result.code,
      secondPromoted: false, rollbackConfirmed: true,
      scope: 'Actual checked-in shell and real 90-second clock; closed local Docker/HTTP adapters; synthetic transport failure; no Fly or production access' };
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => bridge.close(resolve));
    await rm(socketPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}
