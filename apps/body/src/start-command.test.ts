import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  processBirthIdentity,
  runtimeDaemonPid,
  stopRuntimeDaemon,
  writeDaemonPidRecord,
} from './runtime.js';
import {
  runStartCommand,
  startStoredRuntime,
  type AgentStartOutcome,
} from './start-command.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startStoredRuntime (beeline start already-running is a no-op)', () => {
  function fixture() {
    const calls: string[] = [];
    let launched = 0;
    const deps = {
      readPid: vi.fn(async () => null as number | null),
      launch: vi.fn(async (_path: string) => ++launched + 1000),
      log: (line: string) => calls.push(line),
    };
    return { calls, deps };
  }

  it('launches when no daemon is running', async () => {
    const f = fixture();
    const outcome = await startStoredRuntime('/tmp/x/runtime.json', {}, f.deps);
    expect(outcome).toEqual({ status: 'started', pid: 1001 });
    expect(f.calls.join('\n')).toContain('[beeline] agent started (pid 1001)');
  });

  it('leaves a live daemon untouched', async () => {
    const f = fixture();
    f.deps.readPid.mockResolvedValue(4242);
    const outcome = await startStoredRuntime('/tmp/x/runtime.json', {}, f.deps);
    expect(outcome).toEqual({ status: 'already-running', pid: 4242 });
    expect(f.deps.launch).not.toHaveBeenCalled();
    expect(f.calls.join('\n')).toContain('[beeline] agent already running (pid 4242)');
  });
});

describe('runStartCommand reports every agent against injected starts', () => {
  it('continues after one failure and names each outcome', async () => {
    const logs: string[] = [];
    const startOne = vi
      .fn<
        (
          configPath: string,
        ) => Promise<AgentStartOutcome>
      >()
      .mockResolvedValueOnce({ status: 'started', pid: 11 })
      .mockResolvedValueOnce({ status: 'already-running', pid: 22 })
      .mockRejectedValueOnce(new Error('disk full'));

    // Drive the loop by stubbing select via real host discovery of three
    // temp runtime dirs under an isolated XDG_STATE_HOME.
    const root = mkdtempSync(resolve(tmpdir(), 'beeline-start-report-'));
    const keys = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)];
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = root;
    try {
      for (const key of keys) {
        const dir = resolve(root, 'beeline', 'agents', key);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'runtime.json'), '{}\n');
      }
      await expect(
        runStartCommand(['start'], false, {
          updateBundle: async () => undefined,
          startOne,
          log: (line) => logs.push(line),
        }),
      ).rejects.toThrow(/failed to start 1 of 3 agent/);
      expect(startOne).toHaveBeenCalledTimes(3);
      expect(logs.some((line) => line.includes(`${keys[0]}: started (pid 11)`))).toBe(true);
      expect(logs.some((line) => line.includes(`${keys[1]}: already running (pid 22)`))).toBe(true);
      expect(logs.some((line) => line.includes(`${keys[2]}: failed (disk full)`))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates before the first agent start', async () => {
    const order: string[] = [];
    const root = mkdtempSync(resolve(tmpdir(), 'beeline-start-update-'));
    const key = 'dd'.repeat(32);
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = root;
    try {
      mkdirSync(resolve(root, 'beeline', 'agents', key), { recursive: true });
      writeFileSync(resolve(root, 'beeline', 'agents', key, 'runtime.json'), '{}\n');
      await runStartCommand(['start'], false, {
        updateBundle: async () => {
          order.push('update');
        },
        startOne: async () => {
          order.push('start');
          return { status: 'started', pid: 9 };
        },
        log: () => undefined,
      });
      expect(order).toEqual(['update', 'start']);
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says the update failed and still starts agents on the current bundle', async () => {
    const logs: string[] = [];
    const root = mkdtempSync(resolve(tmpdir(), 'beeline-start-update-fail-'));
    const key = 'ee'.repeat(32);
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = root;
    try {
      mkdirSync(resolve(root, 'beeline', 'agents', key), { recursive: true });
      writeFileSync(resolve(root, 'beeline', 'agents', key, 'runtime.json'), '{}\n');
      const reports = await runStartCommand(['start'], false, {
        updateBundle: async () => {
          throw new Error('manifest fetch failed: HTTP 503');
        },
        startOne: async () => ({ status: 'started', pid: 7 }),
        log: (line) => logs.push(line),
      });
      expect(logs.some((line) => line.includes('helper update failed (manifest fetch failed: HTTP 503)'))).toBe(
        true,
      );
      expect(logs.some((line) => line.includes('starting agents on the current bundle'))).toBe(true);
      expect(reports).toEqual([
        { id: key, path: resolve(root, 'beeline', 'agents', key, 'runtime.json'), status: 'started', pid: 7 },
      ]);
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stale pid recovery (gone vs recycled birth)', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function spawnStubDaemon(configPath: string): Promise<{ pid: number; child: ReturnType<typeof spawn> }> {
    const script = resolve(root, 'stub-daemon.mjs');
    writeFileSync(
      script,
      `process.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1_000);\n`,
    );
    return new Promise((resolveSpawn, reject) => {
      const child = spawn(process.execPath, [script, 'daemon', '--config', configPath], {
        stdio: 'ignore',
      });
      child.once('spawn', () => resolveSpawn({ pid: child.pid!, child }));
      child.once('error', reject);
    });
  }

  async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 5_000): Promise<void> {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolveWait, reject) => {
      const timer = setTimeout(() => reject(new Error('stub did not exit')), timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveWait();
      });
    });
  }

  it('revives an agent killed by SIGTERM instead of refusing the stale pid', async () => {
    root = mkdtempSync(resolve(tmpdir(), 'beeline-start-sigterm-'));
    const configPath = resolve(root, 'runtime.json');
    writeFileSync(configPath, '{}\n');
    const { pid, child } = await spawnStubDaemon(configPath);
    await writeDaemonPidRecord(configPath, pid);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    expect(await runtimeDaemonPid(configPath)).toBe(pid);

    process.kill(pid, 'SIGTERM');
    await waitForExit(child);

    expect(await runtimeDaemonPid(configPath)).toBeNull();
    const launched: number[] = [];
    const outcome = await startStoredRuntime(
      configPath,
      {},
      {
        readPid: runtimeDaemonPid,
        launch: async () => {
          launched.push(99);
          return 99;
        },
        log: () => undefined,
      },
    );
    expect(outcome).toEqual({ status: 'started', pid: 99 });
    expect(launched).toEqual([99]);
  }, 15_000);

  it('treats a recycled pid (birth mismatch) as gone and does not signal it', async () => {
    root = mkdtempSync(resolve(tmpdir(), 'beeline-start-recycle-'));
    const configPath = resolve(root, 'runtime.json');
    writeFileSync(configPath, '{}\n');
    writeFileSync(resolve(root, 'daemon.pid'), `${process.pid}\n`);
    writeFileSync(resolve(root, 'daemon.birth'), '1\n');
    expect(processBirthIdentity(process.pid)).not.toBe('1');
    expect(await runtimeDaemonPid(configPath)).toBeNull();
    await expect(stopRuntimeDaemon(configPath)).resolves.toBeNull();
    expect(process.kill(process.pid, 0)).toBe(true);
  });

  it('starts only the selected agent when its stale pid now belongs to another runtime', async () => {
    root = mkdtempSync(resolve(tmpdir(), 'beeline-start-selected-stale-'));
    const selected = 'aa'.repeat(32);
    const other = 'bb'.repeat(32);
    const selectedConfig = resolve(root, 'beeline', 'agents', selected, 'runtime.json');
    const otherConfig = resolve(root, 'beeline', 'agents', other, 'runtime.json');
    mkdirSync(resolve(selectedConfig, '..'), { recursive: true });
    mkdirSync(resolve(otherConfig, '..'), { recursive: true });
    writeFileSync(selectedConfig, '{}\n');
    writeFileSync(otherConfig, '{}\n');
    const { pid, child } = await spawnStubDaemon(otherConfig);
    writeFileSync(resolve(selectedConfig, '..', 'daemon.pid'), `${pid}\n`);
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = root;
    try {
      const launched: string[] = [];
      const reports = await runStartCommand(['start', '--agent', selected], false, {
        updateBundle: async () => undefined,
        startOne: (configPath) =>
          startStoredRuntime(
            configPath,
            {},
            {
              readPid: runtimeDaemonPid,
              launch: async (path) => {
                launched.push(path);
                return 99;
              },
              log: () => undefined,
            },
          ),
        log: () => undefined,
      });

      expect(reports).toEqual([
        { id: selected, path: selectedConfig, status: 'started', pid: 99 },
      ]);
      expect(launched).toEqual([selectedConfig]);
      expect(existsSync(resolve(selectedConfig, '..', 'daemon.pid'))).toBe(false);
      expect(process.kill(pid, 0)).toBe(true);
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      child.kill('SIGTERM');
      await waitForExit(child);
    }
  });
});

describe('stopRuntimeDaemon waits out a graceful drain', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /**
   * A stand-in daemon whose argv names `daemon --config <configPath>` (the
   * identity check stopRuntimeDaemon performs), and which drains for
   * `drainMs` after SIGTERM before writing its marker and exiting.
   */
  function spawnStubDaemon(
    configPath: string,
    markerPath: string,
    drainMs: number,
  ): Promise<number> {
    const script = resolve(root, 'stub-daemon.mjs');
    writeFileSync(
      script,
      `import fs from 'node:fs';\n` +
        `process.on('SIGTERM', () => setTimeout(() => {\n` +
        `  fs.writeFileSync(${JSON.stringify(markerPath)}, 'done'); process.exit(0);\n` +
        `}, ${drainMs}));\n` +
        `setInterval(() => {}, 1_000);\n`,
    );
    return new Promise((resolveSpawn, reject) => {
      const child = spawn(process.execPath, [script, 'daemon', '--config', configPath], {
        stdio: 'ignore',
      });
      child.once('spawn', () => resolveSpawn(child.pid!));
      child.once('error', reject);
    });
  }

  it('returns only after the daemon finished its graceful shutdown', async () => {
    root = mkdtempSync(resolve(tmpdir(), 'beeline-stop-drain-'));
    const configPath = resolve(root, 'runtime.json');
    writeFileSync(configPath, '{}\n');
    const markerPath = resolve(root, 'drained');
    const pid = await spawnStubDaemon(configPath, markerPath, 400);
    await writeDaemonPidRecord(configPath, pid);
    // Let the stub finish booting so its SIGTERM handler is installed — a
    // signal arriving during Node startup takes the default action (terminate)
    // and would measure nothing about graceful draining.
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));

    const stopped = await stopRuntimeDaemon(configPath, { timeoutMs: 10_000, pollMs: 25 });
    expect(stopped).toBe(pid);
    expect(existsSync(markerPath)).toBe(true);
  }, 20_000);

  it('does not signal a process that is not this runtime daemon', async () => {
    root = mkdtempSync(resolve(tmpdir(), 'beeline-stop-refuse-'));
    const configPath = resolve(root, 'runtime.json');
    writeFileSync(configPath, '{}\n');
    writeFileSync(resolve(root, 'daemon.pid'), `${process.pid}\n`);
    await expect(stopRuntimeDaemon(configPath)).resolves.toBeNull();
    expect(process.kill(process.pid, 0)).toBe(true);
  });
});
