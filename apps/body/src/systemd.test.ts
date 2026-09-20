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
  isCanonicalInstalledLauncher,
  disableAgentService,
  reconcileAgentServices,
} from './systemd.js';

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
    expect(unit).toContain('WatchdogSec=180s');
    expect(unit).toContain('TimeoutStopSec=10min');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('ExecStart=%h/.local/bin/beeline daemon --agent %i');
    expect(unit).not.toContain('Environment="PATH=');
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

  it('reconciles only bounded enabled units whose exact runtime is absent', async () => {
    const orphan = 'd'.repeat(64);
    const live = 'e'.repeat(64);
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return {
        stdout:
          args[0] === 'list-unit-files'
            ? [
                `beeline-agent@${orphan}.service enabled`,
                `beeline-agent@${live}.service enabled`,
                'beeline-agent@../../operator.service enabled',
                'beeline-agent@short.service enabled',
              ].join('\n')
            : '',
      };
    });
    const hasRuntime = vi.fn(async (path: string) => path.includes(live));

    await expect(
      reconcileAgentServices({ env: { XDG_STATE_HOME: '/state' }, run, hasRuntime }),
    ).resolves.toEqual([orphan]);
    expect(calls).toEqual([
      ['list-unit-files', 'beeline-agent@*.service', '--state=enabled', '--no-legend', '--no-pager'],
      ['disable', `beeline-agent@${orphan}.service`],
      ['reset-failed', `beeline-agent@${orphan}.service`],
    ]);
    expect(hasRuntime).toHaveBeenCalledTimes(2);
    expect(hasRuntime.mock.calls[0]?.[0]).toBe(`/state/beeline/agents/${orphan}/runtime.json`);
    expect(hasRuntime.mock.calls[1]?.[0]).toBe(`/state/beeline/agents/${live}/runtime.json`);
  });
});
