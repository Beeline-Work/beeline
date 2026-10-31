import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkDocument, checkRepository } from './release-artifact-allowlist.mjs';

const workflow = (steps) => `name: probe\non: workflow_dispatch\njobs:\n  job:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;

test('every release workflow and the actions it uses hand over build outputs only', () => {
  const { violations, checked } = checkRepository();
  assert.deepEqual(violations, []);
  for (const file of ['.github/workflows/unified-release.yml', '.github/actions/mobile-ota-leg/action.yml',
    '.github/actions/server-leg/action.yml', '.github/actions/daemon-leg/action.yml', '.github/workflows/desktop.yml']) {
    assert.ok(checked.includes(file), file);
  }
});

// Reproduction NEW-STATE-FILE: someone adds a cross-step state file to a
// release workflow; CI must fail.
test('NEW-STATE-FILE: a new state artifact, a cross-run download or an artifact lookup fails the check', () => {
  const upload = checkDocument('.github/workflows/unified-release.yml', workflow(`      - uses: actions/upload-artifact@v4
        with:
          name: release-ledger-\${{ github.run_id }}
          path: ledger.json
`));
  assert.equal(upload.violations.length, 1);
  assert.match(upload.violations[0], /"release-ledger-\$\{\{ github\.run_id \}\}", which is not an allowed build output/);

  const crossRun = checkDocument('.github/workflows/unified-release.yml', workflow(`      - uses: actions/download-artifact@v4
        with:
          name: mobile-native-android-build-\${{ needs.initialize.outputs.release_id }}
          run-id: \${{ steps.find.outputs.run_id }}
`));
  assert.equal(crossRun.violations.length, 1);
  assert.match(crossRun.violations[0], /from another run/);

  const lookup = checkDocument('.github/workflows/unified-release.yml', workflow(`      - uses: actions/github-script@v7
        with:
          script: |
            await github.rest.actions.listArtifactsForRepo({ owner: 'o', repo: 'r' })
      - run: gh run download 123 --name anything
`));
  assert.equal(lookup.violations.length, 2);

  const cache = checkDocument('.github/workflows/unified-release.yml', workflow(`      - uses: actions/cache@v4
        with:
          path: state.json
          key: release-state-\${{ github.sha }}
`));
  assert.match(cache.violations[0], /caches "release-state-/);
});

test('the check follows local actions a release workflow uses', () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-allowlist-'));
  try {
    const write = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write('.github/workflows/unified-release.yml', workflow('      - uses: ./.github/actions/leg\n'));
    write('.github/actions/leg/action.yml', `name: leg\nruns:\n  using: composite\n  steps:\n    - uses: actions/upload-artifact@v4\n      with:\n        name: ota-ledger\n        path: x\n`);
    const { violations } = checkRepository(root, ['.github/workflows/unified-release.yml']);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^\.github\/actions\/leg\/action\.yml: .*"ota-ledger"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
