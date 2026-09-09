import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'clean-dist.mjs');
const repositoryRoot = dirname(dirname(script));

test('clean-dist removes dist without relying on platform shell tools', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'beeline-clean-dist-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const output = join(project, 'dist', 'nested', 'output.js');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, 'built');

  const result = spawnSync(process.execPath, [script], {
    cwd: project,
    env: { ...process.env, PATH: '' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(project, 'dist')), false);
});

test('release images copy clean-dist before building workspace packages', () => {
  const dockerignore = readFileSync(join(repositoryRoot, '.dockerignore'), 'utf8');
  assert.match(
    dockerignore,
    /^!scripts$/m,
    'Docker build context must include the scripts directory',
  );
  assert.match(
    dockerignore,
    /^!scripts\/clean-dist\.mjs$/m,
    'Docker build context must include scripts/clean-dist.mjs',
  );

  for (const app of ['auth', 'server']) {
    const dockerfile = readFileSync(join(repositoryRoot, 'apps', app, 'Dockerfile'), 'utf8');
    const copyIndex = dockerfile.indexOf('COPY scripts/clean-dist.mjs ./scripts/clean-dist.mjs');
    const buildIndex = dockerfile.indexOf('RUN npm run build -w @beeline/nostr');

    assert.notEqual(copyIndex, -1, `${app} build stage must copy scripts/clean-dist.mjs`);
    assert.ok(
      copyIndex < buildIndex,
      `${app} build stage must copy clean-dist before workspace builds`,
    );
  }
});
