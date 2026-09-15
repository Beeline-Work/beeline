#!/usr/bin/env node
/**
 * Release proof: run the Maestro flows in apps/mobile/maestro/ against the
 * exact Android artifact a release is about to promote, on the shared
 * emulator rig (emulator-5554 by default).
 *
 * What it proves, per flow:
 *   room-renders       a repo-bound Room renders its transcript AND composer
 *                      (the flow that would have caught the 2026-09-14
 *                      blank-screen release)
 *   corner-opens       a corner opens and renders its objective line
 *   settings-workbench the settings workbench (Connectors) is reachable
 *   signed-out         the sign-in surface renders for a signed-out identity
 *                      (thrown into a throwaway secondary Android user, so
 *                      the rig's signed-in session is never touched)
 *
 * Usage:
 *   node scripts/release-proof.mjs --apk app-release.apk
 *   node scripts/release-proof.mjs --aab app-release.aab
 *
 * The rig's signed-in session (GitHub user methoxine-debug on emulator-5554)
 * must already exist: the runner never scripts a sign-in. If the app starts
 * signed out, room/corner/settings flows cannot run and the runner exits 2
 * with a loud message.
 *
 * Exit codes: 0 all flows passed · 1 a flow failed · 2 preflight failure
 * (device, artifact, or missing signed-in session).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = resolve(SCRIPT_DIR, '..');
const MAESTRO_DIR = join(MOBILE_DIR, 'maestro');
const APP_ID = 'app.usebeeline';
const LAUNCH_ACTIVITY = 'app.usebeeline/.MainActivity';
const MAESTRO_BIN = process.env.MAESTRO_BIN ?? join(process.env.HOME ?? '', '.maestro/bin/maestro');
const BUNDLETOOL_VERSION = '1.17.0';
const BUNDLETOOL_URL = `https://repo1.maven.org/maven2/com/android/tools/build/bundletool/${BUNDLETOOL_VERSION}/bundletool-${BUNDLETOOL_VERSION}.jar`;
const LOCK_STALE_AFTER_MS = 30 * 60 * 1000;

const FLOWS = [
  { name: 'room-renders', yaml: join(MAESTRO_DIR, 'room-renders.yaml'), needsRoom: true },
  { name: 'corner-opens', yaml: join(MAESTRO_DIR, 'corner-opens.yaml'), needsRoom: true, needsCorner: true },
  { name: 'settings-workbench', yaml: join(MAESTRO_DIR, 'settings-workbench.yaml'), needsRoom: false },
  { name: 'signed-out', yaml: join(MAESTRO_DIR, 'signed-out.yaml'), needsRoom: false, secondaryUser: true },
];

function parseArgs(argv) {
  const args = { device: 'emulator-5554', out: join(MOBILE_DIR, 'release-proof-out') };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apk') args.apk = resolve(argv[++i]);
    else if (flag === '--aab') args.aab = resolve(argv[++i]);
    else if (flag === '--device') args.device = argv[++i];
    else if (flag === '--out') args.out = resolve(argv[++i]);
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      fail(`Unknown argument: ${flag}`);
    }
  }
  if (args.help) return args;
  if (!args.apk && !args.aab) fail('Provide exactly one of --apk <path> or --aab <path>.');
  if (args.apk && args.aab) fail('Provide only one of --apk and --aab.');
  if (args.apk && !existsSync(args.apk)) fail(`APK not found: ${args.apk}`);
  if (args.aab && !existsSync(args.aab)) fail(`AAB not found: ${args.aab}`);
  return args;
}

function fail(message, code = 1) {
  console.error(`release-proof: ${message}`);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'buffer',
    timeout: opts.timeout ?? 10 * 60 * 1000,
    env: opts.env ?? process.env,
  });
  const stdout = res.stdout ? res.stdout.toString() : '';
  const stderr = res.stderr ? res.stderr.toString() : '';
  if (opts.allowFailure) return { ok: res.status === 0, stdout, stderr, status: res.status };
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})\n${stdout}\n${stderr}`);
  }
  return { ok: true, stdout, stderr, status: res.status };
}

function adb(device, args, opts = {}) {
  return run('adb', ['-s', device, ...args], opts);
}

function adbShell(device, command, opts = {}) {
  return adb(device, ['shell', command], opts);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Rig lock: lanes hold /tmp/<serial>.lock before touching the shared device.
// A stale lock (dead holder, or older than LOCK_STALE_AFTER_MS) is stolen.
// ---------------------------------------------------------------------------

function lockPath(device) {
  return `/tmp/${device}.lock`;
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function acquireLock(device, waitMs = 10 * 60 * 1000) {
  const path = lockPath(device);
  const deadline = Date.now() + waitMs;
  for (;;) {
    let holder = null;
    try {
      const raw = readFileSync(path, 'utf8');
      const [pid, ts] = raw.trim().split(/\s+/);
      holder = { pid: Number(pid), ts: Number(ts) || 0 };
    } catch {
      holder = null;
    }
    const stale =
      !holder ||
      (!pidAlive(holder.pid) && holder.pid !== process.pid) ||
      (holder.ts > 0 && Date.now() - holder.ts > LOCK_STALE_AFTER_MS && holder.pid !== process.pid);
    if (stale) {
      writeFileSync(path, `${process.pid} ${Date.now()}\n`);
      return path;
    }
    if (Date.now() > deadline) {
      fail(`/tmp/${device}.lock is held by pid ${holder?.pid} — another lane is using the device. ` +
        'Wait for it or steal the lock once it is provably dead.');
    }
    await sleep(5000);
  }
}

function releaseLock(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    if (Number(raw.trim().split(/\s+/)[0]) === process.pid) rmSync(path, { force: true });
  } catch {
    /* nothing to release */
  }
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

function adbDevices() {
  const res = run('adb', ['devices']);
  return res.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.endsWith('\tdevice') || l.endsWith('\tdevice\n') || /device$/.test(l))
    .map((l) => l.split('\t')[0]);
}

async function waitForDevice(device, timeoutMs = 120 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = adb(device, ['get-state'], { allowFailure: true });
    if (res.ok && res.stdout.trim() === 'device') {
      const booted = adbShell(device, ['getprop', 'sys.boot_completed'].join(' '), { allowFailure: true });
      if (booted.ok && booted.stdout.trim() === '1') return;
    }
    await sleep(3000);
  }
  fail(`Device ${device} did not become ready in ${Math.round(timeoutMs / 1000)}s.`);
}

function findAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    '/home/lunchbox/android-sdk',
    join(process.env.HOME ?? '', 'Android/Sdk'),
    '/opt/android-sdk',
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'emulator', 'emulator'))) return c;
  }
  return null;
}

/**
 * If the device is absent, try to boot the rig AVD headlessly. Works only on
 * hosts where the AVD (and its persisted session data) exist. The emulator is
 * never stopped afterwards.
 */
async function ensureDevice(device, avd) {
  if (adbDevices().includes(device)) {
    await waitForDevice(device);
    return;
  }
  const sdk = findAndroidSdk();
  if (!sdk) {
    fail(`Device ${device} is not connected and no Android SDK with an emulator was found. ` +
      'On CI hosts without the rig (e.g. no AVD provisioned), the release-proof lane cannot run.');
  }
  const emulatorBin = join(sdk, 'emulator', 'emulator');
  const avds = run(emulatorBin, ['-list-avds'], { timeout: 30 * 1000 }).stdout.trim().split('\n');
  if (!avds.includes(avd)) {
    fail(`Device ${device} is not connected and AVD "${avd}" does not exist on this host. ` +
      'The signed-in session lives only on the rig host.');
  }
  const port = device.startsWith('emulator-') ? Number(device.slice('emulator-'.length)) : null;
  console.log(`release-proof: booting AVD ${avd} headlessly as ${device} (left running afterwards)`);
  const child = spawn(
    emulatorBin,
    ['@' + avd, '-port', String(port ?? 5554), '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save'],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  await waitForDevice(device, 300 * 1000);
}

// ---------------------------------------------------------------------------
// App install
// ---------------------------------------------------------------------------

function sideloadKeystore() {
  const env = process.env;
  const keystorePath = env.BEELINE_SIDELOAD_KEYSTORE;
  if (keystorePath && existsSync(keystorePath)) {
    return {
      path: keystorePath,
      alias: env.BEELINE_SIDELOAD_KEY_ALIAS,
      storePass: env.BEELINE_SIDELOAD_STORE_PASSWORD,
      keyPass: env.BEELINE_SIDELOAD_KEY_PASSWORD,
    };
  }
  if (env.ANDROID_SIDELOAD_KEYSTORE_B64) {
    const decoded = Buffer.from(env.ANDROID_SIDELOAD_KEYSTORE_B64, 'base64');
    const path = `/tmp/beeline-sideload-${createHash('sha1').update(decoded).digest('hex').slice(0, 12)}.jks`;
    writeFileSync(path, decoded);
    return {
      path,
      alias: env.ANDROID_SIDELOAD_KEY_ALIAS,
      storePass: env.ANDROID_SIDELOAD_STORE_PASSWORD,
      keyPass: env.ANDROID_SIDELOAD_KEY_PASSWORD,
    };
  }
  fail('AAB install needs the sideload keystore: set BEELINE_SIDELOAD_KEYSTORE (path) or ' +
    'ANDROID_SIDELOAD_KEYSTORE_B64 (repository secret), plus the matching _KEY_ALIAS / _STORE_PASSWORD / _KEY_PASSWORD.');
  return null;
}

function ensureBundletool() {
  const cache = join(process.env.HOME ?? '/tmp', '.cache/beeline/bundletool');
  const jar = join(cache, `bundletool-${BUNDLETOOL_VERSION}.jar`);
  if (!existsSync(jar)) {
    mkdirSync(cache, { recursive: true });
    console.log(`release-proof: downloading bundletool ${BUNDLETOOL_VERSION}`);
    run('curl', ['-fsSL', '-o', jar, BUNDLETOOL_URL], { timeout: 5 * 60 * 1000 });
  }
  return jar;
}

function installArtifact(device, args) {
  const installed = adbShell(device, 'pm path ' + APP_ID, { allowFailure: true });
  const alreadyInstalled = installed.ok && installed.stdout.trim().length > 0;
  if (args.apk) {
    console.log(`release-proof: installing ${args.apk}`);
    adb(device, ['install', '-r', '-d', args.apk], { timeout: 10 * 60 * 1000 });
    return 'apk';
  }
  const ks = sideloadKeystore();
  const jar = ensureBundletool();
  const apks = '/tmp/release-proof-universal.apks';
  rmSync(apks, { force: true });
  console.log(`release-proof: building universal APKs from ${args.aab} (re-signed with the sideload key so the rig session survives)`);
  run('java', [
    '-jar', jar, 'build-apks',
    '--bundle=' + args.aab,
    '--output=' + apks,
    '--mode=universal',
    '--ks=' + ks.path,
    '--ks-key-alias=' + ks.alias,
    '--ks-pass=pass:' + ks.storePass,
    '--key-pass=pass:' + (ks.keyPass ?? ks.storePass),
  ], { timeout: 15 * 60 * 1000 });
  run('java', ['-jar', jar, 'install-apks', '--apks=' + apks, '--device-id=' + device], { timeout: 10 * 60 * 1000 });
  rmSync(apks, { force: true });
  return 'aab';
}

// ---------------------------------------------------------------------------
// UI reading
// ---------------------------------------------------------------------------

function dumpUi(device, outDir, tag) {
  adbShell(device, 'uiautomator dump /sdcard/release-proof-dump.xml', { allowFailure: true });
  const res = adb(device, ['exec-out', 'cat', '/sdcard/release-proof-dump.xml'], { allowFailure: true });
  const xml = res.ok ? res.stdout.toString() : '';
  if (outDir && xml) writeFileSync(join(outDir, `dump-${tag}.xml`), xml);
  return xml;
}

async function waitForAnyResource(device, outDir, tag, needles, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let xml = '';
  while (Date.now() < deadline) {
    xml = dumpUi(device, outDir, tag);
    if (needles.some((n) => xml.includes(`resource-id="${n}"`))) return { xml, found: true };
    await sleep(2500);
  }
  return { xml, found: false };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function parseRoomIds(xml) {
  const re = new RegExp(`resource-id="room-(${UUID})"`, 'g');
  const ids = new Set();
  let m;
  while ((m = re.exec(xml))) ids.add(m[1]);
  return [...ids];
}

function parseCornerIds(xml) {
  const re = new RegExp(`resource-id="room-corner-(${UUID})"`, 'g');
  const reStatus = new RegExp(`resource-id="room-corner-status-(${UUID})"[^>]*>[\\s\\S]*?text="([^"]*)"`, 'g');
  const statuses = new Map();
  let m;
  while ((m = reStatus.exec(xml))) statuses.set(m[1], m[2]);
  const ids = new Set();
  while ((m = re.exec(xml))) ids.add(m[1]);
  return [...ids].map((id) => ({ id, status: statuses.get(id) ?? '' }));
}

function pickRoom(xml) {
  const ids = parseRoomIds(xml);
  if (!ids.length) fail('No room rows found on the room list — cannot run room flows.', 1);
  const override = process.env.RELEASE_PROOF_ROOM;
  if (override) {
    const match = ids.find((id) => id === override || id.startsWith(override));
    if (!match) fail(`RELEASE_PROOF_ROOM=${override} has no row on the current room list.`);
    return { id: match, roomIds: ids };
  }
  // A repo-bound room is the one carrying a corners toggle (corners exist only there).
  const repoBound = new RegExp(`resource-id="room-corners-toggle-(${UUID})"`, 'g');
  const bound = [...xml.matchAll(repoBound)].map((m) => m[1]);
  if (bound.length) return { id: bound[0], roomIds: ids };
  console.log('release-proof: WARNING — no repo-bound room on the deck; corner discovery will likely fail.');
  return { id: ids[0], roomIds: ids };
}

// ---------------------------------------------------------------------------
// Maestro
// ---------------------------------------------------------------------------

function maestroAvailable() {
  if (!existsSync(MAESTRO_BIN)) {
    const onPath = run('which', ['maestro'], { allowFailure: true });
    return onPath.ok;
  }
  return true;
}

function runMaestro(device, yamlPath, env = {}, outDir, tag) {
  if (!maestroAvailable()) fail(`Maestro not found at ${MAESTRO_BIN} (set MAESTRO_BIN to override).`);
  const args = ['test', '--device', device];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(yamlPath);
  const res = spawnSync(MAESTRO_BIN, args, { encoding: 'buffer', timeout: 10 * 60 * 1000 });
  const output = `${res.stdout?.toString() ?? ''}${res.stderr?.toString() ?? ''}`;
  if (outDir && output) writeFileSync(join(outDir, `maestro-${tag}.log`), output);
  return { ok: res.status === 0, output };
}

function screenshot(device, outPath) {
  const res = adb(device, ['exec-out', 'screencap', '-p'], { allowFailure: true });
  if (res.ok && res.stdout?.length) {
    writeFileSync(outPath, res.stdout);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Secondary user (signed-out flow)
// ---------------------------------------------------------------------------

function listAndroidUsers(device) {
  const res = adbShell(device, 'pm list users', { allowFailure: true });
  const users = new Map();
  for (const m of res.stdout.matchAll(/UserInfo\{(\d+):([^:}]*)/g)) users.set(Number(m[1]), m[2]);
  return users;
}

async function runSignedOutFlow(device, args, outDir) {
  const usersBefore = listAndroidUsers(device);
  const leftover = [...usersBefore.entries()].find(([, name]) => name === 'beeline-proof');
  if (leftover) {
    adbShell(device, `pm remove-user ${leftover[0]}`, { allowFailure: true });
    await sleep(3000);
  }
  const created = adbShell(device, 'pm create-user beeline-proof', { allowFailure: true });
  if (!created.ok || !/Success.*user id (\d+)/.test(created.stdout)) {
    return {
      ok: false,
      output: `could not create a secondary Android user for the signed-out proof:\n${created.stdout}\n${created.stderr}`,
    };
  }
  const userId = Number(created.stdout.match(/user id (\d+)/)[1]);
  console.log(`release-proof: created secondary user ${userId} for the signed-out proof`);
  try {
    const install = adbShell(device, `pm install-existing --user ${userId} ${APP_ID}`, { allowFailure: true });
    if (!install.ok || !/Success/.test(install.stdout)) {
      // Fall back to a full install for that user.
      const push = adb(device, ['push', args.apk ?? '/dev/null', '/data/local/tmp/release-proof.apk'], { allowFailure: true });
      if (!push.ok) {
        return { ok: false, output: `could not provision the app for secondary user ${userId}:\n${install.stdout}` };
      }
      const inst = adbShell(device, `pm install --user ${userId} -r /data/local/tmp/release-proof.apk`, { allowFailure: true });
      if (!inst.ok) return { ok: false, output: `could not install the app for secondary user ${userId}:\n${inst.stdout}` };
    }
    const switched = adbShell(device, `am switch-user ${userId}`, { allowFailure: true });
    if (!switched.ok) return { ok: false, output: `could not switch to secondary user ${userId}:\n${switched.stderr}` };
    // Wait until the switch has actually taken effect: Maestro reads the
    // foreground user's windows, so a race here reads user 0's signed-in app.
    let switchedToUser = false;
    for (let i = 0; i < 40; i++) {
      const cur = adbShell(device, 'am get-current-user', { allowFailure: true });
      if (cur.ok && Number(cur.stdout.trim()) === userId) {
        switchedToUser = true;
        break;
      }
      await sleep(3000);
    }
    if (!switchedToUser) {
      return { ok: false, output: `secondary user ${userId} never became the foreground user` };
    }
    // First boot of a fresh user is slow and early `am start` calls are
    // silently dropped, so keep launching until onboarding actually renders.
    const onboardingFound = await (async () => {
      const deadline = Date.now() + 180 * 1000;
      for (;;) {
        adbShell(device, `am start --user ${userId} -n ${LAUNCH_ACTIVITY}`, { allowFailure: true });
        const waited = await waitForAnyResource(
          device,
          outDir,
          `signedout-user${userId}`,
          ['onboarding-wordmark', 'onboarding-github-sign-in'],
          30 * 1000,
        );
        if (waited.found) return true;
        if (Date.now() > deadline) return false;
      }
    })();
    if (!onboardingFound) {
      return { ok: false, output: 'onboarding never rendered for the secondary user (see dump-signedout-*.xml)' };
    }
    // A fresh user's first launch can churn under the poll; one retry keeps a
    // confirmed-visible onboarding from failing an assert that ran too early.
    const yamlPath = FLOWS.find((f) => f.name === 'signed-out').yaml;
    let result = runMaestro(device, yamlPath, {}, outDir, 'signed-out');
    if (!result.ok) {
      await sleep(5000);
      result = runMaestro(device, yamlPath, {}, outDir, 'signed-out-retry');
    }
    return result;
  } finally {
    adbShell(device, 'am switch-user 0', { allowFailure: true });
    await sleep(5000);
    adbShell(device, `pm remove-user ${userId}`, { allowFailure: true });
    console.log(`release-proof: removed secondary user ${userId}`);
  }
}

// ---------------------------------------------------------------------------
// JUnit + JSON reports
// ---------------------------------------------------------------------------

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

function writeJunit(results, path, { releaseProofApk, device }) {
  const total = results.length;
  const failures = results.filter((r) => !r.ok).length;
  const cases = results
    .map((r) =>
      r.ok
        ? `    <testcase name="${r.name}" classname="release-proof" time="${r.seconds.toFixed(1)}"/>`
        : `    <testcase name="${r.name}" classname="release-proof" time="${r.seconds.toFixed(1)}">\n` +
          `      <failure message="${escapeXml(r.message ?? 'flow failed')}">${escapeXml(r.output ?? '')}</failure>\n` +
          `    </testcase>`,
    )
    .join('\n');
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="release-proof" tests="${total}" failures="${failures}">\n` +
    `  <testsuite name="release-proof" tests="${total}" failures="${failures}" ` +
    `hostname="${device}" package="app.usebeeline">\n` +
    `    <properties><property name="artifact" value="${escapeXml(releaseProofApk ?? '')}"/></properties>\n` +
    `${cases}\n  </testsuite>\n</testsuites>\n`;
  writeFileSync(path, xml);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/release-proof.mjs (--apk <path> | --aab <path>) [--device emulator-5554] [--out <dir>]');
    return;
  }
  const device = args.device;
  const avd = process.env.RELEASE_PROOF_AVD ?? 'buzzy_api36';
  const outDir = args.out;
  mkdirSync(outDir, { recursive: true });

  const lock = await acquireLock(device);
  let competingDisabled = [];
  try {
    await ensureDevice(device, avd);

    // Isolate the beeline:// scheme so deep links land on the artifact under test.
    const query = adbShell(device,
      'cmd package query-activities --brief -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d beeline://beeline/channels',
      { allowFailure: true });
    competingDisabled = [...new Set(
      (query.stdout.match(/([\w.]+)\/\./g) ?? []).map((s) => s.replace(/\/\.$/, '')),
    )].filter((pkg) => pkg && pkg !== APP_ID);
    for (const pkg of competingDisabled) {
      adbShell(device, `pm disable-user --user 0 ${pkg}`, { allowFailure: true });
      console.log(`release-proof: disabled competing scheme handler ${pkg}`);
    }

    const artifactKind = installArtifact(device, args);
    const artifactPath = args.apk ?? args.aab;

    // Preflight: the rig session must be signed in for the room flows.
    adbShell(device, 'am force-stop ' + APP_ID, { allowFailure: true });
    await sleep(2000);
    adbShell(device, 'am start -n ' + LAUNCH_ACTIVITY, { allowFailure: true });
    const preflight = await waitForAnyResource(device, outDir, 'preflight', ['room-list'], 120 * 1000);
    const signedOut = preflight.xml.includes('Continue with GitHub');
    if (!preflight.found) {
      screenshot(device, join(outDir, 'preflight.png'));
      if (signedOut) {
        console.error(
          'release-proof: PREFLIGHT FAILURE — the app started signed out on this rig.\n' +
          'The room/corner/settings proofs need the persisted signed-in session\n' +
          '(GitHub user methoxine-debug on emulator-5554). Sign in once on the\n' +
          'emulator (never scripted), then re-run this proof.',
        );
      } else {
        console.error('release-proof: PREFLIGHT FAILURE — the app never reached the room list. See preflight.png and dump-preflight.xml in ' + outDir);
      }
      process.exit(2);
    }
    console.log('release-proof: preflight OK — signed-in session present');

    const room = pickRoom(preflight.xml);
    console.log(`release-proof: room under proof: ${room.id}${room.roomIds.length > 1 ? ` (of ${room.roomIds.length} rooms)` : ''}`);

    // Corner discovery: expand the deck dropdown with a throwaway flow, read
    // the expanded rows, pick a non-archived corner.
    let cornerId = process.env.RELEASE_PROOF_CORNER ?? null;
    let corners = [];
    const expandYaml = join(outDir, 'expand-corners.yaml');
    writeFileSync(expandYaml, [
      'appId: ' + APP_ID,
      'name: expand-corners',
      '---',
      '- launchApp:',
      '    clearState: false',
      '- assertVisible:',
      '    id: room-list',
      '- tapOn:',
      `    id: room-corners-toggle-${room.id}`,
      '- assertVisible:',
      `    id: room-corners-${room.id}`,
      '',
    ].join('\n'));
    const expand = runMaestro(device, expandYaml, {}, outDir, 'expand-corners');
    if (expand.ok) {
      const expandedXml = dumpUi(device, outDir, 'expanded-corners');
      corners = parseCornerIds(expandedXml);
    } else {
      console.log(`release-proof: corner expansion failed:\n${expand.output}`);
    }
    if (!cornerId && corners.length) {
      const nonArchived = corners.find((c) => c.status !== 'archived');
      cornerId = (nonArchived ?? corners[0]).id;
    }
    if (!cornerId) {
      console.error(
        'release-proof: no corner could be opened — the corner-opens proof cannot run.\n' +
        'Open (or point RELEASE_PROOF_CORNER at) a corner in the proof workspace and re-run.',
      );
      process.exit(2);
    }
    console.log(`release-proof: corner under proof: ${cornerId}`);

    const results = [];
    const flowEnvs = {
      'room-renders': { ROOM_ID: room.id },
      'corner-opens': { ROOM_ID: room.id, CORNER_ID: cornerId },
      'settings-workbench': {},
      'signed-out': {},
    };

    for (const flow of FLOWS) {
      if (flow.secondaryUser) {
        const started = Date.now();
        const r = await runSignedOutFlow(device, args, outDir);
        const screenshotPath = join(outDir, 'signed-out.png');
        screenshot(device, screenshotPath);
        results.push({ name: flow.name, ok: r.ok, output: r.output ?? '', message: r.ok ? undefined : 'signed-out flow failed', seconds: (Date.now() - started) / 1000, screenshot: screenshotPath });
        // Give the rig back to user 0 before the remaining (none) flows.
        continue;
      }
      adbShell(device, 'am force-stop ' + APP_ID, { allowFailure: true });
      await sleep(2000);
      const started = Date.now();
      const r = runMaestro(device, flow.yaml, flowEnvs[flow.name] ?? {}, outDir, flow.name);
      const seconds = (Date.now() - started) / 1000;
      const screenshotPath = join(outDir, `${flow.name}.png`);
      screenshot(device, screenshotPath);
      const ok = r.ok;
      results.push({
        name: flow.name,
        ok,
        output: r.output,
        message: ok ? undefined : `${flow.name} failed${ok ? '' : ' — see maestro log and screenshot'}`,
        seconds,
        screenshot: screenshotPath,
      });
      console.log(`release-proof: ${flow.name}: ${ok ? 'PASS' : 'FAIL'} (${seconds.toFixed(1)}s) → ${screenshotPath}`);
    }

    writeJunit(results, join(outDir, 'release-proof-junit.xml'), { releaseProofApk: artifactPath, device });
    writeFileSync(
      join(outDir, 'release-proof.json'),
      JSON.stringify({ device, avd, artifact: artifactPath, artifactKind, room: room.id, corner: cornerId, results }, null, 2),
    );

    console.log('\nrelease-proof results');
    console.log('=====================');
    for (const r of results) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(20)} ${r.screenshot ?? ''}`);
    }
    const allOk = results.every((r) => r.ok);
    console.log('\nwhat it proved:');
    console.log(`  · the ${artifactKind === 'aab' ? 'AAB' : 'APK'} under proof installs and cold-starts on ${device} (${avd})`);
    console.log(`  · room ${room.id} renders its transcript and composer`);
    console.log(`  · corner ${cornerId} opens and renders its objective line`);
    console.log('  · the settings workbench (Connectors) is reachable from the deck');
    console.log('  · a signed-out identity is offered "Continue with GitHub"');
    if (!allOk) {
      console.error('\nrelease-proof: ONE OR MORE FLOWS FAILED — the release must not promote its OTA.');
      process.exit(1);
    }
    console.log('\nrelease-proof: ALL FLOWS PASSED');
  } finally {
    for (const pkg of competingDisabled) {
      adbShell(device, `pm enable ${pkg}`, { allowFailure: true });
    }
    releaseLock(lock);
  }
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
