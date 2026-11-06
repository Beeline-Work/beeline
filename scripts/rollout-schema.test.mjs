import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDrained } from './rollout-schema.mjs';

const release = { version: 'v0.1.200', sourceSha: 'a'.repeat(40) };
const machines = [
  { id: 'first', state: 'started', config: { image: 'registry.fly.io/beeline-server:deployment-AAA' } },
  { id: 'second', state: 'started', config: { image: 'registry.fly.io/beeline-server:deployment-BBB' } },
];
const refused = /contract migration refused/;

function probe(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const id = options.headers['fly-force-instance-id'];
    assert.ok(machines.some(machine => machine.id === id));
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    const path = new URL(url).pathname;
    calls.push(`${id}${path}`);
    const response = overrides[`${id}${path}`];
    if (response instanceof Error) throw response;
    return response ?? Response.json(path === '/version' ? release : { ok: true });
  };
  return { calls, fetchImpl };
}

test('drain accepts different Fly deployment tags serving the exact release on every Machine', async () => {
  const { calls, fetchImpl } = probe();
  await assertDrained(machines, release, fetchImpl);
  assert.deepEqual(calls.sort(), ['first/readyz', 'first/version', 'second/readyz', 'second/version']);
});

test('matching image tags cannot authorize a Machine serving an older source or version', async () => {
  const sameTag = machines.map(machine => ({ ...machine, config: { image: 'registry.fly.io/beeline-server:0.1.200-aaaaaaaaaaaa' } }));
  for (const version of [
    { ...release, sourceSha: 'b'.repeat(40) },
    { ...release, version: 'v0.1.199' },
    { ...release, sourceSha: release.sourceSha.slice(0, 12) },
    {},
    null,
  ]) {
    await assert.rejects(assertDrained(sameTag, release, probe({ 'second/version': Response.json(version) }).fetchImpl), refused);
  }
});

test('drain refuses empty, stopped or unidentified fleets before probing', async () => {
  for (const fleet of [[], [{ ...machines[0], state: 'stopped' }], [{ ...machines[0], id: '' }]]) {
    const { calls, fetchImpl } = probe();
    await assert.rejects(assertDrained(fleet, release, fetchImpl), refused);
    assert.deepEqual(calls, []);
  }
});

test('drain refuses missing release identity before probing', async () => {
  for (const expected of [{}, { version: release.version }, { sourceSha: release.sourceSha }]) {
    const { calls, fetchImpl } = probe();
    await assert.rejects(assertDrained(machines, expected, fetchImpl), refused);
    assert.deepEqual(calls, []);
  }
});

test('drain fails closed on readiness, HTTP, network, timeout or malformed version responses', async () => {
  for (const overrides of [
    { 'second/readyz': new Response('', { status: 503 }) },
    { 'second/version': new Response('', { status: 500 }) },
    { 'second/version': new Error('connection refused') },
    { 'second/version': new DOMException('timed out', 'TimeoutError') },
    { 'second/version': new Response('not json') },
  ]) {
    await assert.rejects(assertDrained(machines, release, probe(overrides).fetchImpl), refused);
  }
});
