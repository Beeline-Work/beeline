import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { loadBodyConfig } from './config.js';
import { formatAgentCommand } from './agent-command.js';
import { LEGACY_ACCESS_POLICY } from './access-policy.js';
import {
  applyRuntimeModelPreflight,
  resolvePreflightModelSelection,
} from './runtime-model-validation.js';
import { syncAgentModelCatalog } from './model-catalog-sync.js';
import {
  AgentSignIn,
  agentSignInHarness,
  answerAgentSignInFrame,
  reportAgentSignInResult,
} from './agent-sign-in.js';
import { ConnectorAssignmentLoop } from './connector-assignments.js';
import { RegistryMcpHostBroker, registryMcpBrokerSocketPath } from './registry-mcp.js';
import { BrowserShareHost, browserShareHostPath } from './browser-share-host.js';
import { ThinDaemonCore } from './thin-core.js';
import { AgentLifecycle, retryBeforeReady, type AgentExitReason } from './helper-lifecycle.js';
import { migrateLegacyDaemonTransport } from './legacy-daemon-migration.js';
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
import type { BeelineInstallLayout } from './self-update.js';
import type { InstalledBundleIdentity } from './self-update-manifest.js';
import { clearDaemonStartFailures } from './daemon-failure.js';
import { extendSystemdStartTimeout } from './systemd.js';
import type { MachineLink } from './machine-link.js';

/** What the machine helper needs from one agent it hosts. */
export interface HostedAgent {
  readonly agentId: string;
  readonly runtimeDir: string;
  readonly lifecycle: AgentLifecycle;
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
  progress(agentId: string, status: string, fault?: unknown): void;
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
): Promise<AgentExitReason> {
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
    runtime = await migrateLegacyDaemonTransport(configPath);
  }
  const activated = await activateDaemonTransport(
    configPath,
    fetch,
    host.machineLink(runtime.transport!.baseUrl),
  );
  if (!activated) throw new Error('monolith daemon transport activation failed');
  runtime = activated.runtime;
  const agentId = runtime.agent.publicKey;
  const daemonApi = activated.client;
  const loadedReleaseIdentity = host.loadedReleaseIdentity;
  if (host.layout)
    daemonApi.setHelperIdentity({
      releaseVersion: loadedReleaseIdentity?.version,
      sourceSha: loadedReleaseIdentity?.commit,
    });
  // Startup preflight is already a daemon request. A supported successor
  // must identify itself before it can trip the minimum-version gate.
  daemonApi.setForceUpdateListener((minVersion) => host.requestForceUpdate(minVersion));
  // A Room pins its adapter into its Workspace before launch. Refreshing the
  // machine-global @latest install here could replace a sibling's live binary.
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
        ? {
            ...(result.model ? { model: result.model } : {}),
            ...(result.effort ? { effort: result.effort } : {}),
          }
        : undefined,
    )
    .catch(() => undefined);
  const preflightModelSelection = resolvePreflightModelSelection(
    runtime.modelSelection,
    serverModelSelection,
  );
  if (preflightModelSelection) {
    await applyRuntimeModelPreflight(config, agent, preflightModelSelection, undefined);
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
  const lifecycle = new AgentLifecycle({ controller });
  daemonApi.setAuthorityRefusalListener((fault) => {
    if (!controller.signal.aborted) host.progress(agentId, fault.message, fault);
  });
  signal.addEventListener('abort', abortFromHost, { once: true });
  if (signal.aborted) abortFromHost();

  if (host.layout) {
    config.daemonReleaseVersion = loadedReleaseIdentity?.version;
    config.daemonSourceSha = loadedReleaseIdentity?.commit;
  }

  console.log(
    `[beeline] agent ${agentId} in workspace ${runtime.communityId} starting with ${runtime.rooms.length} Room binding(s)`,
  );
  console.log(`[body] agent binary: ${formatAgentCommand(agent)}`);
  console.log(`[body] ${sandbox.advisory}`);

  let privateStorageTimer: ReturnType<typeof setInterval> | undefined;
  let discoveryReady = false;
  const markEstablished = () => {
    if (controller.signal.aborted || !discoveryReady || !daemonApi.channel.isOpen()) return;
    host.established(agentId);
    host.progress(agentId, 'machine registered; discovery ready');
  };
  daemonApi.setChannelStateListener((connected, refusal) => {
    if (controller.signal.aborted) return;
    if (connected) markEstablished();
    else if (refusal) {
      const auth = refusal === 'daemon_token_required' || refusal === 'unauthorized';
      host.progress(
        agentId,
        `degraded: machine registration refused: ${refusal}`,
        new DaemonApiError(
          `machine registration refused: ${refusal}`,
          auth ? 401 : 400,
          false,
          refusal,
        ),
      );
    } else host.progress(agentId, 'degraded: machine link reconnecting');
  });
  let connectorLoop: ConnectorAssignmentLoop | undefined;
  let agentSignIn: AgentSignIn | undefined;
  let registryMcpBroker: RegistryMcpHostBroker | undefined;
  let browserShareHost: BrowserShareHost | undefined;
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
  let exitReason: AgentExitReason | undefined;
  try {
    // Credential activation and interruption replay precede every intake.
    await retryBeforeReady(() => reportInterruptedTurns(runtimeDir, daemonApi, agentId), {
      onLinkOpen: (listener) => daemonApi.onLiveOpen(listener),
      extendStartTimeout: extendSystemdStartTimeout,
      signal: controller.signal,
    });
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
      registryMcpBrokerSocketPath(config.operatorHome, agentId),
    );
    await registryMcpBroker.start();
    config.registryMcpBrokerSocket = registryMcpBroker.socketPath;
    browserShareHost = new BrowserShareHost(
      browserShareHostPath(process.env.XDG_STATE_HOME ?? config.operatorHome ?? homedir(), agentId),
    );
    await browserShareHost.start();
    config.browserShareHostSocket = browserShareHost.socketPath;
    let lifecycleRestart: Promise<void> | undefined;
    const core = new ThinDaemonCore(runtime, configPath, config, {
      daemonApi,
      onConfigChanged: refreshCatalog,
      onRestartRequested: () => {
        // `/restart` cancels at once, and takes over an update still waiting.
        if (lifecycleRestart || !lifecycle.quiesce('restart')) return;
        lifecycleRestart = (async () => {
          const cancelled = await core.cancelActiveWorkForRestart();
          host.progress(
            agentId,
            cancelled
              ? 'restart requested; active work cancelled'
              : 'restart requested; no active work',
          );
          lifecycle.stop('restart-requested');
        })().catch((error) => {
          console.error('[thin-core] requested restart failed:', error);
          lifecycle.stop('restart-requested');
        });
      },
    });
    // The existing six-hour local-disk timer now reclaims whole unused objects
    // from previously confirmed lifecycle facts. It makes no server reads.
    privateStorageTimer = setInterval(() => {
      void core.reclaimKnownPrivateStorage().catch(error =>
        console.error('[body] private storage cleanup deferred:', error));
    }, 6 * 60 * 60_000);
    privateStorageTimer.unref();
    leaveHost = host.attach({ agentId, runtimeDir, lifecycle, core });
    daemonApi.setForceUpdateListener((minVersion) => host.requestForceUpdate(minVersion));
    daemonApi.setHelperReleaseListener(({ version, sha }) => {
      host.notifyReleaseAvailable(`${version}:${sha}`);
      void host.tickUpdate();
    });
    core.setInteractiveIdleListener(() => {
      void host.tickUpdate();
    });
    const result = await core.run({
      signal: controller.signal,
      onEstablished: async () => {
        await clearDaemonStartFailures(runtimeDir);
        discoveryReady = true;
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
        // The connector work queue drains on the live Connect push.
        // One loop per agent also handles reconnects.
        connectorLoop ??= new ConnectorAssignmentLoop({
          api: daemonApi,
          agentId,
          registryHome: config.operatorHome,
          log: (message) => console.log(`[body] connector: ${message}`),
        });
        daemonApi.setConnectorAssignmentListener(() => connectorLoop?.wake());
        void readMachineId(process.env)
          .then(({ machineId, machineName }) =>
            daemonApi.execute('postAgentMachineReport', { machineId, machineName }))
          .catch((error) => console.warn('[body] machine report failed:', error))
          .finally(() => connectorLoop?.start());
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
            onSignedIn: () => daemonApi.emitConfigChanged(),
          });
          const signIn = agentSignIn;
          daemonApi.setAgentSignInListener((frame) => {
            void answerAgentSignInFrame(daemonApi, agentId, signIn, frame, cards, log);
          });
        }
      },
      onProgress: async (status, fault) => {
        if (!controller.signal.aborted)
          host.progress(
            agentId,
            daemonApi.channel.isOpen() ? status : 'degraded: machine link reconnecting',
            fault,
          );
        await host.tickUpdate();
      },
    });
    if (result === 'agent-removed') {
      controller.abort();
      exitReason = 'agent-removed';

    }
  } finally {
    signal.removeEventListener('abort', abortFromHost);
    leaveHost?.();
    clearInterval(privateStorageTimer);
    connectorLoop?.stop();
    agentSignIn?.stop();
    await registryMcpBroker?.stop();
    await browserShareHost?.stop();
    daemonApi.closeLive();
    // Only clear the pid record while it still names THIS process.
    await clearDaemonPidRecordIfPid(configPath, process.pid);
  }
  if (exitReason === 'agent-removed') {
    await retireRemovedAgent(runtime);
    console.log(`[beeline] agent ${agentId} removed; private storage reclaimed or deferred while in use`);
  }
  return exitReason ?? lifecycle.stopReason ?? 'stopped';
}

/** The force-update journal entries for one hosted agent. */
export function interruptHostedAgent(agent: HostedAgent): InterruptedTurn[] {
  agent.lifecycle.quiesce('force-update');
  agent.core.setDrainDeadlineAt(Date.now() + 60_000);
  return agent.core.interruptForServerMinimum();
}
