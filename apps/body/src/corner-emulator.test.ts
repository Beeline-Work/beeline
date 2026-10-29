import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processAlive } from './android-emulator-lease.js';
import {
  closeCornerEmulatorListeners,
  cornerEmulatorHostFromEnv,
  cornerEmulatorSocketName,
  listenCornerEmulator,
  prepareCornerAdb,
  reapKeptCornerEmulators,
  stopKeptCornerEmulator,
  type CornerEmulatorHost,
  type KeptCornerEmulator,
} from './corner-emulator.js';

const roots: string[] = [];

afterEach(async () => {
  await closeCornerEmulatorListeners();
  for (const root of roots) {
    await stopKeptCornerEmulator(root, 'corner-keep').catch(() => undefined);
    await stopKeptCornerEmulator(root, 'corner-gone').catch(() => undefined);
    await stopKeptCornerEmulator(root, 'corner-attack').catch(() => undefined);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function layout(name: string): Promise<{
  supervisor: string;
  socketPath: string;
  env: NodeJS.ProcessEnv;
  host: CornerEmulatorHost;
}> {
  const supervisor = await mkdtemp(join(tmpdir(), `corner-emulator-${name}-`));
  roots.push(supervisor);
  const sdk = join(supervisor, 'sdk');
  const binary = join(sdk, 'emulator', 'emulator');
  const avdBase = join(supervisor, 'avd-base');
  await mkdir(join(sdk, 'emulator'), { recursive: true });
  await writeFile(binary, '#!/bin/sh\nexec sleep 120\n', { mode: 0o755 });
  await chmod(binary, 0o755);
  await mkdir(join(avdBase, 'demo.avd'), { recursive: true });
  await writeFile(join(avdBase, 'demo.ini'), 'path=/opt/avd/demo.avd\n');
  await writeFile(join(avdBase, 'demo.avd', 'config.ini'), 'AvdId=demo\n');
  const leaseRoot = join(
    supervisor, 'beeline', 'workspaces', 'ws', 'shared-home', 'cache', 'android-leases',
  );
  await mkdir(leaseRoot, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ANDROID_HOME: sdk,
    BEELINE_ANDROID_EMULATOR_BINARY: binary,
    BEELINE_ANDROID_LEASE_ROOT: leaseRoot,
    BEELINE_ANDROID_INSTANCE_ROOT: join(supervisor, 'instances'),
    BEELINE_ANDROID_BASE_AVD_HOME: avdBase,
    ANDROID_AVD_HOME: avdBase,
  };
  const host = cornerEmulatorHostFromEnv(env);
  if (!host) throw new Error('test host is incomplete');
  return {
    supervisor,
    socketPath: cornerEmulatorSocketName(name),
    env,
    host,
  };
}

function turn(
  socketPath: string,
  cornerId: string,
  requestEnv: NodeJS.ProcessEnv = {},
): Promise<{ status: number; response: string }> {
  const payload = JSON.stringify({
    cornerId,
    args: ['-avd', 'demo', '-no-window'],
    env: requestEnv,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `
      const net = require('node:net');
      const name = process.env.SOCK;
      const socket = net.createConnection(name.startsWith('@') ? String.fromCharCode(0) + name.slice(1) : name);
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk;
        if (!buf.includes('\\n')) return;
        process.stdout.write(buf);
        socket.end();
        process.exit(0);
      });
      socket.on('error', (error) => {
        process.stderr.write(String(error));
        process.exit(1);
      });
      socket.write(process.env.PAYLOAD + '\\n');
    `], {
      env: { PATH: process.env.PATH ?? '', SOCK: socketPath, PAYLOAD: payload },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(stderr || stdout || `turn exited ${code}`));
      else resolve({ status: code ?? 1, response: stdout });
    });
  });
}

async function record(env: NodeJS.ProcessEnv, cornerId: string): Promise<KeptCornerEmulator> {
  const raw = await readFile(join(env.BEELINE_ANDROID_LEASE_ROOT!, 'kept', `${cornerId}.json`), 'utf8');
  return JSON.parse(raw) as KeptCornerEmulator;
}

describe('corner emulator lifetime', () => {
  it.each(['', 'sleep 0.2\n'])('returns the emulator KVM failure through the supervisor socket before cleaning up (delay: %j)', async (delay) => {
    const { socketPath, host } = await layout('diagnostic');
    await writeFile(host.emulatorBinary, `#!/bin/sh\n${delay}echo "/dev/kvm permission denied for this sandbox user" >&2\nexit 1\n`, {mode:0o755});
    const adb = join(host.androidHome, 'platform-tools', 'adb');
    await mkdir(join(host.androidHome, 'platform-tools'), {recursive:true});
    await writeFile(adb, '#!/bin/sh\nif [ \"$1\" = start-server ]; then exit 0; fi\nexit 1\n', {mode:0o755});
    await listenCornerEmulator(socketPath, undefined, host);
    const result = JSON.parse((await turn(socketPath, 'corner-keep')).response);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('/dev/kvm permission denied for this sandbox user');
    console.info('Reproduction KVM-diagnostic: supervisor socket returns the emulator permission failure');
  }, 15_000);

  it('keeps the leased emulator and its lease after the turn that started it exits', async () => {
    const cornerId = 'corner-keep';
    const { supervisor, socketPath, env, host } = await layout('keep');
    await listenCornerEmulator(socketPath, undefined, host);
    const first = await turn(socketPath, cornerId);
    const started = JSON.parse(first.response) as { ok: boolean; alreadyRunning: boolean; serial: string };
    expect(started.ok).toBe(true);
    expect(started.alreadyRunning).toBe(false);
    const kept = await record(env, cornerId);
    expect(processAlive(kept.pid)).toBe(true);
    expect(await readFile(kept.markerPath, 'utf8')).toBe(kept.ownership);
    expect(existsSync(kept.instanceRoot)).toBe(true);

    const second = await turn(socketPath, cornerId);
    const again = JSON.parse(second.response) as { ok: boolean; alreadyRunning: boolean; serial: string };
    expect(again).toMatchObject({ ok: true, alreadyRunning: true, serial: started.serial });
    expect((await record(env, cornerId)).pid).toBe(kept.pid);

    const leftAlone = await reapKeptCornerEmulators(supervisor, new Set([cornerId]), async () => true);
    expect(leftAlone).toEqual([]);
    expect(processAlive(kept.pid)).toBe(true);
    const unconfirmed = await reapKeptCornerEmulators(supervisor, new Set(), async () => false);
    expect(unconfirmed).toEqual([]);
    expect(existsSync(kept.markerPath)).toBe(true);

    expect(await stopKeptCornerEmulator(supervisor, cornerId)).toBe(true);
    expect(processAlive(kept.pid)).toBe(false);
    expect(existsSync(kept.markerPath)).toBe(false);
    expect(existsSync(kept.instanceRoot)).toBe(false);
    expect(existsSync(join(env.BEELINE_ANDROID_LEASE_ROOT!, 'kept', `${cornerId}.json`))).toBe(false);
  }, 30_000);

  it('releases a kept emulator on helper start when the corner is confirmed gone', async () => {
    const cornerId = 'corner-gone';
    const { supervisor, socketPath, env, host } = await layout('gone');
    await listenCornerEmulator(socketPath, undefined, host);
    await turn(socketPath, cornerId);
    const kept = await record(env, cornerId);
    expect(processAlive(kept.pid)).toBe(true);
    const stopped = await reapKeptCornerEmulators(supervisor, new Set(), async () => true);
    expect(stopped).toEqual([cornerId]);
    expect(processAlive(kept.pid)).toBe(false);
    expect(existsSync(kept.markerPath)).toBe(false);
  }, 30_000);

  it('rejects a client-selected emulator binary and does not run it', async () => {
    const cornerId = 'corner-attack';
    const { supervisor, socketPath, env, host } = await layout('attack');
    await listenCornerEmulator(socketPath, undefined, host);
    const attackRoot = join(supervisor, 'attack-sdk');
    const marker = join(attackRoot, 'marker');
    const binary = join(attackRoot, 'emulator', 'emulator');
    const avdBase = join(attackRoot, 'avd');
    await mkdir(join(attackRoot, 'emulator'), { recursive: true });
    await mkdir(join(avdBase, 'demo.avd'), { recursive: true });
    await writeFile(join(avdBase, 'demo.ini'), 'path=/opt/avd/demo.avd\n');
    await writeFile(join(avdBase, 'demo.avd', 'config.ini'), 'AvdId=demo\n');
    // Both ANDROID_HOME and the binary point at this tree, so a check that
    // only compares those two request values would let the script through.
    await writeFile(binary, `#!/bin/sh\necho ran > '${marker}'\nexec sleep 120\n`, { mode: 0o755 });
    await chmod(binary, 0o755);
    const attack = await turn(socketPath, cornerId, {
      ANDROID_HOME: attackRoot,
      ANDROID_SDK_ROOT: attackRoot,
      BEELINE_ANDROID_EMULATOR_BINARY: binary,
      BEELINE_ANDROID_LEASE_ROOT: join(attackRoot, 'leases'),
      BEELINE_ANDROID_INSTANCE_ROOT: join(attackRoot, 'instances'),
      BEELINE_ANDROID_BASE_AVD_HOME: avdBase,
      ANDROID_AVD_HOME: avdBase,
      ANDROID_EMULATOR_HOME: join(attackRoot, 'emu-home'),
      PATH: attackRoot,
      HOME: attackRoot,
      TMPDIR: attackRoot,
    });
    const rejected = JSON.parse(attack.response) as { ok: boolean; error?: string };
    expect(rejected).toEqual({ ok: false, exitCode: 1, error: 'emulator paths are owned by the helper' });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(env.BEELINE_ANDROID_LEASE_ROOT!, 'kept', `${cornerId}.json`))).toBe(false);

    const echoed = await turn(socketPath, cornerId, {
      ANDROID_HOME: env.ANDROID_HOME,
      BEELINE_ANDROID_EMULATOR_BINARY: env.BEELINE_ANDROID_EMULATOR_BINARY,
    });
    expect(JSON.parse(echoed.response)).toMatchObject({
      ok: false,
      error: 'emulator paths are owned by the helper',
    });
    expect(existsSync(marker)).toBe(false);

    const honest = await turn(socketPath, cornerId, { ANDROID_ADB_SERVER_PORT: '6799' });
    const started = JSON.parse(honest.response) as { ok: boolean; alreadyRunning: boolean };
    expect(started).toMatchObject({ ok: true, alreadyRunning: false });
    const kept = await record(env, cornerId);
    expect(processAlive(kept.pid)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(kept.leaseRoot).toBe(env.BEELINE_ANDROID_LEASE_ROOT);
    expect(kept.adbServerPort).toBe(String(kept.port + 2));
  }, 30_000);
});

it('CORNER-ADB-1: resolves a lease booted during the turn and restores it for another agent', async () => {
  const { supervisor, socketPath, env, host } = await layout('adb');
  const adb = join(host.androidHome, 'platform-tools', 'adb');
  await mkdir(join(host.androidHome, 'platform-tools'), { recursive: true });
  // The fake adb exposes the exact environment delivered to the SDK binary.
  await writeFile(adb, '#!/usr/bin/env node\nconsole.log(JSON.stringify({serial:process.env.ANDROID_SERIAL,port:process.env.ANDROID_ADB_SERVER_PORT,socket:process.env.ADB_SERVER_SOCKET}));\n', {mode:0o755});
  const first = { ...env, PATH: process.env.PATH!, ANDROID_ADB_SERVER_PORT: '6799' } as Record<string,string>;
  await prepareCornerAdb(supervisor, 'corner-keep', first);
  // Boot with no platform-tools installed so this lifetime fixture needs no Android guest.
  await rm(adb);
  await listenCornerEmulator(socketPath, undefined, host);
  await turn(socketPath, 'corner-keep', { ANDROID_ADB_SERVER_PORT: '6799' });
  const kept = await record(env, 'corner-keep');
  await writeFile(adb, '#!/usr/bin/env node\nconsole.log(JSON.stringify({serial:process.env.ANDROID_SERIAL,port:process.env.ANDROID_ADB_SERVER_PORT,socket:process.env.ADB_SERVER_SOCKET}));\n', {mode:0o755});
  const invoke = (wiring: Record<string,string>) => JSON.parse(execFileSync(join(supervisor,'corner-adb-bin','adb'), ['devices'], {
    env: {...wiring, ADB_SERVER_SOCKET:'tcp:localhost:5037'}, encoding:'utf8',
  }));
  expect(invoke(first)).toEqual({serial:kept.serial,port:kept.adbServerPort});
  // A retained lease from an older helper keeps its server but loses its TCP alias.
  kept.adbServerPort = '6799';
  await writeFile(join(env.BEELINE_ANDROID_LEASE_ROOT!, 'kept', 'corner-keep.json'), JSON.stringify(kept));
  const calls = join(supervisor, 'adb-calls');
  await writeFile(adb, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log(JSON.stringify({serial:process.env.ANDROID_SERIAL,port:process.env.ANDROID_ADB_SERVER_PORT,socket:process.env.ADB_SERVER_SOCKET}));\n`, {mode:0o755});
  const next = {...first, ANDROID_ADB_SERVER_PORT:'6899'};
  await prepareCornerAdb(supervisor,'corner-keep',next);
  expect(await readFile(calls,'utf8')).toContain(JSON.stringify(['disconnect',`127.0.0.1:${kept.port+1}`]));
  expect(next.ANDROID_SERIAL).toBe(kept.serial);
  expect(next.ANDROID_ADB_SERVER_PORT).toBe(kept.adbServerPort);
  expect(invoke(next)).toEqual(invoke(first));
});
