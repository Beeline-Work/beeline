import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { previousSources } from './server-previous-sources.mjs';

const sha = '98c2a49a4f3df909e8fd3fc32ae39129f6f8367b';
const image = 'registry.fly.io/beeline-server:deployment-01M6J073EW3QD5G3HAFPT9WR6J';
const machines = [{ config: { image }, image_ref: { labels: { 'app.usebeeline.release.sha': sha } } }];

test('Reproduction A: deployment-tag fleet resolves its own source label through the guard CLI', () => {
  const result = spawnSync(process.execPath, ['scripts/server-previous-sources.mjs', 'scripts/fixtures/server-deployment-machines.json', 'new'], { encoding: 'utf8', env: { ...process.env, PUBLISHED_SERVER_IMAGE: '', ROLLBACK_SERVER_IMAGE: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), sha);
});

test('Reproduction A: unknown source still refuses, including absent rollback metadata', () => {
  const unknown = JSON.parse(readFileSync('scripts/fixtures/server-unknown-machines.json', 'utf8'));
  assert.throws(() => previousSources(unknown, 'new'), /Cannot identify/);
  assert.throws(() => previousSources(machines, image), /Cannot identify/);
  assert.throws(() => previousSources([], 'new'), /Cannot identify/);
});

test('saved deployment rollback and published refs resolve only their own image labels', () => {
  const current = [{ config: { image: 'new', metadata: { beeline_replaced_image: image } }, image_ref: { labels: { 'app.usebeeline.release.sha': 'a'.repeat(40) } } }];
  const inspected = [];
  assert.deepEqual(previousSources(current, 'new', [image], ref => { inspected.push(ref); return { 'app.usebeeline.release.sha': sha }; }), [sha]);
  assert.deepEqual(inspected, [image]);
  assert.throws(() => previousSources(current, 'new', [], () => ({})), /Cannot identify/);
  assert.throws(() => previousSources(current, 'new', [], () => ({ 'app.usebeeline.release.sha': 'bad' })), /Invalid/);
});

test('legacy release tags remain supported alongside label sources', () => {
  assert.deepEqual(previousSources(machines, 'new', ['registry.fly.io/beeline-server:0.1.142-abcdef123456@sha256:abc']), [sha, 'abcdef123456']);
});
