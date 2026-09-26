import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LAUNCHD_BROKER_LABEL,
  cleanupLaunchdAgentService,
  installLaunchdAgentService,
  installLaunchdTrustySquireBrokerService,
  launchdAgentLabel,
  launchdAgentPlist,
  launchdAgentPlistPath,
  launchdAgentSupervisorPath,
  launchdAgentSupervisorScript,
  launchdBrokerPlist,
  launchdBrokerPlistPath,
  launchdUserDomain,
  reconcileLaunchdAgentServices,
} from './launchd.js';
import {
  DAEMON_DISTRESS_EXIT_STATUS,
  DELIBERATE_REMOVAL_EXIT_STATUS,
  UNKNOWN_AGENT_EXIT_STATUS,
} from './systemd.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function canonicalEnv() {
  const home = await mkdtemp(resolve(tmpdir(), 'beeline-launchd-home-'));
  roots.push(home);
  return {
    home,
    env: { HOME: home, BEELINE_LIB_DIR: resolve(home, '.local', 'lib', 'beeline') },
    invocationPath: resolve(home, '.local', 'lib', 'beeline', 'lib', 'beeline', 'beeline-cli.mjs'),
  };
}

describe('launchd supervision contract', () => {
  it('renders a login-persistent agent with throttled unsuccessful-exit restart', () => {
    const publicKey = 'a'.repeat(64);
    const plist = launchdAgentPlist(publicKey, { HOME: '/Users/operator' });
    expect(plist).toContain(`<string>${launchdAgentLabel(publicKey)}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(plist).toContain('<key>ThrottleInterval</key>\n  <integer>5</integer>');
    expect(plist).toContain('<key>ExitTimeOut</key>\n  <integer>600</integer>');
    expect(plist).toContain('/Users/operator/.local/bin');
    expect(plist).toContain('BEELINE_MANAGED_BY_LAUNCHD');
  });

  it('maps ordinary exits to restart and terminal daemon statuses to stop', () => {
    const script = launchdAgentSupervisorScript();
    expect(script).toContain('*) exit 1 ;;');
    expect(script).toContain(
      `${DAEMON_DISTRESS_EXIT_STATUS}|${DELIBERATE_REMOVAL_EXIT_STATUS}|${UNKNOWN_AGENT_EXIT_STATUS}) exit 0 ;;`,
    );
  });

  it('installs, bootstraps, and replaces an agent job from the canonical launcher', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const publicKey = 'b'.repeat(64);
    const target = `${launchdUserDomain()}/${launchdAgentLabel(publicKey)}`;
    const calls: string[][] = [];
    let replaced = false;
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'kickstart') replaced = true;
      if (args[0] === 'print') {
        return { stdout: `state = running\npid = ${replaced ? 222 : 111}\n` };
      }
      return { stdout: '' };
    });

    await expect(
      installLaunchdAgentService(publicKey, { env, invocationPath, run, waitTimeoutMs: 1_000 }),
    ).resolves.toBe(222);
    expect(calls).toEqual([
      ['print', target],
      ['print', target],
      ['bootout', target],
      ['enable', target],
      ['bootstrap', launchdUserDomain(), launchdAgentPlistPath(publicKey, env)],
      ['kickstart', '-k', target],
      ['print', target],
    ]);
    expect(await readFile(launchdAgentPlistPath(publicKey, env), 'utf8')).toBe(
      launchdAgentPlist(publicKey, env),
    );
    expect(await readFile(launchdAgentSupervisorPath(env), 'utf8')).toBe(
      launchdAgentSupervisorScript(),
    );
  });

  it('installs one launchd Squire broker with the shared host paths', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const target = `${launchdUserDomain()}/${LAUNCHD_BROKER_LABEL}`;
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'print') throw new Error('not loaded');
      return { stdout: '' };
    });
    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run });
    expect(calls).toEqual([
      ['print', target],
      ['enable', target],
      ['print', target],
      ['bootstrap', launchdUserDomain(), launchdBrokerPlistPath(env)],
      ['kickstart', '-k', target],
    ]);
    const plist = await readFile(launchdBrokerPlistPath(env), 'utf8');
    expect(plist).toBe(launchdBrokerPlist(env));
    expect(plist).toContain(`${env.HOME}/.trusty-squire/broker.sock`);
  });

  it('disables retirement without booting out the process before it archives its runtime', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const publicKey = 'e'.repeat(64);
    let pid = 100;
    await installLaunchdAgentService(publicKey, {
      env,
      invocationPath,
      waitTimeoutMs: 1_000,
      run: async (args) => ({
        stdout: args[0] === 'print' ? `state = running\npid = ${pid++}\n` : '',
      }),
    });
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: 'state = running\npid = 101\n' };
    });

    await expect(cleanupLaunchdAgentService(publicKey, { env, run })).resolves.toBe(true);

    expect(calls).toEqual([
      ['disable', `${launchdUserDomain()}/${launchdAgentLabel(publicKey)}`],
    ]);
    await expect(stat(launchdAgentPlistPath(publicKey, env))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reconciles only exact orphan agent plists and removes them after bootout', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const orphan = 'c'.repeat(64);
    const live = 'd'.repeat(64);
    let nextPid = 100;
    const installRun = vi.fn(async (args: string[]) => {
      if (args[0] === 'print') return { stdout: `state = running\npid = ${nextPid++}\n` };
      return { stdout: '' };
    });
    await installLaunchdAgentService(orphan, {
      env,
      invocationPath,
      run: installRun,
      waitTimeoutMs: 1_000,
    });
    await installLaunchdAgentService(live, {
      env,
      invocationPath,
      run: installRun,
      waitTimeoutMs: 1_000,
    });
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: args[0] === 'print' ? 'state = running\npid = 555\n' : '' };
    });

    await expect(
      reconcileLaunchdAgentServices({
        env,
        run,
        hasRuntime: async (path) => path.includes(live),
      }),
    ).resolves.toEqual([orphan]);
    expect(calls).toEqual([
      ['disable', `${launchdUserDomain()}/${launchdAgentLabel(orphan)}`],
      ['print', `${launchdUserDomain()}/${launchdAgentLabel(orphan)}`],
      ['bootout', `${launchdUserDomain()}/${launchdAgentLabel(orphan)}`],
    ]);
    await expect(stat(launchdAgentPlistPath(orphan, env))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(launchdAgentPlistPath(live, env))).resolves.toMatchObject({});

    await expect(cleanupLaunchdAgentService(orphan, { env, run })).resolves.toBe(false);
  });
});
