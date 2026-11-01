import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { APPS } from './walk.mjs';

test('R1: CLI writes both triage artifacts, detects errors, loops, baseline changes and window edge gaps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'log-walk-'));
  try {
    const raw = join(dir, 'raw'), state = join(dir, 'state'), out = join(dir, 'out');
    const now = Date.parse('2026-11-01T12:00:00Z');
    for (const app of APPS) await mkdir(join(raw, app), { recursive: true });
    await mkdir(state);
    await writeFile(join(state, '2026-10-31.json'), JSON.stringify({ generatedAt: '2026-10-31T12:00:00Z', patterns: [{ pattern: 'gone job', count: 10 }] }));
    // Sparse fixture deliberately misses both edges, with a steady identity loop.
    const text = Array.from({ length: 6 }, (_, i) => `${new Date(now - 3600000 + i * 60000).toISOString()} app[abc] [req-error] POST /v1/test identity=fixture-human status=503 failed`).join('\n');
    await writeFile(join(raw, APPS[0], '2026-11-01.log'), `${text}\nuntimestamped line\n2026-10-30T00:00:00Z error outside window\n`);
    // A full window for another app must not inherit the first app's gaps.
    const complete = Array.from({ length: 145 }, (_, i) => JSON.stringify({ timestamp: new Date(now - 86400000 + i * 600000).toISOString(), level: 'info', message: '[background] heartbeat' })).join('\n');
    await writeFile(join(raw, APPS[2], '2026-10-31.log'), complete.split('\n').filter(line => JSON.parse(line).timestamp < '2026-11-01').join('\n'));
    await writeFile(join(raw, APPS[2], '2026-11-01.log'), complete.split('\n').filter(line => JSON.parse(line).timestamp >= '2026-11-01').join('\n'));
    const run = () => execFileSync(process.execPath, ['scripts/log-walk/walk.mjs', '--raw', raw, '--state', state, '--out', out, '--hours', '24', '--now', new Date(now).toISOString()]);
    run();
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    const markdown = await readFile(join(out, 'report.md'), 'utf8');
    assert.equal(report.coverage[0].lines, 6);
    assert.deepEqual(report.coverage[0].gaps.map(gap => gap.edge), ['head', 'tail']);
    assert.equal(report.coverage[1].complete, false);
    assert.equal(report.coverage[1].gaps[0].minutes, 1440);
    assert.equal(report.coverage[2].complete, true);
    assert.equal(report.errors[0].count, 6);
    assert.equal(report.newOrUp[0].previous, 0);
    assert.equal(report.gone[0].pattern, 'gone job');
    assert.equal(report.loops[0].seconds, 60);
    assert.equal(report.identities[0][0], 'fixture-human');
    assert.equal(report.routes[0][0], 'POST /v1/test');
    assert.equal(report.jobs[0][1], 145);
    assert.equal(report.ignoredLines, 1);
    for (const section of ['Coverage', 'Errors and refusals', 'New or up', 'Gone', 'Loops', 'Heaviest identities', 'Busiest routes', 'Background job', 'Logging gaps']) assert.ok(markdown.includes(section), section);
    assert.equal(JSON.parse(await readFile(join(state, '2026-11-01.json'), 'utf8')).patterns.length, 2);
    run();
    assert.equal(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).baseline, report.baseline);
    await writeFile(join(raw, APPS[0], '2026-11-01.log'), `${text}\n2026-11-01T09:00:00Z heartbeat\n`);
    run();
    assert.ok(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).coverage[0].gaps.some(gap => gap.edge === 'interior'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
