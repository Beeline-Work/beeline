// Reproduction REVIEW-DEPS-1: real exact-head worktrees, npm guard, builds and tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDependencyGeneration, installDependencyNpmGuard } from '../apps/body/src/dependency-generation.ts';
import { reviewExactHead, REVIEW_BUILD_PACKAGES } from './review-exact-head.mjs';

const root = mkdtempSync(join(tmpdir(), 'review-dependency-proof-'));
const before = process.cwd(), oldPath = process.env.PATH;
const npm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
const repo = join(root, 'repo');
mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
try {
  const payload = join(root, 'payload');
  mkdirSync(payload);
  writeFileSync(join(payload, 'package.json'), JSON.stringify({ name: 'review-proof', version: '1.0.0', main: 'index.js' }));
  writeFileSync(join(payload, 'index.js'), 'module.exports = 42;');
  execFileSync(npm, ['pack', '--pack-destination', root], { cwd: payload, stdio: 'ignore' });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'review-fixture', version: '1.0.0', private: true,
    workspaces: ['packages/*'], dependencies: { 'review-proof': `file:${join(root, 'review-proof-1.0.0.tgz')}` } }));
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  for (const name of REVIEW_BUILD_PACKAGES) {
    const dir = join(repo, 'packages', name.split('/')[1]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'test.cjs'), "require('node:assert/strict').equal(require('review-proof'),42); console.log('dependency loaded: 42')");
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: {
      build: `node -e "require('node:assert/strict').equal(require('review-proof'),42)"`,
      test: 'node test.cjs',
    } }));
  }
  execFileSync(npm, ['install', '--package-lock-only', '--ignore-scripts'], { cwd: repo, stdio: 'ignore' });
  await prepareDependencyGeneration({ root: repo, store: join(root, 'store'), npm, cache: join(root, 'cache') });
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Proof', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'Fixture');
  const matching = git('rev-parse', 'HEAD');
  // Changing only lockfile bytes must invalidate reuse even with the same packages.
  writeFileSync(join(repo, 'package-lock.json'), readFileSync(join(repo, 'package-lock.json'), 'utf8') + '\n');
  git('add', 'package-lock.json');
  git('-c', 'user.name=Proof', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'Different lockfile');
  const changed = git('rev-parse', 'HEAD');
  git('checkout', '-q', matching);
  // Reuse must point workspace links at committed review files, not this dirty source.
  writeFileSync(join(repo, 'packages/body/test.cjs'), "throw new Error('source workspace was used instead of exact head');");
  process.env.PATH = await installDependencyNpmGuard(join(root, 'home'), npm, oldPath, [join(repo, 'node_modules')]);
  process.chdir(repo);
  for (const [head, reuse] of [[matching, true], [changed, false]]) {
    const result = reviewExactHead([head, '--', '@beeline/body:proof']);
    assert.equal(result.ok, true);
    assert.equal(result.verdicts.some(step => step.detail.includes('reused')), reuse);
    assert.ok(result.verdicts.some(step => step.name.startsWith('test ') && step.status));
  }
  console.log('REVIEW-DEPS-1 PASS: matching generation reused; changed lock installed privately; both exact heads built and tested.');
} finally {
  process.chdir(before);
  process.env.PATH = oldPath;
  rmSync(root, { recursive: true, force: true });
}
