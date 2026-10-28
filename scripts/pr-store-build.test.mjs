import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeBuildNotice } from './pr-store-build.mjs';
const pins = (android, ios) => ({android:{runtimeVersion:android},ios:{runtimeVersion:ios}});
test('runtime changes flag the affected store before merge', () => {
  assert.match(storeBuildNotice(pins('40','36'), pins('41','36')), /android: 40 → 41/);
  assert.match(storeBuildNotice(pins('41','36'), pins('41','37')), /ios: 36 → 37/);
  assert.match(storeBuildNotice(pins('41','36'), pins('40','36')), /pin-restore approval/);
});
test('metadata and unchanged runtime pins stay quiet', () => {
  assert.equal(storeBuildNotice(pins('41','36'), {...pins('41','36'), fingerprints:{android:'new'}}), '');
});

test('Reproduction store-build: PR command annotates a real git pin diff and stays quiet otherwise', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'pr-store-build-'));
  const summary = join(root, 'summary.md');
  const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim();
  const cli = base => execFileSync(process.execPath, [fileURLToPath(new URL('./pr-store-build.mjs', import.meta.url)), base], {
    cwd:root, encoding:'utf8', env:{...process.env, GITHUB_STEP_SUMMARY:summary},
  });
  try {
    git('init','-q');
    git('config','user.name','Fixture'); git('config','user.email','fixture@example.test');
    mkdirSync(join(root,'apps/mobile'), {recursive:true});
    const write = pin => writeFileSync(join(root,'apps/mobile/native-fingerprint.json'), JSON.stringify(pins(pin,'36')));
    write('40'); git('add','.'); git('commit','-qm','baseline');
    const base = git('rev-parse','HEAD');
    assert.equal(cli(base), ''); assert.equal(existsSync(summary), false);
    write('41'); git('add','.'); git('commit','-qm','runtime bump');
    assert.match(cli(base), /::warning title=Store build required::.*android: 40 → 41/);
    assert.match(readFileSync(summary,'utf8'), /Store build required/);
  } finally { rmSync(root, {recursive:true,force:true}); }
});
