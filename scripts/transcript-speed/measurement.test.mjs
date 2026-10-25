import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messages, rooms, agents, localDatabase } from './fixture.mjs';
import { percentile, summarize, historyPageProved } from './metrics.mjs';

test('fixture refuses remote databases and libpq connection overrides', () => {
  assert.equal(localDatabase('postgresql://localhost/beeline_latency_rig_transcript_test'), 'postgresql://localhost/beeline_latency_rig_transcript_test');
  for (const value of ['postgresql://server.usebeeline.app/beeline_latency_rig_transcript_test',
    'postgresql://localhost/production',
    'postgresql://localhost/beeline_latency_rig_transcript_test?host=remote',
    'postgresql://localhost/beeline_latency_rig_transcript_test?connectionString=remote'])
    assert.throws(() => localDatabase(value));
});
test('fixture is deterministic and replies refer to existing messages', () => {
  const rows = messages(rooms[0], 'http://localhost:19882');
  assert.deepEqual(rows, messages(rooms[0], 'http://localhost:19882'));
  assert.equal(new Set(rows.map(row => row.id)).size, 1000);
  assert.ok(rows.filter(row => row.reply).every(row => rows.some(parent => parent.id === row.reply)));
  assert.ok(agents.every(agent => rows.some(row => row.author === agent)));
});
test('nearest-rank percentile preserves tail stalls and missing samples', () => {
  assert.equal(percentile([], .95), null);
  assert.equal(percentile([10, 10, 10, 10, 100], .95), 100);
  assert.throws(() => percentile([NaN], .95));
  const result = summarize({ name: 'typing', startMs: 0, endMs: 100,
    jsFrameIntervalsMs: [1000 / 60, 50], commits: [{ kind: 'row', id: 'a' }, { kind: 'row', id: 'a' }, { kind: 'transcript', id: 'room' }] }, 60);
  assert.equal(result.missedJsFrameOpportunities, 2);
  assert.equal(result.rowCommits, 2);
  assert.equal(result.distinctRowsCommitted, 1);
  assert.equal(result.jsFrameIntervalMaxMs, 50);
  const sparseStall = summarize({ name: 'room-switch', startMs: 0, endMs: 5000,
    jsFrameIntervalsMs: [...Array(99).fill(1000 / 60), 2638], commits: [] }, 60);
  assert.equal(sparseStall.jsFrameIntervalP95Ms, 1000 / 60);
  assert.equal(sparseStall.jsFrameIntervalMaxMs, 2638);
  assert.equal(sparseStall.missedJsFrameOpportunities, 157);
  assert.equal(summarize({ name: 'empty', startMs: 0, endMs: 0,
    jsFrameIntervalsMs: [], commits: [] }, 60).jsFrameIntervalMaxMs, null);
});

test('history proof requires crossing the initial page, not recycler mounting', () => {
  assert.equal(historyPageProved(992, 991), false);
  assert.equal(historyPageProved(970, 969), true);
  assert.equal(historyPageProved(942, 941), true);
  assert.equal(historyPageProved(942, 950), false);
  assert.equal(historyPageProved(970, null), false);
  assert.equal(historyPageProved(970, Infinity), false);
});

test('build probe reports the effective compiler option and rejects moved targets', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
  const { transformSync } = require('@babel/core');
  const plugin = require('../../scripts/transcript-speed/commits.cjs');
  const options = { configFile: false, babelrc: false, filename: '/fixture/chat/_chat-surface.tsx',
    caller: { name: 'metro', platform: 'android', supportsReactCompiler: false }, plugins: [plugin] };
  const output = transformSync('function BuzzChatSurface() { return null; }', options).code;
  assert.match(output, /__transcriptCommit\("transcript", "room"\)/);
  assert.match(output, /reactCompiler: false/);
  assert.match(output, /__transcriptBuild/);
  assert.throws(() => transformSync('function Renamed() {}', options), /target moved/);
  const config = require('./babel.config.js')({ cache() {} });
  assert.ok(!config.plugins.flat().some(item => typeof item === 'string' && item.endsWith('commits.cjs')));
});

test('build provenance anchors Git pathspecs at the repository root', async () => {
  const { createRequire } = await import('node:module');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { resolve, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'transcript-git-'));
  const command = join(directory, 'git-fixture.cjs');
  const recordedArgs = join(directory, 'args.json');
  writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(recordedArgs)}, JSON.stringify(args));
if (args[0] !== '-C') process.exit(0);
process.stdout.write(args[2] === 'rev-parse' ? '1111111111111111111111111111111111111111' : 'fixture source diff');
`, { mode: 0o755 });
  const previous = process.env.TRANSCRIPT_GIT;
  try {
    process.env.TRANSCRIPT_GIT = command;
    const output = require('@babel/core').transformSync('function BuzzChatSurface() { return null; }', {
      configFile: false, babelrc: false, filename: '/fixture/chat/_chat-surface.tsx',
      caller: { name: 'metro', platform: 'android' }, plugins: [require('../../scripts/transcript-speed/commits.cjs')],
    }).code;
    const expected = createHash('sha256').update('fixture source diff').digest('hex');
    assert.ok(output.includes(`sourceDiffSha256: "${expected}"`));
    assert.deepEqual(JSON.parse(readFileSync(recordedArgs, 'utf8')).slice(0, 3),
      ['-C', resolve(fileURLToPath(new URL('../../', import.meta.url))), 'diff']);
  } finally {
    if (previous === undefined) delete process.env.TRANSCRIPT_GIT; else process.env.TRANSCRIPT_GIT = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('list experiment is build-only and rejects mismatched engine provenance', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
  const { transformSync } = require('@babel/core');
  const options = { configFile: false, babelrc: false, filename: '/fixture/chat/_chat-surface.tsx',
    caller: { name: 'metro', platform: 'web' }, parserOpts: { plugins: ['jsx'] },
    plugins: [require('../../scripts/transcript-speed/commits.cjs')] };
  const source = 'function BuzzChatSurface() { const desktopTranscript = desktopExperience; return <FlatList />; }';
  const prior = [process.env.BEELINE_TRANSCRIPT_ENGINE, process.env.EXPO_PUBLIC_TRANSCRIPT_ENGINE];
  try {
    delete process.env.BEELINE_TRANSCRIPT_ENGINE;
    assert.doesNotMatch(transformSync(source, options).code, /benchmark-list|__BenchmarkList/);
    for (const engine of ['flatlist', 'flashlist', 'legendlist']) {
      process.env.BEELINE_TRANSCRIPT_ENGINE = engine;
      process.env.EXPO_PUBLIC_TRANSCRIPT_ENGINE = engine;
      const output = transformSync(source, options).code;
      assert.match(output, /desktopTranscript = false/);
      assert.match(output, /<__BenchmarkList/);
      assert.ok(output.includes(`listEngine: "${engine}"`));
    }
    process.env.EXPO_PUBLIC_TRANSCRIPT_ENGINE = 'flatlist';
    assert.throws(() => transformSync(source, options), /must match/);
  } finally {
    for (const [index, key] of ['BEELINE_TRANSCRIPT_ENGINE', 'EXPO_PUBLIC_TRANSCRIPT_ENGINE'].entries()) {
      if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index];
    }
  }
});

test('fixture control accepts isolated ports and never polls a remote origin', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(new URL('../../apps/mobile/transcript-speed/runtime.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/, '').replaceAll('export function ', 'function ');
  for (const [url, allowed] of [
    ['http://127.0.0.1:19886', true], ['http://10.0.2.2:20886', true],
    ['http://127.0.0.1:65535', true], ['http://127.0.0.1:65536', false],
    ['http://127.0.0.1:0', false], ['https://server.usebeeline.app:20886', false],
    ['http://127.0.0.1.example.com:20886', false], ['http://10.0.2.2:20886/path', false],
  ]) {
    const requests = [];
    const scheduled = [];
    runInNewContext(source, { process: { env: { EXPO_PUBLIC_TRANSCRIPT_CONTROL: url } },
      setTimeout(callback) { scheduled.push(callback); },
      fetch(target) { requests.push(target); return new Promise(() => {}); } });
    scheduled.shift()?.();
    assert.deepEqual(requests, allowed ? [`${url}/next`] : [], url);
  }
});
