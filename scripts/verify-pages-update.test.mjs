import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyPagesUpdate } from './verify-pages-update.mjs';

// Executable miniature bundle: exercise the production updater's HTTP,
// checksum, tar extraction, activation, stable forwarder and CLI smoke path.
async function fixture(root) {
  const bundle = join(root, 'bundle');
  await mkdir(join(bundle, 'bin'), { recursive: true });
  await mkdir(join(bundle, 'lib/beeline'), { recursive: true });
  const identity = { commit: 'a'.repeat(40), version: 'v0.0.63' };
  await writeFile(join(bundle, 'lib/beeline/bundle.json'), JSON.stringify(identity));
  await writeFile(join(bundle, 'lib/beeline/beeline-cli.mjs'), 'console.log("beeline v0.0.63")');
  await writeFile(join(bundle, 'lib/beeline/pi-mcp-adapter.mjs'), '');
  await writeFile(
    join(bundle, 'bin/beeline'),
    '#!/bin/sh\nnode "$BEELINE_LIB_DIR/lib/beeline/beeline-cli.mjs" "$@"\n',
  );
  await chmod(join(bundle, 'bin/beeline'), 0o755);
  const file = 'beeline-linux-x64.tar.gz';
  execFileSync('tar', ['-czf', join(root, file), '-C', bundle, 'bin', 'lib']);
  const bytes = await readFile(join(root, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    schemaVersion: 1,
    sourceCommit: identity.commit,
    version: identity.version,
    bundles: { 'linux-x64': { ...identity, file, sha256, bytes: bytes.length, verified: true } },
  };
  return { file, bytes, sha256, manifest };
}

test('round trip applies exact bytes, and refuses stale, corrupt and redirected hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pages-update-'));
  const current = await fixture(root);
  let mode = 'current';
  const server = createServer((req, res) => {
    if (mode === 'redirect') {
      res.writeHead(302, { location: '/old-origin' }).end();
      return;
    }
    if (req.url === '/dl/manifest.json') {
      res.end(
        JSON.stringify(
          mode === 'stale' ? { ...current.manifest, version: '0.0.13' } : current.manifest,
        ),
      );
    } else if (req.url.endsWith('.sha256')) {
      res.end(`${current.sha256}  ${current.file}\n`);
    } else if (req.url === `/dl/${current.file}`) {
      res.end(mode === 'corrupt' ? 'damaged archive' : current.bytes);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const options = {
      manifestUrl: `http://127.0.0.1:${server.address().port}/dl/manifest.json`,
      expectedManifest: current.manifest,
      workDir: join(root, 'proof'),
    };
    assert.equal((await verifyPagesUpdate(options)).sha256, current.sha256);
    for (const [failure, message] of [
      ['stale', /served manifest differs/],
      ['corrupt', /checksum mismatch/],
      ['redirect', /fetch failed/],
    ]) {
      mode = failure;
      await assert.rejects(verifyPagesUpdate(options), message);
    }
  } finally {
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
