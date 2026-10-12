import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { DaemonApiClient } from './daemon-api-client.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';
import { activeReleaseId, hostPlatformKey, SelfUpdateManager } from './self-update.js';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeHost, HostedAgent } from './agent-runtime.js';
import { reportInterruptedTurns } from './force-update-journal.js';
import * as updateJournal from './force-update-journal.js';
import { daemonFailurePath } from './daemon-failure.js';
import { HelperLifecycle, type HelperExitReason } from './helper-lifecycle.js';
import { helperStatusLines, helperStatusPath } from './helper-status.js';
import { quiesceHostedAgents, runMachineHelper } from './machine-helper.js';
import {
  identityFromKey,
  readRuntimeRecord,
  setAgentStopped,
  stageMonolithAgentRuntime,
} from './runtime.js';
import { ThinDaemonCore } from './thin-core.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it('expires old deleted runtimes on helper start without a recurring timer', async () => {
    const { root, env, signals } = await machine(1);
    const old = resolve(root, 'beeline', 'deleted-runtimes',
      `${'a'.repeat(64)}-${Date.now() - 31 * 86400_000}`);
    await mkdir(old, { recursive: true });
    const fake = fakeRuntimes();
    const running = runMachineHelper({ env, signals, runAgent: fake.runAgent, exitProcess: () => undefined });
    await vi.waitFor(async () => {
      await expect(access(old)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    signals.emit('SIGTERM');
    expect((await running).reason).toBe('stopped');
  });

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
    const { root, configPaths, env, signals } = await machine(2);
    const failing = (await readRuntimeRecord(configPaths[0]!)).agent.publicKey;
    const sibling = (await readRuntimeRecord(configPaths[1]!)).agent.publicKey;
    const fake = fakeRuntimes((agentId) =>
      agentId === failing ? Promise.reject(new Error('harness exploded')) : undefined);
    const running = runMachineHelper({ env, signals, runAgent: fake.runAgent, exitProcess: () => undefined });
    const waitForRestart = async (previousSince?: string) => {
      let since = '';
      await vi.waitFor(async () => {
        const status = JSON.parse(await readFile(helperStatusPath(root), 'utf8'));
        const agent = status.agents[failing];
        expect(agent.state).toBe('restarting');
        expect(agent.since).not.toBe(previousSince);
        since = agent.since;
      });
      return since;
    };
    await vi.waitFor(() => expect(fake.runs.get(failing)).toBe(1));
    // A run starts before its failure is recorded and restart timer is armed.
    const firstRestart = await waitForRestart();
    // Restarted in this process, 5 s then 10 s later, like the unit used to be.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(fake.runs.get(failing)).toBe(2));
    await waitForRestart(firstRestart);
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
    // The distress record is written before the helper status is persisted.
    await vi.waitFor(async () => {
      const lines = await helperStatusLines(env);
      expect(lines.find((line) => line.includes(failing.slice(0, 12)))).toMatch(/distressed/);
      expect(lines.find((line) => line.includes(sibling.slice(0, 12)))).toMatch(/serving/);
    });
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
  it.each(['quiet gap', 'deadline', 'deadline retry'] as const)('installs at %s and resumes queued/interrupted work in an isolated helper', async (handoff) => {
    const { root, configPaths, env, signals } = await machine(1);
    const layout = { libDir: resolve(root, 'lib/beeline'),
      releasesRoot: resolve(root, 'lib/beeline-releases'), binDir: resolve(root, 'bin') };
    for (const id of ['old']) {
      const bundle = resolve(layout.releasesRoot, id, 'lib/beeline');
      await mkdir(bundle, { recursive: true });
      await writeFile(resolve(bundle, 'bundle.json'), JSON.stringify({ version: id }));
      await writeFile(resolve(bundle, 'beeline-cli.mjs'), '');
    }
    await symlink('beeline-releases/old', layout.libDir);
    env.BEELINE_LIB_DIR = layout.libDir;
    // Local archive and server only: no service-unit writes or production Workspace.
    const helperEnv = { ...env, BEELINE_UPDATE_DISABLE: '1' };
    const archiveRoot = resolve(root, 'published');
    const publishedLib = resolve(archiveRoot, 'lib/beeline');
    await mkdir(resolve(publishedLib, 'codegraph/bin'), { recursive: true });
    await writeFile(resolve(publishedLib, 'beeline-cli.mjs'), "console.log('beeline v0.1.29');\n");
    await writeFile(resolve(publishedLib, 'pi-mcp-adapter.mjs'), 'export {};\n');
    await writeFile(resolve(publishedLib, 'codegraph/bin/codegraph'), '#!/bin/sh\nexit 0\n');
    await writeFile(resolve(archiveRoot, 'bundle.json'), JSON.stringify({ version: 'v0.1.29', commit: 'new' }));
    const archivePath = resolve(root, 'bundle.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', archiveRoot, '.']);
    const archive = await readFile(archivePath);
    const manifest = JSON.stringify({ schemaVersion: 1, sourceCommit: 'new', version: 'v0.1.29',
      bundles: { [hostPlatformKey()]: { file: 'bundle.tar.gz',
        sha256: createHash('sha256').update(archive).digest('hex') } } });
    // Legacy failure state cannot trigger a rollback or delay startup.
    const legacyAttemptPath = resolve(layout.releasesRoot, '.state/update-attempt.json');
    await mkdir(dirname(legacyAttemptPath), { recursive: true });
    const legacyAttempt = JSON.stringify({ version: 1, releaseId: 'old', status: 'pending', confirmBy: 1 });
    await writeFile(legacyAttemptPath, legacyAttempt);
    const agentId = (await readRuntimeRecord(configPaths[0]!)).agent.publicKey;
    const queued = new Map<string, AgentCommand>();
    const claims = new Map<string, number>();
    const claimed = new Map<string, AgentCommand>();
    const claimGenerations: string[] = [];
    const replies: string[] = [];
    const errors: unknown[] = [];
    const push = () => {
      for (const socket of sockets.clients) for (const roomId of ['long-room', 'message-room'])
        socket.send(JSON.stringify({ type: 'commands', roomId, agentId, commandProtocol: 1,
          commands: [...queued.values()].filter((row) => row.roomId === roomId) }));
    };
    const server = createServer(async (req, res) => {
      if (req.url === '/manifest.json') { res.end(manifest); return; }
      if (req.url === '/bundle.tar.gz') { res.end(archive); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.setHeader('content-type', 'application/json');
      if (req.url === '/messages') {
        queued.set(input.id, { id: input.id, roomId: input.roomId, agentId,
          sourceMessageId: input.id, turnRequestId: input.id, rootCommandId: input.id,
          rootSourceMessageId: input.id, agentDepth: 0, action: 'input', reason: 'human_tag',
          source: { id: input.id, authorId: 'human', body: input.text,
            createdAt: Date.now(), type: 'message', attachments: [] } });
        push();
      } else if (req.url?.endsWith('/getAgentCommands')) {
        res.end(JSON.stringify({ commandProtocol: 1,
          commands: [...queued.values()].filter((row) => row.roomId === input.roomId) }));
        return;
      } else if (req.url?.endsWith('/claimAgentCommand')) {
        claims.set(input.commandId, Date.now());
        claimed.set(input.commandId, queued.get(input.commandId)!);
        claimGenerations.push(input.generationId);
        queued.delete(input.commandId);
      } else if (req.url?.endsWith('/postAgentTurnReceipt') && input.reasonKind === 'update-interrupted') {
        const command = claimed.get(input.requestId)!;
        queued.set(command.id, command);
      } else if (req.url?.endsWith('/postRoomMessage')) replies.push(input.text);
      res.end(JSON.stringify({ id: 'ok' }));
    });
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', (socket) => socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'register') socket.send(JSON.stringify({ type: 'registered', agentId }));
      if (frame.type === 'subscribe') {
        socket.send(JSON.stringify({ type: 'subscribed', roomId: frame.roomId, agentId,
          capabilities: { pushIntake: true, connectionPresence: true } }));
        push();
      }
    }));
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const send = (id: string, roomId = 'message-room') => fetch(`${origin}/messages`, {
      method: 'POST', body: JSON.stringify({ id, roomId, text: `@bee ${id}` }) });
    let finishHeld!: () => void;
    const held = new Promise<void>((resolveHeld) => { finishHeld = resolveHeld; });
    let host!: AgentRuntimeHost;
    let core!: ThinDaemonCore;
    let agentLifecycle!: HelperLifecycle;
    let generation = 0;
    const runAgent = async (configPath: string, runtimeHost: AgentRuntimeHost, signal: AbortSignal) => {
      host = runtimeHost;
      const run = ++generation;
      const runtime = await readRuntimeRecord(configPath);
      runtime.transport = { kind: 'monolith', baseUrl: origin, daemonToken: 'isolated-test-token' };
      const api = new DaemonApiClient(origin, 'isolated-test-token', agentId);
      await reportInterruptedTurns(dirname(configPath), api, agentId);
      core = new ThinDaemonCore(runtime, configPath, { workspaceRoot: root } as never, { daemonApi: api });
      const lifecycle = new HelperLifecycle({ controller: new AbortController(), exitProcess: () => undefined });
      agentLifecycle = lifecycle;
      const leave = host.attach({ agentId, runtimeDir: dirname(configPath), lifecycle, core });
      const internal = core as unknown as { roomRuntime: {
        running: Map<string, unknown>; restartRequested: boolean;
      } };
      const intakes = ['long-room', 'message-room'].map((roomId) => {
        let busy = false;
        const context = new CommandExecutionContext(root);
        internal.roomRuntime.running.set(roomId, { body: { isBusy: () => busy,
          interruptForServerMinimum: () => busy && context.current ? {
            roomId, requestId: context.current.turnRequestId, generationId: context.generationId,
          } : undefined }, controller: new AbortController(), promise: Promise.resolve() });
        return runServerCommandIntake({ api, roomId, agentId, context, signal,
          canStartTurn: () => !internal.roomRuntime.restartRequested,
          onClaiming: () => { busy = true; }, onClaimFailed: () => { busy = false; },
          onLeave: () => { busy = false; }, stop: finishHeld, onError: (error) => errors.push(error),
          run: async (command) => {
            if (command.id === 'held' && run === 1) {
              await Promise.race([held, new Promise<void>((resolveAbort) =>
                signal.addEventListener('abort', () => resolveAbort(), { once: true }))]);
              if (signal.aborted) return;
            }
            await context.bind(api).execute('postRoomMessage', { roomId, text: command.id });
          } });
      });
      host.established(agentId);
      try { await Promise.all(intakes); } finally { leave(); }
      return 'stopped' as const;
    };
    let running: ReturnType<typeof runMachineHelper> | undefined;
    try {
      await send('held', 'long-room');
      if (handoff !== 'quiet gap') vi.useFakeTimers({ toFake: ['Date'] });
      running = runMachineHelper({ configPaths, env: helperEnv, signals, runAgent, exitProcess: () => undefined });
      await vi.waitFor(() => expect(claims.has('held')).toBe(true));
      const manager = new SelfUpdateManager({ layout, stageOnly: true, env: { ...helperEnv,
        BEELINE_UPDATE_MANIFEST_URL: `${origin}/manifest.json` }, logger: () => undefined });
      await manager.checkAndApply({ force: true });
      await host.tickUpdate();
      expect(core.activeTurnCount()).toBe(1);
      expect(await activeReleaseId(layout)).toBe('old');

      const sentAt = Date.now();
      await send('mid-drain');
      await vi.waitFor(() => expect(replies).toContain('mid-drain'), { timeout: 1_000 });
      const midDrainClaimMs = claims.get('mid-drain')! - sentAt;
      expect(midDrainClaimMs).toBeLessThan(1_000);
      // The original turn remains active: this claim did not wait for its end.
      expect(core.activeTurnCount()).toBe(1);
      expect(await activeReleaseId(layout)).toBe('old');
      if (handoff === 'quiet gap') {
        finishHeld();
        await vi.waitFor(() => expect(core.activeTurnCount()).toBe(0));
      } else {
        // Move wall time across the cap while keeping the real HTTP/socket transport.
        vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      }
      if (handoff === 'deadline retry') {
        vi.spyOn(updateJournal, 'journalInterruptedTurns').mockImplementationOnce(() => {
          throw new Error('interruption journal temporarily unavailable');
        });
        await host.tickUpdate();
        expect(agentLifecycle.serving).toBe(true);
      }
      const restartAt = Date.now();
      await host.tickUpdate();
      expect((await running).reason).toBe('update');
      expect(await activeReleaseId(layout)).toBe('new');
      expect(Date.now() - restartAt).toBeLessThan(1_000);
      vi.useRealTimers();

      // Arrives with no serving helper. The successor's initial GET claims it.
      await send('during-restart');
      const queuedAt = Date.now();
      running = runMachineHelper({ configPaths, env: helperEnv, signals, runAgent, exitProcess: () => undefined });
      await vi.waitFor(() => expect(replies).toContain('during-restart'), { timeout: 2_000 });
      const successorClaimMs = claims.get('during-restart')! - queuedAt;
      const successorAnswerMs = Date.now() - queuedAt;
      expect(successorClaimMs).toBeLessThan(2_000);
      expect(successorAnswerMs).toBeLessThan(2_000);
      if (handoff !== 'quiet gap') {
        await vi.waitFor(() => expect(replies).toContain('held'));
        expect(claimGenerations[0]).not.toBe(claimGenerations.at(-1));
        expect(replies.filter((reply) => reply === 'held')).toHaveLength(1);
      }
      expect(queued.size).toBe(0);
      expect(await readFile(legacyAttemptPath, 'utf8')).toBe(legacyAttempt);
      expect(await readFile(resolve(layout.releasesRoot, 'new/bundle.json'), 'utf8')).toContain('v0.1.29');
      expect(errors).toEqual([]);
      console.log(`[isolated-helper] downloaded+installed v0.1.29; mid-drain claim=${midDrainClaimMs}ms; ` +
        `successor claim=${successorClaimMs}ms; answer=${successorAnswerMs}ms; XDG_STATE_HOME=${root}`);
    } finally {
      finishHeld();
      signals.emit('SIGTERM');
      await running;
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolveClose) => sockets.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  function hosted(busy: boolean): HostedAgent & { closed: () => boolean } {
    let intakeClosed = false;
    const lifecycle = new HelperLifecycle({ controller: new AbortController(), exitProcess: () => undefined });
    const core = {
      activeTurnCount: () => (busy ? 1 : 0),
      quiesceForUpdate: () => {
        intakeClosed = true;
      },
      resumeServing: () => {
        intakeClosed = false;
      },
    } as unknown as ThinDaemonCore;
    return { agentId: 'a', runtimeDir: '/tmp', lifecycle, core, closed: () => intakeClosed };
  }

  it('closes intake for every agent at once', () => {
    const idle = [hosted(false), hosted(false)];
    expect(quiesceHostedAgents(idle)).toBe(true);
    expect(idle.every((agent) => agent.closed() && !agent.lifecycle.serving)).toBe(true);
  });

  it('closes every intake when the deadline arrives even with busy turns', () => {
    const agents = [hosted(false), hosted(true), hosted(false)];
    expect(quiesceHostedAgents(agents, true)).toBe(true);
    expect(agents.every((agent) => agent.closed() && !agent.lifecycle.serving)).toBe(true);
  });

  it('keeps every agent serving while any hosted turn is busy', () => {
    const agents = [hosted(false), hosted(true), hosted(false)];
    expect(quiesceHostedAgents(agents)).toBe(false);
    expect(agents.every((agent) => !agent.closed() && agent.lifecycle.serving)).toBe(true);
  });
});
