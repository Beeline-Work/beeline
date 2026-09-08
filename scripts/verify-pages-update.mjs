#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const run = promisify(execFile);

async function updaterModule() {
  // Execute the production updater without rebuilding the full monorepo.
  const result = await build({
    entryPoints: [new URL('../apps/body/src/self-update.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  );
}

export async function verifyPagesUpdate({ manifestUrl, expectedManifest, workDir }) {
  const strictFetch = async (url, options) => {
    // Before DNS cutover github.io must not redirect this proof to the old
    // origin. After cutover pass the final custom-domain URL explicitly.
    const response = await fetch(url, { ...options, redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response;
  };
  const response = await strictFetch(manifestUrl, { signal: AbortSignal.timeout(30_000) });
  const manifest = await response.json();
  assert.deepEqual(
    manifest,
    expectedManifest,
    'served manifest differs from the exact release artifact',
  );
  const platform = `${process.platform}-${process.arch}`;
  const bundle = manifest.bundles[platform];
  assert.ok(bundle, `missing ${platform} bundle`);
  assert.match(bundle.file, /^beeline-[a-z0-9-]+\.tar\.gz$/);
  const updater = await updaterModule();
  const sidecarUrl = updater.archiveUrlFor(manifestUrl, `${bundle.file}.sha256`);
  const sidecar = await (
    await strictFetch(sidecarUrl, { signal: AbortSignal.timeout(30_000) })
  ).text();
  assert.equal(sidecar.trim(), `${bundle.sha256}  ${bundle.file}`);

  await mkdir(workDir, { recursive: true });
  const prefix = await mkdtemp(join(resolve(workDir), 'probe-'));
  const layout = updater.beelineInstallLayout({ BEELINE_LIB_DIR: join(prefix, 'lib/beeline') });
  try {
    // Seed only an older on-disk identity to force the update comparison even
    // during a same-release redeploy. No production daemon or pairing runs.
    await mkdir(layout.libDir, { recursive: true });
    await writeFile(
      join(layout.libDir, 'bundle.json'),
      JSON.stringify({ commit: '0'.repeat(40), version: '0.0.0' }),
    );
    const manager = new updater.SelfUpdateManager({
      layout,
      env: { BEELINE_UPDATE_MANIFEST_URL: manifestUrl },
      fetchImpl: strictFetch,
      isIdle: () => true,
    });
    await manager.checkAndApply();
    const installed = await updater.readInstalledBundleIdentity(layout);
    assert.equal(installed.commit, manifest.sourceCommit);
    assert.equal(installed.version, manifest.version);
    const state = await updater.readUpdateState(layout);
    assert.equal(state.lastCheckResult, 'applied');
    const { stdout } = await run(join(layout.binDir, 'beeline'), ['--version'], {
      cwd: prefix,
      timeout: 30_000,
      env: { ...process.env, XDG_STATE_HOME: join(prefix, 'state'), BEELINE_UPDATE_DISABLE: '1' },
    });
    console.log(stdout.trim());
    console.log(
      `pages-update: verified ${manifest.version} ${manifest.sourceCommit} sha256=${bundle.sha256} from ${manifestUrl}`,
    );
    return {
      version: manifest.version,
      sourceCommit: manifest.sourceCommit,
      sha256: bundle.sha256,
    };
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
}

async function main() {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const manifestUrl = option('--manifest-url');
  const expectedPath = option('--expected-manifest');
  const workDir = option('--work-dir');
  const attempts = Number(option('--attempts', '1'));
  if (
    !manifestUrl ||
    !expectedPath ||
    !workDir ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 20
  ) {
    throw new Error(
      'usage: verify-pages-update.mjs --manifest-url URL --expected-manifest FILE --work-dir DIR [--attempts 1..20]',
    );
  }
  const expectedManifest = JSON.parse(await readFile(expectedPath, 'utf8'));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await verifyPagesUpdate({ manifestUrl, expectedManifest, workDir });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.error(`Pages propagation attempt ${attempt}: ${error.message}`);
      await new Promise((done) => setTimeout(done, 15_000));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
