import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildRecord, mergesSince, ownerReceipt, stageTimings } from './release-bookkeeping.mjs';

const script = fileURLToPath(new URL('./release-bookkeeping.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

test('owner receipt counts only the physical phone reporting this exact release', () => {
  const release = { version: 'v0.1.130', sha: 'a'.repeat(40) };
  const devices = [
    { environment: 'simulator', releaseVersion: 'v0.1.130', sourceSha: 'a'.repeat(40), deviceId: 'sim' },
    { environment: 'physical', releaseVersion: 'v0.1.129', sourceSha: 'b'.repeat(40), deviceId: 'old' },
  ];
  assert.deepEqual(ownerReceipt({ devices }, release), { state: 'not-reported' });
  devices.push({ environment: 'physical', releaseVersion: 'v0.1.130', sourceSha: 'a'.repeat(40),
    deviceId: 'phone', updateId: 'u1', channel: 'production', reportedAt: '2026-10-30T12:00:00Z' });
  assert.deepEqual(ownerReceipt({ devices }, release), { state: 'confirmed', deviceId: 'phone', updateId: 'u1',
    channel: 'production', reportedAt: '2026-10-30T12:00:00Z' });
});

test('stage timings list every started job in start order with whole seconds', () => {
  assert.deepEqual(stageTimings([
    { name: 'server', conclusion: 'success', started_at: '2026-10-30T10:01:00Z', completed_at: '2026-10-30T10:04:30Z' },
    { name: 'initialize', conclusion: 'success', started_at: '2026-10-30T10:00:00Z', completed_at: '2026-10-30T10:00:40Z' },
    { name: 'skipped', conclusion: 'skipped', started_at: null },
    { name: 'bookkeeping', status: 'in_progress', started_at: '2026-10-30T10:05:00Z', completed_at: null },
  ]).map(({ job, seconds, conclusion }) => [job, seconds, conclusion]), [
    ['initialize', 40, 'success'], ['server', 210, 'success'], ['bookkeeping', null, 'in_progress'],
  ]);
});

test('the merge list runs from the previous release to this one', () => {
  const head = git('rev-parse', 'HEAD');
  const base = git('rev-parse', 'HEAD~2');
  const merges = mergesSince(base, head);
  assert.deepEqual(merges.map((merge) => merge.sha), [git('rev-parse', 'HEAD~1'), head]);
  assert.equal(mergesSince(null, head).length, 1);
});

test('the record names the OTA branch from whichever OTA leg ran', () => {
  const record = buildRecord({
    version: 'v0.1.130', sha: 'a'.repeat(40), previous: { version: 'v0.1.129', sourceSha: 'b'.repeat(40) },
    needs: {
      mobile_ota: { result: 'skipped', outputs: {} },
      mobile_ota_after_proof: { result: 'success', outputs: { ota_branch: 'release-v0.1.130',
        ota_targets: 'android@38,android@39,ios@36', completed_at: '1000' } },
      release_result: { result: 'success', outputs: { outcome: 'success', failure_class: '' } },
    },
    runId: '7', attempt: '2', merges: [], jobs: [], receipt: { state: 'not-reported' }, triggerEpoch: '400',
  });
  assert.equal(record.outcome, 'success');
  assert.equal(record.failureClass, null);
  assert.deepEqual(record.ota, { branch: 'release-v0.1.130', targets: ['android@38', 'android@39', 'ios@36'],
    promotedAt: 1000, fixToPhoneSeconds: 600 });
  assert.equal(record.previousVersion, 'v0.1.129');
});

// A local stand-in for api.github.com (jobs + contents) and the receipt server.
async function fakeServices({ contents = 'ok', receipt = 'ok' } = {}) {
  const files = new Map();
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const url = new URL(request.url, 'http://local');
      const send = (status, value) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (url.pathname === '/repos/Beeline-Work/beeline/actions/runs/41/attempts/1/jobs') {
        return send(200, { jobs: [{ name: 'initialize', conclusion: 'success',
          started_at: '2026-10-30T10:00:00Z', completed_at: '2026-10-30T10:00:30Z' }] });
      }
      if (url.pathname.startsWith('/update-receipts/')) {
        if (receipt !== 'ok') return send(503, {});
        return send(200, { devices: [{ environment: 'physical', releaseVersion: 'v0.1.130',
          sourceSha: process.env.PROBE_SHA, deviceId: 'owner-phone', reportedAt: '2026-10-30T10:06:00Z' }] });
      }
      const path = url.pathname.replace('/repos/Beeline-Work/beeline-insights/contents/', '');
      if (url.pathname.startsWith('/repos/Beeline-Work/beeline-insights/contents/')) {
        if (contents !== 'ok') return send(500, { message: 'GitHub is down' });
        if (request.method === 'GET') return files.has(path) ? send(200, { sha: files.get(path).sha }) : send(404, {});
        const put = JSON.parse(body);
        if (files.has(path) && put.sha !== files.get(path).sha) return send(409, {});
        files.set(path, { sha: `s${files.size + 1}`, record: JSON.parse(Buffer.from(put.content, 'base64').toString()) });
        return send(201, {});
      }
      return send(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, files, origin: `http://127.0.0.1:${server.address().port}` };
}

function runScript(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: root, env: { PATH: process.env.PATH, ...env } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function releaseEnv(origin, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bookkeeping-'));
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'previous.json'), JSON.stringify({ version: 'v0.1.129', sourceSha: git('rev-parse', 'HEAD~3') }));
  writeFileSync(join(dir, 'needs.json'), JSON.stringify({
    mobile_ota: { result: 'success', outputs: { ota_branch: 'release-v0.1.130', ota_targets: 'android@40,ios@36', completed_at: '1761818760' } },
    release_result: { result: 'success', outputs: { outcome: 'success' } },
  }));
  process.env.PROBE_SHA = head;
  return {
    GITHUB_API_URL: origin, GITHUB_REPOSITORY: 'Beeline-Work/beeline', GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '1',
    GH_TOKEN: 'run-token', INSIGHTS_TOKEN: 'insights-token', OWNER_PUBKEY: 'owner', RECEIPT_TOKEN: 'receipt',
    RECEIPT_ORIGIN: origin, RELEASE_VERSION: 'v0.1.130', RELEASE_SHA: head, TRIGGER_EPOCH: '1761818400',
    NEEDS_FILE: join(dir, 'needs.json'), PREVIOUS_RECORD_FILE: join(dir, 'previous.json'), ...overrides,
  };
}

// Reproduction BOOKKEEPING-OUT-OF-PATH: a release finishes and its delivery
// bookkeeping lands in the insights store, as a separate process.
test('a finished release writes its bookkeeping to releases/<version>.json, and a rerun replaces it', async () => {
  const fake = await fakeServices();
  try {
    const env = releaseEnv(fake.origin);
    const first = await runScript(env);
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, /written to Beeline-Work\/beeline-insights\/releases\/v0\.1\.130\.json/);
    const { record } = fake.files.get('releases/v0.1.130.json');
    assert.equal(record.merges.length, 3);
    assert.equal(record.merges.at(-1).sha, env.RELEASE_SHA);
    assert.deepEqual(record.ota.targets, ['android@40', 'ios@36']);
    assert.equal(record.ota.fixToPhoneSeconds, 360);
    assert.equal(record.ownerReceipt.state, 'confirmed');
    assert.deepEqual(record.stages.map((stage) => [stage.job, stage.seconds]), [['initialize', 30]]);

    const rerun = await runScript({ ...env, GITHUB_RUN_ATTEMPT: '1' });
    assert.equal(rerun.code, 0, rerun.output);
    assert.equal(fake.files.size, 1);
    assert.equal(fake.files.get('releases/v0.1.130.json').sha, 's2');
  } finally {
    fake.server.close();
  }
});

// Reproduction BOOKKEEPING-FAILS: the store, the receipt server or the token
// is missing; the script warns and exits 0, so the release result stands.
test('a bookkeeping failure only warns and exits 0', async () => {
  const fake = await fakeServices({ contents: 'down', receipt: 'down' });
  try {
    const down = await runScript(releaseEnv(fake.origin));
    assert.equal(down.code, 0, down.output);
    assert.match(down.output, /::warning title=Release bookkeeping::bookkeeping write failed: .* 500\. The release is unaffected\./);
    const noToken = await runScript(releaseEnv(fake.origin, { INSIGHTS_TOKEN: '' }));
    assert.equal(noToken.code, 0);
    assert.match(noToken.output, /BEELINE_INSIGHTS_TOKEN is not set/);
    const unreachable = await runScript(releaseEnv('http://127.0.0.1:9'));
    assert.equal(unreachable.code, 0, unreachable.output);
    assert.match(unreachable.output, /stage timings unavailable/);
    assert.match(unreachable.output, /bookkeeping write failed/);
  } finally {
    fake.server.close();
  }
});

test('the release workflow keeps bookkeeping out of the release result', () => {
  const workflow = parse(readFileSync(join(root, '.github/workflows/unified-release.yml'), 'utf8'));
  const job = workflow.jobs.bookkeeping;
  assert.equal(job['continue-on-error'], true);
  assert.ok(job.needs.includes('release_result'));
  for (const [name, other] of Object.entries(workflow.jobs)) {
    const needs = [other.needs ?? []].flat();
    assert.ok(!needs.includes('bookkeeping'), `${name} must not depend on bookkeeping`);
  }
  assert.deepEqual(Object.keys(job.permissions).sort(), ['actions', 'contents']);
});
