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

export function run() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  const gh = args => execFileSync('gh', args, { encoding: 'utf8' });
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/actions/artifacts?name=unified-release-index&per_page=100`]));
  const candidates = pages.flatMap(page => page.artifacts).filter(a => !a.expired && a.workflow_run?.id).sort((a,b) => b.created_at.localeCompare(a.created_at));
  let last;
  for (const artifact of candidates) {
    const result = JSON.parse(gh(['api', `repos/${repository}/actions/runs/${artifact.workflow_run.id}`]));
    if (result.conclusion === 'success') { last = artifact; break; }
  }
  if (!last) throw new Error('No successful release index is available; cannot establish shipped native runtime.');
  const temp = mkdtempSync(join(tmpdir(), 'release-preflight-'));
  try {
    gh(['run', 'download', String(last.workflow_run.id), '--repo', repository, '--name', 'unified-release-index', '--dir', temp]);
    const index = JSON.parse(readFileSync(join(temp, 'release-attempt.json'), 'utf8'));
    const sha = index.components?.['mobile-native']?.sourceSha;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Release index has no immutable mobile-native source SHA.');
    const released = JSON.parse(execFileSync('git', ['show', `${sha}:apps/mobile/native-fingerprint.json`], { encoding: 'utf8' }));
    const current = JSON.parse(readFileSync('apps/mobile/native-fingerprint.json', 'utf8'));
    const results = compareReleasedRuntime(current, released);
    const report = `## Native release preflight\nReleased native source: ${sha}\n` + results.map(r => `- ${r.platform}: ${r.ok ? 'PASS' : 'FAIL'}; released runtime ${r.released}, current ${r.current}`).join('\n') + '\n';
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    if (results.some(r => !r.ok)) throw new Error('Native runtime/fingerprint differs from the last released native binary. A store build or explicit verified pin restore is needed before routine OTA release.');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
