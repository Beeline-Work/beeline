/**
 * The broker-count proof runs real processes, not a model of them.
 *
 * A stand-in `npx` on PATH plays Squire's server: it tries to BIND the broker
 * socket it was pointed at, recording `elected` when it becomes the daemon and
 * `connected` when one already holds that inode. RED spawns the operator's own
 * launch line the way a verbatim copy into two PrivateTmp agents would; GREEN
 * spawns the real `squire-facade` entry produced by the route rewrite.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rewriteHostMcpDeclaration } from './host-mcp-route.js';
import {
  ensureSquireHostDir,
  SQUIRE_BROKER_FLAG,
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
} from './squire-host.js';

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

  it('GREEN: two real façades reach one host broker and elect nothing', async () => {
    const home = await scratch('beeline-squire-green-');
    const paths = ensureSquireHostDir(home);
    const ledger = join(home, 'brokers.jsonl');
    const shimDir = join(home, 'bin');
    installNpxShim(shimDir, ledger);
    const broker = await listenUnix(paths.brokerSocket);
    const hostInode = lstatSync(paths.brokerSocket).ino;
    try {
      const route = rewriteHostMcpDeclaration('squire', { ...SQUIRE_LAUNCH }, home);
      const routeEnv = route.env as Record<string, string>;
      for (const agent of ['agent-a', 'agent-b']) {
        const privateTmp = join(home, agent, 'tmp');
        mkdirSync(privateTmp, { recursive: true });
        const run = spawnSync(route.command as string, route.args as string[], {
          encoding: 'utf8',
          env: {
            ...routeEnv,
            PATH: `${shimDir}:${process.env.PATH ?? ''}`,
            TMPDIR: privateTmp,
            HOME: join(home, agent),
          },
        });
        expect(run.status).toBe(0);
      }
      const records = brokerRecords(ledger);
      expect(records.map((record) => record.outcome)).toEqual(['connected', 'connected']);
      expect(new Set(records.map((record) => record.socket))).toEqual(
        new Set([paths.brokerSocket]),
      );
      expect(new Set(records.map((record) => record.profileDir))).toEqual(
        new Set([paths.profileDir]),
      );
      expect(lstatSync(paths.brokerSocket).ino).toBe(hostInode);
    } finally {
      await closeServer(broker);
    }
  });

  it('a real façade refuses and starts nothing when no host broker holds the socket', async () => {
    const home = await scratch('beeline-squire-unavailable-');
    ensureSquireHostDir(home);
    const ledger = join(home, 'brokers.jsonl');
    const shimDir = join(home, 'bin');
    installNpxShim(shimDir, ledger);
    const launch = squireFacadeLaunch(home);
    expect(squireBrokerSocketReady(launch.env.TRUSTY_SQUIRE_BROKER_SOCKET!)).toBe(false);
    const run = spawnSync(launch.command, launch.args, {
      encoding: 'utf8',
      env: { ...launch.env, PATH: `${shimDir}:${process.env.PATH ?? ''}`, HOME: home },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(SQUIRE_BROKER_UNAVAILABLE);
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
  it('writes a per-client façade that carries the three host rewrite vars', () => {
    const launch = squireFacadeLaunch('/home/op');
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
