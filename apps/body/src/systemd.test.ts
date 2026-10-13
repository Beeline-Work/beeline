import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupAgentService, helperServiceUnit, installHelperService, installTrustySquireBrokerService, isCanonicalInstalledLauncher, reloadHelperService, startLocalWatchdog, systemdBrokerUnitPath } from './systemd.js';
import { squireBrokerInstalledVersion, TRUSTY_SQUIRE_BROKER_UNIT_NAME, trustySquireBrokerUnit } from './squire-host.js';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('systemd supervision contract', () => {
  it('keeps an idle connected helper alive using only local watchdog progress', async () => {
    vi.useFakeTimers();
    try {
      const progress = vi.fn(async () => undefined);
      let status = 'connected';
      const stop = startLocalWatchdog({ progress }, () => status, async () => undefined, 1_000, {
        WATCHDOG_USEC: '180000000',
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(progress).toHaveBeenCalledTimes(3);
      status = 'reconnecting';
      await vi.advanceTimersByTimeAsync(1_000);
      expect(progress).toHaveBeenLastCalledWith('reconnecting', true);
      stop();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(progress).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
  it('skips a not-yet-established core and resumes on the next existing local tick', async () => {
    vi.useFakeTimers();
    const progress = vi.fn(async () => undefined);
    let established = false;
    const stop = startLocalWatchdog({ progress }, () => 'starting', async () => established,
      1_000, { WATCHDOG_USEC: '180000000' });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(progress).not.toHaveBeenCalled();
      established = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(progress).toHaveBeenCalledWith('starting', true);
    } finally { stop(); vi.useRealTimers(); }
  });
  it('logs a failed watchdog notification and feeds only an armed watchdog', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const progress = vi.fn(async () => {
        throw new Error('systemd-notify exited 1');
      });
      const unarmed = startLocalWatchdog({ progress }, () => 'idle', async () => undefined, 1_000, {});
      await vi.advanceTimersByTimeAsync(3_000);
      expect(progress).not.toHaveBeenCalled();
      unarmed();
      const stop = startLocalWatchdog({ progress }, () => 'idle', async () => undefined, 1_000, { WATCHDOG_USEC: '1' });
      await vi.advanceTimersByTimeAsync(2_000);
      stop();
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(progress).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(
        '[thin-core] watchdog notification failed:',
        expect.objectContaining({ message: 'systemd-notify exited 1' }),
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
      error.mockRestore();
    }
  });
  it('bounds a frozen macOS work barrier locally without notification or server reads', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.useFakeTimers();
    const stalled = vi.fn(), progress = vi.fn();
    const stop = startLocalWatchdog({ progress }, () => 'serving', () => new Promise(() => {}), 1000, {}, stalled);
    try {
      await vi.advanceTimersByTimeAsync(180_999);
      expect(stalled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stalled).toHaveBeenCalledOnce();
      expect(progress).not.toHaveBeenCalled();
    } finally { stop(); vi.useRealTimers(); if (descriptor) Object.defineProperty(process, 'platform', descriptor); }
  });

  it('renders one notify helper that hosts every agent and rescans on reload', () => {
    const unit = helperServiceUnit();
    expect(unit).toContain('Type=notify');
    expect(unit).toContain('Environment=BEELINE_MANAGED_BY_SYSTEMD=1');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('ExecStart=%h/.local/bin/beeline helper-bootstrap');
    expect(unit).toContain('ExecReload=/bin/kill -HUP $MAINPID');
    expect(unit).not.toContain('RestartPreventExitStatus=');
    expect(unit).not.toContain('SuccessExitStatus=');
    expect(unit).toContain('WatchdogSec=180s');
    expect(unit).toContain('TimeoutStopSec=90s');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin');
    expect(unit).toContain('AppArmorProfile=-unconfined');
    expect(unit).not.toContain('%i');
    expect(unit).not.toContain('NoNewPrivileges=');
    expect(unit).not.toContain('PrivateTmp=');
  });

  it('favours the helper over host load and never stops restarting it', () => {
    const unit = helperServiceUnit();
    for (const line of [
      'CPUWeight=1000',
      'IOWeight=1000',
      'Nice=-5',
      'OOMScoreAdjust=-1000',
      'StartLimitIntervalSec=0',
    ])
      expect(unit.split('\n')).toContain(line);
    expect(unit).not.toContain('StartLimitBurst=');
    expect(unit).not.toContain('MemoryMax=');
  });

  it('keeps the helper alive when the kernel OOM-kills one harness child', () => {
    const unit = helperServiceUnit();
    // systemd's default OOMPolicy=stop would tear the whole helper down when
    // one child is reclaimed, taking every agent on the machine with it.
    expect(unit.split('\n')).toContain('OOMPolicy=continue');
    expect(unit.split('\n')).toContain('OOMScoreAdjust=-1000');
  });

  it('keeps the checked-in reference unit identical to the rendered helper unit', async () => {
    const reference = await readFile(
      new URL('../systemd/beeline-helper.service', import.meta.url),
      'utf8',
    );
    expect(reference).toBe(helperServiceUnit());
  });

  function systemctl(state: { active: boolean; pids: number[]; legacy?: string[] }) {
    const calls: string[][] = [];
    let reads = 0;
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'show') {
        const pid = state.pids[Math.min(reads, state.pids.length - 1)] ?? 0;
        reads += 1;
        return { stdout: `MainPID=${pid}\nActiveState=${state.active || pid ? 'active' : 'inactive'}\nResult=success\n` };
      }
      if (args[0] === 'list-unit-files' || args[0] === 'list-units')
        return { stdout: (state.legacy ?? []).map((unit) => `${unit} enabled`).join('\n') };
      return { stdout: '' };
    });
    return { calls, run };
  }

  const installed = (root: string) => ({
    env: { ...process.env, HOME: '/operator', BEELINE_LIB_DIR: '/operator/.local/lib/beeline', XDG_CONFIG_HOME: root },
    invocationPath: '/operator/.local/lib/beeline/lib/beeline/beeline-cli.mjs',
  });
  const show = [
    'show', '--property=MainPID', '--property=ActiveState', '--property=Result', 'beeline-helper.service',
  ];

  it('installs, enables and starts the one helper, then retires every per-agent unit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-systemd-'));
    roots.push(root);
    await mkdir(join(root, 'systemd/user'), { recursive: true });
    await writeFile(join(root, 'systemd/user/beeline-agent@.service'), '[Unit]\nDescription=legacy Beeline agent\n');
    const first = `beeline-agent@${'a'.repeat(64)}.service`;
    const second = `beeline-agent@${'b'.repeat(64)}.service`;
    const { calls, run } = systemctl({ active: false, pids: [4242], legacy: [first, second, 'beeline-agent@short.service'] });
    await expect(installHelperService({ ...installed(root), run })).resolves.toBe(4242);
    expect(calls).toContainEqual(['start', 'beeline-helper.service']);
    expect(calls).toContainEqual(['enable', 'beeline-helper.service']);
    expect(calls).toContainEqual(['stop', first, second]);
    expect(calls.findIndex((row) => row[0] === 'stop')).toBeLessThan(calls.findIndex((row) => row[0] === 'start'));
    expect(calls.filter((row) => row[0] === 'show')).toHaveLength(1);
    expect(await readFile(join(root, 'systemd/user/beeline-helper.service'), 'utf8'))
      .toBe(helperServiceUnit());
    // The template is gone; each agent's runtime directory is never touched here.
    expect(await readdir(join(root, 'systemd/user'))).toEqual(['beeline-agent@.service.d', 'beeline-helper.service']);
  });

  it('queues a native successor before the legacy caller can be terminated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-self-handoff-')); roots.push(root);
    const id = 'a'.repeat(64), legacy = `beeline-agent@${id}.service`;
    const { calls, run } = systemctl({ active: false, pids: [], legacy: [legacy] });
    await expect(installHelperService({ ...installed(root), run, selfAgent: id })).resolves.toBe(0);
    expect(calls).toContainEqual(['disable', legacy]);
    expect(calls).toContainEqual(['enable', 'beeline-helper.service']);
    expect(calls.at(-1)).toEqual(['start', '--no-block', 'beeline-helper.service']);
    expect(calls.some((row) => row[0] === 'stop')).toBe(false);
    expect(await readFile(join(root, 'systemd/user/beeline-helper.service.d/legacy-forward-migration.conf'), 'utf8')).toContain(`Conflicts=${legacy}\nAfter=${legacy}`);
  });

  it('never disables the sole helper when native start fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-systemd-failure-')); roots.push(root);
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); if (args[0] === 'start') throw new Error('native start timed out'); return { stdout: '' }; };
    await expect(installHelperService({ ...installed(root), run })).rejects.toThrow('native start timed out');
    expect(calls).toContainEqual(['enable', 'beeline-helper.service']);
    expect(calls).not.toContainEqual(['disable', 'beeline-helper.service']);
    expect(calls).not.toContainEqual(['stop', 'beeline-helper.service']);
  });

  it.each(['inactive', 'active'])('migrates a deleted legacy unit whose native state is %s', async (state) => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-missing-legacy-')); roots.push(root);
    const legacy = `beeline-agent@${'d'.repeat(64)}.service`, calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'list-units') return { stdout: `${legacy} not-found ${state} dead\n` };
      if (args[0] === 'disable') throw new Error(`Failed to disable unit: Unit file ${legacy} does not exist.`);
      return { stdout: args[0] === 'show' ? 'MainPID=42\n' : '' };
    };
    await expect(installHelperService({ ...installed(root), run })).resolves.toBe(42);
    expect(calls.some((row) => row[0] === 'stop')).toBe(state === 'active');
    expect(calls).toContainEqual(['enable', 'beeline-helper.service']);
  });

  it('asks a running helper to rescan instead of restarting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-systemd-'));
    roots.push(root);
    const { calls, run } = systemctl({ active: true, pids: [777] });
    await expect(installHelperService({ ...installed(root), run })).resolves.toBe(777);
    expect(calls).toContainEqual(['reload', 'beeline-helper.service']);
    expect(calls.some((args) => args[0] === 'restart')).toBe(false);
    expect(calls.some((args) => args[0] === 'stop')).toBe(false);
  });

  it('refuses a worktree invocation before touching the shared user unit', async () => {
    const run = vi.fn(async () => ({ stdout: '' }));
    await expect(
      installHelperService({
        env: { ...process.env, HOME: '/operator', BEELINE_LIB_DIR: '/operator/.local/lib/beeline' },
        invocationPath: '/worktree/apps/body/src/cli.ts',
        run,
      }),
    ).rejects.toThrow(/refusing to modify.*canonical.*launcher/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts only the installed launcher's stable lib anchor", () => {
    expect(
      isCanonicalInstalledLauncher(
        { HOME: '/operator', BEELINE_LIB_DIR: '/operator/.local/lib/beeline' },
        '/operator/.local/lib/beeline/lib/beeline/beeline-cli.mjs',
      ),
    ).toBe(true);
    expect(
      isCanonicalInstalledLauncher(
        { HOME: '/operator', BEELINE_LIB_DIR: '/operator/.local/lib/beeline' },
        '/worktree/apps/body/src/cli.ts',
      ),
    ).toBe(false);
  });

  it('reloads only a helper that is running', async () => {
    const running = systemctl({ active: true, pids: [10] });
    await expect(reloadHelperService({ run: running.run })).resolves.toBe(true);
    expect(running.calls.at(-1)).toEqual(['reload', 'beeline-helper.service']);
    const stopped = systemctl({ active: false, pids: [0] });
    await expect(reloadHelperService({ run: stopped.run })).resolves.toBe(false);
    expect(stopped.calls).toEqual([show]);
  });

  it('clears a retired agent\'s leftover per-agent unit, and nothing when there is none', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: args[0] === 'show' ? (args.at(-1)!.includes('a'.repeat(64)) ? 'loaded\n' : 'not-found\n') : '' };
    });
    await expect(cleanupAgentService('a'.repeat(64), { run })).resolves.toBe(true);
    await expect(cleanupAgentService('b'.repeat(64), { run })).resolves.toBe(false);
    expect(calls.filter((args) => args[0] !== 'show')).toEqual([
      ['disable', `beeline-agent@${'a'.repeat(64)}.service`],
      ['reset-failed', `beeline-agent@${'a'.repeat(64)}.service`],
    ]);
  });
});

describe('trusty squire host broker unit', () => {
  it('installs one host elector with no PrivateTmp and enables it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-squire-broker-'));
    roots.push(root);
    const home = await mkdtemp(join(tmpdir(), 'beeline-squire-home-'));
    roots.push(home);
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: '' };
    });
    let published = '1.1.32';
    const squireInstallRun = vi.fn(async (_command: string, args: readonly string[], installOptions: { cwd: string }) => {
      if (args[0] === 'view') return { code: 0, stderr: '', stdout: published };
      const entryDir = join(installOptions.cwd, 'node_modules', '@trusty-squire', 'mcp', 'dist');
      await mkdir(entryDir, { recursive: true });
      await writeFile(join(entryDir, 'bin.js'), '');
      await writeFile(join(entryDir, '..', 'package.json'), JSON.stringify({ version: published }));
      return { code: 0, stderr: '' };
    });
    const options = {
      env: {
        ...process.env,
        HOME: home,
        BEELINE_LIB_DIR: `${home}/.local/lib/beeline`,
        XDG_CONFIG_HOME: root,
      },
      invocationPath: `${home}/.local/lib/beeline/lib/beeline/beeline-cli.mjs`,
      run,
      squireInstallRun,
    };
    await installTrustySquireBrokerService(options);
    expect(squireInstallRun).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      ['daemon-reload'],
      ['enable', TRUSTY_SQUIRE_BROKER_UNIT_NAME],
      ['restart', '--no-block', TRUSTY_SQUIRE_BROKER_UNIT_NAME],
    ]);
    const written = await readFile(systemdBrokerUnitPath({ XDG_CONFIG_HOME: root }), 'utf8');
    expect(written).toBe(trustySquireBrokerUnit());
    expect(written).not.toContain('PrivateTmp');
    const marker = JSON.parse(
      await readFile(join(home, '.trusty-squire', '.trusty-squire-broker-unit.json'), 'utf8'),
    );
    expect(marker.socket).toBe(join(home, '.trusty-squire', 'broker.sock'));

    calls.length = 0;
    await installTrustySquireBrokerService(options);
    expect(squireInstallRun).toHaveBeenCalledTimes(3);
    expect(calls).not.toContainEqual(['restart', '--no-block', TRUSTY_SQUIRE_BROKER_UNIT_NAME]);

    published = '1.1.33';
    calls.length = 0;
    await installTrustySquireBrokerService(options);
    expect(calls).toContainEqual(['restart', '--no-block', TRUSTY_SQUIRE_BROKER_UNIT_NAME]);

    published = '1.1.34';
    calls.length = 0;
    await expect(installTrustySquireBrokerService({
      ...options,
      squireInstallRun: async (_command, args) => args[0] === 'view'
        ? { code: 0, stderr: '', stdout: published }
        : { code: 1, stderr: 'download failed' },
    })).rejects.toThrow('download failed');
    expect(calls).toEqual([]);
    expect(squireBrokerInstalledVersion(home)).toBe('1.1.33');
  });
});
