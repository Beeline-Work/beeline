import { createHash, randomUUID } from 'node:crypto';
import { MachineControl, machineControlPath } from './machine-control.js';
import { withKernelLock } from './kernel-lock.js';
import { DaemonApiError, isAgentRemovedError } from './daemon-api-client.js';
import { retireRemovedAgent } from './agent-retirement.js';
import { watch, type FSWatcher } from 'node:fs';
import type { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  interruptHostedAgent,
  runAgentRuntime,
  type AgentRuntimeHost,
  type HostedAgent,
} from './agent-runtime.js';
import { daemonFailurePath, settleDaemonStartFailure } from './daemon-failure.js';
import { helperStatusPath, type AgentSlotState, type HelperStatusFile } from './helper-status.js';
import { journalInterruptedTurns } from './force-update-journal.js';
import {
  HelperLifecycle,
  type AgentExitReason,
  type HelperExitReason,
} from './helper-lifecycle.js';
import { supervisor } from './helper-service.js';
import { installLaunchdTrustySquireBrokerService } from './launchd.js';
import { MachineLink } from './machine-link.js';
import { ReleaseTransaction, withInstallLock } from './managed-update.js';
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
  readUpdateState,
  runningReleaseId,
} from './self-update.js';
import type { InstalledBundleIdentity } from './self-update-manifest.js';
import {
  installTrustySquireBrokerService,
  startLocalWatchdog,
  SystemdNotifier,
} from './systemd.js';
import { squireBrokerMeetsComputerUseMinimum } from './squire-host.js';
import { pruneDeletedRuntimes, pruneRepositoryCaches } from './host-disk-retention.js';
import { pruneSharedModelCache } from './scratch-lifecycle.js';
import { monitorPrivateRecoveryReserve } from './shared-asset-capacity.js';

/** A failed agent restarts inside the helper after this, doubling to the cap. */
const AGENT_RESTART_BASE_MS = 5_000;
const AGENT_RESTART_MAX_MS = 60_000;
/** How long an agent waits for a previous process (an old per-agent daemon) to let go of it. */

interface AgentSlot {
  readonly configPath: string;
  agentId: string;
  controller: AbortController;
  state: AgentSlotState;
  status: string;
  lastError?: string;
  since: number;
  running: Promise<void> | undefined;
  established: boolean;
  enabled: boolean;
  watcher?: FSWatcher;
  configDigest?: string;
  revision: number;
  attemptRevision: number;
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
async function serveMachineHelper(
  options: {
    configPaths?: readonly string[];
    env?: NodeJS.ProcessEnv;
    /** Test seams: production runs the real per-agent runtime on process signals. */
    runAgent?: typeof runAgentRuntime;
    runUpdateWorker?: () => Promise<void>;
    signals?: EventEmitter;
    exitProcess?: (code: number) => void;
  } = {},
): Promise<{ reason: HelperExitReason; lifecycle: HelperLifecycle }> {
  const runAgent = options.runAgent ?? runAgentRuntime;
  const env = options.env ?? process.env;
  const supervisorRoot = defaultSupervisorRoot(env);
  const managedBy = options.configPaths || options.runAgent ? 'lab' : supervisor(env);
  if (
    managedBy !== 'lab' &&
    !(managedBy === 'systemd'
      ? env.BEELINE_MANAGED_BY_SYSTEMD === '1'
      : env.BEELINE_MANAGED_BY_LAUNCHD === '1')
  )
    throw new Error('machine helper requires native service ownership; run beeline start');
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
      [...hosted.values()].some((agent) => !agent.core.isWorkspaceIdle()) ||
      (now - lastModelSweepAt < 60 * 60_000 && now - lastRetentionSweepAt < 24 * 60 * 60_000)
    )
      return;
    diskSweepRunning = true;
    try {
      const modelDue = now - lastModelSweepAt >= 60 * 60_000;
      const removed = modelDue
        ? await pruneSharedModelCache(resolve(supervisorRoot, 'beeline', 'model-cache'))
        : [];
      if (modelDue) lastModelSweepAt = now;
      if (now - lastRetentionSweepAt >= 24 * 60 * 60_000) {
        removed.push(...(await pruneDeletedRuntimes(supervisorRoot)));
        removed.push(...(await pruneRepositoryCaches(supervisorRoot)));
        lastRetentionSweepAt = now;
      }
      if (removed.length)
        console.log(
          `[helper] idle disk sweep removed ${removed.length} expired cache/runtime directories`,
        );
    } catch (error) {
      console.warn('[helper] idle disk sweep failed:', error);
    } finally {
      diskSweepRunning = false;
    }
  };
  if (!options.configPaths) await writeHelperPidRecord(supervisorRoot, process.pid);

  const layout = beelineInstallLayout(env);
  let loadedRelease: string | undefined;
  let loadedReleaseIdentity: InstalledBundleIdentity | undefined;
  let update: ReleaseTransaction | undefined;
  const generation = randomUUID();
  let control: MachineControl | undefined;
  let stoppingStatus = 'helper stopped';

  const hostedRuntimes = async (): Promise<string[]> => {
    const paths = options.configPaths ?? (await findAgentRuntimeConfigPaths(env));
    const live: string[] = [];
    for (const path of paths) {
      if (
        !(await stat(path).then(
          () => true,
          () => false,
        ))
      )
        continue;
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
    loadedRelease =
      runningReleaseId(layout, env) ||
      env.BEELINE_EXECUTING_RELEASE ||
      (await activeReleaseId(layout));
    loadedReleaseIdentity = await readInstalledBundleIdentity(
      loadedRelease ? { ...layout, libDir: resolve(layout.releasesRoot, loadedRelease) } : layout,
    );
    if (!squireBrokerMeetsComputerUseMinimum(env.HOME?.trim() || homedir())) {
      // Converge the elector only when the durable install is below
      // the computer-use floor. Activation already converges new bundles.
      // A broker crash restart never reaches this path.
      const squireUpdateMode = 'minimum';
      if (managedBy === 'systemd')
        void installTrustySquireBrokerService({
          env,
          squireUpdateMode,
          invocationPath: resolve(layout.libDir, 'lib/beeline/beeline-cli.mjs'),
        }).catch((error) =>
          console.error(
            `[beeline] host Squire broker unit not converged: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      else if (managedBy === 'launchd')
        void installLaunchdTrustySquireBrokerService({
          env,
          squireUpdateMode,
          invocationPath: resolve(layout.libDir, 'lib/beeline/beeline-cli.mjs'),
        }).catch((error) =>
          console.error(
            `[beeline] host Squire broker launchd job not converged: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
  }
  const initial = await hostedRuntimes();

  const statusLine = () => {
    const parts = [...slots.values()].map(
      (slot) =>
        `${slot.agentId.slice(0, 12)} ${slot.state}${slot.status ? `: ${slot.status}` : ''}`,
    );
    return `loaded_release=${loadedRelease ?? 'development'}; agents=${slots.size}; ${parts.join(' | ')}`.slice(
      0,
      2_000,
    );
  };
  const snapshot = (): HelperStatusFile => ({
    pid: process.pid,
    generation,
    processState: lifecycle.state.kind,
    ...(update?.desiredRelease ? { desiredRelease: update.desiredRelease } : {}),
    ...(loadedRelease ? { loadedRelease, loadedIdentity: loadedReleaseIdentity } : {}),
    updatedAt: new Date().toISOString(),
    agents: Object.fromEntries(
      [...slots.values()].map((slot) => [
        slot.agentId,
        {
          state: slot.state,
          enabled: slot.enabled,
          status: slot.status,
          lastError: slot.lastError,
          since: new Date(slot.since).toISOString(),
        },
      ]),
    ),
  });
  let statusWrite: Promise<void> = Promise.resolve();
  const writeStatus = () => {
    const body = snapshot();
    control?.publish(body);
    statusWrite = statusWrite
      .then(async () => {
        const path = helperStatusPath(supervisorRoot);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const staged = `${path}.${process.pid}.tmp`;
        await writeFile(staged, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
        await rename(staged, path);
      })
      .catch((error) => console.error('[helper] status not written:', error));
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
    // Close the machine socket before agent teardown can unregister the last agent.
    if (reason === 'update') for (const link of links.values()) link.stop(true);
    lifecycle.stop(reason);
  };

  if (layout)
    update = new ReleaseTransaction({
      layout,
      loadedRelease,
      env,
      ...(options.runUpdateWorker ? { prepare: options.runUpdateWorker } : {}),
      idle: () => [...hosted.values()].every((agent) => agent.core.activeTurnCount() === 0),
      changed: () => writeStatus(),
      interrupt: () => {
        quiesceHostedAgents([...hosted.values()], true);
        for (const agent of hosted.values())
          journalInterruptedTurns(agent.runtimeDir, agent.core.interruptedTurns());
        for (const agent of hosted.values()) interruptHostedAgent(agent);
      },
      handoff: async (desiredRelease, interrupted) => {
        if (!quiesceHostedAgents([...hosted.values()], interrupted))
          throw new Error('helper could not close intake for release handoff');
        if (interrupted) {
          for (const agent of hosted.values())
            journalInterruptedTurns(agent.runtimeDir, agent.core.interruptedTurns());
          for (const agent of hosted.values()) agent.core.interruptForServerMinimum();
        }
        stoppingStatus = `loaded_release=${loadedRelease}; desired_release=${desiredRelease}; handoff ${interrupted ? 'interrupted' : 'idle'}`;
        restartHelper('update');
      },
      failed: (error, minimum) => {
        console.error('[helper] release transaction failed:', error);
        for (const agent of hosted.values())
          agent.lifecycle.resumeAfterFailedUpdate(() => agent.core.resumeServing());
        if (minimum) restartHelper('failed');
      },
    });
  const tickUpdate = async () => {
    await update?.idleChanged();
    void sweepHostDisk();
  };
  const requestForceUpdate = (minimum: string) => {
    if (!update) {
      restartHelper('failed');
      return;
    }
    update.notify(undefined, minimum, true);
  };

  const host: AgentRuntimeHost = {
    machineLink: (baseUrl) => {
      let link = links.get(baseUrl);
      if (!link) {
        link = new MachineLink({
          baseUrl,
          onRegistered: () => {
            update?.notify();
          },
        });
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
    progress: (agentId, status, fault) => {
      const slot = [...slots.values()].find((candidate) => candidate.agentId === agentId);
      if (slot?.controller.signal.aborted) return;
      if (slot && fault) slot.lastError = String(fault).slice(0, 500);
      if (
        slot &&
        fault instanceof DaemonApiError &&
        (fault.status === 401 || fault.status === 403) &&
        slot.revision !== slot.attemptRevision
      ) {
        setState(slot, 'restarting', 'configuration changed; reconnecting');
        slot.controller.abort();
        return;
      }
      if (
        (slot?.state === 'needs-auth' || slot?.state === 'needs-config') &&
        !(fault instanceof DaemonApiError && (fault.status === 401 || fault.status === 403))
      )
        return;
      if (slot && fault instanceof DaemonApiError && !fault.retryable &&
          fault.status >= 400 && fault.status < 500 && fault.status !== 401 && fault.status !== 403) {
        setState(slot, 'needs-config', status);
        return;
      }
      if (slot)
        setState(
          slot,
          fault instanceof DaemonApiError && (fault.status === 401 || fault.status === 403)
            ? 'needs-auth'
            : slot.established
              ? 'serving'
              : slot.state,
          fault instanceof DaemonApiError && (fault.status === 401 || fault.status === 403)
            ? `needs reconnect: ${status}`
            : status,
        );
      void notifier
        .progress(statusLine())
        .catch((error) => console.error('[helper] progress notification failed:', error));
    },
    established: (agentId) => {
      const slot = [...slots.values()].find((candidate) => candidate.agentId === agentId);
      if (!slot) return;
      slot.established = true;
      if (slot.state === 'starting' || slot.state === 'restarting') setState(slot, 'serving');
    },
    tickUpdate,
    notifyReleaseAvailable: (releaseKey) => update?.notify(releaseKey),
    requestForceUpdate,
  };

  /** One agent's whole life in this process: start, restart on failure, stop. */
  const supervise = async (slot: AgentSlot) => {
    let failures = 0;
    while (!controller.signal.aborted && !slot.controller.signal.aborted) {
      if (
        !(await stat(slot.configPath).then(
          () => true,
          () => false,
        ))
      ) {
        slot.enabled = false;
        setState(slot, 'removed', 'runtime no longer on this machine');
        break;
      }
      let reason: AgentExitReason;
      slot.attemptRevision = slot.revision;
      setState(slot, 'starting', slot.status);
      try {
        const previous = await runtimeDaemonPid(slot.configPath);
        if (previous && previous !== process.pid)
          throw new Error(
            `previous runtime owner ${previous} still alive; native topology migration incomplete`,
          );
        reason = await runAgent(slot.configPath, host, slot.controller.signal);
      } catch (error) {
        console.error(`[helper] agent ${slot.agentId} failed:`, error);
        await settleDaemonStartFailure(dirname(slot.configPath), error).catch(() => undefined);
        slot.established = false;
        slot.status =
          error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        slot.lastError = slot.status;
        if (isAgentRemovedError(error)) {
          await retireRemovedAgent(await readRuntimeRecord(slot.configPath));
          slot.enabled = false;
          setState(slot, 'removed', slot.status);
          break;
        }
        if (
          error instanceof DaemonApiError &&
          (error.status === 401 ||
            error.status === 403 ||
            (!error.retryable && error.code === 'legacy_reconnect_required'))
        ) {
          if (slot.revision !== slot.attemptRevision) continue;
          setState(slot, 'needs-auth', `needs reconnect: ${slot.status}`);
          break; // Only this refused revision waits; an explicit start/config event resumes it.
        }
        if (
          (error instanceof DaemonApiError && !error.retryable && error.status >= 400 && error.status < 500) ||
          error instanceof SyntaxError ||
          /invalid agent runtime|stored identity public key mismatch/.test(slot.status)
        ) {
          if (slot.revision !== slot.attemptRevision) continue;
          setState(slot, 'needs-config', slot.status);
          break;
        }
        reason = 'failed';
      }
      if (controller.signal.aborted || slot.controller.signal.aborted) break;
      if (reason === 'restart-requested') {
        failures = 0;
        setState(slot, 'restarting', 'restart requested');
        continue;
      }
      if (reason === 'agent-removed') {
        slot.enabled = false;
        setState(slot, 'removed', 'agent removed from Beeline');
        break;
      }
      if (reason === 'update') {
        restartHelper('update');
        break;
      }
      // An ordinary failure restarts only this agent, the way the service
      // manager used to restart its unit: 5 s, doubling to a minute.
      const delay = Math.min(AGENT_RESTART_MAX_MS, AGENT_RESTART_BASE_MS * 2 ** failures);
      failures += 1;
      setState(slot, 'restarting');
      await sleep(delay, slot.controller.signal);
    }
    if (slot.state !== 'removed' && slot.state !== 'needs-auth' && slot.state !== 'needs-config')
      setState(slot, 'stopped');
  };

  const startingSlots = new Map<string, Promise<void>>();
  const startSlot = (configPath: string): Promise<void> => {
    const pending = startingSlots.get(configPath);
    if (pending) return pending;
    const operation = startSlotOnce(configPath).finally(() => startingSlots.delete(configPath));
    startingSlots.set(configPath, operation);
    return operation;
  };
  const startSlotOnce = async (configPath: string) => {
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
      enabled: true,
      revision: 0,
      attemptRevision: 0,
    };
    slot.lastError ??= await readFile(daemonFailurePath(dirname(configPath)), 'utf8')
      .then((raw) => {
        const error = JSON.parse(raw).lastError;
        return typeof error === 'string' ? error.slice(0, 500) : undefined;
      })
      .catch(() => undefined);
    if (slot.controller.signal.aborted) slot.controller = new AbortController();
    slot.configDigest = await readFile(configPath)
      .then((raw) => createHash('sha256').update(raw).digest('hex'))
      .catch(() => undefined);
    slots.set(configPath, slot);
    if (!slot.watcher)
      slot.watcher = watch(dirname(configPath), (_event, filename) => {
        if (filename !== 'runtime.json') return;
        void readFile(configPath)
          .then((raw) => createHash('sha256').update(raw).digest('hex'))
          .catch(() => undefined)
          .then((digest) => {
            if (digest === slot.configDigest) return;
            slot.configDigest = digest;
            slot.revision += 1;
            if (slot.state === 'needs-auth' || slot.state === 'needs-config') {
              if (slot.running) slot.controller.abort();
              else void startSlot(configPath);
            }
          });
      });
    slot.enabled = true;
    slot.established = false;
    setState(slot, 'starting', '');
    slot.running = supervise(slot).finally(() => {
      slot.running = undefined;
      // A start racing an in-flight scoped stop is remembered in the durable desired set.
      if (!controller.signal.aborted && slot.controller.signal.aborted)
        void rescan().catch((error) =>
          console.error('[helper] desired-set reconciliation failed:', error),
        );
    });
  };

  /** Host every paired, not-stopped agent; stop the ones that were stopped or removed. */
  const rescan = async () => {
    const wanted = new Set(await hostedRuntimes());
    for (const [configPath, slot] of slots) {
      slot.enabled = wanted.has(configPath);
      if (wanted.has(configPath)) {
        if ((slot.state === 'needs-auth' || slot.state === 'needs-config') && slot.running)
          slot.controller.abort();
        continue;
      }
      slot.controller.abort();
    }
    for (const configPath of wanted) await startSlot(configPath);
  };
  const onHangup = () => {
    console.log('[helper] rescanning paired agents');
    void rescan().catch((error) => console.error('[helper] rescan failed:', error));
  };
  control = new MachineControl(machineControlPath(supervisorRoot), async (request) => {
    if (request.operation === 'converge' || request.operation === 'stop') await rescan();
    if (
      request.operation === 'update' &&
      request.releaseId &&
      layout &&
      (!request.sourceGeneration || request.sourceGeneration === generation)
    ) {
      const target = await withInstallLock(
        layout,
        async () => (await readUpdateState(layout)).stagedReleaseId ?? request.releaseId!,
      );
      await update?.prepared(target);
    }
    writeStatus();
    await statusWrite;
  });
  await control.start();
  signals.on('SIGHUP', onHangup);
  const stopWatchdog = startLocalWatchdog(
    notifier,
    statusLine,
    async () => {
      // Startup/backoff slots have no live core to acknowledge. Include every
      // hosted core so an actual stalled loop cannot borrow a sibling's health.
      await Promise.all([...hosted.values()].map((agent) => agent.core.requestWorkLoopProgress()));
      return true;
    },
    undefined,
    env,
    () => restartHelper('failed'),
  );

  try {
    console.log(`[helper] hosting ${initial.length} agent(s) on one machine socket per server`);
    for (const configPath of initial) await startSlot(configPath);
    lifecycle.beginServing();
    writeStatus();
    if (!controller.signal.aborted) void sweepHostDisk();
    if (!controller.signal.aborted)
      await notifier
        .ready(`ready; ${statusLine()}`)
        .catch((error) => console.error('[helper] ready notification failed:', error));
    if (!controller.signal.aborted)
      await new Promise<void>((resolveAbort) =>
        controller.signal.addEventListener('abort', () => resolveAbort(), { once: true }),
      );
    for (const slot of slots.values()) {
      slot.watcher?.close();
      slot.controller.abort();
    }
    await Promise.all([...slots.values()].map((slot) => slot.running));
  } finally {
    signals.off('SIGHUP', onHangup);
    stopWatchdog();
    update?.dispose();
    await control.stop();
    for (const link of links.values()) link.stop();
    await statusWrite;
  }
  return finish(lifecycle.stopReason ?? 'stopped');
}

/**
 * Close every intake in one synchronous step; permit busy agents only at the update deadline.
 */
export function quiesceHostedAgents(
  agents: readonly HostedAgent[],
  deadlineReached = false,
): boolean {
  if (!deadlineReached && agents.some((agent) => agent.core.activeTurnCount() > 0)) return false;
  if (
    agents.some(
      (agent) =>
        !agent.lifecycle.serving &&
        !(
          agent.lifecycle.state.kind === 'quiescing' &&
          (agent.lifecycle.state.reason === 'update' ||
            agent.lifecycle.state.reason === 'force-update')
        ),
    )
  )
    return false;
  for (const agent of agents) {
    if (agent.lifecycle.serving) {
      agent.core.quiesceForUpdate();
      agent.lifecycle.quiesce('update');
    }
  }
  return true;
}

export async function runMachineHelper(
  options: Parameters<typeof serveMachineHelper>[0] = {},
): ReturnType<typeof serveMachineHelper> {
  return withKernelLock(`beeline-helper:${defaultSupervisorRoot(options?.env)}`, () =>
    serveMachineHelper(options),
  );
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
