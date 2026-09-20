import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureSquireHostDir,
  SQUIRE_BROKER_UNAVAILABLE,
  SQUIRE_PROFILE_BUSY,
  squireBrokerSocketReady,
  squireFacadeIsPaired,
  squireFacadeLaunch,
  squireFacadeMaySpawn,
  squireFacadeProbe,
  squireHostBindPaths,
  squireHostRewriteEnv,
  squireHostTopology,
  squirePrivateTmpTopology,
  squireProcessPlan,
  squireSessionFile,
  squireTurnFailure,
  squireUnfixedProcessPlan,
  TRUSTY_SQUIRE_BROKER_UNIT_NAME,
  trustySquireBrokerUnit,
} from './squire-host.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

describe('RED/GREEN broker topology', () => {
  async function listenUnix(socket: string) {
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socket, () => resolveListen());
    });
    return server;
  }

  it('RED: two PrivateTmp agents elect two broker sockets and two Chromes', async () => {
    const agentA = await mkdtemp(join(tmpdir(), 'beeline-squire-red-a-'));
    const agentB = await mkdtemp(join(tmpdir(), 'beeline-squire-red-b-'));
    roots.push(agentA, agentB);
    const topology = squirePrivateTmpTopology([agentA, agentB]);
    for (const home of [agentA, agentB]) {
      mkdirSync(join(home, 'tmp'), { recursive: true });
      mkdirSync(join(home, '.trusty-squire', 'chrome-profile'), { recursive: true });
    }
    const servers = await Promise.all(topology.sockets.map((socket) => listenUnix(socket)));
    try {
      expect(lstatSync(topology.sockets[0]!).ino).not.toBe(lstatSync(topology.sockets[1]!).ino);
      expect(new Set(topology.chromeProfiles).size).toBe(2);
      expect(squireUnfixedProcessPlan(2)).toEqual({
        daemons: 2,
        chromes: 2,
        facades: 0,
        refusals: 0,
      });
    } finally {
      await Promise.all(
        servers.map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
      );
    }
  });

  it('GREEN: two façade processes share one host socket inode and one Chrome', async () => {
    const home = await mkdtemp(join(tmpdir(), 'beeline-squire-green-'));
    roots.push(home);
    const paths = ensureSquireHostDir(home);
    mkdirSync(join(paths.configHome, 'trusty-squire'), { recursive: true });
    writeFileSync(squireSessionFile(paths.configHome), '{"paired":true}\n');
    const server = await listenUnix(paths.brokerSocket);
    try {
      const topology = squireHostTopology(home, ['agent-a', 'agent-b']);
      expect(lstatSync(topology.facades[0]!.brokerSocket).ino).toBe(
        lstatSync(topology.facades[1]!.brokerSocket).ino,
      );
      expect(new Set(topology.facades.map((facade) => facade.profileDir)).size).toBe(1);
      const env = { ...process.env, ...squireHostRewriteEnv(home), HOME: home };
      const probe = [
        "const fs=require('fs');",
        "const path=require('path');",
        "const session=path.join(process.env.XDG_CONFIG_HOME,'trusty-squire','session.json');",
        'const socket=process.env.TRUSTY_SQUIRE_BROKER_SOCKET;',
        'try {',
        "  const paired=fs.readFileSync(session,'utf8').trim().length>0 && fs.lstatSync(socket).isSocket();",
        "  process.stdout.write(paired?'paired\\n':'unpaired\\n');",
        '  process.exit(paired?0:1);',
        "} catch { process.stdout.write('unpaired\\n'); process.exit(1); }",
      ].join('');
      const facadeA = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env });
      const facadeB = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env });
      expect(facadeA.stdout.trim()).toBe('paired');
      expect(facadeB.stdout.trim()).toBe('paired');
      expect(squireFacadeProbe(env)).toEqual({ paired: true, socketReady: true });
      expect(squireFacadeIsPaired(env)).toBe(true);
      expect(squireProcessPlan({ hostHome: home, agentCount: 2, brokerReady: true })).toEqual({
        daemons: 1,
        chromes: 1,
        facades: 2,
        refusals: 0,
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('a sandboxed façade does not elect when the host socket is missing', () => {
    expect(squireFacadeMaySpawn('/no/such/broker.sock')).toBe(false);
    expect(squireBrokerSocketReady('/no/such/broker.sock')).toBe(false);
    expect(
      squireProcessPlan({ hostHome: '/home/op', agentCount: 2, brokerReady: false }),
    ).toEqual({ daemons: 0, chromes: 0, facades: 0, refusals: 2 });
  });

  it('a façade may spawn only once the host socket inode exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-squire-sock-'));
    roots.push(dir);
    const socket = join(dir, 'broker.sock');
    const server = await listenUnix(socket);
    try {
      expect(squireFacadeMaySpawn(socket)).toBe(true);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

describe('host broker unit', () => {
  it('elects outside every sandbox: no PrivateTmp, one host socket', () => {
    const unit = trustySquireBrokerUnit();
    expect(TRUSTY_SQUIRE_BROKER_UNIT_NAME).toBe('trusty-squire-broker.service');
    expect(unit).not.toContain('PrivateTmp');
    expect(unit).toContain('TRUSTY_SQUIRE_BROKER_SOCKET=%h/.trusty-squire/broker.sock');
    expect(unit).toContain('TRUSTY_SQUIRE_PROFILE_DIR=%h/.trusty-squire/chrome-profile');
    expect(unit).toContain('XDG_CONFIG_HOME=%h/.config');
    expect(unit).toContain('npx -y @trusty-squire/mcp@latest server');
    expect(unit).toContain('ExecStartPre=/bin/mkdir -p %h/.trusty-squire');
  });
});

describe('façade launch and failures', () => {
  it('writes a per-client façade that carries the three host rewrite vars', () => {
    const launch = squireFacadeLaunch('/home/op');
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toMatch(/squire-facade\.(js|ts)$/);
    expect(launch.env).toEqual(squireHostRewriteEnv('/home/op'));
  });

  it('surfaces profile_busy and broker unavailable once, with no retry classification', () => {
    expect(squireTurnFailure('broker unavailable')).toBe(SQUIRE_BROKER_UNAVAILABLE);
    expect(squireTurnFailure('profile_busy: chrome in use')).toBe(SQUIRE_PROFILE_BUSY);
    expect(
      squireTurnFailure('another Trusty Squire session is already using the browser'),
    ).toBe(SQUIRE_PROFILE_BUSY);
    expect(squireTurnFailure('ok')).toBeUndefined();
  });

  it('creates the host socket directory before any façade starts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'beeline-squire-home-'));
    roots.push(home);
    const paths = ensureSquireHostDir(home);
    expect(paths.dir).toBe(join(home, '.trusty-squire'));
    expect(paths.brokerSocket).toBe(join(home, '.trusty-squire', 'broker.sock'));
    expect(squireHostBindPaths(home, ['squire'])).toEqual([paths.dir]);
    expect(squireHostBindPaths(home, [])).toEqual([]);
  });
});
