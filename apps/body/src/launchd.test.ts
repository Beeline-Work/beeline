import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LAUNCHD_BROKER_LABEL,
  LAUNCHD_HELPER_LABEL,
  cleanupLaunchdAgentService,
  installLaunchdHelperService,
  installLaunchdTrustySquireBrokerService,
  launchdAgentLabel,
  launchdAgentPlist,
  launchdAgentPlistPath,
  launchdAgentSupervisorPath,
  launchdAgentSupervisorScript,
  launchdBrokerPlistPath,
  launchdHelperPlist,
  launchdHelperPlistPath,
  launchdHelperSupervisorPath,
  launchdHelperSupervisorScript,
  launchdUserDomain,
  restoreLegacyLaunchdAgents,
  retireLegacyLaunchdAgents,
} from './launchd.js';
import {
  DAEMON_DISTRESS_EXIT_STATUS,
  DELIBERATE_REMOVAL_EXIT_STATUS,
  NO_AGENTS_EXIT_STATUS,
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
  if (!root || typeof root !== 'object' || Array.isArray(root))
    throw new Error('plist has no root dict');
  return root as Record<string, PlistValue>;
}

/**
 * Install the generated wrapper with a stub daemon and report the exit status
 * launchd would observe. `signal` is delivered to the wrapper once the stub is
 * running, standing in for `launchctl bootout`.
 */
async function runSupervisor(
  daemon: string,
  options: { signal?: NodeJS.Signals; helper?: boolean } = {},
): Promise<{ status: number | null; signal: NodeJS.Signals | null; log: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-launchd-wrapper-'));
  roots.push(root);
  const supervisor = resolve(root, 'supervise-agent');
  const stub = resolve(root, 'beeline');
  const ready = resolve(root, 'ready');
  const log = resolve(root, 'log');
  await writeFile(
    supervisor,
    options.helper ? launchdHelperSupervisorScript() : launchdAgentSupervisorScript(),
    { mode: 0o700 },
  );
  await chmod(supervisor, 0o700);
  await writeFile(
    stub,
    `#!/bin/sh\nLOG=${JSON.stringify(log)}\nREADY=${JSON.stringify(ready)}\n${daemon}\n`,
    { mode: 0o700 },
  );
  await chmod(stub, 0o700);
  const child = spawn(supervisor, options.helper ? [stub] : ['a'.repeat(64), stub], { stdio: 'ignore' });
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

/**
 * A launchd whose job is mid-teardown: `bootout` answers `36: Operation now in
 * progress`, the label stays in the domain for two more reads, and a `bootstrap`
 * while it is still there is refused the way launchd refuses it.
 */
function terminatingJob(): (args: string[]) => Promise<{ stdout: string }> {
  let loaded = true;
  let reaped = false;
  let readsBeforeGone = 2;
  let pid = 111;
  return async (args) => {
    if (args[0] === 'print') {
      if (!loaded) throw new Error('Could not find service');
      if (!reaped) {
        if (readsBeforeGone > 0) readsBeforeGone -= 1;
        else {
          reaped = true;
          loaded = false;
          throw new Error('Could not find service');
        }
      }
      return { stdout: `state = running\npid = ${pid}\n` };
    }
    if (args[0] === 'bootout') {
      throw Object.assign(new Error('Command failed: launchctl bootout'), {
        stderr: 'Boot-out failed: 36: Operation now in progress\n',
      });
    }
    if (args[0] === 'bootstrap') {
      if (loaded) throw new Error('Bootstrap failed: 37: Operation already in progress');
      loaded = true;
      pid = 222;
    }
    return { stdout: '' };
  };
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
  it('renders one login-persistent helper job for every agent, restarted on unsuccessful exit', () => {
    const env = { HOME: '/Users/operator' };
    const job = parsePlist(launchdHelperPlist(env));
    expect(job.Label).toBe(LAUNCHD_HELPER_LABEL);
    expect(job.ProgramArguments).toEqual([
      launchdHelperSupervisorPath(env),
      '/Users/operator/.local/bin/beeline',
    ]);
    expect(job.RunAtLoad).toBe(true);
    expect(job.KeepAlive).toEqual({ SuccessfulExit: false });
    expect(job.ThrottleInterval).toBe(5);
    expect(job.ExitTimeOut).toBe(600);
    // A `Background` ProcessType puts the job — and every ACP harness and build
    // it spawns — in darwin's throttled background task role.
    expect(job.ProcessType).toBeUndefined();
    const environment = job.EnvironmentVariables as Record<string, PlistValue>;
    expect(String(environment.PATH).split(':')).toContain('/Users/operator/.local/bin');
    expect(job.StandardOutPath).toBe('/Users/operator/Library/Logs/Beeline/helper.log');
    expect(launchdHelperSupervisorScript()).toContain('"$1" daemon --machine &');
  });

  it('keeps the per-agent job a rollback hands agents back to', () => {
    const publicKey = 'a'.repeat(64);
    const env = { HOME: '/Users/operator' };
    const job = parsePlist(launchdAgentPlist(publicKey, env));
    expect(job.Label).toBe(launchdAgentLabel(publicKey));
    expect(job.ProgramArguments).toEqual([
      launchdAgentSupervisorPath(env),
      publicKey,
      '/Users/operator/.local/bin/beeline',
    ]);
  });

  it('stops the helper for good only when it has no agent to host', async () => {
    await expect(runSupervisor(`exit ${NO_AGENTS_EXIT_STATUS}`, { helper: true }))
      .resolves.toMatchObject({ status: 0 });
    for (const status of [0, 1, 75])
      await expect(runSupervisor(`exit ${status}`, { helper: true })).resolves.toMatchObject({ status: 1 });
  }, 20_000);

  it('forwards a stop to the helper so every agent drains, and a hangup so it rescans', async () => {
    await expect(
      runSupervisor(
        `trap 'printf drained > "$LOG"; exit 0' TERM\nprintf ready > "$READY"\nwhile :; do sleep 1; done`,
        { signal: 'SIGTERM', helper: true },
      ),
    ).resolves.toMatchObject({ status: 1, signal: null, log: 'drained' });
    await expect(
      runSupervisor(
        `trap 'printf rescanned > "$LOG"; exit ${NO_AGENTS_EXIT_STATUS}' HUP\nprintf ready > "$READY"\nwhile :; do sleep 1; done`,
        { signal: 'SIGHUP', helper: true },
      ),
    ).resolves.toMatchObject({ status: 0, signal: null, log: 'rescanned' });
  }, 20_000);

  it('maps the per-agent job statuses the way it always has', async () => {
    for (const status of [
      DAEMON_DISTRESS_EXIT_STATUS,
      DELIBERATE_REMOVAL_EXIT_STATUS,
      UNKNOWN_AGENT_EXIT_STATUS,
    ]) {
      await expect(runSupervisor(`exit ${status}`)).resolves.toMatchObject({ status: 0 });
    }
    await expect(runSupervisor('exit 1')).resolves.toMatchObject({ status: 1 });
  }, 20_000);

  async function legacyJobs(env: { HOME: string }, keys: string[]) {
    const directory = resolve(env.HOME, 'Library', 'LaunchAgents');
    await mkdir(directory, { recursive: true });
    for (const key of keys) await writeFile(launchdAgentPlistPath(key, env), launchdAgentPlist(key, env));
    await writeFile(resolve(directory, 'app.usebeeline.agent.short.plist'), '');
  }

  it('bootstraps the helper job, then retires every per-agent job, its own last', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const own = 'b'.repeat(64);
    const other = 'c'.repeat(64);
    await legacyJobs(env, [own, other]);
    const domain = launchdUserDomain();
    const target = `${domain}/${LAUNCHD_HELPER_LABEL}`;
    const calls: string[][] = [];
    let loaded = false;
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'bootstrap') loaded = true;
      if (args[0] === 'print') {
        if (!loaded) throw new Error('Could not find service');
        return { stdout: 'state = running\npid = 222\n' };
      }
      return { stdout: '' };
    });
    await expect(installLaunchdHelperService({
      env, invocationPath, run, waitTimeoutMs: 1_000, selfLabel: launchdAgentLabel(own),
    })).resolves.toBe(222);
    const ownLabel = `${domain}/${launchdAgentLabel(own)}`;
    const otherLabel = `${domain}/${launchdAgentLabel(other)}`;
    expect(calls).toEqual([
      ['print', target],
      ['print', target],
      ['enable', target],
      ['print', target],
      ['bootstrap', domain, launchdHelperPlistPath(env)],
      ['print', target],
      ['disable', otherLabel], ['bootout', otherLabel],
      ['disable', ownLabel], ['bootout', ownLabel],
    ]);
    await expect(stat(launchdAgentPlistPath(own, env))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(launchdAgentPlistPath(other, env))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(launchdHelperSupervisorPath(env), 'utf8')).toBe(launchdHelperSupervisorScript());
  });

  it('asks a running, unchanged helper to rescan with SIGHUP instead of replacing it', async () => {
    const { env, invocationPath } = await canonicalEnv();
    const first = vi.fn(async (args: string[]) => {
      if (args[0] === 'print') throw new Error('not loaded');
      return { stdout: '' };
    });
    await installLaunchdHelperService({ env, invocationPath, run: async (args) => {
      if (args[0] === 'bootstrap') first.mockImplementation(async () => ({ stdout: 'state = running\npid = 5\n' }));
      return first(args);
    }, waitTimeoutMs: 1_000 });
    const helper = spawn('sleep', ['30'], { stdio: 'ignore' });
    const hungUp = new Promise<NodeJS.Signals | null>((done) => helper.once('exit', (_code, signal) => done(signal)));
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: args[0] === 'print' ? `state = running\npid = ${helper.pid}\n` : '' };
    });
    await expect(installLaunchdHelperService({ env, invocationPath, run })).resolves.toBe(helper.pid);
    await expect(hungUp).resolves.toBe('SIGHUP');
    expect(calls.some((args) => ['bootout', 'bootstrap', 'kickstart'].includes(args[0]!))).toBe(false);
  });

  it('hands every agent back to its per-agent job after a rollback, and stands the helper down', async () => {
    const { env } = await canonicalEnv();
    await mkdir(resolve(env.HOME, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(launchdHelperPlistPath(env), launchdHelperPlist(env));
    const keys = ['a'.repeat(64), 'b'.repeat(64)];
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: '' };
    });
    await restoreLegacyLaunchdAgents(keys, { env, run });
    const domain = launchdUserDomain();
    expect(calls).toEqual([
      ['enable', `${domain}/${launchdAgentLabel(keys[0]!)}`],
      ['bootstrap', domain, launchdAgentPlistPath(keys[0]!, env)],
      ['enable', `${domain}/${launchdAgentLabel(keys[1]!)}`],
      ['bootstrap', domain, launchdAgentPlistPath(keys[1]!, env)],
      ['disable', `${domain}/${LAUNCHD_HELPER_LABEL}`],
    ]);
    expect(await readFile(launchdAgentPlistPath(keys[0]!, env), 'utf8')).toBe(launchdAgentPlist(keys[0]!, env));
    await expect(stat(launchdHelperPlistPath(env))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retires nothing on a host that never had per-agent jobs', async () => {
    const { env } = await canonicalEnv();
    const run = vi.fn(async () => ({ stdout: '' }));
    await expect(retireLegacyLaunchdAgents({ env, run })).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('clears a retired agent\'s leftover per-agent job without booting anything out', async () => {
    const { env } = await canonicalEnv();
    const publicKey = 'e'.repeat(64);
    await legacyJobs(env, [publicKey]);
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
    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run });
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
    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run: first });
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: args[0] === 'print' ? 'state = running\npid = 321\n' : '' };
    });

    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run });

    expect(calls).toEqual([
      ['enable', target],
      ['print', target],
      ['kickstart', target],
    ]);
  });

  it('bootstraps the broker after a removal in progress instead of kickstarting a dying job', async () => {
    const { env, invocationPath } = await canonicalEnv();
    await installLaunchdTrustySquireBrokerService({
      env,
      invocationPath,
      run: async (args) => {
        if (args[0] === 'print') throw new Error('not loaded');
        return { stdout: '' };
      },
    });
    const launchd = terminatingJob();
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return launchd(args);
    });

    await installLaunchdTrustySquireBrokerService({ env, invocationPath, run, restart: true });

    expect(calls.some((args) => args[0] === 'kickstart')).toBe(false);
    expect(calls.filter((args) => args[0] === 'bootstrap')).toEqual([
      ['bootstrap', launchdUserDomain(), launchdBrokerPlistPath(env)],
    ]);
  });
});
