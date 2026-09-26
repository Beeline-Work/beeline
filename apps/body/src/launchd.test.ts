import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('plist has no root dict');
  return root as Record<string, PlistValue>;
}

/**
 * Install the generated wrapper with a stub daemon and report the exit status
 * launchd would observe. `signal` is delivered to the wrapper once the stub is
 * running, standing in for `launchctl bootout`.
 */
async function runSupervisor(
  daemon: string,
  options: { signal?: NodeJS.Signals } = {},
): Promise<{ status: number | null; signal: NodeJS.Signals | null; log: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-launchd-wrapper-'));
  roots.push(root);
  const supervisor = resolve(root, 'supervise-agent');
  const stub = resolve(root, 'beeline');
  const ready = resolve(root, 'ready');
  const log = resolve(root, 'log');
  await writeFile(supervisor, launchdAgentSupervisorScript(), { mode: 0o700 });
  await chmod(supervisor, 0o700);
  await writeFile(
    stub,
    `#!/bin/sh\nLOG=${JSON.stringify(log)}\nREADY=${JSON.stringify(ready)}\n${daemon}\n`,
    { mode: 0o700 },
  );
  await chmod(stub, 0o700);
  const child = spawn(supervisor, ['a'.repeat(64), stub], { stdio: 'ignore' });
  if (options.signal) {
    await vi.waitFor(async () => expect(await readFile(ready, 'utf8')).toContain('ready'), {
      timeout: 5_000,
      interval: 25,
    });
    child.kill(options.signal);
  }
  const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) =>
    child.once('exit', (code, received) => done([code, received])),
  );
  return { status, signal, log: await readFile(log, 'utf8').catch(() => '') };
}

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
    const env = { HOME: '/Users/operator' };
    const job = parsePlist(launchdAgentPlist(publicKey, env));
    expect(job.Label).toBe(launchdAgentLabel(publicKey));
    expect(job.ProgramArguments).toEqual([
      launchdAgentSupervisorPath(env),
      publicKey,
      '/Users/operator/.local/bin/beeline',
    ]);
    expect(job.RunAtLoad).toBe(true);
    expect(job.KeepAlive).toEqual({ SuccessfulExit: false });
    expect(job.ThrottleInterval).toBe(5);
    expect(job.ExitTimeOut).toBe(600);
    expect(job.WorkingDirectory).toBe('/Users/operator');
    const environment = job.EnvironmentVariables as Record<string, PlistValue>;
    expect(environment.HOME).toBe('/Users/operator');
    expect(String(environment.PATH).split(':')).toContain('/Users/operator/.local/bin');
    expect(job.StandardOutPath).toBe(
      `/Users/operator/Library/Logs/Beeline/agent-${publicKey}.log`,
    );
    expect(job.StandardErrorPath).toBe(job.StandardOutPath);
  });

  it('maps ordinary exits to restart and terminal daemon statuses to stop', async () => {
    for (const status of [
      DAEMON_DISTRESS_EXIT_STATUS,
      DELIBERATE_REMOVAL_EXIT_STATUS,
      UNKNOWN_AGENT_EXIT_STATUS,
    ]) {
      await expect(runSupervisor(`exit ${status}`)).resolves.toMatchObject({ status: 0 });
    }
    for (const status of [0, 1, 70]) {
      await expect(runSupervisor(`exit ${status}`)).resolves.toMatchObject({ status: 1 });
    }
  }, 20_000);

  it('forwards a stop signal to the daemon and reports the status it drained to', async () => {
    // `launchctl bootout` SIGTERMs the wrapper: a foreground child would never
    // see it, so the daemon's own drain (and the plist's ExitTimeOut ceiling)
    // would be skipped and the terminal status lost.
    await expect(
      runSupervisor(
        `trap 'printf drained > "$LOG"; exit ${DELIBERATE_REMOVAL_EXIT_STATUS}' TERM\n` +
          'printf ready > "$READY"\nwhile :; do sleep 1; done',
        { signal: 'SIGTERM' },
      ),
    ).resolves.toMatchObject({ status: 0, signal: null, log: 'drained' });
  }, 20_000);

  it('installs, bootstraps, and replaces an agent job from the canonical launcher', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const publicKey = 'b'.repeat(64);
    const target = `${launchdUserDomain()}/${launchdAgentLabel(publicKey)}`;
    const calls: string[][] = [];
    let replaced = false;
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'bootstrap') replaced = true;
      if (args[0] === 'print') {
        return { stdout: `state = running\npid = ${replaced ? 222 : 111}\n` };
      }
      return { stdout: '' };
    });

    await expect(
      installLaunchdAgentService(publicKey, { env, invocationPath, run, waitTimeoutMs: 1_000 }),
    ).resolves.toBe(222);
    // `RunAtLoad` starts the job with bootstrap, so exactly one daemon starts.
    expect(calls).toEqual([
      ['print', target],
      ['print', target],
      ['bootout', target],
      ['enable', target],
      ['bootstrap', launchdUserDomain(), launchdAgentPlistPath(publicKey, env)],
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

  it('fails fast when launchd leaves the job stopped after a terminal daemon exit', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const publicKey = 'f'.repeat(64);
    const run = vi.fn(async (args: string[]) => {
      if (args[0] !== 'print') return { stdout: '' };
      return { stdout: 'state = not running\nlast exit code = 0\n' };
    });

    await expect(
      installLaunchdAgentService(publicKey, { env, invocationPath, run, waitTimeoutMs: 30_000 }),
    ).rejects.toThrow(/deliberate terminal status/);
  });

  it('keeps waiting while a job that has never exited is still starting', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const publicKey = '9'.repeat(64);
    let prints = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args[0] !== 'print') return { stdout: '' };
      prints += 1;
      return prints > 2
        ? { stdout: 'state = running\npid = 4242\nlast exit code = (never exited)\n' }
        : { stdout: 'state = not running\nlast exit code = (never exited)\n' };
    });

    await expect(
      installLaunchdAgentService(publicKey, { env, invocationPath, run, waitTimeoutMs: 5_000 }),
    ).resolves.toBe(4242);
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
