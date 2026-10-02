/**
 * The broker-count proof runs real processes, not a model of them.
 *
 * A stand-in `npx` on PATH plays Squire's server: it tries to BIND the broker
 * socket it was pointed at, recording `elected` when it becomes the daemon and
 * `connected` when one already holds that inode. RED spawns the operator's own
 * launch line the way a verbatim copy into two PrivateTmp agents would; GREEN
 * spawns the real `squire-facade` entry produced by the route rewrite.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rewriteHostMcpDeclaration } from './host-mcp-route.js';
import {
  ensureSquireHostDir,
  SQUIRE_BROKER_FLAG,
  SQUIRE_BROKER_UNIT_MARKER_FILE,
  SQUIRE_BROKER_ARGS,
  SQUIRE_BROKER_UNAVAILABLE,
  SQUIRE_SERVER_ARGS,
  squireBrokerSocketReady,
  squireFacadeLaunch,
  squireHostBindPaths,
  squireHostPaths,
  squireHostRewriteEnv,
  squireServerCommand,
  TRUSTY_SQUIRE_BROKER_UNIT_NAME,
  trustySquireBrokerUnit,
  writeSquireBrokerUnitMarker,
} from './squire-host.js';
import { startFakeMcpBroker, stopFakeMcpBroker } from './squire-broker-link.test-support.js';

const SQUIRE_LAUNCH = {
  command: 'npx',
  args: ['-y', '@trusty-squire/mcp@latest', 'server'],
};

type BrokerRecord = { outcome: 'elected' | 'connected'; socket: string; profileDir: string | null };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A PATH `npx` that elects exactly the way Squire's own server would. */
function installNpxShim(dir: string, ledger: string): string {
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'npx');
  writeFileSync(
    shim,
    `#!${process.execPath}
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const socket =
  process.env.TRUSTY_SQUIRE_BROKER_SOCKET ||
  path.join(process.env.TMPDIR || '/tmp', 'trusty-squire-broker.sock');
const record = (outcome) =>
  fs.appendFileSync(
    ${JSON.stringify(ledger)},
    JSON.stringify({
      outcome,
      socket,
      profileDir: process.env.TRUSTY_SQUIRE_PROFILE_DIR || null,
      argv: process.argv.slice(2),
    }) + '\\n',
  );
const server = net.createServer();
server.once('error', () => {
  record('connected');
  process.exit(0);
});
server.listen(socket, () => {
  record('elected');
  server.close(() => process.exit(0));
});
`,
  );
  chmodSync(shim, 0o755);
  return shim;
}

function brokerRecords(ledger: string): BrokerRecord[] {
  let raw = '';
  try {
    raw = readFileSync(ledger, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BrokerRecord);
}

async function listenUnix(socket: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(socket, () => resolveListen());
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

/**
 * One newline-delimited JSON-RPC reply from a real child's stdout. `spawnSync`
 * writes its whole `input` then closes stdin immediately, which races ahead
 * of the façade's async socket connect — a real harness keeps stdin open and
 * reads replies as they arrive, so the façade tests do the same with `spawn`.
 */
async function readChildLine(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  return await new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      stream.off('data', onData);
      resolve(JSON.parse(buffer.subarray(0, end).toString('utf8')) as Record<string, unknown>);
    };
    stream.on('data', onData);
  });
}

/**
 * Leave an orphaned Unix socket inode at `path`, the way a broker that never
 * reaches its own graceful shutdown does (SIGKILL, OOM, a restart-loop crash
 * mid-cycle): only `server.close()` unlinks the file, so a listener that dies
 * any other way leaves the socket special file behind with nothing answering
 * it.
 */
async function leaveStaleSocket(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['-e', `require('net').createServer().listen(${JSON.stringify(path)});`],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !existsSync(path)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (!existsSync(path)) throw new Error('stale socket setup never bound');
  child.kill('SIGKILL');
  await new Promise((resolveExit) => child.once('exit', resolveExit));
}

describe('squire host rewrite env', () => {
  it('points every façade at the host home, never a private /tmp', () => {
    const env = squireHostRewriteEnv('/home/op');
    expect(env).toEqual({
      TRUSTY_SQUIRE_PROFILE_DIR: '/home/op/.trusty-squire/chrome-profile',
      XDG_CONFIG_HOME: '/home/op/.config',
      TRUSTY_SQUIRE_BROKER_SOCKET: '/home/op/.trusty-squire/broker.sock',
    });
    expect(env.TRUSTY_SQUIRE_BROKER_SOCKET.startsWith('/tmp')).toBe(false);
  });
});

describe('RED/GREEN broker election', () => {
  it('RED: the operator launch line copied into two private-/tmp sessions elects two brokers', async () => {
    const root = await scratch('beeline-squire-red-');
    const ledger = join(root, 'brokers.jsonl');
    const shimDir = join(root, 'bin');
    installNpxShim(shimDir, ledger);
    const sockets: string[] = [];
    for (const agent of ['agent-a', 'agent-b']) {
      // bwrap --tmpfs /tmp: each ACP session's /tmp is its own inode.
      const privateTmp = join(root, agent, 'tmp');
      mkdirSync(privateTmp, { recursive: true });
      const run = spawnSync(SQUIRE_LAUNCH.command, SQUIRE_LAUNCH.args, {
        encoding: 'utf8',
        env: { PATH: `${shimDir}:${process.env.PATH ?? ''}`, TMPDIR: privateTmp },
      });
      expect(run.status).toBe(0);
      sockets.push(join(privateTmp, 'trusty-squire-broker.sock'));
    }
    const records = brokerRecords(ledger);
    expect(records.map((record) => record.outcome)).toEqual(['elected', 'elected']);
    expect(new Set(records.map((record) => record.socket)).size).toBe(2);
    expect(records.map((record) => record.socket)).toEqual(sockets);
  });

  it('GREEN: two real façades reach the host broker over its shared MCP socket and never touch npx', async () => {
    const home = await scratch('beeline-squire-green-');
    const paths = ensureSquireHostDir(home);
    const ledger = join(home, 'brokers.jsonl');
    const shimDir = join(home, 'bin');
    installNpxShim(shimDir, ledger);
    const broker = await listenUnix(paths.brokerSocket); // satisfies the fast pre-check
    const mcpBroker = await startFakeMcpBroker(paths.mcpSocket); // the real connect-only transport
    try {
      const route = rewriteHostMcpDeclaration('squire', { ...SQUIRE_LAUNCH }, home, undefined, { agentId: 'agent-a', roomId: 'room-a' });
      const routeEnv = route.env as Record<string, string>;
      for (const agent of ['agent-a', 'agent-b']) {
        const privateTmp = join(home, agent, 'tmp');
        mkdirSync(privateTmp, { recursive: true });
        const child = spawn(route.command as string, route.args as string[], {
          env: {
            ...routeEnv,
            PATH: `${shimDir}:${process.env.PATH ?? ''}`,
            TMPDIR: privateTmp,
            HOME: join(home, agent),
          },
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
        const initReply = await readChildLine(child.stdout);
        expect((initReply.result as { serverInfo: { name: string } }).serverInfo.name).toBe('fake-mcp-broker');
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        const toolsReply = await readChildLine(child.stdout);
        expect((toolsReply.result as { tools: unknown[] }).tools).toHaveLength(1);
        child.stdin.end();
        const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
        expect(code).toBe(0);
      }
      // The regression this test guards: neither façade ever ran `npx …
      // server` at all — the connect-only relay speaks the broker's shared
      // MCP socket directly, so there is nothing left that could elect.
      expect(brokerRecords(ledger)).toEqual([]);
    } finally {
      await closeServer(broker);
      await stopFakeMcpBroker(mcpBroker);
    }
  });

  it('a real façade refuses and starts nothing when no host broker holds the socket', async () => {
    const home = await scratch('beeline-squire-unavailable-');
    ensureSquireHostDir(home);
    const ledger = join(home, 'brokers.jsonl');
    const shimDir = join(home, 'bin');
    installNpxShim(shimDir, ledger);
    const launch = squireFacadeLaunch(home, { agentId: 'agent-a', roomId: 'room-a' });
    await expect(squireBrokerSocketReady(launch.env.TRUSTY_SQUIRE_BROKER_SOCKET!)).resolves.toBe(false);
    const run = spawnSync(launch.command, launch.args, {
      encoding: 'utf8',
      env: { ...launch.env, PATH: `${shimDir}:${process.env.PATH ?? ''}`, HOME: home },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(SQUIRE_BROKER_UNAVAILABLE);
    expect(run.stderr).toContain(TRUSTY_SQUIRE_BROKER_UNIT_NAME);
    expect(brokerRecords(ledger)).toEqual([]);
  });

  it('a real façade refuses and spawns nothing when the broker socket is a stale inode with no listener (connect-only, never elect)', async () => {
    const home = await scratch('beeline-squire-stale-');
    ensureSquireHostDir(home);
    const ledger = join(home, 'brokers.jsonl');
    const shimDir = join(home, 'bin');
    installNpxShim(shimDir, ledger);
    const launch = squireFacadeLaunch(home, { agentId: 'agent-a', roomId: 'room-a' });
    const socket = launch.env.TRUSTY_SQUIRE_BROKER_SOCKET!;
    await leaveStaleSocket(socket);
    // The file-type check this test guards against would have reported this
    // orphaned inode as a live broker; only an actual connect attempt can
    // tell a crashed daemon's leftover socket from a listening one.
    expect(lstatSync(socket).isSocket()).toBe(true);
    await expect(squireBrokerSocketReady(socket)).resolves.toBe(false);
    const run = spawnSync(launch.command, launch.args, {
      encoding: 'utf8',
      env: { ...launch.env, PATH: `${shimDir}:${process.env.PATH ?? ''}`, HOME: home },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(SQUIRE_BROKER_UNAVAILABLE);
    expect(run.stderr).toContain(TRUSTY_SQUIRE_BROKER_UNIT_NAME);
    // The regression: the façade must never fall through to `npx … server`
    // (whose own on-demand-launch fallback is what elected a second,
    // agent-owned broker in production while the host unit was restart-looping).
    expect(brokerRecords(ledger)).toEqual([]);
  });
});

describe('host broker unit', () => {
  function unitSettings(unit: string): { keys: string[]; environment: Record<string, string> } {
    const keys: string[] = [];
    const environment: Record<string, string> = {};
    for (const line of unit.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index < 0) continue;
      const key = trimmed.slice(0, index);
      const value = trimmed.slice(index + 1);
      keys.push(key);
      if (key !== 'Environment') continue;
      const split = value.indexOf('=');
      environment[value.slice(0, split)] = value.slice(split + 1);
    }
    return { keys, environment };
  }

  it('elects outside every sandbox, on the same paths a façade is handed', () => {
    const unit = trustySquireBrokerUnit();
    const { keys, environment } = unitSettings(unit);
    expect(TRUSTY_SQUIRE_BROKER_UNIT_NAME).toBe('trusty-squire-broker.service');
    expect(keys).not.toContain('PrivateTmp');
    // `%h` is systemd's own host-home specifier: the unit's socket, profile
    // and config home are the same three the rewrite hands every façade.
    const layout = Object.fromEntries(
      Object.entries(squireHostRewriteEnv('/host-home')).map(([key, value]) => [
        key,
        value.replace('/host-home', '%h'),
      ]),
    );
    expect(environment).toEqual({
      ...layout,
      PATH: `${dirname(process.execPath)}:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    });
    expect(environment.TRUSTY_SQUIRE_BROKER_SOCKET).toBe(
      squireHostPaths('/host-home').brokerSocket.replace('/host-home', '%h'),
    );
    expect(keys).toContain('ExecStart');
    const execStart = unit
      .split('\n')
      .find((line) => line.startsWith('ExecStart='))
      ?.slice('ExecStart='.length);
    expect(execStart).toBe(`%h/.local/bin/beeline ${SQUIRE_BROKER_FLAG}`);
    expect(execStart).not.toMatch(/\bnpx\b/);
  });

  it('elects npx from beside the running node, not from a shell PATH', async () => {
    const dir = await scratch('beeline-squire-npx-');
    const npx = join(dir, 'npx');
    writeFileSync(npx, '#!/bin/sh\n');
    chmodSync(npx, 0o755);
    expect(squireServerCommand(join(dir, 'node'))).toEqual({
      command: npx,
      args: [...SQUIRE_SERVER_ARGS],
      pathPrefix: dir,
    });
    expect(squireServerCommand(join(dir, 'missing', 'node'))).toEqual({
      command: 'npx',
      args: [...SQUIRE_SERVER_ARGS],
      pathPrefix: join(dir, 'missing'),
    });
  });

  it('pins the installation Node and selects the durable broker command', () => {
    expect(trustySquireBrokerUnit('/opt/node24/bin/node')).toContain(
      'Environment=PATH=/opt/node24/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin',
    );
    expect(SQUIRE_BROKER_ARGS.at(-1)).toBe('broker');
    expect(SQUIRE_SERVER_ARGS.at(-1)).toBe('server');
  });
});

describe('façade launch and host binds', () => {
  it('routes a task facade to the helper without broker or identity env', () => {
    const launch = squireFacadeLaunch('/home/op', {
      agentId: 'agent-a', roomId: 'room-a',
      relay: { url: 'http://127.0.0.1:1234', token: 'secret', contextFile: '/tmp/context' },
    });
    expect(launch.env).toEqual({
      BEELINE_SQUIRE_RELAY_URL: 'http://127.0.0.1:1234',
      BEELINE_SQUIRE_RELAY_TOKEN: 'secret',
      BEELINE_TURN_CONTEXT_FILE: '/tmp/context',
    });
  });

  it('writes a per-client façade that carries the three host rewrite vars', () => {
    const launch = squireFacadeLaunch('/home/op', { agentId: 'agent-a', roomId: 'room-a' });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args.at(-1)).toMatch(/squire-facade\.(js|ts)$/);
    expect(launch.env).toEqual(squireHostRewriteEnv('/home/op'));
  });

  it('binds the host broker directory only for a Squire route', async () => {
    const home = await scratch('beeline-squire-home-');
    const paths = ensureSquireHostDir(home);
    expect(paths.dir).toBe(join(home, '.trusty-squire'));
    expect(paths.brokerSocket).toBe(join(home, '.trusty-squire', 'broker.sock'));
    expect(squireHostBindPaths(home, true)).toEqual([paths.dir]);
    expect(squireHostBindPaths(home, false)).toEqual([]);
  });
});

describe('managed broker marker', () => {
  it('declares the host socket and the profile device anchor beside the profile', async () => {
    const home = await scratch('beeline-squire-marker-');
    const path = writeSquireBrokerUnitMarker(home);
    const paths = squireHostPaths(home);
    expect(path).toBe(join(paths.dir, SQUIRE_BROKER_UNIT_MARKER_FILE));
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const parent = statSync(paths.dir);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      socket: paths.brokerSocket,
      profile: { dev: parent.dev, ino: parent.ino, name: 'chrome-profile' },
      accountBinding: null,
    });
  });

  it('writes the marker in the canonical parent when the home is a symlink', async () => {
    const real = await scratch('beeline-squire-marker-real-');
    const link = join(await scratch('beeline-squire-marker-link-'), 'home');
    symlinkSync(real, link);
    const path = writeSquireBrokerUnitMarker(link);
    expect(path).toBe(join(real, '.trusty-squire', SQUIRE_BROKER_UNIT_MARKER_FILE));
    expect(JSON.parse(readFileSync(path, 'utf8')).socket).toBe(squireHostPaths(link).brokerSocket);
  });
});
