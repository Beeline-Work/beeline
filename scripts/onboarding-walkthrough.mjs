/** Run the real Android path three times. No fake GitHub server or merge shortcut. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const login = process.env.ONBOARDING_GITHUB_LOGIN;
const google = process.env.ONBOARDING_PROVIDER === 'google';
if (google && (!process.env.ONBOARDING_GOOGLE_EMAIL || ['lunchboxfortwo@gmail.com','lunchbox@trustysquire.ai'].includes(process.env.ONBOARDING_GOOGLE_EMAIL.toLowerCase())))
  throw new Error('Google walkthrough requires a dedicated ONBOARDING_GOOGLE_EMAIL test account.');
const device = process.env.ONBOARDING_ANDROID_DEVICE;
const switchId = process.env.ONBOARDING_SWITCH_REPOSITORY_ID;
const switchName = process.env.ONBOARDING_SWITCH_REPOSITORY_NAME;
if (!login || login.toLowerCase() === 'lunchboxfortwo' || !/^[a-z\d-]+$/i.test(login))
  throw new Error('Set ONBOARDING_GITHUB_LOGIN to a dedicated test account; personal acceptance repos are forbidden.');
if (!device?.startsWith('emulator-') || !/^\d+$/.test(switchId ?? '') || !switchName?.startsWith(`${login}/`))
  throw new Error('Set an isolated ONBOARDING_ANDROID_DEVICE and a test-account switch repository id/name.');
for (const binary of ['adb', 'maestro', 'ffmpeg']) {
  const probe = spawnSync(binary, ['--version'], { stdio: 'ignore' });
  if (probe.error) throw new Error(`${binary} must be installed before the walkthrough starts`);
}
const output = resolve(process.env.ONBOARDING_OUTPUT_DIR ?? 'artifacts/onboarding-walkthrough');
await mkdir(output, { recursive: true });
const runs = [];
for (let run = 1; run <= 3; run++) {
  const folder = resolve(output, `run-${run}`);
  await mkdir(folder, { recursive: true });
  const segments = [];
  let recording = true;
  let recorder;
  const film = (async () => {
    for (let segment = 1; recording; segment++) {
      const remote = `/sdcard/beeline-onboarding-${run}-${segment}.mp4`;
      const local = resolve(folder, `segment-${segment}.mp4`);
      recorder = spawn('adb', ['-s', device, 'shell', 'screenrecord', '--time-limit', '180', remote], { stdio: 'ignore' });
      await new Promise(resolveExit => recorder.once('exit', resolveExit));
      const pull = spawnSync('adb', ['-s', device, 'pull', remote, local], { encoding: 'utf8' });
      if (pull.status === 0) segments.push(local);
      spawnSync('adb', ['-s', device, 'shell', 'rm', remote], { stdio: 'ignore' });
    }
  })();
  const startedAt = new Date().toISOString();
  const logs = [];
  const command = spawn('maestro', ['--device', device, 'test', '--test-output-dir', folder,
    '-e', `ONBOARDING_GITHUB_LOGIN=${login}`, '-e', `ONBOARDING_SWITCH_REPOSITORY_ID=${switchId}`,
    '-e', `ONBOARDING_SWITCH_REPOSITORY_NAME=${switchName}`, '-e', `ONBOARDING_INVITE_URL=${process.env.ONBOARDING_INVITE_URL ?? ''}`,
    ...(google ? ['-e', `ONBOARDING_GOOGLE_EMAIL=${process.env.ONBOARDING_GOOGLE_EMAIL}`, 'apps/mobile/e2e/google-repository-onboarding.yaml'] : ['apps/mobile/e2e/repository-onboarding.yaml'])], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [command.stdout, command.stderr]) stream.on('data', chunk => { logs.push(chunk.toString()); process.stdout.write(chunk); });
  let status;
  try {
    status = await new Promise((resolveExit, reject) => { command.once('exit', resolveExit); command.once('error', reject); });
  } finally {
    recording = false;
    const pids = spawnSync('adb', ['-s', device, 'shell', 'pidof', 'screenrecord'], { encoding: 'utf8' }).stdout?.trim();
    if (pids && /^\d+(?:\s+\d+)*$/.test(pids)) spawnSync('adb', ['-s', device, 'shell', 'kill', '-2', ...pids.split(/\s+/)], { stdio: 'ignore' });
    else recorder?.kill('SIGINT');
    await film;
  }
  await writeFile(resolve(folder, 'maestro.log'), logs.join(''));
  await writeFile(resolve(folder, 'segments.txt'), segments.map(path => `file '${path.replaceAll("'", "'\\''")}'`).join('\n'));
  if (segments.length) {
    const combine = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', resolve(folder, 'segments.txt'), '-c', 'copy', resolve(folder, 'walkthrough.mp4')], { stdio: 'ignore' });
    if (combine.status !== 0) throw new Error(`Could not assemble recording for run ${run}`);
  }
  runs.push({ run, startedAt, endedAt: new Date().toISOString(), status, recordings: segments.length,
    humanActionsBeforeFirstCommit: Number(logs.join('').match(/HUMAN_ACTIONS_BEFORE_FIRST_COMMIT=(\d+)/)?.[1] ?? NaN) || null, targetHumanActionsBeforeFirstCommit: 4 });
  await writeFile(resolve(output, 'runs.json'), JSON.stringify({ login, device, runs }, null, 2));
  if (status !== 0) throw new Error(`Walkthrough run ${run} failed; see ${folder}`);
}
console.log(`Three consecutive UI walkthroughs passed. Recordings and logs: ${output}`);
