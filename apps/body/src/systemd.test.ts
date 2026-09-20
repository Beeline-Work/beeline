import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DAEMON_DISTRESS_EXIT_STATUS,
  DELIBERATE_REMOVAL_EXIT_STATUS,
  UNKNOWN_AGENT_EXIT_STATUS,
  agentServiceUnit,
  installAgentService,
  installTrustySquireBrokerService,
  isCanonicalInstalledLauncher,
  disableAgentService,
  reconcileAgentServices,
  systemdBrokerUnitPath,
} from './systemd.js';
import { TRUSTY_SQUIRE_BROKER_UNIT_NAME, trustySquireBrokerUnit } from './squire-host.js';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('systemd supervision contract', () => {
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
    expect(unit).toContain('TimeoutStopSec=10min');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('ExecStart=%h/.local/bin/beeline daemon --agent %i');
    expect(unit).toContain('Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin');
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
      ['enable', '--now', TRUSTY_SQUIRE_BROKER_UNIT_NAME],
    ]);
    const written = await readFile(systemdBrokerUnitPath({ XDG_CONFIG_HOME: root }), 'utf8');
    expect(written).toBe(trustySquireBrokerUnit());
    expect(written).not.toContain('PrivateTmp');
  });
});
