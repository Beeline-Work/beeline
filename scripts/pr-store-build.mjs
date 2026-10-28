import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function storeBuildNotice(before, after) {
  const changes = ['android', 'ios'].flatMap(platform => {
    const oldPin = before[platform]?.runtimeVersion;
    const newPin = after[platform]?.runtimeVersion;
    return oldPin === newPin ? [] : [`${platform}: ${oldPin ?? 'unset'} → ${newPin ?? 'unset'}`];
  });
  return changes.length ? `Store build required (${changes.join('; ')}). Release with the changed platform's native build and an explicit store track. A restore to an already shipped runtime requires explicit pin-restore approval.` : '';
}

export function checkStoreBuild(base, head = 'HEAD') {
  const read = ref => JSON.parse(execFileSync('git', ['show', `${ref}:apps/mobile/native-fingerprint.json`], {encoding:'utf8'}));
  return storeBuildNotice(read(base), read(head));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2];
  if (!base) throw new Error('Usage: node scripts/pr-store-build.mjs <base> [head]');
  const notice = checkStoreBuild(base, process.argv[3]);
  if (notice) {
    console.log(`::warning title=Store build required::${notice}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Store build required\n\n${notice}\n`);
  }
}
