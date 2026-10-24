import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processAlive } from './android-emulator-lease.js';
import {
  closeCornerEmulatorListeners,
  cornerEmulatorSocketName,
  listenCornerEmulator,
  reapKeptCornerEmulators,
  stopKeptCornerEmulator,
  type KeptCornerEmulator,
} from './corner-emulator.js';

const roots: string[] = [];

afterEach(async () => {
  await closeCornerEmulatorListeners();
  for (const root of roots) {
    await stopKeptCornerEmulator(root, 'corner-keep').catch(() => undefined);
    await stopKeptCornerEmulator(root, 'corner-gone').catch(() => undefined);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function layout(name: string): Promise<{
  supervisor: string;
  socketPath: string;
  env: NodeJS.ProcessEnv;
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
  return {
    supervisor,
    socketPath: cornerEmulatorSocketName(name),
    env: {
      ANDROID_HOME: sdk,
      BEELINE_ANDROID_EMULATOR_BINARY: binary,
      BEELINE_ANDROID_LEASE_ROOT: leaseRoot,
      BEELINE_ANDROID_INSTANCE_ROOT: join(supervisor, 'instances'),
      BEELINE_ANDROID_BASE_AVD_HOME: avdBase,
      ANDROID_AVD_HOME: avdBase,
    },
  };
}

function turn(
  socketPath: string,
  cornerId: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; response: string }> {
  const payload = JSON.stringify({
    cornerId,
    args: ['-avd', 'demo', '-no-window'],
    env,
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
  it('keeps the leased emulator and its lease after the turn that started it exits', async () => {
    const cornerId = 'corner-keep';
    const { supervisor, socketPath, env } = await layout('keep');
    await listenCornerEmulator(socketPath);
    const first = await turn(socketPath, cornerId, env);
    const started = JSON.parse(first.response) as { ok: boolean; alreadyRunning: boolean; serial: string };
    expect(started.ok).toBe(true);
    expect(started.alreadyRunning).toBe(false);
    const kept = await record(env, cornerId);
    expect(processAlive(kept.pid)).toBe(true);
    expect(await readFile(kept.markerPath, 'utf8')).toBe(kept.ownership);
    expect(existsSync(kept.instanceRoot)).toBe(true);

    const second = await turn(socketPath, cornerId, env);
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
    const { supervisor, socketPath, env } = await layout('gone');
    await listenCornerEmulator(socketPath);
    await turn(socketPath, cornerId, env);
    const kept = await record(env, cornerId);
    expect(processAlive(kept.pid)).toBe(true);
    const stopped = await reapKeptCornerEmulators(supervisor, new Set(), async () => true);
    expect(stopped).toEqual([cornerId]);
    expect(processAlive(kept.pid)).toBe(false);
    expect(existsSync(kept.markerPath)).toBe(false);
  }, 30_000);
});
