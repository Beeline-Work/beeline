import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeVersionsFromConfig } from '../apps/mobile/scripts/native-fingerprint.mjs';

export function compareReleasedRuntime(current, released) {
  const pins = runtimeVersionsFromConfig(current);
  const previous = runtimeVersionsFromConfig(released);
  const results = ['android', 'ios'].map(platform => ({
    platform, current: pins[platform], released: previous[platform],
    ok: pins[platform] === previous[platform] && current.fingerprints?.[platform] === released.fingerprints?.[platform],
  }));
  return results;
}

export function enforceReleasedRuntime(results, { reportOnly = false, warn = console.warn } = {}) {
  if (results.every(result => result.ok)) return;
  const message = 'Native runtime/fingerprint differs from the last released native binary. A store build or explicit verified pin restore is needed before routine OTA release.';
  if (reportOnly) warn(`::warning::${message}`);
  else throw new Error(message);
}

export function run() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  const temp = mkdtempSync(join(tmpdir(), 'release-preflight-'));
  try {
    // The newest published GitHub Release's record names the commit the
    // live store binaries were built from.
    execFileSync(process.execPath, [new URL('./release-record.mjs', import.meta.url).pathname, 'previous', '--output', join(temp, 'release.json')], { encoding: 'utf8' });
    const index = JSON.parse(readFileSync(join(temp, 'release.json'), 'utf8'));
    const sha = index.components?.['mobile-native']?.sourceSha;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Release record has no immutable mobile-native source SHA.');
    const released = JSON.parse(execFileSync('git', ['show', `${sha}:apps/mobile/native-fingerprint.json`], { encoding: 'utf8' }));
    const current = JSON.parse(readFileSync('apps/mobile/native-fingerprint.json', 'utf8'));
    const results = compareReleasedRuntime(current, released);
    const report = `## Native release preflight\nReleased native source: ${sha}\n` + results.map(r => `- ${r.platform}: ${r.ok ? 'PASS' : 'FAIL'}; released runtime ${r.released}, current ${r.current}`).join('\n') + '\n';
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    enforceReleasedRuntime(results, { reportOnly: process.env.PREFLIGHT_REPORT_ONLY === 'true' });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
