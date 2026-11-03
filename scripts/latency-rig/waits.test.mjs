import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { waitReady } from './wait-ready.mjs';
import { waitLoad } from './load-gate.mjs';
import { assessNight } from './nightly-local.mjs';

test('rig-2: delayed listener is ready before the first proxy request', async () => {
  const script = await readFile(new URL('./local-attempt.sh', import.meta.url), 'utf8');
  for (const port of ['LATENCY_RIG_SERVER_PORT', 'LATENCY_RIG_PORT']) {
    const wait = script.indexOf(`node scripts/latency-rig/wait-ready.mjs "$${port}"`);
    assert.ok(wait > 0 && wait < script.indexOf('curl -fsS'));
  }
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const timer = setTimeout(() => server.listen(port, '127.0.0.1'), 40);
  try { await waitReady(port, { timeoutMs: 1000, pollMs: 5 }); }
  finally { clearTimeout(timer); await new Promise((resolve) => server.close(resolve)); }
  await assert.rejects(waitReady(port, { timeoutMs: 20, pollMs: 5 }), /Readiness timed out.*not listening/);
  await assert.rejects(waitReady(port, { alive: () => false }), /fixture exited/);
});

test('rig-1: gate waits for the existing contention boundary and preserves observations', async () => {
  let clock = Date.parse('2026-11-03T08:00:00Z');
  const loads = [76, 20, 10];
  let saved;
  const pass = await waitLoad({ now: () => clock, observe: () => ({ load: [loads.shift()], cpus: 20 }),
    pause: async (ms) => { clock += ms; }, save: async (samples) => { saved = [...samples]; } });
  assert.equal(pass, true);
  assert.equal(saved.length, 3);
});

test('rig-1: busy deadline produces contended verdict with actual load and no report', async () => {
  let samples;
  assert.equal(await waitLoad({ timeoutMs: 0, observe: () => ({ load: [76], cpus: 20 }),
    save: async (value) => { samples = value; } }), false);
  const result = assessNight({ head: 'a'.repeat(40), night: '2026-11-03', hostLoad: samples });
  assert.equal(result.contended, true);
  assert.equal(result.regression.status, 'contended');
  assert.match(result.text, /mean=76, max=76, cpus=20/);
});

test('gate stops waiting at the prompt replay window', async () => {
  const now = () => Date.parse('2026-11-03T09:00:00Z');
  assert.equal(await waitLoad({ now, observe: () => ({ load: [76], cpus: 20 }),
    pause: () => { throw new Error('must not wait'); } }), false);
});
