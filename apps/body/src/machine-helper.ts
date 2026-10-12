import type { EventEmitter } from 'node:events';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  interruptHostedAgent,
  runAgentRuntime,
  type AgentRuntimeHost,
  type HostedAgent,
} from './agent-runtime.js';
import { settleDaemonStartFailure } from './daemon-failure.js';
import { helperStatusPath, type AgentSlotState, type HelperStatusFile } from './helper-status.js';
import { ForceUpdateCoordinator } from './force-update.js';
import { journalInterruptedTurns } from './force-update-journal.js';
import { HelperLifecycle, type HelperExitReason } from './helper-lifecycle.js';
import { supervisor } from './helper-service.js';
import {
  installLaunchdTrustySquireBrokerService,
  retireLegacyLaunchdAgents,
} from './launchd.js';
import { MachineLink } from './machine-link.js';
import {
  forceInstallMinimum,
  managedRestartStaggerMs,
  ManagedUpdateDrain,
  ManagedUpdateHandoff,
  withInstallLock,
} from './managed-update.js';
import { DEFAULT_DRAIN_DEADLINE_MS } from './room-runtime.js';
import {
  clearHelperPidRecordIfPid,
  defaultSupervisorRoot,
  findAgentRuntimeConfigPaths,
  isAgentStopped,
  readRuntimeRecord,
  runtimeDaemonPid,
  writeHelperPidRecord,
} from './runtime.js';
import {
  activeReleaseId,
  beelineInstallLayout,
  readInstalledBundleIdentity,
} from './self-update.js';
import type { InstalledBundleIdentity } from './self-update-manifest.js';
import {
  extendSystemdStartTimeout,
  installTrustySquireBrokerService,
  retireLegacyAgentUnits,
  startLocalWatchdog,
  SystemdNotifier,
} from './systemd.js';
import { squireBrokerMeetsComputerUseMinimum } from './squire-host.js';
import { pruneDeletedRuntimes, pruneRepositoryCaches } from './host-disk-retention.js';
import { applyRequestedStartupCleanup } from './startup-cleanup.js';
import { pruneSharedModelCache } from './scratch-lifecycle.js';
import { monitorPrivateRecoveryReserve } from './shared-asset-capacity.js';

/** A failed agent restarts inside the helper after this, doubling to the cap. */
const AGENT_RESTART_BASE_MS = 5_000;
const AGENT_RESTART_MAX_MS = 60_000;
/** How long an agent waits for a previous process (an old per-agent daemon) to let go of it. */
const PREVIOUS_HOLDER_WAIT_MS = 120_000;
const PREVIOUS_HOLDER_KILL_WAIT_MS = 30_000;

interface AgentSlot {
  readonly configPath: string;
  agentId: string;
  controller: AbortController;
  state: AgentSlotState;
  status: string;
  since: number;
  running: Promise<void> | undefined;
  established: boolean;
}

/**
 * The machine's one helper process. It hosts every paired agent on this host
 * as an in-process runtime and holds one live socket per server for all of
 * them. It owns everything that is per process: signals, the service
 * manager's watchdog, the update drain (all agents drain, then one restart),
 * and the forced update. One agent's failure restarts or stops only
 * that agent. SIGHUP rescans the paired agents, which is how pairing, `start`
 * and `stop` change what it hosts.
 *
 * A hard crash of this process takes every agent on the machine down until
 * the service manager restarts it.
 */
export async function runMachineHelper(
  options: {
    configPaths?: readonly string[];
    env?: NodeJS.ProcessEnv;
    /** Test seams: production runs the real per-agent runtime on process signals. */
    runAgent?: typeof runAgentRuntime;
    signals?: EventEmitter;
    exitProcess?: (code: number) => void;
  } = {},
): Promise<{ reason: HelperExitReason; lifecycle: HelperLifecycle }> {
  const runAgent = options.runAgent ?? runAgentRuntime;
  const env = options.env ?? process.env;
  const supervisorRoot = defaultSupervisorRoot(env);
  const managedBy = options.configPaths ? 'process' : supervisor(env);
  const controller = new AbortController();
  const lifecycle = new HelperLifecycle({
    controller,
    ...(options.exitProcess ? { exitProcess: options.exitProcess } : {}),
  });
  const signals = options.signals ?? process;
  const disposeSignals = lifecycle.installSignals(signals);
  const stopReserveMonitor = monitorPrivateRecoveryReserve(supervisorRoot);
  const notifier = new SystemdNotifier();
  const slots = new Map<string, AgentSlot>();
  const hosted = new Map<string, HostedAgent>();
  const links = new Map<string, MachineLink>();
  let diskSweepRunning = false;
  let lastModelSweepAt = 0;
  let lastRetentionSweepAt = 0;
  const sweepHostDisk = async () => {
    const now = Date.now();
    if (
      controller.signal.aborted ||
      diskSweepRunning ||
      [...slots.values()].some((slot) => slot.state === 'starting' || slot.state === 'restarting') ||
      [...hosted.values()].some((agent) => !agent.core.isWorkspaceIdle()) ||
      (now - lastModelSweepAt < 60 * 60_000 && now - lastRetentionSweepAt < 24 * 60 * 60_000)
    ) return;
    diskSweepRunning = true;
    try {
      const modelDue = now - lastModelSweepAt >= 60 * 60_000;
      const removed = modelDue
        ? await pruneSharedModelCache(resolve(supervisorRoot, 'beeline', 'model-cache'))
        : [];
      if (modelDue) lastModelSweepAt = now;
      if (now - lastRetentionSweepAt >= 24 * 60 * 60_000) {
        removed.push(...await pruneDeletedRuntimes(supervisorRoot));
        removed.push(...await pruneRepositoryCaches(supervisorRoot));
        lastRetentionSweepAt = now;
      }
      if (removed.length) console.log(`[helper] idle disk sweep removed ${removed.length} expired cache/runtime directories`);
    } catch (error) {
      console.warn('[helper] idle disk sweep failed:', error);
    } finally {
      diskSweepRunning = false;
    }
  };
  await applyRequestedStartupCleanup(supervisorRoot);
  if (!options.configPaths) await writeHelperPidRecord(supervisorRoot, process.pid);

  const layout = beelineInstallLayout(env);
  let loadedRelease: string | undefined;
  let loadedReleaseIdentity: InstalledBundleIdentity | undefined;
  let update: ManagedUpdateHandoff | undefined;
  let stoppingStatus = 'helper stopped';

  const hostedRuntimes = async (): Promise<string[]> => {
    const paths = options.configPaths ?? (await findAgentRuntimeConfigPaths(env));
    const live: string[] = [];
    for (const path of paths) {
      if (!(await stat(path).then(() => true, () => false))) continue;
      if (await isAgentStopped(path)) continue;
      live.push(path);
    }
    return live;
  };

  const finish = async (reason: HelperExitReason) => {
    disposeSignals();
    stopReserveMonitor();
    await notifier.stopping(stoppingStatus).catch(() => undefined);
    if (!options.configPaths) await clearHelperPidRecordIfPid(supervisorRoot, process.pid);
    return { reason, lifecycle };
  };

  if (layout) {
    loadedRelease = await activeReleaseId(layout);
    loadedReleaseIdentity = await readInstalledBundleIdentity(layout);
    if (!squireBrokerMeetsComputerUseMinimum(env.HOME?.trim() || homedir())) {
      // Converge the elector only when the durable install is below
      // the computer-use floor. Activation already converges new bundles.
      // A broker crash restart never reaches this path.
      const squireUpdateMode = 'minimum';
      if (managedBy === 'systemd')
        await installTrustySquireBrokerService({ env, squireUpdateMode }).catch((error) => console.error(
          `[beeline] host Squire broker unit not converged: ${error instanceof Error ? error.message : String(error)}`));
      else if (managedBy === 'launchd')
        await installLaunchdTrustySquireBrokerService({ env, squireUpdateMode }).catch((error) => console.error(
          `[beeline] host Squire broker launchd job not converged: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  // Every start finishes a migration from per-agent units: none may serve an
  // agent this helper hosts. Each runtime directory is kept exactly as it is.
  if (managedBy === 'systemd')
    await (layout ? withInstallLock(layout, () => retireLegacyAgentUnits({ env })) : retireLegacyAgentUnits({ env }))
      .catch((error) => console.error('[helper] per-agent units not retired:', error));
  else if (managedBy === 'launchd')
    await retireLegacyLaunchdAgents({ env })
      .catch((error) => console.error('[helper] per-agent jobs not retired:', error));

  const initial = await hostedRuntimes();
  if (initial.length === 0) {
    console.log('[helper] no paired agent on this machine; nothing to host');
    stoppingStatus = 'no paired agent';
    return finish('no-agents');
  }

  const statusLine = () => {
    const parts = [...slots.values()].map((slot) =>
      `${slot.agentId.slice(0, 12)} ${slot.state}${slot.status ? `: ${slot.status}` : ''}`);
    return `loaded_release=${loadedRelease ?? 'development'}; agents=${slots.size}; ${parts.join(' | ')}`
      .slice(0, 2_000);
  };
  let statusWrite: Promise<void> = Promise.resolve();
  const writeStatus = () => {
    statusWrite = statusWrite.then(async () => {
      const path = helperStatusPath(supervisorRoot);
      const body: HelperStatusFile = {
        pid: process.pid,
        ...(loadedRelease ? { loadedRelease } : {}),
        updatedAt: new Date().toISOString(),
        agents: Object.fromEntries([...slots.values()].map((slot) => [slot.agentId, {
          state: slot.state,
          status: slot.status,
          since: new Date(slot.since).toISOString(),
        }])),
      };
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const staged = `${path}.${process.pid}.tmp`;
      await writeFile(staged, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      await rename(staged, path);
    }).catch((error) => console.error('[helper] status not written:', error));
  };
  const setState = (slot: AgentSlot, state: AgentSlotState, status = slot.status) => {
    if (slot.state !== state) slot.since = Date.now();
    slot.state = state;
    slot.status = status;
    writeStatus();
  };

  let restarting: HelperExitReason | undefined;
  /** Stop every agent and end the process; the service manager starts the next one. */
  const restartHelper = (reason: HelperExitReason) => {
    if (restarting) return;
    restarting = reason;
    lifecycle.stop(reason);
  };

  const forceUpdate = layout ? new ForceUpdateCoordinator({
    ...(loadedReleaseIdentity?.version ? { loadedVersion: loadedReleaseIdentity.version } : {}),
    interrupt: () =>
      [...hosted.values()].map((agent) => ({
        runtimeDir: agent.runtimeDir,
        turns: interruptHostedAgent(agent),
      })),
    install: async (minVersion) => {
      stoppingStatus = `server requires helper ${minVersion}; installing published release`;
      await notifier.progress(stoppingStatus);
      return forceInstallMinimum({
        layout,
        minVersion,
      });
    },
    restart: async (desiredRelease) => {
      const deadlineAt = Date.now() + DEFAULT_DRAIN_DEADLINE_MS;
      const staggerMs = managedRestartStaggerMs(machineKey(), desiredRelease, deadlineAt);
      if (staggerMs > 0) await sleep(staggerMs);
      stoppingStatus = `server minimum installed; restarting onto ${desiredRelease}`;
      await notifier.stopping(stoppingStatus).catch((error) =>
        console.error('[helper] stopping notification failed:', error));
      restartHelper('update');
    },
    failed: (error) => {
      // The interrupted-turn journals stay for the next process to report.
      console.error('[helper] forced helper update failed:', error);
      restartHelper('force-update-failed');
    },
  }) : undefined;
  const requestForceUpdate = (minVersion: string) => {
    if (!forceUpdate) {
      console.error('[helper] server requires a published helper, but this process has no install layout');
      restartHelper('stopped');
      return;
    }
    forceUpdate.request(minVersion);
  };

  const machineKey = () => [...slots.values()].map((slot) => slot.agentId).sort()[0] ?? 'helper';
  if (layout) {
    update = await ManagedUpdateHandoff.create(layout, Date.now, {
      env,
    });
  }
  const recoverManagedRestart = (error: unknown) => {
    console.error('[helper] managed restart failed; serving again:', error);
    for (const agent of hosted.values())
      agent.lifecycle.resumeAfterFailedUpdate(() => agent.core.resumeServing());
  };
  // Serve new messages while an update waits. Close intake across the machine
  // in a quiet gap or at the deadline; interrupted commands are replayed by the successor.
  const updateDrain = update
    ? new ManagedUpdateDrain({
        update,
        failed: recoverManagedRestart,
        quiesce: (deadlineReached) =>
          !forceUpdate?.active && lifecycle.serving && quiesceHostedAgents([...hosted.values()], deadlineReached),
        activeTurnCount: () =>
          [...hosted.values()].reduce((sum, agent) => sum + agent.core.activeTurnCount(), 0),
        restart: async ({ desiredRelease }, mode) => {
          if (mode === 'interrupted') {
            for (const agent of hosted.values())
              journalInterruptedTurns(agent.runtimeDir, agent.core.interruptForServerMinimum());
          }
          stoppingStatus =
            `update pending, converging; loaded_release=${loadedRelease ?? 'unknown'}; ` +
            `desired_release=${desiredRelease}; drain ${mode}; intake quiesced`;
          await notifier.stopping(stoppingStatus).catch((error) =>
            console.error('[helper] stopping notification failed:', error));
          restartHelper('update');
        },
        waiting: async ({ desiredRelease }) => {
          await notifier.progress(
            `loaded_release=${loadedRelease ?? 'unknown'}; update ready; ` +
              `serving messages; waiting for a quiet gap; ` +
              `desired_release=${desiredRelease}`,
          );
        },
      })
    : undefined;
  // A managed restart that fails after intake closed must not leave agents
  // that refuse every turn: they go back to serving.
  const tickUpdate = async (): Promise<void> => {
    try {
      await updateDrain?.tick();
    } catch (error) {
      recoverManagedRestart(error);
    }
    void sweepHostDisk();
  };

  let readyResolve: (() => void) | undefined;
  const allEstablished = new Promise<void>((resolveReady) => { readyResolve = resolveReady; });
  const settleReady = () => {
    if ([...slots.values()].every((slot) => slot.established)) readyResolve?.();
  };

  const host: AgentRuntimeHost = {
    machineLink: (baseUrl) => {
      let link = links.get(baseUrl);
      if (!link) {
        link = new MachineLink({ baseUrl });
        link.setHelperIdentity({
          releaseVersion: loadedReleaseIdentity?.version,
          sourceSha: loadedReleaseIdentity?.commit,
        });
        links.set(baseUrl, link);
      }
      return link;
    },
    layout,
    loadedRelease,
    loadedReleaseIdentity,
    attach: (agent) => {
      hosted.set(agent.agentId, agent);
      return () => {
        if (hosted.get(agent.agentId) === agent) hosted.delete(agent.agentId);
      };
    },
    progress: (agentId, status) => {
      const slot = [...slots.values()].find((candidate) => candidate.agentId === agentId);
      if (slot) setState(slot, slot.state === 'starting' || slot.state === 'restarting' ? 'serving' : slot.state, status);
      void notifier.progress(statusLine()).catch((error) =>
        console.error('[helper] progress notification failed:', error));
    },
    established: (agentId) => {
      const slot = [...slots.values()].find((candidate) => candidate.agentId === agentId);
      if (!slot) return;
      slot.established = true;
      if (slot.state === 'starting' || slot.state === 'restarting') setState(slot, 'serving');
      settleReady();
    },
    tickUpdate,
    notifyReleaseAvailable: (releaseKey) => update?.notifyReleaseAvailable(releaseKey),
    requestForceUpdate,
  };

  /** One agent's whole life in this process: start, restart on failure, stop. */
  const supervise = async (slot: AgentSlot) => {
    let failures = 0;
    while (!controller.signal.aborted && !slot.controller.signal.aborted) {
      if (!(await stat(slot.configPath).then(() => true, () => false))) {
        setState(slot, 'removed', 'runtime no longer on this machine');
        break;
      }
      await waitForPreviousHolder(slot.configPath, slot.controller.signal);
      let reason: HelperExitReason;
      try {
        reason = await runAgent(slot.configPath, host, slot.controller.signal);
      } catch (error) {
        console.error(`[helper] agent ${slot.agentId} failed:`, error);
        const failure: { distressed: boolean; count?: number; path?: string } =
          await settleDaemonStartFailure(dirname(slot.configPath), error)
            .catch(() => ({ distressed: false }));
        if (failure.distressed) {
          console.error(
            `[helper] agent ${slot.agentId} failed to start ${failure.count} times; it stays stopped. ` +
              `operator record: ${failure.path}`,
          );
          reason = 'distress';
        } else {
          reason = 'failed';
        }
        slot.status = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
      }
      // A slot that ends on its own still counts for the machine's readiness.
      slot.established = true;
      settleReady();
      if (controller.signal.aborted || slot.controller.signal.aborted) break;
      if (reason === 'restart-requested') {
        failures = 0;
        setState(slot, 'restarting', 'restart requested');
        continue;
      }
      if (reason === 'agent-removed') {
        setState(slot, 'removed', 'agent removed from Beeline');
        break;
      }
      if (reason === 'distress') {
        setState(slot, 'distressed');
        break;
      }
      if (reason === 'update' || reason === 'force-update-failed') {
        restartHelper(reason);
        break;
      }
      // An ordinary failure restarts only this agent, the way the service
      // manager used to restart its unit: 5 s, doubling to a minute.
      const delay = Math.min(AGENT_RESTART_MAX_MS, AGENT_RESTART_BASE_MS * 2 ** failures);
      failures += 1;
      setState(slot, 'restarting');
      await sleep(delay, slot.controller.signal);
    }
    if (slot.state !== 'removed' && slot.state !== 'distressed') setState(slot, 'stopped');
  };

  const startSlot = async (configPath: string) => {
    const existing = slots.get(configPath);
    if (existing?.running) return;
    const runtime = await readRuntimeRecord(configPath).catch(() => undefined);
    const slot: AgentSlot = existing ?? {
      configPath,
      agentId: runtime?.agent.publicKey ?? dirname(configPath).split('/').at(-1)!,
      controller: new AbortController(),
      state: 'starting',
      status: '',
      since: Date.now(),
      running: undefined,
      established: false,
    };
    if (slot.controller.signal.aborted) slot.controller = new AbortController();
    slots.set(configPath, slot);
    setState(slot, 'starting', '');
    slot.running = supervise(slot).finally(() => {
      slot.running = undefined;
    });
  };

  /** Host every paired, not-stopped agent; stop the ones that were stopped or removed. */
  const rescan = async () => {
    const wanted = new Set(await hostedRuntimes());
    for (const [configPath, slot] of slots) {
      if (wanted.has(configPath)) continue;
      slot.controller.abort();
    }
    for (const configPath of wanted) await startSlot(configPath);
  };
  const onHangup = () => {
    console.log('[helper] rescanning paired agents');
    void rescan().catch((error) => console.error('[helper] rescan failed:', error));
  };
  signals.on('SIGHUP', onHangup);
  const stopWatchdog = startLocalWatchdog(notifier, statusLine);

  try {
    console.log(`[helper] hosting ${initial.length} agent(s) on one machine socket per server`);
    for (const configPath of initial) await startSlot(configPath);
    // READY once every agent is serving, or has stopped trying.
    await Promise.race([
      allEstablished,
      new Promise<void>((resolveAbort) => controller.signal.addEventListener('abort', () => resolveAbort(), { once: true })),
    ]);
    if (!controller.signal.aborted) void sweepHostDisk();
    if (!controller.signal.aborted)
      await notifier.ready(`ready; ${statusLine()}`).catch((error) =>
        console.error('[helper] ready notification failed:', error));
    if (!controller.signal.aborted)
      await new Promise<void>((resolveAbort) =>
        controller.signal.addEventListener('abort', () => resolveAbort(), { once: true }));
    for (const slot of slots.values()) slot.controller.abort();
    await Promise.all([...slots.values()].map((slot) => slot.running));
  } finally {
    signals.off('SIGHUP', onHangup);
    stopWatchdog();
    for (const link of links.values()) link.stop();
    await statusWrite;
  }
  return finish(lifecycle.stopReason ?? 'stopped');
}

/**
 * Close every intake in one synchronous step; permit busy agents only at the update deadline.
 */
export function quiesceHostedAgents(agents: readonly HostedAgent[], deadlineReached = false): boolean {
  if (!deadlineReached && agents.some((agent) => agent.core.activeTurnCount() > 0)) return false;
  if (agents.some((agent) => !agent.lifecycle.serving &&
      !(agent.lifecycle.state.kind === 'quiescing' && agent.lifecycle.state.reason === 'update')))
    return false;
  for (const agent of agents) {
    if (agent.lifecycle.serving) {
      agent.core.quiesceForUpdate();
      agent.lifecycle.quiesce('update');
    }
  }
  return true;
}

/**
 * An agent is never served by two processes. A per-agent daemon from before
 * the machine helper, or the previous helper still finishing its drain, may
 * hold this runtime for a while; wait for it, then ask it to stop.
 */
async function waitForPreviousHolder(configPath: string, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  let asked = false;
  let announced = false;
  for (;;) {
    if (signal.aborted) return;
    const pid = await runtimeDaemonPid(configPath);
    if (!pid || pid === process.pid) return;
    if (!announced) {
      announced = true;
      console.log(`[helper] waiting for process ${pid} to let go of ${dirname(configPath)}`);
    }
    const waited = Date.now() - startedAt;
    if (waited >= PREVIOUS_HOLDER_WAIT_MS && !asked) {
      asked = true;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        return;
      }
    }
    if (waited >= PREVIOUS_HOLDER_WAIT_MS + PREVIOUS_HOLDER_KILL_WAIT_MS) return;
    await extendSystemdStartTimeout(30_000);
    await sleep(500, signal);
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal?.aborted) return resolveSleep();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolveSleep();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
