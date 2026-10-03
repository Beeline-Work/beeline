/**
 * Real processes, real /proc: a squatter is a node process listening on the
 * unit's socket path, launched from a `@trusty-squire/mcp/dist/bin.js broker`
 * command line the way npm runs Squire's broker.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reclaimSquireBrokerSockets } from './squire-broker-squatter.js';
import { ensureSquireHostDir, squireBrokerSocketReady, squireHostPaths } from './squire-host.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratchHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-squatter-'));
  roots.push(root);
  ensureSquireHostDir(root);
  return root;
}

const LISTENER = `
const net = require('net');
const path = process.env.SQUAT_SOCKET;
if (process.env.SQUAT_IGNORE_TERM === '1') process.on('SIGTERM', () => undefined);
net.createServer().listen(path, () => process.stdout.write('ready\\n'));
`;

/** A listener on `socket`; `entry` decides what its command line looks like. */
async function squat(
  socket: string,
  options: { entry: string; args: string[]; env: Record<string, string>; ignoreTerm?: boolean },
): Promise<ChildProcess> {
  mkdirSync(join(options.entry, '..'), { recursive: true });
  writeFileSync(options.entry, LISTENER);
  const child = spawn(process.execPath, [options.entry, ...options.args], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...options.env,
      SQUAT_SOCKET: socket,
      SQUAT_IGNORE_TERM: options.ignoreTerm ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.push(child);
  await new Promise<void>((resolveReady, rejectReady) => {
    child.stdout?.once('data', () => resolveReady());
    child.once('exit', () => rejectReady(new Error('squatter exited before listening')));
  });
  return child;
}

function squireBroker(home: string, socket: string, extra: { ignoreTerm?: boolean; profileDir?: string } = {}) {
  return squat(socket, {
    entry: join(home, 'npx-cache', 'node_modules', '@trusty-squire', 'mcp', 'dist', 'bin.js'),
    args: ['broker'],
    env: {
      HOME: home,
      ...(extra.profileDir ? { TRUSTY_SQUIRE_PROFILE_DIR: extra.profileDir } : {}),
    },
    ...(extra.ignoreTerm ? { ignoreTerm: true } : {}),
  });
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function leaveStaleSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)});`], {
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !existsSync(path)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  child.kill('SIGKILL');
  await new Promise((resolveExit) => child.once('exit', resolveExit));
}

const linux = existsSync('/proc/net/unix');

describe.skipIf(!linux)('host broker socket preflight', () => {
  it('stops a live same-profile Squire broker squatting on mcp.sock so the unit can bind', async () => {
    const home = await scratchHome();
    const paths = squireHostPaths(home);
    const squatter = await squireBroker(home, paths.mcpSocket);
    const lines: string[] = [];

    const result = await reclaimSquireBrokerSockets({
      sockets: [paths.mcpSocket, paths.brokerSocket],
      profileDir: paths.profileDir,
      log: (line) => lines.push(line),
    });

    expect(result).toEqual({ ok: true, stopped: [squatter.pid] });
    // Socket release can precede Node's notification that the child exited.
    if (!exited(squatter)) await once(squatter, 'exit');
    expect(exited(squatter)).toBe(true);
    expect(await squireBrokerSocketReady(paths.mcpSocket)).toBe(false);
    expect(lines.join('\n')).toContain(`pid ${squatter.pid}`);
  });

  it('stops a same-profile broker holding broker.sock too', async () => {
    const home = await scratchHome();
    const paths = squireHostPaths(home);
    const squatter = await squireBroker(home, paths.brokerSocket);

    const result = await reclaimSquireBrokerSockets({
      sockets: [paths.mcpSocket, paths.brokerSocket],
      profileDir: paths.profileDir,
      log: () => undefined,
    });

    expect(result).toEqual({ ok: true, stopped: [squatter.pid] });
  });

  it('escalates to SIGKILL when the squatter ignores SIGTERM', async () => {
    const home = await scratchHome();
    const paths = squireHostPaths(home);
    const squatter = await squireBroker(home, paths.mcpSocket, { ignoreTerm: true });

    const result = await reclaimSquireBrokerSockets({
      sockets: [paths.mcpSocket],
      profileDir: paths.profileDir,
      log: () => undefined,
      stopTimeoutMs: 300,
    });

    expect(result).toEqual({ ok: true, stopped: [squatter.pid] });
    if (!exited(squatter)) await once(squatter, 'exit');
    expect(squatter.signalCode).toBe('SIGKILL');
  });

  it('leaves a stale socket file with no listener to Squire', async () => {
    const home = await scratchHome();
    const paths = squireHostPaths(home);
    await leaveStaleSocket(paths.mcpSocket);

    const result = await reclaimSquireBrokerSockets({
      sockets: [paths.mcpSocket, paths.brokerSocket],
      profileDir: paths.profileDir,
    });

    expect(result).toEqual({ ok: true, stopped: [] });
    expect(existsSync(paths.mcpSocket)).toBe(true);
  });

  it('does nothing on a clean start', async () => {
    const home = await scratchHome();
    const paths = squireHostPaths(home);

    const result = await reclaimSquireBrokerSockets({
      sockets: [paths.mcpSocket, paths.brokerSocket],
      profileDir: paths.profileDir,
    });

    expect(result).toEqual({ ok: true, stopped: [] });
  });

  it('refuses to stop a process that is not a Squire broker and names it', async () => {
    const home = await scratchHome();
    const paths = squireHostPaths(home);
    const unrelated = await squat(paths.mcpSocket, {
      entry: join(home, 'other', 'server.js'),
      args: ['broker'],
      env: { HOME: home },
    });

    const result = await reclaimSquireBrokerSockets({
      sockets: [paths.mcpSocket],
      profileDir: paths.profileDir,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(`pid ${unrelated.pid}`);
    expect(!result.ok && result.reason).toContain('not a Trusty Squire broker');
    expect(exited(unrelated)).toBe(false);
  });

  it('refuses to stop a Squire broker for a different profile directory', async () => {
    const home = await scratchHome();
    const paths = squireHostPaths(home);
    const other = await squireBroker(home, paths.mcpSocket, { profileDir: join(home, 'elsewhere') });

    const result = await reclaimSquireBrokerSockets({
      sockets: [paths.mcpSocket],
      profileDir: paths.profileDir,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(`pid ${other.pid}`);
    expect(exited(other)).toBe(false);
  });
});
