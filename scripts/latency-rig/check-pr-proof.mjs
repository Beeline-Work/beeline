import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const paths = JSON.parse(readFileSync(new URL('./sensitive-paths.json', import.meta.url)));
export const cases = ['room-list-1', 'room-list-5', 'push-1', 'push-5', 'warm-room', 'send-text'];

/** Require measured before/after p95 values for the fixed nightly matrix. */
export function checkProof(files, body) {
  if (!files.some(file => paths.some(prefix => file.startsWith(prefix)))) return;
  const line = body?.split(/\r?\n/).find(line => line.startsWith('Rig before/after: '));
  for (const name of cases) {
    const match = line?.match(new RegExp(`(?:^|[ ;])${name}=([0-9]+(?:\\.[0-9]+)?)\\s*->\\s*([0-9]+(?:\\.[0-9]+)?)ms(?:[ ;]|$)`));
    if (!match || !Number.isFinite(Number(match[1])) || !Number.isFinite(Number(match[2])))
      throw new Error(`Missing rig proof for ${name}. Add one line: Rig before/after: ${cases.map(name => `${name}=BEFORE->AFTERms`).join('; ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr) throw new Error('Pull request context required');
  const files = execFileSync('git', ['diff', '--name-only', `${pr.base.sha}...${pr.head.sha}`], { encoding: 'utf8' }).trim().split('\n');
  checkProof(files, pr.body);
  console.log('Latency rig proof accepted.');
}
