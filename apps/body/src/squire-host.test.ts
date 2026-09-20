import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureSquireHostDir,
  SQUIRE_BROKER_UNAVAILABLE,
  SQUIRE_PROFILE_BUSY,
  squireBrokerSocketReady,
  squireFacadeLaunch,
  squireFacadeMaySpawn,
  squireHostBindPaths,
  squireHostPaths,
  squireHostRewriteEnv,
  squireHostTopology,
  squireProcessPlan,
  squireTurnFailure,
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
  it('two agents with private /tmp sockets are two brokers and two Chromes', () => {
    const agentATmp = '/tmp-agent-a';
    const agentBTmp = '/tmp-agent-b';
    const defaultSocket = (tmp: string) => join(tmp, 'trusty-squire.sock');
    expect(defaultSocket(agentATmp)).not.toBe(defaultSocket(agentBTmp));
    expect(defaultSocket(agentATmp)).not.toBe(squireHostPaths('/home/op').brokerSocket);
  });

  it('GREEN: two façades on one host share one daemon socket and one Chrome', () => {
    const topology = squireHostTopology('/home/op', ['agent-a', 'agent-b']);
    expect(topology.daemonSocket).toBe('/home/op/.trusty-squire/broker.sock');
    expect(topology.chromeProfile).toBe('/home/op/.trusty-squire/chrome-profile');
    expect(topology.facades).toHaveLength(2);
    expect(new Set(topology.facades.map((facade) => facade.brokerSocket)).size).toBe(1);
    expect(new Set(topology.facades.map((facade) => facade.profileDir)).size).toBe(1);
    expect(squireProcessPlan({ hostHome: '/home/op', agentCount: 2, brokerReady: true })).toEqual({
      daemons: 1,
      chromes: 1,
      facades: 2,
      refusals: 0,
    });
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
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => resolve());
    });
    try {
      expect(squireFacadeMaySpawn(socket)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
