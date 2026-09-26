#!/usr/bin/env node
import { RESOURCE_FACADE_FLAG, runResourceFacade } from './resource-mcp-facade.js';
/**
 * Beeline body CLI — run a body against a TLC channel.
 *
 * Usage:
 *   BUZZ_PRIVATE_KEY=nsec1... \
 *   BUZZ_AGENT_BIN=/path/to/buzz-agent \
 *   BUZZ_DEV_MCP_BIN=/path/to/buzz-dev-mcp \
 *   BUZZY_BODY_LLM_FILE=/path/to/llm-egress.env \
 *   npx tsx src/cli.ts provision <channel-uuid>
 *
 * Or via npm:
 *   npm run body -- provision <channel-uuid>
 *
 * Env-driven config; see BodyConfig for all env overrides.
 */
import './network-family-bootstrap.js';
import { dirname, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { loadBodyConfig } from './config.js';
import { CURSOR_ACP_BRIDGE_FLAG, runCursorAcpStdioServer } from './cursor-acp-bridge.js';
import {
  runSquireBroker,
  runSquireFacade,
  SQUIRE_BROKER_FLAG,
  SQUIRE_FACADE_FLAG,
} from './squire-host.js';
import {
  formatAdapterInstallCommand,
  formatAgentCommand,
  installLatestAgentAdapter,
  latestAdapterInstallCommand,
} from './agent-command.js';
import {
  AGENT_ACCESS_POLICIES,
  isAgentAccessPolicy,
  LEGACY_ACCESS_POLICY,
} from './access-policy.js';
import { applyRuntimeModelPreflight } from './runtime-model-validation.js';
import { syncAgentModelCatalog } from './model-catalog-sync.js';
import { ConnectorAssignmentLoop } from './connector-assignments.js';
import {
  InstitutionalMemoryShadowWorker,
  institutionalMemoryShadowEnabled,
} from './institutional-memory-shadow-worker.js';
import { ThinDaemonCore } from './thin-core.js';
import { DEFAULT_DRAIN_DEADLINE_MS } from './room-runtime.js';
import { activateDaemonTransport } from './daemon-api-client.js';
import { hiccupBackoffMs } from '@beeline/api-contract/daemon';
import {
  clearDaemonPidRecordIfPid,
  findAgentRuntimeConfigPaths,
  migrateRuntimeRecordAccessPolicy,
  readRuntimeRecord,
  resolveRuntimeConfigPath,
  runtimeAgentCommand,
  stopRuntimeDaemon,
  writeDaemonPidRecord,
} from './runtime.js';
import { retireRemovedAgent } from './agent-retirement.js';
import { runStartCommand } from './start-command.js';
import {
  parseConnectSubscriptions,
  readMachineId,
  runConnectCommand,
  runConnectFinishCommand,
} from './connect-command.js';
import { runUpdateCommand } from './self-update-cli.js';
import { ensureBwrapSandbox } from './bwrap-sandbox.js';
import {
  activeReleaseId,
  beelineInstallLayout,
  describeIdentity,
  readInstalledBundleIdentity,
  readUpdateAttempt,
  repairInstallForwarders,
  settleUpdateAttemptOnStart,
} from './self-update.js';
import { clearDaemonStartFailures, recordDaemonStartFailure } from './daemon-failure.js';
import {
  DAEMON_DISTRESS_EXIT_STATUS,
  DELIBERATE_REMOVAL_EXIT_STATUS,
  SystemdNotifier,
  UNKNOWN_AGENT_EXIT_STATUS,
  disableAgentService,
  extendSystemdStartTimeout,
  installTrustySquireBrokerService,
  reconcileAgentServices,
} from './systemd.js';
import {
  ManagedUpdateDrain,
  attemptFailureText,
  gateManagedSuccessor,
  ManagedUpdateHandoff,
  rollbackFailedSuccessor,
  runningRuntimeProbeIds,
  runManagedUpdateWorker,
} from './managed-update.js';
import { runUpdateFunctionalProbe } from './update-functional-probe.js';
import {
  CURRENT_RELEASE_PROBE_TIMEOUT_MS,
  probeReleaseInSubprocess,
  runUpdateProbeCommand,
  UPDATE_PROBE_COMMAND,
} from './current-release-probe.js';
import {
  reportUpdateRollback,
  queueUpdateRollbackAlert,
  clearUpdateRollbackAlert,
  clearUpdateRollbackAlertIfConfirmed,
} from './update-rollback-alert.js';
import { writeDaemonReleaseStatus } from './release-status.js';
import { runScratchSweep } from './scratch-sweep.js';
import {
  disableLaunchdAgentService,
  installLaunchdTrustySquireBrokerService,
  reconcileLaunchdAgentServices,
} from './launchd.js';

function usage(exitCode = 1): void {
  console.error(`
${pc.bold('Beeline — thin Room agent.')}

${pc.dim('Usage:')}
  beeline connect [XXXXXXXX-XXXXXXXX] [--subscribe <kinds>] [--access <policy>]
                                            Install and connect an app-authorized agent;
                                            --subscribe takes a comma-separated list of
                                            event kinds it reacts to (e.g. joined);
                                            --access is everyone|creator|allowlist
                                            (default creator)
  beeline start                             Update the helper, then start every
                                            paired agent on this host. Already-
                                            running agents are left untouched.
                                            Reports started, already running, or
                                            failed for each.
  beeline start --agent <agent-pubkey>      Same, for one agent only
  beeline stop --agent <agent-pubkey>       Stop and disable the supervised agent
  beeline update [--check|--status|--rollback|--force]
                                            Self-update the installed bundle

${pc.dim('Options:')}
  --workspace-root <path>   Agent workspace (default: ./body-workspace)
  --llm-env-file <path>     Path to LLM credentials env file

All other config via env vars (see config.ts).
`);
  process.exit(exitCode);
}

let daemonFailureRuntimeDir: string | undefined;

const SCRATCH_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

function runScratchSweepLogged(runtimeDir: string): void {
  void runScratchSweep(runtimeDir).catch((error) =>
    console.error('[body] scratch sweep failed:', error),
  );
}

class DaemonExitError extends Error {
  constructor(
    message: string,
    readonly exitStatus: number,
  ) {
    super(message);
    this.name = 'DaemonExitError';
  }
}

async function runStoredDaemon(pathOrPointer: string): Promise<void> {
  // `--config` may point at the repo-anchored compatibility pointer; every
  // per-daemon path below (workspace, daemon.pid, Room roots) must hang off the
  // real runtime directory, not the pointer's.
  const configPath = await resolveRuntimeConfigPath(pathOrPointer);
  daemonFailureRuntimeDir = dirname(configPath);
  // One-time, idempotent migration: a runtime record that predates per-agent
  // access policies gets an explicit `accessPolicy: 'everyone'` stamped on it,
  // so flipping DEFAULT_ACCESS_POLICY to owner-only never re-gates an
  // already-paired agent. A record with any explicit policy is untouched.
  const accessMigration = await migrateRuntimeRecordAccessPolicy(configPath);
  let runtime = accessMigration.runtime;
  if (!runtime.transport) {
    throw new Error('legacy relay runtime is unsupported; reconnect this agent from the app');
  }
  const activated = await activateDaemonTransport(configPath);
  if (!activated) throw new Error('monolith daemon transport activation failed');
  runtime = activated.runtime;
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
    workspaceRoot: resolve(dirname(configPath), 'workspace'),
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
  if (runtime.modelSelection) {
    await applyRuntimeModelPreflight(
      config,
      agent,
      runtime.modelSelection,
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
  // OS sandbox for every ACP child (`bwrap-sandbox.ts`). Settled exactly once
  // here, at daemon start, so an unusable bwrap costs one advisory line rather
  // than a failed spawn per session — and so the operator learns the state of
  // the boundary before any Room comes online. Absent bubblewrap is installed
  // on this one pass: a Room shell is approved only inside that sandbox, so
  // without it the helper silently has no shell at all.
  const sandbox = await ensureBwrapSandbox({
    ...(runtime.sandbox ? { policy: runtime.sandbox } : {}),
  });
  if (sandbox.path) config.bwrapPath = sandbox.path;
  else config.sandboxUnavailableDetail = sandbox.advisory;
  // Owner-configured credential masks ride the runtime record; the
  // BUZZY_BODY_SANDBOX_MASK env var is already folded into `config` by
  // loadBodyConfig. Both are unioned at spawn time in Body.sessionSpawnCommand.
  if (runtime.sandboxMaskPaths?.length) {
    config.sandboxMaskPaths = [...(config.sandboxMaskPaths ?? []), ...runtime.sandboxMaskPaths];
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  // The service manager, never this process, owns resurrection and handoff.
  const runtimeDir = dirname(configPath);
  const layout = beelineInstallLayout(process.env);
  const notifier = new SystemdNotifier();
  let rollbackAlertDrain: Promise<void> | undefined;
  const drainRollbackAlert = (channelId: string | undefined): Promise<void> => {
    if (!channelId) return Promise.resolve();
    if (rollbackAlertDrain) return rollbackAlertDrain;
    rollbackAlertDrain = reportUpdateRollback({
      runtimeDir,
    })
      .then(() => undefined)
      .catch((alertError) =>
        console.error('[thin-core] automatic rollback alert remains queued:', alertError),
      )
      .finally(() => {
        rollbackAlertDrain = undefined;
      });
    return rollbackAlertDrain;
  };
  let loadedRelease: string | undefined;
  let loadedReleaseIdentity: Awaited<ReturnType<typeof readInstalledBundleIdentity>> | undefined;
  let update: ManagedUpdateHandoff | undefined;
  let pendingSuccessor = false;
  let successorRolledBack = false;
  if (layout) {
    const settle = await settleUpdateAttemptOnStart(layout);
    if (settle.kind === 'rolled-back') {
      await queueUpdateRollbackAlert(runtimeDir, settle.record.releaseId);
      await drainRollbackAlert(runtime.rooms[0]?.channelId);
      console.error(
        `[body] self-update ROLLED BACK: bundle ${describeIdentity(settle.record.to)} never confirmed healthy; ` +
          `restored ${settle.record.previousReleaseId ?? 'previous release'}`,
      );
      throw new DaemonExitError(
        'stale unconfirmed release rolled back; supervisor must restart',
        75,
      );
    } else if (settle.kind === 'pending') {
      pendingSuccessor = true;
    }
    loadedRelease = await activeReleaseId(layout);
    // A prior process may have queued a rollback alert that has since been
    // overtaken by events (this exact release later confirmed active
    // fleet-wide). Check before this process has any chance to queue an
    // alert of its own for a failure of ITS OWN — that check happens later
    // and must never observe this early clear.
    await clearUpdateRollbackAlertIfConfirmed(runtimeDir, loadedRelease);
    loadedReleaseIdentity = await readInstalledBundleIdentity(layout);
    config.daemonReleaseVersion = loadedReleaseIdentity?.version;
    config.daemonSourceSha = loadedReleaseIdentity?.commit;
    update = await ManagedUpdateHandoff.create(layout, runtimeDir, Date.now, {
      requiredProbeIds: [...(await runningRuntimeProbeIds(process.env)), runtime.agent.publicKey],
    });
    if (
      pendingSuccessor &&
      process.platform === 'linux' &&
      process.env.BEELINE_SYSTEMD_USER !== '0'
    ) {
      // This daemon is the first process running a newly-activated bundle. The
      // process that activated it may have been the PREVIOUS release (the
      // managed worker runs from the bundle it replaces), so converge the host
      // Squire elector here too: the swap does not rewrite or restart the unit
      // installed by `beeline start`/pairing, and a pre-#1653 host would keep
      // its PATH-less unit forever. Best-effort — the release is already live.
      await installTrustySquireBrokerService().catch((error) => {
        console.error(
          `[beeline] host Squire broker unit not converged: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    } else if (
      pendingSuccessor &&
      process.platform === 'darwin' &&
      process.env.BEELINE_LAUNCHD_USER !== '0'
    ) {
      await installLaunchdTrustySquireBrokerService().catch((error) => {
        console.error(
          `[beeline] host Squire broker launchd job not converged: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }

  console.log(
    `[beeline] thin daemon core ${runtime.communityId} starting with ${runtime.rooms.length} Room binding(s)`,
  );
  console.log(`[body] agent binary: ${formatAgentCommand(agent)}`);
  console.log(`[body] ${sandbox.advisory}`);

  // The attach scratch roots (`scratch-sweep.ts`) are settled the moment the
  // per-agent runtime layout above is: swept once now, then on a fixed
  // interval for the life of this process.
  runScratchSweepLogged(runtimeDir);
  const scratchSweepTimer = setInterval(
    () => runScratchSweepLogged(runtimeDir),
    SCRATCH_SWEEP_INTERVAL_MS,
  );
  scratchSweepTimer.unref();

  let ready = false;
  let connectorLoop: ConnectorAssignmentLoop | undefined;
  let institutionalMemoryWorker: InstitutionalMemoryShadowWorker | undefined;
  let catalogRefresh: Promise<void> | undefined;
  const refreshCatalog = (): Promise<void> => {
    catalogRefresh ??= syncAgentModelCatalog({
      api: daemonApi,
      agent,
      agentEnv: config.agentEnv,
      agentId: runtime.agent.publicKey,
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
  let stoppingStatus = 'daemon stopped';
  try {
    let lifecycleRestartDrain: Promise<void> | undefined;
    const core = new ThinDaemonCore(runtime, configPath, config, {
      daemonApi,
      onConfigChanged: refreshCatalog,
      onHiccupRestart: (attempt) => {
        const delay = hiccupBackoffMs(attempt);
        console.warn(
          `[thin-core] hiccup restart attempt ${attempt}; exiting so the service manager can start a fresh helper`,
        );
        if (delay <= 0) {
          process.exit(0);
          return;
        }
        const timer = setTimeout(() => process.exit(0), delay);
        timer.unref?.();
      },
      onRestartRequested: () => {
        if (lifecycleRestartDrain) return;
        const deadlineAt = Date.now() + DEFAULT_DRAIN_DEADLINE_MS;
        stoppingStatus =
          `restart requested; active work draining; ` +
          `exit_deadline=${new Date(deadlineAt).toISOString()}`;
        void notifier.progress(stoppingStatus);
        core.setDrainDeadlineAt(deadlineAt);
        lifecycleRestartDrain = (async () => {
          while (core.activeTurnCount() > 0 && Date.now() < deadlineAt) {
            await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
          }
          const forced = core.activeTurnCount() > 0;
          if (forced) await core.prepareForForcedUpdateRestart();
          else core.quiesceForUpdateIfIdle();
          stoppingStatus = forced
            ? 'restart requested; drain deadline reached; active work cancelled'
            : 'restart requested; active work drained';
          await notifier.stopping(stoppingStatus);
          controller.abort();
        })().catch((error) => {
          console.error('[thin-core] requested restart drain failed:', error);
          controller.abort();
        });
      },
    });
    // Busy means a turn is executing right now. An idle helper restarts on the
    // tick that arms the update; a busy one at the earlier of its last turn's
    // end or the absolute drain deadline, which the drain's own timer enforces.
    const updateDrain = update
      ? new ManagedUpdateDrain({
          update,
          quiesceIfIdle: () => core.quiesceForUpdateIfIdle(),
          activeTurnCount: () => core.activeTurnCount(),
          restart: async ({ desiredRelease, drainDeadlineAt }, mode) => {
            if (mode === 'forced') await core.prepareForForcedUpdateRestart();
            core.setDrainDeadlineAt(drainDeadlineAt);
            stoppingStatus =
              `update pending, converging; loaded_release=${loadedRelease ?? 'unknown'}; ` +
              `desired_release=${desiredRelease}; ` +
              `${mode === 'forced' ? 'active work cancelled at the drain deadline' : 'active work drained'}; ` +
              `intake quiesced; exit_deadline=${new Date(drainDeadlineAt).toISOString()}`;
            await notifier.stopping(stoppingStatus);
            controller.abort();
          },
          waiting: async ({ desiredRelease, drainDeadlineAt }) => {
            await notifier.progress(
              `loaded_release=${loadedRelease ?? 'unknown'}; update ready; ` +
                `active agent work is still running; handoff deferred; ` +
                `desired_release=${desiredRelease}; exit_deadline=${new Date(drainDeadlineAt).toISOString()}`,
            );
          },
        })
      : undefined;
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
            probeId: runtime.agent.publicKey,
            probe: () =>
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
                        await extendSystemdStartTimeout(CURRENT_RELEASE_PROBE_TIMEOUT_MS + 15_000);
                        return probeReleaseInSubprocess({
                          layout,
                          releaseId: currentReleaseId,
                          runtimeConfigPath: configPath,
                        });
                      },
                    }
                  : {}),
              }),
          });
          if (gate.kind === 'failed') {
            successorRolledBack = gate.rolledBack;
            throw gate.error;
          }
          functionalProof = gate.proof;
          pendingSuccessor = false;
          // A fresh gate pass proves this update path is healthy right now,
          // whichever release it names — it supersedes any stale rollback
          // record from an earlier failed attempt.
          await clearUpdateRollbackAlert(runtimeDir);
          console.log(
            `[thin-core] successor functional probe passed on exact release ${loadedRelease}: ` +
              `${functionalProof?.harness ?? 'unknown'} session/new + turn` +
              (functionalProof?.modelAnswer === 'unavailable'
                ? ` (model answer unavailable: ${functionalProof.modelAnswerReason})`
                : ''),
          );
        }
        await clearDaemonStartFailures(runtimeDir);
        await writeDaemonReleaseStatus(runtimeDir, runtime.agent.publicKey, loadedReleaseIdentity);
        await notifier.ready(`ready; loaded_release=${loadedRelease ?? 'development'}`);
        ready = true;
        // One bounded harness probe per activation keeps the phone's MODEL /
        // EFFORT rows current; it never blocks readiness or the Room loop.
        void syncAgentModelCatalog({
          api: daemonApi,
          agent,
          agentEnv: config.agentEnv,
          agentId: runtime.agent.publicKey,
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
        void readMachineId(process.env).then(({ machineId, machineName }) =>
          daemonApi.execute('postAgentMachineReport', { machineId, machineName }),
        );
        // The connector work queue drains on the live Connect push; the
        // interval is only recovery. One loop per daemon process, started
        // idempotently so a reconnect never stacks a second timer.
        connectorLoop ??= new ConnectorAssignmentLoop({
          api: daemonApi,
          agentId: runtime.agent.publicKey,
          log: (message) => console.log(`[body] connector: ${message}`),
        });
        daemonApi.setConnectorAssignmentListener(() => connectorLoop?.wake());
        connectorLoop.start();
        // Institutional review is dark unless the host opts into shadow or
        // live mode. It waits for interactive idleness; the server decides
        // whether a claimed job is measurement-only or may create an item.
        if (institutionalMemoryShadowEnabled()) {
          institutionalMemoryWorker ??= new InstitutionalMemoryShadowWorker({
            api: daemonApi,
            agentId: runtime.agent.publicKey,
            agent,
            agentEnv: config.agentEnv,
            ...(runtime.modelSelection ? { modelSelection: runtime.modelSelection } : {}),
            isInteractiveIdle: () => core.isWorkspaceIdle(),
            log: (message) => console.log(`[body] institutional memory: ${message}`),
          });
          institutionalMemoryWorker.start();
        }
      },
      onProgress: async (status) => {
        void drainRollbackAlert(core.activeRoomIds()[0] ?? runtime.rooms[0]?.channelId);
        // The watchdog heartbeat is coupled to this completed progress tick.
        await notifier.progress(`loaded_release=${loadedRelease ?? 'development'}; ${status}`);
        await updateDrain?.tick();
      },
    });
    if (result === 'agent-removed') {
      controller.abort();
      const archivedRuntime = await retireRemovedAgent(runtime);
      process.exitCode = DELIBERATE_REMOVAL_EXIT_STATUS;
      console.log(
        `[beeline] agent ${runtime.agent.publicKey} removed; runtime archived at ${archivedRuntime}`,
      );
    }
  } catch (error) {
    const rolledBack =
      successorRolledBack ||
      (layout &&
        pendingSuccessor &&
        !ready &&
        // Named, so a sibling daemon's journal can say whose failure reverted
        // the attempt it shares with this one.
        (await rollbackFailedSuccessor(layout, runtimeDir, {
          probeId: runtime.agent.publicKey,
          failure: attemptFailureText(error),
        })));
    if (rolledBack) {
      console.error('[thin-core] successor failed before READY; previous release restored once');
      const alertRoom = runtime.rooms[0]?.channelId;
      await drainRollbackAlert(alertRoom);
    }
    throw error;
  } finally {
    clearInterval(scratchSweepTimer);
    connectorLoop?.stop();
    institutionalMemoryWorker?.stop();
    await notifier.stopping(stoppingStatus).catch(() => undefined);
    // Only clear the pid record while it still names THIS process — a
    // self-update handover has already written the replacement's pid there.
    await clearDaemonPidRecordIfPid(configPath, process.pid);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const command = args[0];
  if (command === CURSOR_ACP_BRIDGE_FLAG) {
    await runCursorAcpStdioServer();
    return;
  }
  if (command === RESOURCE_FACADE_FLAG) {
    runResourceFacade();
    return;
  }
  if (command === SQUIRE_FACADE_FLAG) {
    runSquireFacade();
    return;
  }
  if (command === SQUIRE_BROKER_FLAG) {
    runSquireBroker();
    return;
  }
  if (command === '--help' || command === '-h') usage(0);

  if (command === 'managed-update-worker') {
    if (process.env.BEELINE_INTERNAL_UPDATE_WORKER !== '1') {
      throw new Error('managed-update-worker is an internal command');
    }
    console.log(JSON.stringify(await runManagedUpdateWorker()));
    return;
  }

  if (command === 'corner-read-token') {
    const configFlag = args.indexOf('--config');
    const roomFlag = args.indexOf('--room');
    const configPath = configFlag >= 0 ? args[configFlag + 1] : undefined;
    const roomId = roomFlag >= 0 ? args[roomFlag + 1] : undefined;
    if (!configPath || !roomId) throw new Error('corner-read-token requires --config and --room');
    const activated = await activateDaemonTransport(resolve(configPath));
    if (!activated) throw new Error('corner-read-token requires monolith transport');
    const credential = await activated.client.execute('getRoomGitHubToken', { roomId });
    process.stdout.write(`${credential.token}\n`);
    return;
  }

  if (command === 'connect') {
    // `--subscribe joined,check-failed`: what this agent reacts to in the
    // Rooms the claim joins it to. A greeter is set up with `--subscribe joined`.
    const subscribeFlag = args.indexOf('--subscribe');
    const subscribe = subscribeFlag >= 0 ? parseConnectSubscriptions(args[subscribeFlag + 1]) : [];
    // `--access everyone`: who may drive this agent. Absent keeps the safe
    // default, where only the person who paired it may. A Room's greeter needs
    // `everyone`, because the people it greets are never its creator.
    const accessFlag = args.indexOf('--access');
    const accessPolicy = accessFlag >= 0 ? args[accessFlag + 1] : undefined;
    if (accessFlag >= 0 && !isAgentAccessPolicy(accessPolicy)) {
      throw new Error(`--access must be one of ${AGENT_ACCESS_POLICIES.join(', ')}`);
    }
    const code = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    await runConnectCommand(code, {
      ...(subscribe.length ? { subscribe } : {}),
      ...(isAgentAccessPolicy(accessPolicy) ? { accessPolicy } : {}),
    });
    return;
  }

  if (command === 'connect-finish') {
    await runConnectFinishCommand(args[1]);
    return;
  }

  // Heal <prefix>/bin forwarders left broken by pre-contract installs (see
  // self-update.ts, "THE CONTRACT"): a daemon that survived the layout drift
  // starts through node directly, so it — and every CLI command run on a
  // healthy install — gets a free chance to make fresh-shell invocations work
  // again. Best-effort; never blocks or fails a command.
  const startupLayout = beelineInstallLayout(process.env);
  if (startupLayout) {
    await repairInstallForwarders(startupLayout).catch(() => undefined);
  }

  // Every command below shares this: a real terminal on both ends gets clack
  // framing (intro/outro, spinners, clean cancel lines); a script/CI/piped
  // run (or `daemon`, which is never a human at a keyboard) gets the exact
  // same plain output as before this existed, and never blocks on a prompt.
  const interactiveUi = command !== 'daemon' && Boolean(stdin.isTTY && stdout.isTTY);

  if (command === '--version' || command === 'version') {
    console.log(pc.bold('beeline 0.0.0'));
    const layout = beelineInstallLayout(process.env);
    if (layout) {
      const identity = await readInstalledBundleIdentity(layout);
      const active = await activeReleaseId(layout);
      console.log(
        `${pc.dim('installed bundle:')} ${describeIdentity(identity)}${active ? ` (release ${active})` : ''}`,
      );
    }
    return;
  }

  if (command === 'daemon') {
    const configFlag = args.indexOf('--config');
    const agentFlag = args.indexOf('--agent');
    let configPath = configFlag >= 0 ? args[configFlag + 1] : undefined;
    const agentPubkey = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
    if (agentPubkey && process.platform === 'linux') {
      await reconcileAgentServices({ env: process.env }).catch((error) => {
        console.error('[beeline] failed to enumerate orphan agent units:', error);
      });
    } else if (agentPubkey && process.platform === 'darwin') {
      await reconcileLaunchdAgentServices({ env: process.env }).catch((error) => {
        console.error('[beeline] failed to enumerate orphan agent launchd jobs:', error);
      });
    }
    if (!configPath && agentPubkey) {
      const configs = await findAgentRuntimeConfigPaths(process.env, process.cwd());
      configPath = configs.find((candidate) => dirname(candidate).endsWith(agentPubkey));
    }
    if (!configPath && agentPubkey) {
      throw new DaemonExitError(
        `unknown agent ${agentPubkey}: no durable runtime exists; refusing service restart loop`,
        UNKNOWN_AGENT_EXIT_STATUS,
      );
    }
    if (!configPath) throw new Error('daemon requires --config <runtime.json> or --agent <pubkey>');
    await runStoredDaemon(resolve(configPath));
    return;
  }

  if (command === 'update') {
    await runUpdateCommand(args);
    return;
  }

  // Internal: a successor's comparison probe spawns the CURRENT release's
  // bundle this way (`current-release-probe.ts`); not listed in usage.
  if (command === UPDATE_PROBE_COMMAND) {
    await runUpdateProbeCommand(args);
    return;
  }

  if (command === 'start') {
    await runStartCommand(args, interactiveUi);
    return;
  }

  if (command === 'stop') {
    const agentFlag = args.indexOf('--agent');
    const agentPubkey = agentFlag >= 0 ? args[agentFlag + 1] : args[1];
    if (!agentPubkey) throw new Error('stop requires --agent <pubkey>');
    const configs = await findAgentRuntimeConfigPaths(process.env, process.cwd());
    const configPath = configs.find((candidate) => dirname(candidate).endsWith(agentPubkey));
    if (!configPath) throw new Error(`no stored runtime found for agent ${agentPubkey}`);
    const runtime = await readRuntimeRecord(configPath);
    if (process.platform === 'linux' && process.env.BEELINE_SYSTEMD_USER !== '0') {
      await disableAgentService(runtime.agent.publicKey);
    } else if (process.platform === 'darwin' && process.env.BEELINE_LAUNCHD_USER !== '0') {
      await disableLaunchdAgentService(runtime.agent.publicKey);
    } else {
      await stopRuntimeDaemon(configPath, { timeoutMs: 30 * 60_000 });
    }
    console.log(`[beeline] agent ${runtime.agent.publicKey} disabled; graceful stop requested`);
    return;
  }

  usage();
}

main().catch(async (err) => {
  // Cover failures before runStoredDaemon reaches its core-level try/catch
  // (runtime migration, safety/config parsing, sandbox detection). A pending
  // release that cannot reach READY rolls back once; the service manager starts the
  // restored anchor. Worker/interactive command failures never touch it.
  if (process.argv[2] === 'daemon') {
    const layout = beelineInstallLayout(process.env);
    if (layout && (await rollbackFailedSuccessor(layout).catch(() => false))) {
      console.error('[thin-core] successor failed during startup; previous release restored once');
    }
  }
  // `daemon` is never a human at a keyboard — always the plain, full-detail
  // form (stack included) regardless of whether a TTY happens to be attached.
  const interactiveUi = process.argv[2] !== 'daemon' && Boolean(stdin.isTTY && stdout.isTTY);
  if (interactiveUi) {
    clack.cancel(err instanceof Error ? err.message : String(err));
  } else if (
    err instanceof Error &&
    err.name === 'ConnectFailureError' &&
    (process.argv[2] === 'connect' || process.argv[2] === 'connect-finish')
  ) {
    // A human is on the other end of the connect wizard even though this
    // child has no TTY (the parent spawns it with pipes). One plain sentence,
    // never a stack — the wizard surfaces this line verbatim.
    console.error(pc.red(err.message));
  } else {
    console.error(pc.red('[body] fatal:'), err);
  }
  let exitStatus = err instanceof DaemonExitError ? err.exitStatus : 1;
  if (process.argv[2] === 'daemon' && daemonFailureRuntimeDir && exitStatus === 1) {
    try {
      const failure = await recordDaemonStartFailure(daemonFailureRuntimeDir, err);
      if (failure.distressed) {
        exitStatus = DAEMON_DISTRESS_EXIT_STATUS;
        console.error(
          `[thin-core] daemon start failed ${failure.count} times; service restart stopped. ` +
            `operator record: ${failure.path}`,
        );
      }
    } catch (recordError) {
      console.error('[thin-core] could not persist daemon distress record:', recordError);
    }
  }
  process.exit(exitStatus);
});
