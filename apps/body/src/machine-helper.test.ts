import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeHost, HostedAgent } from './agent-runtime.js';
import { daemonFailurePath } from './daemon-failure.js';
import { HelperLifecycle, type HelperExitReason } from './helper-lifecycle.js';
import { helperStatusLines, helperStatusPath } from './helper-status.js';
import { quiesceHostedAgentsIfIdle, runMachineHelper } from './machine-helper.js';
import {
  identityFromKey,
  readRuntimeRecord,
  setAgentStopped,
  stageMonolithAgentRuntime,
} from './runtime.js';
import type { ThinDaemonCore } from './thin-core.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function machine(agents: number) {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-machine-'));
  roots.push(root);
  const configPaths: string[] = [];
  for (let index = 0; index < agents; index++) configPaths.push(await stage(root, index));
  const env = {
    ...process.env,
    XDG_STATE_HOME: root,
    BEELINE_SYSTEMD_USER: '0',
    BEELINE_LAUNCHD_USER: '0',
    BEELINE_LIB_DIR: '',
    BEELINE_MANAGED_BY_SYSTEMD: '0',
  };
  return { root, configPaths, env, signals: new EventEmitter() };
}

async function stage(root: string, index: number): Promise<string> {
  const staged = await stageMonolithAgentRuntime({
    workspaceId: 'workspace', pairedBy: 'human', daemonExchangeToken: `bde_${'a'.repeat(43)}`,
    agentBinary: '/nonexistent', agentKind: 'codex', agentCommand: '/nonexistent',
    agentArgs: [], mcpBinary: 'unused',
    agentIdentity: identityFromKey(String(index + 1).padStart(2, '0').repeat(32), `Bee ${index}`),
    bodyIdentity: identityFromKey('44'.repeat(32), 'Body'), supervisorRoot: root,
  });
  return staged.configPath;
}

/** A fake agent runtime: serves until its signal aborts, unless a script says otherwise. */
function fakeRuntimes(script: (agentId: string, run: number) => Promise<HelperExitReason> | undefined = () => undefined) {
  const runs = new Map<string, number>();
  const signals = new Map<string, AbortSignal>();
  const runAgent = vi.fn(async (configPath: string, host: AgentRuntimeHost, signal: AbortSignal) => {
    const agentId = (await readRuntimeRecord(configPath)).agent.publicKey;
    const run = (runs.get(agentId) ?? 0) + 1;
    runs.set(agentId, run);
    signals.set(agentId, signal);
    host.established(agentId);
    host.progress(agentId, `healthy; run ${run}`);
    const scripted = script(agentId, run);
    if (scripted) return scripted;
    await new Promise<void>((resolveStop) => signal.addEventListener('abort', () => resolveStop(), { once: true }));
    return 'stopped' as const;
  });
  return { runAgent, runs, signals };
}

describe('one helper process hosts every agent on the machine', () => {
  it('runs every paired agent in this one process and reports each of them', async () => {
    const { root, configPaths, env, signals } = await machine(3);
    const fake = fakeRuntimes();
    const exits: number[] = [];
    const running = runMachineHelper({ env, signals, runAgent: fake.runAgent, exitProcess: (code) => exits.push(code) });
    await vi.waitFor(() => expect(fake.signals.size).toBe(3));
    expect(fake.runAgent.mock.calls.map(([path]) => path).sort()).toEqual([...configPaths].sort());
    await vi.waitFor(async () => {
      const status = JSON.parse(await readFile(helperStatusPath(root), 'utf8'));
      expect(Object.values(status.agents).map((agent) => (agent as { state: string }).state))
        .toEqual(['serving', 'serving', 'serving']);
      expect(status.pid).toBe(process.pid);
    });
    const lines = await helperStatusLines(env);
    expect(lines[0]).toBe(`running (pid ${process.pid}; one process for every agent)`);
    expect(lines.slice(1)).toHaveLength(3);
    for (const line of lines.slice(1)) expect(line).toMatch(/^agent [0-9a-f]{12} {2}serving since .* — healthy; run 1$/);

    signals.emit('SIGTERM');
    const { reason, lifecycle } = await running;
    expect(reason).toBe('stopped');
    expect([...fake.signals.values()].every((signal) => signal.aborted)).toBe(true);
    lifecycle.exit(reason);
    expect(exits).toEqual([0]);
  });

  it('restarts only the agent that failed, and stops only the one in distress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { configPaths, env, signals } = await machine(2);
    const failing = (await readRuntimeRecord(configPaths[0]!)).agent.publicKey;
    const sibling = (await readRuntimeRecord(configPaths[1]!)).agent.publicKey;
    const fake = fakeRuntimes((agentId) =>
      agentId === failing ? Promise.reject(new Error('harness exploded')) : undefined);
    const running = runMachineHelper({ env, signals, runAgent: fake.runAgent, exitProcess: () => undefined });
    await vi.waitFor(() => expect(fake.runs.get(failing)).toBe(1));
    // Restarted in this process, 5 s then 10 s later, like the unit used to be.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(fake.runs.get(failing)).toBe(2));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(fake.runs.get(failing)).toBe(3));
    // Three counted failures in the window: distress, recorded as before, and no more restarts.
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(daemonFailurePath(dirname(configPaths[0]!)), 'utf8')))
        .toMatchObject({ distressedAt: expect.any(Number), lastError: 'harness exploded' }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.runs.get(failing)).toBe(3);
    // The sibling started once and was never touched.
    expect(fake.runs.get(sibling)).toBe(1);
    expect(fake.signals.get(sibling)!.aborted).toBe(false);
    const lines = await helperStatusLines(env);
    expect(lines.find((line) => line.includes(failing.slice(0, 12)))).toMatch(/distressed/);
    expect(lines.find((line) => line.includes(sibling.slice(0, 12)))).toMatch(/serving/);
    signals.emit('SIGTERM');
    expect((await running).reason).toBe('stopped');
  });

  it('restarts one agent in place when that agent is asked to restart', async () => {
    const { configPaths, env, signals } = await machine(2);
    const restarting = (await readRuntimeRecord(configPaths[0]!)).agent.publicKey;
    const sibling = (await readRuntimeRecord(configPaths[1]!)).agent.publicKey;
    const fake = fakeRuntimes((agentId, run) =>
      agentId === restarting && run === 1 ? Promise.resolve('restart-requested') : undefined);
    const running = runMachineHelper({ env, signals, runAgent: fake.runAgent, exitProcess: () => undefined });
    await vi.waitFor(() => expect(fake.runs.get(restarting)).toBe(2));
    expect(fake.runs.get(sibling)).toBe(1);
    expect(fake.signals.get(sibling)!.aborted).toBe(false);
    signals.emit('SIGTERM');
    expect((await running).reason).toBe('stopped');
  });

  it('rescans on SIGHUP: a newly paired agent starts and a stopped one ends, leaving the rest', async () => {
    const { root, configPaths, env, signals } = await machine(2);
    const fake = fakeRuntimes();
    const running = runMachineHelper({ env, signals, runAgent: fake.runAgent, exitProcess: () => undefined });
    await vi.waitFor(() => expect(fake.signals.size).toBe(2));
    const kept = (await readRuntimeRecord(configPaths[0]!)).agent.publicKey;
    const stopped = (await readRuntimeRecord(configPaths[1]!)).agent.publicKey;
    const paired = await stage(root, 7);
    const pairedId = (await readRuntimeRecord(paired)).agent.publicKey;
    await setAgentStopped(configPaths[1]!, true);
    signals.emit('SIGHUP');
    await vi.waitFor(() => expect(fake.runs.get(pairedId)).toBe(1));
    await vi.waitFor(() => expect(fake.signals.get(stopped)!.aborted).toBe(true));
    expect(fake.signals.get(kept)!.aborted).toBe(false);
    expect(fake.runs.get(kept)).toBe(1);
    // `beeline start` clears the marker; the next rescan hosts it again.
    await setAgentStopped(configPaths[1]!, false);
    signals.emit('SIGHUP');
    await vi.waitFor(() => expect(fake.runs.get(stopped)).toBe(2));
    signals.emit('SIGTERM');
    expect((await running).reason).toBe('stopped');
  });

  it('ends with no-agents, which the service manager does not restart, when nothing is paired', async () => {
    const { env, signals } = await machine(0);
    const { reason } = await runMachineHelper({ env, signals, runAgent: vi.fn(), exitProcess: () => undefined });
    expect(reason).toBe('no-agents');
  });
});

describe('one update drain for every hosted agent', () => {
  function hosted(busy: boolean): HostedAgent & { closed: () => boolean } {
    let intakeClosed = false;
    const lifecycle = new HelperLifecycle({ controller: new AbortController(), exitProcess: () => undefined });
    const core = {
      activeTurnCount: () => (busy ? 1 : 0),
      quiesceForUpdateIfIdle: () => {
        if (busy) return false;
        intakeClosed = true;
        return true;
      },
      resumeServing: () => {
        intakeClosed = false;
      },
    } as unknown as ThinDaemonCore;
    return { agentId: 'a', runtimeDir: '/tmp', lifecycle, core, closed: () => intakeClosed };
  }

  it('closes intake for every agent at once only when none of them runs a turn', () => {
    const idle = [hosted(false), hosted(false)];
    expect(quiesceHostedAgentsIfIdle(idle)).toBe(true);
    expect(idle.every((agent) => agent.closed() && !agent.lifecycle.serving)).toBe(true);
  });

  it('lets one busy agent hold the restart without closing anyone', () => {
    const agents = [hosted(false), hosted(true), hosted(false)];
    expect(quiesceHostedAgentsIfIdle(agents)).toBe(false);
    expect(agents.every((agent) => !agent.closed() && agent.lifecycle.serving)).toBe(true);
  });
});
