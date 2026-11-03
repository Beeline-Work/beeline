import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTests } from './workspace-test-selection.mjs';

export function selectedWorkspaceTests({ selection, sha, group, discovered }) {
  if (!selection || selection.version !== 1 || selection.sha !== sha || selection.mode === 'full') return null;
  if (selection.mode !== 'subset' || !Array.isArray(selection.groups?.[group])) return null;
  const files = selection.groups[group];
  if (new Set(files).size !== files.length || files.some(file => !discovered.includes(file))) return null;
  return files;
}

function main() {
  const group = process.argv[2];
  assert.ok(['body', 'mobile'].includes(group), 'Expected body or mobile');
  const root = process.cwd();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let selection, files = null;
  try {
    selection = JSON.parse(process.env.WORKSPACE_TEST_SELECTION || 'null');
    if (selection?.mode === 'subset') files = selectedWorkspaceTests({ selection, sha, group, discovered: discoverTests(root, [group])[group] });
  } catch (error) { console.log(`Full ${group} fallback: ${error.message}`); }
  if (files?.length === 0) { console.log(`No ${group} tests affected at verified head ${sha}`); return; }
  const directory = join(root, 'apps', group);
  const vitest = join(root, group === 'mobile' ? 'apps/mobile/node_modules/vitest/vitest.mjs' : 'node_modules/vitest/vitest.mjs');
  const workers = Number(process.env.CI_TEST_WORKERS || 2);
  assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= 2, 'Expected one or two workers');
  const args = [vitest, 'run', ...(files?.map(file => relative(directory, join(root, file))) ?? []), `--maxWorkers=${workers}`, '--minWorkers=1'];
  if (group === 'mobile') args.push('--exclude', 'sources/config/nativeFingerprint.test.ts');
  console.log(`${group}: ${files ? `${files.length} affected files` : 'full suite'} at ${sha}`);
  const result = spawnSync(process.execPath, args, { cwd: directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
