import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = join(dirname(fileURLToPath(import.meta.url)), 'verify-referenced-paths.mjs');

function repository(files) {
  const root = mkdtempSync(join(tmpdir(), 'referenced-paths-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}
const run = (root) => spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });

const references = {
  'package.json': JSON.stringify({ scripts: { proof: 'node --import tsx scripts/prove-thing.mjs' } }),
  'apps/mobile/package.json': JSON.stringify({ scripts: { lint: 'vitest run sources/lint' } }),
  'apps/mobile/sources/keep.ts': '',
  '.github/workflows/release.yml':
    'jobs:\n  proof:\n    steps:\n      - working-directory: apps/mobile\n        run: node scripts/release-proof.mjs --ota\n',
  'scripts/walk/systemd/walk.service':
    '[Service]\nExecStart=%h/.local/share/walk/checkout/scripts/walk/walk.sh\n',
  'apps/body/src/review-skill.ts': 'export const skill = `run npx vitest run sources/buzz/design-lint`;\n',
};

test('fails on each kind of reference to a deleted file, then passes once the files exist', () => {
  const root = repository(references);
  try {
    const failed = run(root);
    assert.equal(failed.status, 1, failed.stdout);
    for (const reference of [
      'package.json scripts.proof  scripts/prove-thing.mjs',
      'apps/mobile/package.json scripts.lint  sources/lint',
      '.github/workflows/release.yml:5  scripts/release-proof.mjs',
      'scripts/walk/systemd/walk.service:2  scripts/walk/walk.sh',
      'apps/body/src/review-skill.ts:1  sources/buzz/design-lint',
    ])
      assert.ok(failed.stderr.includes(reference), `${reference}\n${failed.stderr}`);

    for (const path of [
      'scripts/prove-thing.mjs',
      'apps/mobile/sources/lint.test.ts',
      'apps/mobile/scripts/release-proof.mjs',
      'scripts/walk/walk.sh',
      'apps/mobile/sources/buzz/design-lint.ts',
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), '');
    }
    execFileSync('git', ['add', '-A'], { cwd: root });
    const passed = run(root);
    assert.equal(passed.status, 0, passed.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores runner expressions, outputs, regular expressions and git-ignored artifacts', () => {
  const root = repository({
    '.gitignore': 'web/dl/*.tar.gz\n',
    'web/index.html': '',
    'apps/server/src/a.ts': '',
    'package.json': JSON.stringify({ scripts: { build: 'tsc && node apps/server/dist/cli.js' } }),
    '.github/workflows/ci.yml': [
      'jobs:',
      '  ci:',
      '    steps:',
      '      - run: tar -czf web/dl/beeline.tar.gz . && cat "$RUNNER_TEMP/apps/x.json"',
      "      - run: '[[ $file =~ ^apps/(body|server)/ ]]'",
      "      - run: echo ${{ hashFiles('apps/server/contracts/*.sql') }}",
      '      - uses: actions/upload-artifact@v4',
      '        with:',
      '          path: |',
      '            web/release-notes.json',
      '',
    ].join('\n'),
  });
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
