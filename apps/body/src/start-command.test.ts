import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { stopRuntimeDaemon } from './runtime.js';
import { DEFAULT_RESTART_DRAIN_TIMEOUT_MS, startStoredRuntime } from './start-command.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startStoredRuntime (beeline start restart semantics)', () => {
  function fixture() {
    const calls: string[] = [];
    let launched = 0;
    const deps = {
      readPid: vi.fn(async () => null as number | null),
      stop: vi.fn(async (_path: string) => null as number | null),
      launch: vi.fn(async (_path: string) => ++launched + 1000),
      log: (line: string) => calls.push(line),
    };
    return { calls, deps };
  }

  it('launches directly when no daemon is running', async () => {
    const f = fixture();
    const pid = await startStoredRuntime('/tmp/x/runtime.json', {}, f.deps);
    expect(pid).toBe(1001);
    expect(f.deps.stop).not.toHaveBeenCalled();
    expect(f.calls.join('\n')).toContain('[buzz] agent daemon started (pid 1001)');
    // The old silent no-op line must never come back.
    expect(f.calls.join('\n')).not.toContain('already running');
  });

  it('restarts a running daemon: stops it first, then launches a replacement', async () => {
    const f = fixture();
    f.deps.readPid.mockResolvedValue(4242);
    f.deps.stop.mockResolvedValue(4242);
    const pid = await startStoredRuntime('/tmp/x/runtime.json', {}, f.deps);
    expect(f.deps.stop).toHaveBeenCalledWith('/tmp/x/runtime.json', expect.anything());
    // The replacement launches only after the stop resolved.
    expect(f.deps.launch).toHaveBeenCalledTimes(1);
    expect(pid).toBe(1001);
    const transcript = f.calls.join('\n');
    expect(transcript).toContain('agent daemon is running (pid 4242); restarting it');
    expect(transcript).toContain('[buzz] stopped previous daemon (pid 4242)');
    expect(transcript).toContain('[buzz] agent daemon restarted (pid 1001)');
  });

  it('gives a draining daemon a generous budget and reports the wait', async () => {
    const f = fixture();
    f.deps.readPid.mockResolvedValue(7);
    f.deps.stop.mockImplementation(
      async (_path: string, opts: { onWait?: (pid: number, ms: number) => void }) => {
        opts.onWait?.(7, 1_000);
        now += 31_000;
        opts.onWait?.(7, 31_000);
        return 7;
      },
    );
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let now = 1_000_000;
    try {
      await startStoredRuntime('/tmp/x/runtime.json', {}, f.deps);
    } finally {
      nowSpy.mockRestore();
    }
    expect(f.deps.stop).toHaveBeenCalledWith('/tmp/x/runtime.json', {
      timeoutMs: DEFAULT_RESTART_DRAIN_TIMEOUT_MS,
      onWait: expect.any(Function),
    });
    expect(f.calls.join('\n')).toContain('waiting for agent 7 to finish its in-flight work');
  });

  it('fails loudly when a restart cannot complete — never silently succeeds', async () => {
    const f = fixture();
    f.deps.readPid.mockResolvedValue(9);
    f.deps.stop.mockRejectedValue(new Error('agent daemon 9 did not stop after 30000ms'));
    await expect(startStoredRuntime('/tmp/x/runtime.json', {}, f.deps)).rejects.toThrow(
      /did not stop/,
    );
    // A failed stop must NOT fall through to launching a second daemon
    // against the same runtime.
    expect(f.deps.launch).not.toHaveBeenCalled();
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
    writeFileSync(resolve(root, 'daemon.pid'), `${pid}\n`);
    // Let the stub finish booting so its SIGTERM handler is installed — a
    // signal arriving during Node startup takes the default action (terminate)
    // and would measure nothing about graceful draining.
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));

    const stopped = await stopRuntimeDaemon(configPath, { timeoutMs: 10_000, pollMs: 25 });
    expect(stopped).toBe(pid);
    // The drain marker exists: stopRuntimeDaemon returned only after the
    // stub's post-SIGTERM work completed — i.e. a restart built on this does
    // not interrupt in-flight work.
    expect(existsSync(markerPath)).toBe(true);
  }, 20_000);

  it("refuses to stop a process that is not this runtime's daemon", async () => {
    root = mkdtempSync(resolve(tmpdir(), 'beeline-stop-refuse-'));
    const configPath = resolve(root, 'runtime.json');
    writeFileSync(configPath, '{}\n');
    // This process's argv names vitest, not `daemon --config <path>`.
    writeFileSync(resolve(root, 'daemon.pid'), `${process.pid}\n`);
    await expect(stopRuntimeDaemon(configPath)).rejects.toThrow(/does not belong to the daemon/);
    // And it was not signalled.
    expect(process.kill(process.pid, 0)).toBe(true);
  });
});
