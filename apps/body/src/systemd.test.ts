import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DELIBERATE_REMOVAL_EXIT_STATUS,
  agentServiceUnit,
  eventsServiceUnit,
  installAgentService,
  installEventsService,
  disableAgentService,
} from './systemd.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('systemd supervision contract', () => {
  it('renders notify readiness, progress watchdog, bounded stop and deliberate-removal policy', () => {
    const unit = agentServiceUnit(
      '/opt/beeline/bin/beeline',
      '/home/operator/.local/share/fnm/node-versions/v24.0.0/installation/bin/node',
      '/usr/local/bin:/usr/bin',
    );
    expect(unit).toContain('Type=notify');
    expect(unit).toContain('Environment=BEELINE_MANAGED_BY_SYSTEMD=1');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain(`RestartPreventExitStatus=${DELIBERATE_REMOVAL_EXIT_STATUS}`);
    expect(unit).toContain('WatchdogSec=180s');
    expect(unit).toContain('TimeoutStopSec=10min');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain(
      'Environment="PATH=/home/operator/.local/share/fnm/node-versions/v24.0.0/installation/bin:/usr/local/bin:/usr/bin"',
    );
    expect(unit).toContain('ExecStart="/opt/beeline/bin/beeline" daemon --agent %i');
  });

  it('renders a single credentials-scoped repository-events service under the same watchdog contract', () => {
    const unit = eventsServiceUnit('/opt/beeline/bin/beeline', '/opt/node/bin/node', '/usr/bin');
    expect(unit).toContain('Type=notify');
    expect(unit).toContain('WatchdogSec=180s');
    expect(unit).toContain('TimeoutStopSec=90s');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('EnvironmentFile=-%h/.config/beeline/events.env');
    expect(unit).toContain('ExecStart="/opt/beeline/bin/beeline" events daemon');
    expect(unit).not.toContain('%i');
  });

  it('installs one non-template events unit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-events-systemd-'));
    roots.push(root);
    const calls: string[][] = [];
    await installEventsService({
      entrypoint: '/opt/beeline/bin/beeline',
      nodePath: '/opt/node/bin/node',
      nodeVersion: '24.1.0',
      env: { XDG_CONFIG_HOME: root, PATH: '/usr/bin' },
      run: async (args) => {
        calls.push(args);
        return { stdout: '' };
      },
    });
    expect(calls).toEqual([
      ['daemon-reload'],
      ['enable', 'beeline-events.service'],
      ['restart', '--no-block', 'beeline-events.service'],
    ]);
    expect(await readFile(join(root, 'systemd/user/beeline-events.service'), 'utf8')).toContain(
      'events daemon',
    );
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
      entrypoint: '/opt/beeline/bin/beeline',
      nodePath: '/opt/fnm/node-v24/bin/node',
      nodeVersion: '24.1.0',
      env: { XDG_CONFIG_HOME: root, PATH: '/usr/bin:/bin' },
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
      'Environment="PATH=/opt/fnm/node-v24/bin:/usr/bin:/bin"',
    );
  });

  it('refuses installation below the supported Node floor before touching systemd', async () => {
    const run = vi.fn(async () => ({ stdout: '' }));
    await expect(
      installAgentService('d'.repeat(64), {
        nodePath: '/usr/bin/node',
        nodeVersion: '18.20.8',
        run,
      }),
    ).rejects.toThrow(/Node\.js 20\.11\.0 or newer.*activate your fnm\/nvm version/i);
    expect(run).not.toHaveBeenCalled();
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

    await expect(installAgentService('c'.repeat(64), { run, waitTimeoutMs: 1_000 })).resolves.toBe(
      222,
    );
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
      ['stop', '--no-block', `beeline-agent@${pubkey}.service`],
    ]);
  });
});
