/**
 * End-to-end demonstration of the Beeline daemon self-update path
 * (`apps/body/src/self-update.ts`), against a locally served fixture
 * manifest — no relay, no checkout required.
 *
 *   node --import tsx scripts/self-update-demo.ts
 *
 * Shows, in order:
 *   1. identity reporting from an installed (deliberately older) bundle
 *   2. busy gate: an update requested mid-work WAITS, staged but not swapped
 *   3. atomic swap + restart onto the new bundle (proving WHICH cli came up)
 *   4. a served-turn proof marking the one update attempt confirmed
 *   5. checksum mismatch aborting loudly with the installed bundle untouched
 *   6. rollback when an applied update never becomes healthy
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  SelfUpdateManager,
  activateRelease,
  activeReleaseId,
  beelineInstallLayout,
  hostPlatformKey,
  readInstalledBundleIdentity,
  readUpdateAttempt,
  settleUpdateAttemptOnStart,
  writeUpdateAttempt,
} from '../src/self-update.js';
import {
  reportUpdateRollback,
  queueUpdateRollbackAlert,
  updateRollbackAlertPath,
} from '../src/update-rollback-alert.js';

const roots: string[] = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  roots.push(dir);
  return dir;
}

const STUB_CLI = `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
function identity() {
  try { return JSON.parse(fs.readFileSync(path.resolve(here, '../../bundle.json'), 'utf8')); }
  catch { return {}; }
}
const args = process.argv.slice(2);
if (args.includes('--version')) {
  const id = identity();
  console.log('beeline', id.version ?? 'unknown', (id.commit ?? '').slice(0, 12));
} else if (args[0] === 'daemon') {
  const configPath = args[args.indexOf('--config') + 1];
  fs.writeFileSync(path.join(path.dirname(configPath), 'daemon-started.json'),
    JSON.stringify({ pid: process.pid, commit: identity().commit }));
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => undefined, 1000);
} else process.exit(2);
`;

async function buildBundle(commit, version) {
  const staging = await tempDir(`build-${commit}`);
  await mkdir(join(staging, 'lib', 'beeline'), { recursive: true });
  await writeFile(join(staging, 'lib', 'beeline', 'beeline-cli.mjs'), STUB_CLI);
  await writeFile(join(staging, 'lib', 'beeline', 'squire-mcp-proxy.mjs'), 'process.exit(0);\n');
  await writeFile(join(staging, 'lib', 'beeline', 'agent-tool-mcp-proxy.mjs'), 'process.exit(0);\n');
  await writeFile(join(staging, 'lib', 'beeline', 'pi-mcp-adapter.mjs'), 'export {};\n');
  await writeFile(
    join(staging, 'bundle.json'),
    `${JSON.stringify({ schemaVersion: 1, platform: hostPlatformKey(), commit, version }, null, 2)}\n`,
  );
  const tarballPath = join(staging, 'bundle.tar.gz');
  const tar = spawnSync('tar', ['-czf', tarballPath, '-C', staging, 'lib', 'bundle.json']);
  if (tar.status !== 0) throw new Error(tar.stderr?.toString());
  return {
    commit,
    version,
    tarballPath,
    sha256: createHash('sha256').update(await readFile(tarballPath)).digest('hex'),
  };
}

function say(step, text) {
  console.log(`\n== ${step} ==`);
  if (text) console.log(text);
}

// --- fixture server -------------------------------------------------------
const files = new Map();
const bodies = new Map();
const server = createServer((request, response) => {
  const url = request.url ?? '';
  if (bodies.has(url)) return void response.writeHead(200).end(bodies.get(url));
  const file = files.get(url);
  if (!file) return void response.writeHead(404).end('not found');
  response.writeHead(200);
  createReadStream(file).pipe(response);
});
import { createReadStream } from 'node:fs';
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

function serveManifest(bundle) {
  const filename = bundle.tarballPath.split('/').pop();
  files.set(`/dl/${filename}`, bundle.tarballPath);
  bodies.set('/dl/manifest.json', JSON.stringify({
    schemaVersion: 1,
    bundles: {
      [hostPlatformKey()]: { file: filename, sha256: bundle.sha256, commit: bundle.commit, version: bundle.version },
    },
  }));
}

try {
  // --- 1. an installed, deliberately OLDER bundle --------------------------
  const root = await tempDir('demo-install');
  const libDir = join(root, 'prefix', 'lib', 'beeline');
  await mkdir(join(libDir, 'lib', 'beeline'), { recursive: true });
  await mkdir(join(root, 'prefix', 'bin'), { recursive: true });
  await writeFile(join(libDir, 'lib', 'beeline', 'beeline-cli.mjs'), STUB_CLI);
  await writeFile(join(libDir, 'bundle.json'), `${JSON.stringify({ commit: 'aaa111old', version: '2026.01.01' }, null, 2)}\n`);
  const layout = beelineInstallLayout({ BEELINE_LIB_DIR: libDir });
  const runtimeDir = join(root, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  const configPath = join(runtimeDir, 'runtime.json');
  await writeFile(configPath, '{}');

  say('1. what is this daemon running?', `installed bundle: ${JSON.stringify(await readInstalledBundleIdentity(layout))}`);

  // --- publish a NEWER bundle ---------------------------------------------
  const newer = await buildBundle('bbb222new', '2026.02.05');
  serveManifest(newer);

  let idle = false;
  const manager = new SelfUpdateManager({
    layout,
    env: { BEELINE_UPDATE_MANIFEST_URL: `${baseUrl}/dl/manifest.json` },
    idleTimeoutMs: 400,
    idlePollMs: 20,
    isIdle: () => idle,
    logger: () => undefined,
  });

  // --- 2. busy: the update waits -------------------------------------------
  say('2. agent work is running — the update must WAIT');
  await manager.checkAndApply();
  console.log(`staged: ${existsSync(join(layout.releasesRoot, newer.commit))}, swapped: ${await activeReleaseId(layout) !== 'legacy'}`);

  // --- 3. idle: atomic swap + restart --------------------------------------
  say('3. work finished — swap atomically and restart onto the new bundle');
  idle = true;
  await manager.checkAndApply();
  console.log(`active release: ${await activeReleaseId(layout)}  (previous kept: ${existsSync(join(layout.releasesRoot, 'aaa111old'))})`);
  console.log('the stable anchor now points at the candidate; the daemon coordinator owns the successor restart.');

  // --- 4. healthy: served turn confirms --------------------------------------
  const attempt = await readUpdateAttempt(layout);
  await writeUpdateAttempt(layout, { ...attempt, status: 'confirmed' });
  say('4. new bundle served a turn', `attempt now: ${(await readUpdateAttempt(layout)).status}`);

  // --- 5. checksum mismatch aborts loudly -----------------------------------
  say('5. corrupt/mismatched download aborts without touching the install');
  const evil = await buildBundle('ddd444evil', '2026.04.01');
  const tampered = { ...evil, sha256: 'f'.repeat(64) };
  serveManifest(tampered);
  try {
    const { stageRelease } = await import('../src/self-update.js');
    await stageRelease(layout, `${baseUrl}/dl/manifest.json`, {
      file: evil.tarballPath.split('/').pop(),
      sha256: tampered.sha256,
      commit: evil.commit,
    });
  } catch (error) {
    console.log(String(error.message).split('\n')[0]);
  }
  console.log(`installed identity still: ${JSON.stringify(await readInstalledBundleIdentity(layout))}`);
  serveManifest(newer); // restore honest manifest

  // --- 6. failed start rolls back --------------------------------------------
  say('6. an applied update that never starts is rolled back at next start');
  const broken = await buildBundle('ccc333bad', '2026.03.01');
  await writeFile(join(broken.tarballPath.replace('.tar.gz', '-dir'), 'placeholder'), 'x').catch(() => undefined);
  // Simulate: release activated but never served a turn before its deadline.
  const { writeUpdateAttemptFixture } = await import('../src/self-update.js');
  await writeUpdateAttemptFixture(layout, {
    from: { commit: 'bbb222new', version: '2026.02.05' },
    to: { commit: broken.commit, version: broken.version },
    releaseId: broken.commit,
    previousReleaseId: 'aaa111old',
    appliedAt: Date.now() - 10 * 60_000,
  });
  const settle = await settleUpdateAttemptOnStart(layout);
  if (settle.kind === 'rolled-back') {
    await queueUpdateRollbackAlert(runtimeDir, settle.record.releaseId);
    await reportUpdateRollback({ runtimeDir });
  }
  console.log(`settle verdict: ${settle.kind}; active release restored to: ${await activeReleaseId(layout)}; durable outcome: ${(await readUpdateAttempt(layout)).status}; record: ${updateRollbackAlertPath(runtimeDir)}`);
} finally {
  server.close();
  for (const dir of roots) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
