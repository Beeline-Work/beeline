#!/usr/bin/env node
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
import { dirname, resolve } from 'node:path';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { loadBodyConfig } from './config.js';
import { formatAgentCommand } from './agent-command.js';
import { LEGACY_ACCESS_POLICY } from './access-policy.js';
import { applyRuntimeModelPreflight } from './runtime-model-validation.js';
import { ThinDaemonCore } from './thin-core.js';
import { activateDaemonTransport } from './daemon-api-client.js';
import {
  findAgentRuntimeConfigPaths,
  migrateRuntimeRecordAccessPolicy,
  readRuntimeRecord,
  removeAgentRuntime,
  resolveRuntimeConfigPath,
  runtimeAgentCommand,
  stopRuntimeDaemon,
} from './runtime.js';
import { runStartCommand } from './start-command.js';
import { runConnectCommand, runConnectFinishCommand } from './connect-command.js';
import { runUpdateCommand } from './self-update-cli.js';
import { detectBwrapSandbox } from './bwrap-sandbox.js';
import {
  activeReleaseId,
  beelineInstallLayout,
  describeIdentity,
  readInstalledBundleIdentity,
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
} from './systemd.js';
import {
  coordinateManagedUpdateHandoff,
  gateManagedSuccessor,
  ManagedUpdateHandoff,
  rollbackFailedSuccessor,
  runningRuntimeProbeIds,
  runManagedUpdateWorker,
} from './managed-update.js';
import { runUpdateFunctionalProbe } from './update-functional-probe.js';
import { reportUpdateRollback, queueUpdateRollbackAlert } from './update-rollback-alert.js';
import { writeDaemonReleaseStatus } from './release-status.js';

function usage(exitCode = 1): void {
  console.error(`
${pc.bold('Beeline — thin Room agent.')}

${pc.dim('Usage:')}
  beeline connect [XXXXXXXX-XXXXXXXX]       Install and connect an app-authorized agent
  beeline start [agent-pubkey]              Start — or RESTART when already running,
                                            stopping cleanly after in-flight work —
                                            this repo's (or, outside a repo, this
                                            host's) durable agent
  beeline start --agent <agent-pubkey>      Same, from anywhere (no repo needed)
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
  const agent = runtimeAgentCommand(runtime);
  await writeFile(resolve(dirname(configPath), 'daemon.pid'), `${process.pid}\n`, { mode: 0o600 });
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
    await applyRuntimeModelPreflight(config, agent, runtime.modelSelection);
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
  // OS sandbox for every ACP child (`bwrap-sandbox.ts`). Detected exactly once
  // here, at daemon start, so an unusable bwrap costs one advisory line rather
  // than a failed spawn per session — and so the operator learns the state of
  // the boundary before any Room comes online.
  const sandbox = detectBwrapSandbox({ ...(runtime.sandbox ? { policy: runtime.sandbox } : {}) });
  if (sandbox.path) config.bwrapPath = sandbox.path;
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
    loadedReleaseIdentity = await readInstalledBundleIdentity(layout);
    config.daemonReleaseVersion = loadedReleaseIdentity?.version;
    config.daemonSourceSha = loadedReleaseIdentity?.commit;
    update = await ManagedUpdateHandoff.create(layout, runtimeDir, Date.now, {
      requiredProbeIds: [...(await runningRuntimeProbeIds(process.env)), runtime.agent.publicKey],
    });
  }

  console.log(
    `[beeline] thin daemon core ${runtime.communityId} starting with ${runtime.rooms.length} Room binding(s)`,
  );
  console.log(`[body] agent binary: ${formatAgentCommand(agent)}`);
  console.log(`[body] ${sandbox.advisory}`);

  let ready = false;
  let stoppingStatus = 'daemon stopped';
  try {
    const core = new ThinDaemonCore(runtime, configPath, config, { daemonApi });
    const result = await core.run({
      signal: controller.signal,
      onEstablished: async () => {
        let functionalProof: Awaited<ReturnType<typeof runUpdateFunctionalProbe>> | undefined;
        if (layout && pendingSuccessor) {
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
              }),
          });
          if (gate.kind === 'failed') {
            successorRolledBack = gate.rolledBack;
            throw gate.error;
          }
          functionalProof = gate.proof;
          pendingSuccessor = false;
          console.log(
            `[thin-core] successor functional probe passed on exact release ${loadedRelease}: ` +
              `${functionalProof?.harness ?? 'unknown'} session/new + turn`,
          );
        }
        await clearDaemonStartFailures(runtimeDir);
        await writeDaemonReleaseStatus(runtimeDir, runtime.agent.publicKey, loadedReleaseIdentity);
        await notifier.ready(`ready; loaded_release=${loadedRelease ?? 'development'}`);
        ready = true;
      },
      onProgress: async (status) => {
        void drainRollbackAlert(core.activeRoomIds()[0] ?? runtime.rooms[0]?.channelId);
        // The watchdog heartbeat is coupled to this completed progress tick.
        await notifier.progress(`loaded_release=${loadedRelease ?? 'development'}; ${status}`);
        if (!update) return;
        await coordinateManagedUpdateHandoff(
          update,
          () => core.quiesceForUpdateIfIdle(),
          async ({ desiredRelease, drainDeadlineAt }) => {
            if (Date.now() >= drainDeadlineAt) await core.prepareForForcedUpdateRestart();
            core.setDrainDeadlineAt(drainDeadlineAt);
            stoppingStatus =
              `update pending, converging; loaded_release=${loadedRelease ?? 'unknown'}; ` +
              `desired_release=${desiredRelease}; active work drained; ` +
              `intake quiesced; exit_deadline=${new Date(drainDeadlineAt).toISOString()}`;
            await notifier.stopping(stoppingStatus);
            controller.abort();
          },
          async ({ desiredRelease, drainDeadlineAt }) => {
            await notifier.progress(
              `loaded_release=${loadedRelease ?? 'unknown'}; update ready; ` +
                `active agent work is still running; handoff deferred; ` +
                `desired_release=${desiredRelease}; exit_deadline=${new Date(drainDeadlineAt).toISOString()}`,
            );
          },
        );
      },
    });
    if (result === 'agent-removed') {
      controller.abort();
      const archivedRuntime = await removeAgentRuntime(runtime);
      if (process.env.BEELINE_MANAGED_BY_SYSTEMD === '1') {
        await disableAgentService(runtime.agent.publicKey, { stop: false }).catch((error) =>
          console.error('[thin-core] could not disable deliberately removed unit:', error),
        );
      }
      process.exitCode = DELIBERATE_REMOVAL_EXIT_STATUS;
      console.log(
        `[beeline] agent ${runtime.agent.publicKey} removed; runtime archived at ${archivedRuntime}`,
      );
    }
  } catch (error) {
    const rolledBack =
      successorRolledBack ||
      (layout && pendingSuccessor && !ready && (await rollbackFailedSuccessor(layout, runtimeDir)));
    if (rolledBack) {
      console.error('[thin-core] successor failed before READY; previous release restored once');
      const alertRoom = runtime.rooms[0]?.channelId;
      await drainRollbackAlert(alertRoom);
    }
    throw error;
  } finally {
    await notifier.stopping(stoppingStatus).catch(() => undefined);
    // Only clear the pid file while it still names THIS process — a
    // self-update handover has already written the replacement's pid there.
    const pidPath = resolve(dirname(configPath), 'daemon.pid');
    const recorded = Number((await readFile(pidPath, 'utf8').catch(() => '')).trim());
    if (recorded === process.pid) {
      await unlink(pidPath).catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const command = args[0];
  if (command === '--help' || command === '-h') usage(0);

  if (command === 'managed-update-worker') {
    if (process.env.BEELINE_INTERNAL_UPDATE_WORKER !== '1') {
      throw new Error('managed-update-worker is an internal command');
    }
    console.log(JSON.stringify(await runManagedUpdateWorker()));
    return;
  }

  if (command === 'connect') {
    await runConnectCommand(args[1]);
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

  // Parse optional flags.
  const llmEnvFile = process.env.BUZZY_BODY_LLM_FILE;
  const workspaceRoot = process.env.BUZZY_BODY_WORKSPACE ?? './body-workspace';

  if (command === '--version' || command === 'version') {
    const config = loadBodyConfig({ workspaceRoot, llmEnvFile });
    console.log(pc.bold('beeline 0.0.0'));
    const layout = beelineInstallLayout(process.env);
    if (layout) {
      const identity = await readInstalledBundleIdentity(layout);
      const active = await activeReleaseId(layout);
      console.log(
        `${pc.dim('installed bundle:')} ${describeIdentity(identity)}${active ? ` (release ${active})` : ''}`,
      );
    }
    console.log(`${pc.dim('[body] agent binary:')} ${config.agentCommand ?? config.agentBinary}`);
    console.log(`${pc.dim('[body] mcp binary:')} ${config.mcpBinary}`);
    console.log(`${pc.dim('[body] read-only mcp:')} ${config.readonlyMcpCommand}`);
    return;
  }

  if (command === 'daemon') {
    const configFlag = args.indexOf('--config');
    const agentFlag = args.indexOf('--agent');
    let configPath = configFlag >= 0 ? args[configFlag + 1] : undefined;
    const agentPubkey = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
    if (!configPath && agentPubkey) {
      const configs = await findAgentRuntimeConfigPaths(process.env, process.cwd());
      configPath = configs.find((candidate) => dirname(candidate).endsWith(agentPubkey));
    }
    if (!configPath && agentPubkey) {
      throw new DaemonExitError(
        `unknown agent ${agentPubkey}: no durable runtime exists; refusing systemd restart loop`,
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
  // release that cannot reach READY rolls back once; systemd starts the
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
