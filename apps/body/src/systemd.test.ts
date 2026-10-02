import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DAEMON_DISTRESS_EXIT_STATUS,
  DELIBERATE_REMOVAL_EXIT_STATUS,
  UNKNOWN_AGENT_EXIT_STATUS,
  agentServiceUnit,
  convergeAgentServiceUnit,
  installAgentService,
  installTrustySquireBrokerService,
  isCanonicalInstalledLauncher,
  disableAgentService,
  reconcileAgentServices,
  startLocalWatchdog,
  systemdBrokerUnitPath,
} from './systemd.js';
import { TRUSTY_SQUIRE_BROKER_UNIT_NAME, trustySquireBrokerUnit } from './squire-host.js';
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
      const stop = startLocalWatchdog({ progress }, () => status, 1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(progress).toHaveBeenCalledTimes(3);
      status = 'reconnecting';
      await vi.advanceTimersByTimeAsync(1_000);
      expect(progress).toHaveBeenLastCalledWith('reconnecting');
      stop();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(progress).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
  it('renders notify readiness, progress watchdog, bounded stop and deliberate-removal policy', () => {
    const unit = agentServiceUnit();
    expect(unit).toContain('Type=notify');
    expect(unit).toContain('Environment=BEELINE_MANAGED_BY_SYSTEMD=1');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain(
      `RestartPreventExitStatus=${DAEMON_DISTRESS_EXIT_STATUS} ${DELIBERATE_REMOVAL_EXIT_STATUS} ${UNKNOWN_AGENT_EXIT_STATUS}`,
    );
    expect(unit).toContain(`SuccessExitStatus=${UNKNOWN_AGENT_EXIT_STATUS}`);
    expect(unit).toContain('WatchdogSec=180s');
    expect(unit).toContain('TimeoutStopSec=90s');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('ExecStart=%h/.local/bin/beeline daemon --agent %i');
    expect(unit).toContain('Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin');
    expect(unit).toContain('AppArmorProfile=-unconfined');
    expect(unit).not.toContain('NoNewPrivileges=');
    expect(unit).not.toContain('PrivateTmp=');
  });

  it('favours the helper over host load and never stops restarting it', () => {
    const unit = agentServiceUnit();
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

  it('keeps the unit alive when the kernel OOM-kills one harness child', () => {
    const unit = agentServiceUnit();
    // systemd's default OOMPolicy=stop would tear down the whole unit when one
    // child is reclaimed, taking every other agent's daemon with it.
    expect(unit.split('\n')).toContain('OOMPolicy=continue');
    // The daemon stays off the kernel's victim list so the child is reclaimed.
    expect(unit.split('\n')).toContain('OOMScoreAdjust=-1000');
  });

  it('keeps the checked-in reference unit on the same OOM policy as the rendered template', async () => {
    // apps/body/systemd/beeline-agent@.service is the checked-in reference copy
    // of the installed unit; letting it drift here is how the OOM policy would
    // silently regress on a host that installs from it.
    const reference = await readFile(
      new URL('../systemd/beeline-agent@.service', import.meta.url),
      'utf8',
    );
    expect(reference.split('\n')).toContain('OOMPolicy=continue');
    expect(reference.split('\n')).toContain('OOMScoreAdjust=-1000');
  });

  it('converges the installed template on update without restarting an agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-systemd-converge-'));
    roots.push(root);
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: '' };
    });
    const home = '/operator';
    const libDir = `${home}/.local/lib/beeline`;
    const changed = await convergeAgentServiceUnit({
      libDir,
      env: { HOME: home, BEELINE_LIB_DIR: libDir, XDG_CONFIG_HOME: root },
      run,
    });
    expect(changed).toBe(true);
    expect(calls).toEqual([['daemon-reload']]);
    const written = await readFile(join(root, 'systemd/user/beeline-agent@.service'), 'utf8');
    expect(written).toContain('OOMPolicy=continue');

    // A second convergence with the same content touches nothing.
    calls.length = 0;
    await expect(
      convergeAgentServiceUnit({
        libDir,
        env: { HOME: home, BEELINE_LIB_DIR: libDir, XDG_CONFIG_HOME: root },
        run,
      }),
    ).resolves.toBe(false);
    expect(calls).toEqual([]);

    // A non-canonical checkout may not rewrite the shared user unit.
    await expect(
      convergeAgentServiceUnit({
        libDir: '/worktree',
        env: { HOME: home, BEELINE_LIB_DIR: '/worktree', XDG_CONFIG_HOME: root },
        run,
      }),
    ).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('installs, enables, starts, and returns the supervised main pid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-systemd-'));
    roots.push(root);
    const calls: string[][] = [];
    let statusReads = 0;
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] !== 'show') return { stdout: '' };
      statusReads += 1;
      return {
        stdout: `MainPID=${statusReads === 1 ? 0 : 4242}\nActiveState=active\nResult=success\n`,
      };
    });
    const pubkey = 'a'.repeat(64);
    const pid = await installAgentService(pubkey, {
      env: {
        HOME: '/operator',
        BEELINE_LIB_DIR: '/operator/.local/lib/beeline',
        XDG_CONFIG_HOME: root,
      },
      invocationPath: '/operator/.local/lib/beeline/lib/beeline/beeline-cli.mjs',
      run,
    });

    expect(pid).toBe(4242);
    expect(calls).toEqual([
      ['daemon-reload'],
      ['enable', `beeline-agent@${pubkey}.service`],
      [
        'show',
        '--property=MainPID',
        '--property=ActiveState',
        '--property=Result',
        `beeline-agent@${pubkey}.service`,
      ],
      ['restart', '--no-block', `beeline-agent@${pubkey}.service`],
      [
        'show',
        '--property=MainPID',
        '--property=ActiveState',
        '--property=Result',
        `beeline-agent@${pubkey}.service`,
      ],
    ]);
    expect(await readFile(join(root, 'systemd/user/beeline-agent@.service'), 'utf8')).toContain(
      'ExecStart=%h/.local/bin/beeline daemon --agent %i',
    );
  });

  it('refuses a worktree invocation before touching the shared user unit', async () => {
    const run = vi.fn(async () => ({ stdout: '' }));
    await expect(
      installAgentService('d'.repeat(64), {
        env: { HOME: '/operator', BEELINE_LIB_DIR: '/operator/.local/lib/beeline' },
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

  it('waits for an already-running unit to publish a replacement MainPID', async () => {
    const calls: string[][] = [];
    let statusReads = 0;
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] !== 'show') return { stdout: '' };
      statusReads += 1;
      return {
        stdout: `MainPID=${statusReads < 3 ? 111 : 222}\nActiveState=active\nResult=success\n`,
      };
    });

    await expect(
      installAgentService('c'.repeat(64), {
        env: { HOME: '/operator', BEELINE_LIB_DIR: '/operator/.local/lib/beeline' },
        invocationPath: '/operator/.local/lib/beeline/lib/beeline/beeline-cli.mjs',
        run,
        waitTimeoutMs: 1_000,
      }),
    ).resolves.toBe(222);
    expect(calls).toContainEqual([
      'restart',
      '--no-block',
      `beeline-agent@${'c'.repeat(64)}.service`,
    ]);
  });

  it('disables before requesting a non-blocking graceful stop', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: '' };
    });
    const pubkey = 'b'.repeat(64);
    await disableAgentService(pubkey, { run });
    expect(calls).toEqual([
      ['disable', `beeline-agent@${pubkey}.service`],
      ['reset-failed', `beeline-agent@${pubkey}.service`],
      ['stop', '--no-block', `beeline-agent@${pubkey}.service`],
    ]);
  });

  it('isolates orphan cleanup failures while preserving exact-unit and live-runtime boundaries', async () => {
    const disableFailure = 'c'.repeat(64);
    const resetFailure = 'd'.repeat(64);
    const reconciled = 'e'.repeat(64);
    const live = 'f'.repeat(64);
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'disable' && args[1]?.includes(disableFailure)) {
        throw new Error('simulated disable failure');
      }
      if (args[0] === 'reset-failed' && args[1]?.includes(resetFailure)) {
        throw new Error('simulated reset failure');
      }
      return {
        stdout:
          args[0] === 'list-unit-files'
            ? [
                `beeline-agent@${disableFailure}.service enabled`,
                `beeline-agent@${resetFailure}.service enabled`,
                `beeline-agent@${reconciled}.service enabled`,
                `beeline-agent@${live}.service enabled`,
                `beeline-agent@${'a'.repeat(64)}.service enabled-runtime`,
                'beeline-agent@../../operator.service enabled',
                'beeline-agent@short.service enabled',
              ].join('\n')
            : '',
      };
    });
    const hasRuntime = vi.fn(async (path: string) => path.includes(live));
    const reportFailure = vi.fn();

    await expect(
      reconcileAgentServices({
        env: { XDG_STATE_HOME: '/state' },
        run,
        hasRuntime,
        reportFailure,
      }),
    ).resolves.toEqual([reconciled]);
    expect(calls).toEqual([
      ['list-unit-files', 'beeline-agent@*.service', '--state=enabled', '--no-legend', '--no-pager'],
      ['disable', `beeline-agent@${disableFailure}.service`],
      ['disable', `beeline-agent@${resetFailure}.service`],
      ['reset-failed', `beeline-agent@${resetFailure}.service`],
      ['disable', `beeline-agent@${reconciled}.service`],
      ['reset-failed', `beeline-agent@${reconciled}.service`],
    ]);
    expect(reportFailure).toHaveBeenCalledTimes(2);
    expect(reportFailure.mock.calls[0]?.[0]).toBe(
      `beeline-agent@${disableFailure}.service`,
    );
    expect(reportFailure.mock.calls[0]?.[1]).toEqual(new Error('simulated disable failure'));
    expect(reportFailure.mock.calls[1]?.[0]).toBe(`beeline-agent@${resetFailure}.service`);
    expect(reportFailure.mock.calls[1]?.[1]).toEqual(new Error('simulated reset failure'));
    expect(hasRuntime).toHaveBeenCalledTimes(4);
    expect(hasRuntime.mock.calls.map(([path]) => path)).toEqual([
      `/state/beeline/agents/${disableFailure}/runtime.json`,
      `/state/beeline/agents/${resetFailure}/runtime.json`,
      `/state/beeline/agents/${reconciled}/runtime.json`,
      `/state/beeline/agents/${live}/runtime.json`,
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
    await installTrustySquireBrokerService({
      env: {
        HOME: home,
        BEELINE_LIB_DIR: `${home}/.local/lib/beeline`,
        XDG_CONFIG_HOME: root,
      },
      invocationPath: `${home}/.local/lib/beeline/lib/beeline/beeline-cli.mjs`,
      run,
    });
    expect(calls).toEqual([
      ['daemon-reload'],
      ['enable', TRUSTY_SQUIRE_BROKER_UNIT_NAME],
      ['restart', '--no-block', TRUSTY_SQUIRE_BROKER_UNIT_NAME],
    ]);
    const written = await readFile(systemdBrokerUnitPath({ XDG_CONFIG_HOME: root }), 'utf8');
    expect(written).toBe(trustySquireBrokerUnit());
    expect(written).not.toContain('PrivateTmp');
  });
});
