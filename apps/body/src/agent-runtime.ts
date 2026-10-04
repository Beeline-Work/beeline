import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadBodyConfig } from './config.js';
import {
  formatAdapterInstallCommand,
  formatAgentCommand,
  installLatestAgentAdapter,
  latestAdapterInstallCommand,
} from './agent-command.js';
import { LEGACY_ACCESS_POLICY } from './access-policy.js';
import {
  applyRuntimeModelPreflight,
  resolvePreflightModelSelection,
} from './runtime-model-validation.js';
import { modelUnavailableState } from './model-availability.js';
import { syncAgentModelCatalog } from './model-catalog-sync.js';
import {
  AgentSignIn,
  agentSignInHarness,
  answerAgentSignInFrame,
  reportAgentSignInResult,
} from './agent-sign-in.js';
import { ConnectorAssignmentLoop } from './connector-assignments.js';
import { RegistryMcpHostBroker } from './registry-mcp.js';
import { ThinDaemonCore } from './thin-core.js';
import {
  HelperLifecycle,
  retryBeforeReady,
  successorRollbackAllowed,
  type HelperExitReason,
} from './helper-lifecycle.js';
import { activateDaemonTransport, DaemonApiError } from './daemon-api-client.js';
import { reportInterruptedTurns } from './force-update-journal.js';
import type { InterruptedTurn } from './force-update-journal.js';
import {
  clearDaemonPidRecordIfPid,
  convergeRuntimeRecordFileModes,
  migrateRuntimeRecordAccessPolicy,
  runtimeAgentCommand,
  writeDaemonPidRecord,
} from './runtime.js';
import { retireRemovedAgent } from './agent-retirement.js';
import { readMachineId } from './connect-command.js';
import { BUBBLEWRAP_INSTALL_BUDGET_MS, ensureBwrapSandbox } from './bwrap-sandbox.js';
import { readUpdateAttempt, type BeelineInstallLayout } from './self-update.js';
import type { InstalledBundleIdentity } from './self-update-manifest.js';
import { clearDaemonStartFailures } from './daemon-failure.js';
import { extendSystemdStartTimeout } from './systemd.js';
import { gateManagedSuccessor, attemptFailureText, rollbackFailedSuccessor } from './managed-update.js';
import { retryWhileAdapterReinstalls, runUpdateFunctionalProbe } from './update-functional-probe.js';
import { CURRENT_RELEASE_PROBE_TIMEOUT_MS, probeReleaseInSubprocess } from './current-release-probe.js';
import {
  reportUpdateRollback,
  clearUpdateRollbackAlert,
  clearUpdateRollbackAlertIfConfirmed,
} from './update-rollback-alert.js';
import { writeDaemonReleaseStatus } from './release-status.js';
import { runScratchSweep } from './scratch-sweep.js';
import type { MachineLink } from './machine-link.js';

const SCRATCH_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

function runScratchSweepLogged(runtimeDir: string): void {
  void runScratchSweep(runtimeDir).catch((error) =>
    console.error('[body] scratch sweep failed:', error),
  );
}

/** What the machine helper needs from one agent it hosts. */
export interface HostedAgent {
  readonly agentId: string;
  readonly runtimeDir: string;
  readonly lifecycle: HelperLifecycle;
  readonly core: ThinDaemonCore;
}

/** What one agent runtime needs from the machine helper that hosts it. */
export interface AgentRuntimeHost {
  /** The machine's one socket to this server origin. */
  machineLink(baseUrl: string): MachineLink;
  readonly layout: BeelineInstallLayout | undefined;
  readonly loadedRelease: string | undefined;
  readonly loadedReleaseIdentity: InstalledBundleIdentity | undefined;
  /** Join the machine's update drain and forced-update handoff; returns leave. */
  attach(agent: HostedAgent): () => void;
  /** A status line for the watchdog and `beeline update --status`. */
  progress(agentId: string, status: string): void;
  /** This agent finished starting (or gave up on it). */
  established(agentId: string): void;
  tickUpdate(): Promise<void>;
  notifyReleaseAvailable(releaseKey: string): void;
  requestForceUpdate(minVersion: string): void;
}

/**
 * One paired agent inside the machine helper: its runtime record, transport
 * registration, sandbox, Room runtime and workers. It returns why it ended;
 * the machine helper decides whether that restarts this agent, stops it, or
 * restarts the whole helper (an update). It never exits the process.
 */
export async function runAgentRuntime(
  configPath: string,
  host: AgentRuntimeHost,
  signal: AbortSignal,
): Promise<HelperExitReason> {
  const runtimeDir = dirname(configPath);
  // Existing installs converge on the private file modes a fresh runtime
  // record already gets: defense-in-depth alongside the sandbox mask below,
  // for the same-machine case file modes alone can actually help with.
  await convergeRuntimeRecordFileModes(configPath);
  // One-time, idempotent migration: a runtime record that predates per-agent
  // access policies gets an explicit `accessPolicy: 'everyone'` stamped on it,
  // so flipping DEFAULT_ACCESS_POLICY to owner-only never re-gates an
  // already-paired agent. A record with any explicit policy is untouched.
  const accessMigration = await migrateRuntimeRecordAccessPolicy(configPath);
  let runtime = accessMigration.runtime;
  if (!runtime.transport) {
    throw new Error('legacy relay runtime is unsupported; reconnect this agent from the app');
  }
  const activated = await activateDaemonTransport(
    configPath,
    fetch,
    host.machineLink(runtime.transport.baseUrl),
  );
  if (!activated) throw new Error('monolith daemon transport activation failed');
  runtime = activated.runtime;
  const agentId = runtime.agent.publicKey;
  const daemonApi = activated.client;
  const refreshRuntimeAdapter = async (): Promise<void> => {
    const kind = runtime.agentKind;
    if (!kind) return;
    const install = latestAdapterInstallCommand(kind);
    if (!install) return;
    console.log(`[body] refreshing ${kind} adapter: ${formatAdapterInstallCommand(install)}`);
    await installLatestAgentAdapter(kind);
  };
  try {
    await refreshRuntimeAdapter();
  } catch (error) {
    console.error(
      `[body] adapter refresh failed; validating the installed copy (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const agent = runtimeAgentCommand(runtime);
  await writeDaemonPidRecord(configPath, process.pid);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUZZ_AGENT_BIN: agent.command,
    BUZZ_DEV_MCP_BIN: runtime.mcpBinary,
  };
  const config = loadBodyConfig({
    workspaceRoot: resolve(runtimeDir, 'workspace'),
    llmEnvFile: runtime.llmEnvFile,
    env,
    agent,
  });
  // Per-agent access policy is a property of the paired runtime, not the
  // process env, so inject it here where both are in hand. The supervisor's
  // per-Room config spread carries it to every Body. A record still carrying
  // no explicit policy at this point can only be pre-policy (the migration
  // above stamps every canonical one), so it keeps the frozen legacy
  // behaviour — never the new pairing default.
  config.accessPolicy = runtime.accessPolicy ?? LEGACY_ACCESS_POLICY;
  config.accessOwnerPubkey = runtime.pairedBy;
  if (runtime.accessAllowlist) config.accessAllowlist = [...runtime.accessAllowlist];
  if (runtime.accessAutoResponse) config.accessAutoResponse = runtime.accessAutoResponse;
  if (runtime.externalMcpCapabilities) {
    config.externalMcpCapabilities = [...runtime.externalMcpCapabilities];
  }
  if (runtime.sharedSkills) config.sharedSkills = [...runtime.sharedSkills];
  // The server's current selection is authoritative for this preflight: a
  // stale local runtime.json cache (an id already corrected server-side, or
  // a retired alias) must not re-poison config.modelUnavailable on this
  // restart just because it never received the correction.
  const serverModelSelection = await daemonApi
    .execute('getAgentConfiguration', { agentId })
    .then((result) =>
      result.model || result.effort
        ? { ...(result.model ? { model: result.model } : {}), ...(result.effort ? { effort: result.effort } : {}) }
        : undefined,
    )
    .catch(() => undefined);
  const preflightModelSelection = resolvePreflightModelSelection(
    runtime.modelSelection,
    serverModelSelection,
  );
  if (preflightModelSelection) {
    await applyRuntimeModelPreflight(
      config,
      agent,
      preflightModelSelection,
      undefined,
      refreshRuntimeAdapter,
    );
    if (!config.modelUnavailable) {
      console.log('[body] persisted model/effort selection passed live startup validation');
    } else {
      console.error(`[body] ${config.modelUnavailable.detail}`);
    }
  }
  // Pinned so corner-session git credential helpers (`corner-read-token.ts`)
  // can exec this bundle's CLI against the exact runtime record — no state-home
  // discovery inside the sandbox, where XDG dirs are deliberately relocated.
  config.runtimeConfigPath = configPath;
  // OS sandbox for every ACP child (`bwrap-sandbox.ts`). Settled once per
  // agent start, so an unusable bwrap costs one advisory line rather than a
  // failed spawn per session. Absent bubblewrap is installed on this pass: a
  // Room shell is approved only inside that sandbox. That install does not
  // come out of the unit's own start budget, so the start deadline is
  // extended first, and only when a package command is really about to run.
  const sandbox = await ensureBwrapSandbox({
    ...(runtime.sandbox ? { policy: runtime.sandbox } : {}),
    stateDir: runtimeDir,
    beforeInstall: () => extendSystemdStartTimeout(BUBBLEWRAP_INSTALL_BUDGET_MS),
  });
  if (sandbox.path) config.bwrapPath = sandbox.path;
  else if (sandbox.shellDetail) config.shellUnavailableDetail = sandbox.shellDetail;
  // Owner-configured credential masks ride the runtime record; the
  // BUZZY_BODY_SANDBOX_MASK env var is already folded into `config` by
  // loadBodyConfig. Both are unioned at spawn time in Body.sessionSpawnCommand.
  if (runtime.sandboxMaskPaths?.length) {
    config.sandboxMaskPaths = [...(config.sandboxMaskPaths ?? []), ...runtime.sandboxMaskPaths];
  }
  const controller = new AbortController();
  const abortFromHost = () => lifecycle.stop('stopped');
  // This agent's own lifecycle. Its end is a return value, never a process exit.
  const lifecycle = new HelperLifecycle({ controller, exitProcess: () => undefined });
  signal.addEventListener('abort', abortFromHost, { once: true });
  if (signal.aborted) abortFromHost();

  const layout = host.layout;
  let rollbackAlertDrain: Promise<void> | undefined;
  const drainRollbackAlert = (channelId: string | undefined): Promise<void> => {
    if (!channelId) return Promise.resolve();
    if (rollbackAlertDrain) return rollbackAlertDrain;
    rollbackAlertDrain = reportUpdateRollback({ runtimeDir })
      .then(() => undefined)
      .catch((alertError) =>
        console.error('[thin-core] automatic rollback alert remains queued:', alertError),
      )
      .finally(() => {
        rollbackAlertDrain = undefined;
      });
    return rollbackAlertDrain;
  };
  const loadedRelease = host.loadedRelease;
  const loadedReleaseIdentity = host.loadedReleaseIdentity;
  let pendingSuccessor = false;
  let successorRolledBack = false;
  /** A pending successor is never rolled back for an outage before this. */
  let attemptDeadlineAt: number | undefined;
  if (layout) {
    // This agent proves the release only while the attempt that installed it
    // is still pending; an agent restarted after a sibling confirmed it serves.
    const attempt = await readUpdateAttempt(layout);
    if (attempt?.status === 'pending' && attempt.releaseId === loadedRelease) {
      pendingSuccessor = true;
      attemptDeadlineAt = attempt.confirmBy;
    }
    // A prior process may have queued a rollback alert that has since been
    // overtaken by events (this exact release later confirmed active
    // fleet-wide). Check before this process has any chance to queue an
    // alert of its own for a failure of ITS OWN — that check happens later
    // and must never observe this early clear.
    await clearUpdateRollbackAlertIfConfirmed(runtimeDir, loadedRelease);
    config.daemonReleaseVersion = loadedReleaseIdentity?.version;
    config.daemonSourceSha = loadedReleaseIdentity?.commit;
    daemonApi.setHelperIdentity({
      releaseVersion: loadedReleaseIdentity?.version,
      sourceSha: loadedReleaseIdentity?.commit,
    });
  }

  console.log(
    `[beeline] agent ${agentId} in workspace ${runtime.communityId} starting with ${runtime.rooms.length} Room binding(s)`,
  );
  console.log(`[body] agent binary: ${formatAgentCommand(agent)}`);
  console.log(`[body] ${sandbox.advisory}`);

  // The attach scratch roots (`scratch-sweep.ts`) are settled the moment the
  // per-agent runtime layout above is: swept once now, then on a fixed
  // interval for the life of this agent.
  runScratchSweepLogged(runtimeDir);
  const scratchSweepTimer = setInterval(
    () => runScratchSweepLogged(runtimeDir),
    SCRATCH_SWEEP_INTERVAL_MS,
  );
  scratchSweepTimer.unref();

  let ready = false;
  let established = false;
  const markEstablished = () => {
    if (established) return;
    established = true;
    host.established(agentId);
  };
  let connectorLoop: ConnectorAssignmentLoop | undefined;
  let agentSignIn: AgentSignIn | undefined;
  let registryMcpBroker: RegistryMcpHostBroker | undefined;
  let catalogRefresh: Promise<void> | undefined;
  let leaveHost: (() => void) | undefined;
  const refreshCatalog = (): Promise<void> => {
    catalogRefresh ??= syncAgentModelCatalog({
      api: daemonApi,
      agent,
      agentEnv: config.agentEnv,
      agentId,
      workspaceId: runtime.communityId,
      runtimeDir,
      ...(runtime.modelSelection ? { runtimeSelection: runtime.modelSelection } : {}),
      force: true,
    })
      .then(() => undefined)
      .finally(() => {
        catalogRefresh = undefined;
      });
    return catalogRefresh;
  };
  let exitReason: HelperExitReason | undefined;
  try {
    registryMcpBroker = new RegistryMcpHostBroker(
      config.operatorHome,
      fetch,
      // The one per-call gate a Registry route has: the server's existing
      // requester-aware resource approval, asked here because the broker
      // socket — not the harness MCP client — is what every caller reaches.
      async ({ roomId, requestId, generationId, target, consume, operation }) =>
        (
          await daemonApi.execute('authorizeResourceCall', {
            roomId,
            requestId,
            generationId,
            target,
            consume,
            ...(operation ? { operation } : {}),
          })
        ).allowed === true,
      // One broker per hosted agent: each authorizes against its own agent.
      registryBrokerSocketPath(config.operatorHome, agentId),
    );
    await registryMcpBroker.start();
    config.registryMcpBrokerSocket = registryMcpBroker.socketPath;
    let lifecycleRestart: Promise<void> | undefined;
    const core = new ThinDaemonCore(runtime, configPath, config, {
      daemonApi,
      onConfigChanged: refreshCatalog,
      onRestartRequested: () => {
        // `/restart` cancels at once, and takes over an update still waiting.
        if (lifecycleRestart || !lifecycle.quiesce('restart')) return;
        lifecycleRestart = (async () => {
          const cancelled = await core.cancelActiveWorkForRestart();
          host.progress(agentId, cancelled
            ? 'restart requested; active work cancelled'
            : 'restart requested; no active work');
          lifecycle.stop('restart-requested');
        })().catch((error) => {
          console.error('[thin-core] requested restart failed:', error);
          lifecycle.stop('restart-requested');
        });
      },
    });
    leaveHost = host.attach({ agentId, runtimeDir, lifecycle, core });
    daemonApi.setForceUpdateListener((minVersion) => host.requestForceUpdate(minVersion));
    daemonApi.setHelperReleaseListener(({ version, sha }) => {
      host.notifyReleaseAvailable(`${version}:${sha}`);
      void host.tickUpdate();
    });
    // The update check reads the static release manifest, never the server.
    daemonApi.onLiveOpen(() => void host.tickUpdate());
    core.setInteractiveIdleListener(() => {
      void host.tickUpdate();
    });
    const result = await core.run({
      signal: controller.signal,
      onEstablished: async () => {
        let functionalProof: Awaited<ReturnType<typeof runUpdateFunctionalProbe>> | undefined;
        if (layout && pendingSuccessor) {
          // The release this successor would roll back to; a provider refusal
          // or ACP turn failure it shares with the successor is not the
          // successor's fault.
          const currentReleaseId = (await readUpdateAttempt(layout))?.previousReleaseId;
          const gate = await gateManagedSuccessor({
            layout,
            runtimeDir,
            loadedRelease,
            probeId: agentId,
            probe: () =>
              retryWhileAdapterReinstalls(
                () =>
                  runUpdateFunctionalProbe({
                    config,
                    runtimeDir,
                    releaseId: loadedRelease ?? 'unknown',
                    sandboxRequired: runtime.sandbox !== 'off',
                    sandboxUnavailableDetail: sandbox.advisory,
                    ...(currentReleaseId
                      ? {
                          compareWithCurrentRelease: async (appeal) => {
                            console.warn(
                              `[thin-core] successor probe got no answer from the provider ` +
                                `(${appeal.reason}); probing the current release ${currentReleaseId} ` +
                                `for the same outcome`,
                            );
                            await extendSystemdStartTimeout(
                              CURRENT_RELEASE_PROBE_TIMEOUT_MS + 15_000,
                            );
                            return probeReleaseInSubprocess({
                              layout,
                              releaseId: currentReleaseId,
                              runtimeConfigPath: configPath,
                            });
                          },
                        }
                      : {}),
                  }),
                {
                  sleep: async (ms) => {
                    await extendSystemdStartTimeout(ms + 15_000);
                    await new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));
                  },
                },
              ),
          });
          if (gate.kind === 'failed') {
            successorRolledBack = gate.rolledBack;
            throw gate.error;
          }
          if (gate.kind === 'agent-failed') {
            if (!config.modelUnavailable)
              config.modelUnavailable = modelUnavailableState(
                config.modelSelection ?? runtime.modelSelection ?? {}, gate.error,
              );
            console.warn('[thin-core] server-minimum release retained; this agent probe failed:', gate.error);
          }
          if (gate.kind === 'agent-unavailable') {
            if (!config.modelUnavailable) {
              config.modelUnavailable = modelUnavailableState(
                config.modelSelection ?? runtime.modelSelection ?? {},
                gate.error.cause ?? gate.error,
              );
            }
            console.warn(
              `[thin-core] new release retained; this agent's selected model is unavailable: ${gate.error.message}`,
            );
          } else if (gate.kind === 'passed') {
            functionalProof = gate.proof;
          }
          pendingSuccessor = false;
          // A fresh gate pass proves this update path is healthy right now,
          // whichever release it names — it supersedes any stale rollback
          // record from an earlier failed attempt.
          await clearUpdateRollbackAlert(runtimeDir);
          if (functionalProof)
            console.log(
              `[thin-core] successor functional probe passed on exact release ${loadedRelease}: ` +
                `${functionalProof?.harness ?? 'unknown'} session/new + turn` +
                (functionalProof?.modelAnswer === 'unavailable'
                  ? ` (model answer unavailable: ${functionalProof.modelAnswerReason})`
                  : ''),
            );
        }
        try {
          // Interrupted-turn replay waits out an outage on every open
          // instead of failing the start (or rolling a successor back).
          await retryBeforeReady(
            () => reportInterruptedTurns(runtimeDir, daemonApi, agentId),
            {
              onLinkOpen: (listener) => daemonApi.onLiveOpen(listener),
              extendStartTimeout: extendSystemdStartTimeout,
              ...(attemptDeadlineAt !== undefined ? { deadlineAt: attemptDeadlineAt } : {}),
              signal: controller.signal,
            },
          );
        } catch (error) {
          // A refusal for the helper version is the forced update's job now.
          if (error instanceof DaemonApiError && error.status === 426 &&
              error.code === 'update_required') {
            markEstablished();
            return;
          }
          throw error;
        }
        await clearDaemonStartFailures(runtimeDir);
        await writeDaemonReleaseStatus(runtimeDir, agentId, loadedReleaseIdentity);
        ready = true;
        markEstablished();
        // One bounded harness probe per activation keeps the phone's MODEL /
        // EFFORT rows current; it never blocks readiness or the Room loop.
        void syncAgentModelCatalog({
          api: daemonApi,
          agent,
          agentEnv: config.agentEnv,
          agentId,
          workspaceId: runtime.communityId,
          runtimeDir,
          ...(runtime.modelSelection ? { runtimeSelection: runtime.modelSelection } : {}),
          ...(config.modelUnavailable
            ? { startupUnavailable: config.modelUnavailable.unavailable.label }
            : {}),
        });
        // Report the machine identity once per activation so the server can
        // collapse multiple agents on one physical host into one machine row
        // in readWorkbench. Best-effort: a failed report does not block
        // readiness or the Room loop.
        void readMachineId(process.env)
          .then(({ machineId, machineName }) =>
            daemonApi.execute('postAgentMachineReport', { machineId, machineName }),
          )
          .catch((error) => console.warn('[body] machine report failed:', error));
        // The connector work queue drains on the live Connect push.
        // One loop per agent also handles reconnects.
        connectorLoop ??= new ConnectorAssignmentLoop({
          api: daemonApi,
          agentId,
          registryHome: config.operatorHome,
          log: (message) => console.log(`[body] connector: ${message}`),
        });
        daemonApi.setConnectorAssignmentListener(() => connectorLoop?.wake());
        connectorLoop.start();
        // `@agent /login`: the owner's Room card relays each step over the
        // live socket; the login lands where this harness reads it.
        const signInHarness = agentSignInHarness(agent.kind);
        if (signInHarness) {
          const cards = new Map<string, string>();
          const log = (message: string) => console.log(`[body] ${message}`);
          agentSignIn ??= new AgentSignIn({
            harness: signInHarness,
            operatorHome: config.operatorHome ?? homedir(),
            agentEnv: config.agentEnv,
            ...(runtime.llmEnvFile ? { llmEnvFile: runtime.llmEnvFile } : {}),
            model: () => config.modelSelection?.model ?? runtime.modelSelection?.model,
            onResult: (attemptId, result) =>
              void reportAgentSignInResult(daemonApi, agentId, attemptId, cards, result, log),
            onKeySaved: () => daemonApi.emitConfigChanged(),
          });
          const signIn = agentSignIn;
          daemonApi.setAgentSignInListener((frame) => {
            void answerAgentSignInFrame(daemonApi, agentId, signIn, frame, cards, log);
          });
        }
      },
      onProgress: async (status) => {
        void drainRollbackAlert(core.activeRoomIds()[0] ?? runtime.rooms[0]?.channelId);
        host.progress(agentId, status);
        await host.tickUpdate();
      },
    });
    if (result === 'agent-removed') {
      controller.abort();
      const archivedRuntime = await retireRemovedAgent(runtime);
      exitReason = 'agent-removed';
      console.log(`[beeline] agent ${agentId} removed; runtime archived at ${archivedRuntime}`);
    }
  } catch (error) {
    const rolledBack =
      successorRolledBack ||
      (layout &&
        pendingSuccessor &&
        !ready &&
        successorRollbackAllowed(error, attemptDeadlineAt) &&
        // Named, so a sibling's journal can say whose failure reverted the
        // attempt it shares with this one.
        (await rollbackFailedSuccessor(layout, runtimeDir, {
          probeId: agentId,
          failure: attemptFailureText(error),
        })));
    if (rolledBack) {
      console.error(`[thin-core] successor failed before READY for agent ${agentId}; previous release restored once`);
      await drainRollbackAlert(runtime.rooms[0]?.channelId);
      return 'rolled-back';
    }
    throw error;
  } finally {
    markEstablished();
    signal.removeEventListener('abort', abortFromHost);
    leaveHost?.();
    clearInterval(scratchSweepTimer);
    connectorLoop?.stop();
    agentSignIn?.stop();
    await registryMcpBroker?.stop();
    daemonApi.closeLive();
    // Only clear the pid record while it still names THIS process.
    await clearDaemonPidRecordIfPid(configPath, process.pid);
  }
  return exitReason ?? lifecycle.stopReason ?? 'stopped';
}

/** Per agent: two agents in one process must never share a broker socket. */
function registryBrokerSocketPath(home: string | undefined, agentId: string): string {
  return join(home ?? homedir(), '.beeline', 'registry-mcp-broker',
    `${process.pid}-${agentId.slice(0, 8)}.sock`);
}

/** The force-update journal entries for one hosted agent. */
export function interruptHostedAgent(agent: HostedAgent): InterruptedTurn[] {
  agent.lifecycle.quiesce('force-update');
  agent.core.setDrainDeadlineAt(Date.now() + 60_000);
  return agent.core.interruptForServerMinimum();
}
