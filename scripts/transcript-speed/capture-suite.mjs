/** Run one platform serially against its already prepared local fixture build. */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [platform, destination] = process.argv.slice(2);
if (!['android', 'web', 'desktop'].includes(platform) || !destination)
  throw new Error('Usage: node scripts/transcript-speed/capture-suite.mjs android|web|desktop output-directory');
const output = path.resolve(destination);
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'host.json'), JSON.stringify({ startedAt: new Date().toISOString(), host: os.hostname(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, loadAverage: os.loadavg(), platform: os.platform(), kernel: os.release(), checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }, null, 2));
const run = (script, directory, env = process.env) => execFileSync(process.execPath,
  [`scripts/transcript-speed/${script}.mjs`, ...(directory ? [path.join(output, directory)] : [])],
  { stdio: 'inherit', env });
run('reset');
run(`capture-${platform}`, 'scenarios');
if (platform === 'android') {
  run('capture-keypaint', 'keypaint', { ...process.env, TRANSCRIPT_CAPTURE_JS: '1' });
  run('capture-keypaint', 'overhead-inactive', { ...process.env, TRANSCRIPT_CAPTURE_JS: '1', TRANSCRIPT_SAMPLER: 'off' });
  run('capture-opens', 'opens');
} else {
  run('capture-overhead', 'overhead');
  run('capture-browser-opens', 'opens');
}
console.log(`Completed ${platform} captures: ${output}`);
