/**
 * The host Squire elector is not the agent daemon: an already-supervised
 * helper is exactly the host that upgrades into this lane, and it returns
 * early from `beeline start`. If the elector install sits behind that return,
 * nothing ever holds `~/.trusty-squire/broker.sock` and every granted façade
 * reports `broker unavailable` for the life of the host.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  installBroker: vi.fn(async () => undefined),
  installAgent: vi.fn(async () => 4242),
  daemonPid: vi.fn(async () => null as number | null),
}));

vi.mock('./systemd.js', () => ({
  installTrustySquireBrokerService: controls.installBroker,
  installAgentService: controls.installAgent,
}));

vi.mock('./runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime.js')>();
  return {
    ...actual,
    readRuntimeRecord: async () => ({ agent: { publicKey: 'ff'.repeat(32) } }),
    runtimeAgentCommand: () => ({ command: '/fake-agent', args: [] }),
    runtimeDaemonPid: controls.daemonPid,
  };
});

const { runStartCommand } = await import('./start-command.js');

describe('beeline start installs the host Squire elector', () => {
  let root = '';
  let previousState: string | undefined;
  let previousPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    controls.installBroker.mockClear();
    controls.installAgent.mockClear();
    controls.daemonPid.mockReset().mockResolvedValue(null);
    root = mkdtempSync(resolve(tmpdir(), 'beeline-start-broker-'));
    mkdirSync(resolve(root, 'beeline', 'agents', 'ff'.repeat(32)), { recursive: true });
    writeFileSync(resolve(root, 'beeline', 'agents', 'ff'.repeat(32), 'runtime.json'), '{}\n');
    previousState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = root;
    previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    if (previousPlatform) Object.defineProperty(process, 'platform', previousPlatform);
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const start = () =>
    runStartCommand(['start'], false, {
      updateBundle: async () => undefined,
      log: () => undefined,
    });

  it('elects on a host whose agent daemon is already supervised', async () => {
    controls.daemonPid.mockResolvedValue(9911);

    const reports = await start();

    expect(reports.map((report) => report.status)).toEqual(['already-running']);
    expect(controls.installAgent).not.toHaveBeenCalled();
    expect(controls.installBroker).toHaveBeenCalledTimes(1);
  });

  it('elects on a host that starts its agent daemon now', async () => {
    const reports = await start();

    expect(reports.map((report) => report.status)).toEqual(['started']);
    expect(controls.installAgent).toHaveBeenCalledTimes(1);
    expect(controls.installBroker).toHaveBeenCalledTimes(1);
  });

  it('starts the agent anyway when the elector cannot be installed', async () => {
    controls.installBroker.mockRejectedValueOnce(new Error('systemctl unavailable'));

    const reports = await start();

    expect(reports.map((report) => report.status)).toEqual(['started']);
    expect(controls.installAgent).toHaveBeenCalledTimes(1);
  });
});
