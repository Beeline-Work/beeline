import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAUNCHD_BROKER_LABEL, LAUNCHD_HELPER_LABEL, cleanupLaunchdAgentService, installLaunchdHelperService, installLaunchdTrustySquireBrokerService, launchdAgentLabel, launchdAgentPlistPath, launchdBrokerPlistPath, launchdHelperPlist, launchdHelperPlistPath, launchdUserDomain } from './launchd.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

/**
 * A plist is launchd's own declarative interface, so the contract below is
 * asserted against its meaning rather than the generator's formatting. This
 * reads the subset the generator emits: nested dict/array, string, integer,
 * true/false.
 */
function parsePlist(source: string): Record<string, PlistValue> {
  const text = (raw: string) =>
    raw
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&');
  const frames: { container: PlistValue[] | Record<string, PlistValue>; key?: string }[] = [];
  let root: PlistValue | undefined;
  const put = (value: PlistValue) => {
    const frame = frames.at(-1);
    if (!frame) {
      root = value;
      return;
    }
    if (Array.isArray(frame.container)) {
      frame.container.push(value);
      return;
    }
    if (frame.key === undefined) throw new Error('plist dict value with no preceding key');
    frame.container[frame.key] = value;
    frame.key = undefined;
  };
  for (const match of source.matchAll(/<(\/?)([a-zA-Z]+)(\/?)>([^<]*)/g)) {
    const [, closing, name, selfClosing, body] = match;
    if (closing) {
      if (name === 'dict' || name === 'array') frames.pop();
      continue;
    }
    if (name === 'dict' || name === 'array') {
      const container: PlistValue = name === 'dict' ? {} : [];
      put(container);
      frames.push({ container: container as PlistValue[] | Record<string, PlistValue> });
      continue;
    }
    if (name === 'key') {
      const frame = frames.at(-1);
      if (!frame || Array.isArray(frame.container)) throw new Error('plist key outside a dict');
      frame.key = text(body ?? '');
      continue;
    }
    if (name === 'string') put(text(body ?? ''));
    else if (name === 'integer' || name === 'real') put(Number(text(body ?? '')));
    else if (name === 'true' || name === 'false') put(name === 'true');
    else if (!selfClosing) throw new Error(`unsupported plist element: ${name}`);
  }
  if (!root || typeof root !== 'object' || Array.isArray(root))
    throw new Error('plist has no root dict');
  return root as Record<string, PlistValue>;
}

async function canonicalEnv() {
  const home = await mkdtemp(resolve(tmpdir(), 'beeline-launchd-home-'));
  roots.push(home);
  return {
    home,
    env: { ...process.env, HOME: home, BEELINE_LIB_DIR: resolve(home, '.local', 'lib', 'beeline') },
    invocationPath: resolve(home, '.local', 'lib', 'beeline', 'lib', 'beeline', 'beeline-cli.mjs'),
  };
}

const squireInstallRun = async (_command: string, args: readonly string[], options: { cwd: string }) => {
  if (args[0] === 'view') return { code: 0, stderr: '', stdout: '1.1.32' };
  const packageDir = resolve(options.cwd, 'node_modules', '@trusty-squire', 'mcp');
  await mkdir(resolve(packageDir, 'dist'), { recursive: true });
  await writeFile(resolve(packageDir, 'dist', 'bin.js'), '');
  await writeFile(resolve(packageDir, 'package.json'), JSON.stringify({ version: '1.1.32' }));
  return { code: 0, stderr: '' };
};

describe('launchd supervision contract', () => {
  it('uses direct native exec and restarts every exit, including an empty machine', () => {
    const plist = parsePlist(launchdHelperPlist({ HOME: '/operator' }));
    expect(plist.ProgramArguments).toEqual(['/operator/.local/bin/beeline', 'helper-bootstrap']);
    expect(plist.KeepAlive).toBe(true);
    expect(plist.ExitTimeOut).toBe(90);
    expect(JSON.stringify(plist)).not.toContain('supervise-helper');
  });
  it('forward-migrates old labels before starting the sole helper', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-launchd-native-')); roots.push(root);
    const dir = resolve(root, 'Library/LaunchAgents');
    await mkdir(dir, { recursive: true });
    const legacy = `app.usebeeline.agent.${'a'.repeat(64)}`;
    await writeFile(resolve(dir, `${legacy}.plist`), 'legacy');
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return { stdout: args[0] === 'print' && calls.some((row) => row[0] === 'bootstrap') ? 'pid = 777' : '' }; };
    const pid = await installLaunchdHelperService({ env: { ...process.env, HOME: root, BEELINE_LIB_DIR: resolve(root, '.local/lib/beeline') }, invocationPath: resolve(root, '.local/lib/beeline/lib/beeline/beeline-cli.mjs'), run });
    expect(pid).toBe(777);
    expect(calls.findIndex((row) => row[0] === 'bootout')).toBeLessThan(calls.findIndex((row) => row[0] === 'bootstrap'));
    expect(await readFile(launchdHelperPlistPath({ HOME: root }), 'utf8')).toContain('<key>KeepAlive</key><true/>');
  });

  it('clears a retired agent\'s leftover per-agent job without booting anything out', async () => {
    const { env } = await canonicalEnv();
    const publicKey = 'e'.repeat(64);
    await mkdir(resolve(env.HOME, 'Library/LaunchAgents'), { recursive: true });
    await writeFile(launchdAgentPlistPath(publicKey, env), 'legacy');
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: '' };
    });
    await expect(cleanupLaunchdAgentService(publicKey, { env, run })).resolves.toBe(true);
    expect(calls).toEqual([['disable', `${launchdUserDomain()}/${launchdAgentLabel(publicKey)}`]]);
    await expect(stat(launchdAgentPlistPath(publicKey, env))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(cleanupLaunchdAgentService(publicKey, { env, run })).resolves.toBe(false);
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
    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run, squireInstallRun });
    // `RunAtLoad` starts the elector with bootstrap, so no kickstart follows it:
    // a second start would land mid socket bind.
    expect(calls).toEqual([
      ['print', target],
      ['enable', target],
      ['print', target],
      ['bootstrap', launchdUserDomain(), launchdBrokerPlistPath(env)],
    ]);
    const broker = parsePlist(await readFile(launchdBrokerPlistPath(env), 'utf8'));
    expect(broker.Label).toBe(LAUNCHD_BROKER_LABEL);
    expect(broker.RunAtLoad).toBe(true);
    expect(broker.ProcessType).toBeUndefined();
    const environment = broker.EnvironmentVariables as Record<string, PlistValue>;
    expect(environment.TRUSTY_SQUIRE_BROKER_SOCKET).toBe(`${env.HOME}/.trusty-squire/broker.sock`);
    const marker = JSON.parse(
      await readFile(`${env.HOME}/.trusty-squire/.trusty-squire-broker-unit.json`, 'utf8'),
    );
    expect(marker.socket).toBe(`${env.HOME}/.trusty-squire/broker.sock`);
  });

  it('starts an already-loaded broker in place when its job is unchanged', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const target = `${launchdUserDomain()}/${LAUNCHD_BROKER_LABEL}`;
    const first = vi.fn(async (args: string[]) => {
      if (args[0] === 'print') throw new Error('not loaded');
      return { stdout: '' };
    });
    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run: first, squireInstallRun });
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: args[0] === 'print' ? 'state = running\npid = 321\n' : '' };
    });

    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run, squireInstallRun });

    expect(calls).toEqual([
      ['enable', target],
      ['print', target],
      ['kickstart', target],
    ]);
  });

  it('restarts a loaded broker only after a newer Squire install is activated', async () => {
    const { env, invocationPath } = await canonicalEnv();
    let published = '1.1.32';
    const installRun = async (_command: string, args: readonly string[], options: { cwd: string }) => {
      if (args[0] === 'view') return { code: 0, stderr: '', stdout: published };
      const packageDir = resolve(options.cwd, 'node_modules', '@trusty-squire', 'mcp');
      await mkdir(resolve(packageDir, 'dist'), { recursive: true });
      await writeFile(resolve(packageDir, 'dist', 'bin.js'), '');
      await writeFile(resolve(packageDir, 'package.json'), JSON.stringify({ version: published }));
      return { code: 0, stderr: '' };
    };
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: args[0] === 'print' ? 'state = running\npid = 321\n' : '' };
    });
    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run, squireInstallRun: installRun });
    calls.length = 0;
    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run, squireInstallRun: installRun });
    expect(calls.some((args) => args[0] === 'bootout')).toBe(false);
    published = '1.1.33';
    calls.length = 0;
    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run, squireInstallRun: installRun });
    expect(calls.some((args) => args[0] === 'bootout')).toBe(true);
  });

  it('reports a native removal still in progress without polling or claiming a loaded successor', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const run = async (args: string[]) => { if (args[0] === 'print') return { stdout: 'state = running\npid = 111\n' }; if (args[0] === 'bootout') throw Object.assign(new Error('Boot-out failed: 36'), { stderr: 'Boot-out failed: 36' }); return { stdout: '' }; };
    await expect(installLaunchdTrustySquireBrokerService({ env, invocationPath, run, squireInstallRun })).rejects.toThrow('still in progress');
  });

});
