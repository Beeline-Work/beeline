/** Opt-in real-Groq replay; normal test runs never execute network benchmarks. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, symlinkSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const evidence = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(evidence, '../..');
const repo = resolve(mobile, '../..');
const clips = resolve(process.env.DICTATION_CLIP_DIR ?? join(evidence, '.local/clips'));
const output = resolve(process.env.DICTATION_OUTPUT_DIR ?? join(evidence, '.local/results'));
const base = process.env.DICTATION_SERVER_URL ?? 'http://127.0.0.1:19347';
if (!['localhost', '127.0.0.1', '::1'].includes(new URL(base).hostname)) throw new Error('Use an isolated loopback staging server');
const repetitions = Number(process.env.DICTATION_RUNS ?? 5);
if (!Number.isInteger(repetitions) || repetitions < 5) throw new Error('Evidence requires at least five repetitions');
mkdirSync(output, { recursive: true });
execFileSync('python', [join(evidence, 'prepare-clips.py'), clips], { stdio: 'inherit' });
let ready = false;
for (let n = 0; n < 30; n++) {
  try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
  await new Promise(done => setTimeout(done, 1000));
}
if (!ready) throw new Error('Start the real isolated Beeline server with Groq configured first');
const scratch = mkdtempSync(join(tmpdir(), 'beeline-dictation-main-'));
const tar = join(scratch, 'source.tar');
const fd = openSync(tar, 'w');
execFileSync('git', ['archive', '--format=tar', '7753811', 'apps/mobile/sources'], { cwd: repo, stdio: ['ignore', fd, 'inherit'] });
closeSync(fd);
execFileSync('tar', ['-xf', tar, '-C', scratch]);
symlinkSync(join(mobile, 'node_modules'), join(scratch, 'apps/mobile/node_modules'));
symlinkSync(join(repo, 'node_modules'), join(scratch, 'node_modules'));
const manifest = JSON.parse(readFileSync(join(clips, 'clip-manifest.json'), 'utf8'));
const allScenarios = [ ['main', 'never'], ['main', 'immediate'], ['branch', 'never'], ['branch', 'immediate'] ];
const only = process.env.DICTATION_ONLY;
if (only && !['main', 'branch'].includes(only)) throw new Error('DICTATION_ONLY must be main or branch');
const scenarios = allScenarios.filter(([source]) => !only || source === only);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const results = [];
try {
  for (const [source, endMode] of scenarios) {
    const label = `${source}-${endMode}`;
    const log = openSync(join(output, `${label}.log`), 'w');
    console.log(`Running ${label}: real human clips, real server/Groq, ${repetitions} parallel repetitions per take`);
    try {
      await new Promise((done, fail) => {
        const child = spawn(join(mobile, 'node_modules/.bin/vitest'), ['run', '--config', join(evidence, 'vitest.replay.config.mts')], {
          cwd: mobile,
          env: { ...process.env, DICTATION_SERVER_URL: base, DICTATION_SOURCE: source,
            DICTATION_BASELINE_SOURCE: join(scratch, 'apps/mobile/sources'), DICTATION_CLIP_DIR: clips,
            DICTATION_LABEL: label, DICTATION_END_MODE: endMode, DICTATION_RUNS: String(repetitions),
            DICTATION_RESULT_PATH: join(output, `${label}.json`) },
          stdio: ['ignore', log, log],
        });
        child.once('error', fail);
        child.once('exit', code => code === 0 ? done() : fail(new Error(`${label} failed (${code}); see its log`)));
      });
    } finally { closeSync(log); }
    const result = JSON.parse(readFileSync(join(output, `${label}.json`), 'utf8'));
    const sourceRoot = source === 'main' ? join(scratch, 'apps/mobile/sources') : join(mobile, 'sources');
    result.sourceSha256 = Object.fromEntries(['buzz/speech-input.ts', 'buzz/speech-transcription.ts', 'components/buzz/ConversationComposer.tsx'].map(file => [file, hash(join(sourceRoot, file))]));
    results.push(result);
    console.log(`Finished ${label}`);
  }
  writeFileSync(join(output, 'replay-results.json'), JSON.stringify({ timingKind: 'harness, not device', harnessSha256: hash(join(evidence, 'replay.proof.tsx')), dirtyWorkingTree: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()), baselineCommit: execFileSync('git', ['rev-parse', '7753811'], { cwd: repo, encoding: 'utf8' }).trim(), branchCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), repetitions, concurrentRepetitions: repetitions, manifest, results }, null, 2)+'\n');
} finally { rmSync(scratch, { recursive: true, force: true }); }
