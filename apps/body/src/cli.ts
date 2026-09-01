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
import { existsSync } from 'node:fs';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { loadBodyConfig } from './config.js';
import { formatAgentCommand } from './agent-command.js';
import { LEGACY_ACCESS_POLICY } from './access-policy.js';
import { DEFAULT_AGENT_IDENTITY_NAME, DEFAULT_BODY_IDENTITY_NAME } from '@beeline/buzz-client';
import { applyRuntimeModelPreflight } from './runtime-model-validation.js';
import { withSpinner } from './clack-support.js';
import { readOperatorMcpServers } from './operator-mcp.js';
import { Body } from './body.js';
import { runCornerGitCredentialCommand } from './corner-git-credential.js';
import { ThinDaemonCore } from './thin-core.js';
import { activateDaemonTransport, type DaemonApiClient } from './daemon-api-client.js';
import {
  findAgentRuntimeConfigPaths,
  identityFromKey,
  migrateRuntimeRecordAccessPolicy,
  readRuntimeRecord,
  removeAgentRuntime,
  resolveRuntimeConfigPath,
  runtimeAgentCommand,
  stopRuntimeDaemon,
  type AgentRuntimeRecord,
} from './runtime.js';
import { runRelayCommand } from './relay-command.js';
import { runStartCommand } from './start-command.js';
import { runPairCommand } from './pair-command.js';
import { runConnectCommand, runConnectFinishCommand } from './connect-command.js';
import { runMissionScaffoldCommand } from './mission-scaffold-command.js';
import { runUpdateCommand } from './self-update-cli.js';
import { migrateLegacyRepositoryPaths } from './repository-truth.js';
import { detectBwrapSandbox } from './bwrap-sandbox.js';
import { trustySquireConfigRootForRuntimeConfig } from './trusty-squire-storage.js';
import { DurableBodyState } from './durable-state.js';
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
import {
  dailyAgentSpend,
  dailyRestartReprimes,
  formatAgentSpendReport,
  formatReprimeReport,
  type ModelTurnSpend,
  type SessionReprimeRecord,
} from './model-spend.js';
import { writeDaemonReleaseStatus } from './release-status.js';

function usage(exitCode = 1): void {
  console.error(`
${pc.bold('Beeline Body — agent session manager.')}

${pc.dim('Usage:')}
  beeline provision <channel-uuid>          Attach read-only agent to a TLC
  beeline serve <channel-uuid> <owner> <repo>  Internal: serve one explicitly-wired Room
  beeline open <channel-uuid> <owner> <repo>  Open subchannel + edit session
  beeline archive <subchannel-uuid>         Archive subchannel
  beeline pair <BUZZ-XXXX-XXXX> [options]   Pair an agent (optionally to this repo)
                                            and start its durable daemon
  beeline connect                           Install and connect an agent through the browser
  beeline start [agent-pubkey]              Start — or RESTART when already running,
                                            stopping cleanly after in-flight work —
                                            this repo's (or, outside a repo, this
                                            host's) durable agent
  beeline start --agent <agent-pubkey>      Same, from anywhere (no repo needed)
  beeline stop --agent <agent-pubkey>       Stop and disable the supervised agent
  beeline relay set <url> [--agent <pubkey>|--all]
                                            Repoint stored runtime(s) and restart cleanly
  beeline update [--check|--status|--rollback|--force]
                                            Self-update the installed bundle
  beeline spend [--day YYYY-MM-DD] [--agent <pubkey>] [--json]
                                            Calls/tokens, causal turns, and restart re-primes
  beeline corner-git-credential (internal)  Git credential helper: read-only repo token for corners
  beeline mission-scaffold <dir> [options]  Write the three-file mission convention into an
                                            existing dir; never overwrites existing files
                                            (--name --objective --principal --chief)

${pc.dim('Options:')}
  --workspace-root <path>   Agent workspace (default: ./body-workspace)
  --llm-env-file <path>     Path to LLM credentials env file
  --agent-key <nsec>        Agent Nostr secret (hex or nsec)

All other config via env vars (see config.ts).
`);
  process.exit(exitCode);
}

function pairUsage(): void {
  console.log(`
${pc.bold('Pair this repository and start its durable Room agent(s).')}

${pc.dim('Usage:')}
  beeline pair <BUZZ-XXXX-XXXX> [--agent <codex|claude|goose|pi|grok|reference|custom>]
               [--agent-command '<command> [args...]'] [--repo <path>]
               [--access <everyone|creator|allowlist>] [--allow <npub-or-hex,...>]
               [--auto-response '<text>']
               [--mcp <capability[,capability...]>]
               [--share-skill <name[,name...]>]
               [--model <model>] [--effort <level>] [--use-env-key]

  beeline pair <CODE1> <CODE2> ... --agents <kind1,kind2,...> [--repo <path>]
               [--access <everyone|creator|allowlist>] [--allow <npub-or-hex,...>]
               [--auto-response '<text>']
               [--mcp <capability[,capability...]>]
               [--share-skill <name[,name...]>]
               [--model <model>] [--effort <level>]

Agent choices:
  codex      Operator's Codex through the codex-acp adapter
  claude     Operator's Claude Code through a Claude ACP adapter
  goose      Operator's Goose through its native 'goose acp' server
  pi         Operator's Pi through the pi-acp adapter
  grok       Operator's Grok through its native 'grok agent stdio' ACP server
  reference  Bundled buzz-agent (explicit fallback; requires an LLM key)
  custom     Explicit ACP command supplied with --agent-command

Cursor has no native ACP mode. To drive it, install the Cursor CLI
(curl -fsSL https://cursor.com/install | sh), log in with \`cursor-agent login\`,
install the community bridge (npm install -g cursor-acp), and pair with
\`--agent custom --agent-command 'cursor-acp'\`.

With no --agent flag, beeline detects supported installed coding agents. Missing
ACP adapters stay visible and can be installed when selected on a terminal. In a
non-interactive session, beeline prints the manual adapter install command and
never installs packages automatically. Several ready matches require --agent.

Multiple runtimes in one Workspace: pass one single-use pairing code per agent
plus a matching --agents list. Each agent gets its own fresh keypair/identity
and its own daemon — three distinct agents live in one Room, each addressed by
its own @-mention. Pairing ignores BUZZ_AGENT_KEY/BUZZ_PRIVATE_KEY and always
mints a fresh agent identity by default.

--use-env-key (single-agent pairing only): the rare deliberate exception —
reuse the ambient BUZZ_AGENT_KEY/BUZZ_PRIVATE_KEY as this agent's identity
instead of minting a fresh one. Requires one of those env vars to be set;
cannot be combined with --agents.

Repository (optional): a repository belongs to a ROOM, not to an agent.
Pairing never infers one from the current directory. Without --repo, the agent
is paired with no repository and materializes each Room's existing binding on
demand. --repo <path> is the explicit opt-in for creating or joining that
repository's Room during pairing; it works from any cwd and must name a git
repository.
There is no way to infer an existing Room's bound repository from the pairing
code alone (pairing codes are Workspace-scoped, not Room-scoped) — pass --repo
to create/join that repository's Room at pair time from any directory.

Model / effort: sets this agent's default before any human picks one in the
app (#223's in-app picker always overrides once set). Checked against the
agent's own live advertised catalog at pair time — an unknown model or effort
is refused with a clear error, not silently launched. In the --agents form,
--model/--effort apply identically to every agent being paired, matching
--access/--auto-response's existing convention (each agent still gets its own
catalog check, so a value invalid for one harness fails that harness only if
paired alone; the whole command aborts on the first invalid pairing).

Interactive: with neither flag and a real terminal on both ends, beeline asks
you to pick a model and effort/thinking level from that agent's own live
catalog (current default pre-selected — press enter to keep it) instead of
requiring the flags. A non-terminal session (script, CI) never blocks on this;
it just proceeds with no default, same as before this existed.

Access policy (per agent, set here at invite time):
  everyone  any Room member may address the agent
  creator   only the inviting owner may; anyone else gets the auto-response
  allowlist only identities named by --allow may address it; creator is not implicit

External MCP capabilities: --mcp squire-credential-use and --mcp squire-app-access are independent.
Account capabilities require --access creator and are mounted from a built-in
profile; pass a comma-separated list to opt into both. Beeline never imports
the operator's other personal MCP servers.

Skills: every agent receives only using-beeline and mission-brief by default.
--share-skill adds exact names from the operator-owned ~/.agents/skills directory
to this agent's runtime record. It never imports the rest of that directory.

Interactive: on a real TTY, --access/--auto-response missing their flags are
also offered as clack pickers (in that order, right after model/effort) —
enter keeps everyone/the default auto-response. A non-terminal session never
blocks on this; it proceeds with the everyone default, same as before.

Examples:
  beeline pair BUZZ-XXXX-XXXX --agent codex
  beeline pair BUZZ-XXXX-XXXX --agent claude --access creator
  beeline pair BUZZ-XXXX-XXXX --repo /path/to/repo --agent claude --model sonnet --effort high
  beeline pair BUZZ-AAAA-AAAA BUZZ-BBBB-BBBB BUZZ-CCCC-CCCC --agents claude,codex,pi
  beeline pair BUZZ-XXXX-XXXX --agent custom --agent-command 'my-agent serve --acp'
`);
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
  let { runtime } = await migrateLegacyRepositoryPaths(accessMigration.runtime, {
    log: console.log,
  });
  let daemonApi: DaemonApiClient | undefined;
  if (runtime.transport) {
    const activated = await activateDaemonTransport(configPath);
    if (!activated) throw new Error('monolith daemon transport activation failed');
    runtime = activated.runtime;
    daemonApi = activated.client;
  }
  const agent = runtimeAgentCommand(runtime);
  await writeFile(resolve(dirname(configPath), 'daemon.pid'), `${process.pid}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUZZ_AGENT_BIN: agent.command,
    BUZZ_DEV_MCP_BIN: runtime.mcpBinary,
    BUZZY_RELAY_URL: runtime.relayBaseUrl,
    ...(runtime.relayHost ? { BUZZY_RELAY_HOST: runtime.relayHost } : {}),
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
  // Operator-authored MCP tool servers for corners (`operator-mcp.json` in the
  // runtime directory — the same directory `runtimeDir` below derives). Read
  // at daemon start so editing the file takes effect on the next daemon
  // restart, like the rest of the runtime record.
  config.operatorMcpServers = readOperatorMcpServers(dirname(configPath));
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
  config.squireConfigRoot = trustySquireConfigRootForRuntimeConfig(configPath);
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
    update = await ManagedUpdateHandoff.create(layout, runtimeDir, Date.now, {
      requiredProbeIds: [...(await runningRuntimeProbeIds(process.env)), runtime.agent.publicKey],
    });
  }

  console.log(
    `[buzz] thin daemon core ${runtime.communityId} starting with ${runtime.rooms.length} Room binding(s)`,
  );
  console.log(`[body] agent binary: ${formatAgentCommand(agent)}`);
  console.log(`[body] ${sandbox.advisory}`);

  let ready = false;
  let stoppingStatus = 'daemon stopped';
  try {
    const core = new ThinDaemonCore(runtime, configPath, config, {
      ...(daemonApi ? { daemonApi } : {}),
    });
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
              `${functionalProof?.harness ?? 'unknown'} session/new + turn + read_mandate`,
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
      const archivedRuntime = await removeAgentRuntime(
        configPath,
        runtime.agent.publicKey,
        runtime.rooms.map((room) => room.repo.gitCommonDir),
      );
      if (process.env.BEELINE_MANAGED_BY_SYSTEMD === '1') {
        await disableAgentService(runtime.agent.publicKey, { stop: false }).catch((error) =>
          console.error('[thin-core] could not disable deliberately removed unit:', error),
        );
      }
      process.exitCode = DELIBERATE_REMOVAL_EXIT_STATUS;
      console.log(
        `[buzz] agent ${runtime.agent.publicKey} removed; runtime archived at ${archivedRuntime}`,
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

async function runtimeSpendStatePaths(
  configPath: string,
  runtime: AgentRuntimeRecord,
): Promise<string[]> {
  const paths = new Set<string>();
  const runtimeRoot = dirname(configPath);
  for (const room of runtime.rooms) {
    paths.add(
      resolve(room.root ?? resolve(runtimeRoot, 'rooms', room.channelId), 'body-state.json'),
    );
  }
  const roomsRoot = resolve(runtimeRoot, 'rooms');
  const entries = await readdir(roomsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) paths.add(resolve(roomsRoot, entry.name, 'body-state.json'));
  }
  return [...paths];
}

async function runSpendCommand(args: string[]): Promise<void> {
  const dayFlag = args.indexOf('--day');
  const agentFlag = args.indexOf('--agent');
  const day = dayFlag >= 0 ? args[dayFlag + 1] : new Date().toISOString().slice(0, 10);
  const agent = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('spend --day requires YYYY-MM-DD');
  }
  if (agentFlag >= 0 && !agent) throw new Error('spend --agent requires an agent pubkey');
  const allowed = new Set(['spend', '--json', '--day', '--agent', day, ...(agent ? [agent] : [])]);
  const unknown = args.find((value) => !allowed.has(value));
  if (unknown) throw new Error(`unknown spend option: ${unknown}`);

  const configs = [...new Set(await findAgentRuntimeConfigPaths(process.env, process.cwd()))];
  const turns: ModelTurnSpend[] = [];
  const reprimes: SessionReprimeRecord[] = [];
  const visitedStates = new Set<string>();
  for (const configPath of configs) {
    const runtime = await readRuntimeRecord(configPath);
    if (agent && runtime.agent.publicKey !== agent) continue;
    const statePaths = await runtimeSpendStatePaths(configPath, runtime);
    for (const statePath of statePaths) {
      if (!existsSync(statePath) || visitedStates.has(statePath)) continue;
      visitedStates.add(statePath);
      const state = new DurableBodyState(statePath);
      turns.push(...(await state.modelTurns()));
      reprimes.push(...(await state.sessionReprimes()));
    }
  }
  const spendReport = dailyAgentSpend(turns, day);
  const reprimeReport = dailyRestartReprimes(reprimes, day);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ spend: spendReport, reprimes: reprimeReport }, null, 2));
  } else {
    console.log(`${formatAgentSpendReport(spendReport)}\n${formatReprimeReport(reprimeReport)}`);
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
    await runConnectCommand();
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
  const agentPrivateKey = process.env.BUZZ_AGENT_KEY ?? process.env.BUZZ_PRIVATE_KEY;

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

  if (command === 'spend') {
    await runSpendCommand(args);
    return;
  }

  // Git credential-helper backend wired into corner sessions for private-repo
  // reads and writes (`corner-read-token.ts`). Non-interactive by construction:
  // git is never a human at a keyboard. Mints are pinned to the Room's exact
  // GitHub App repository grant; branch protection remains GitHub's boundary.
  if (command === 'corner-git-credential') {
    process.exitCode = await runCornerGitCredentialCommand(args.slice(1));
    return;
  }

  if (command === 'relay') {
    await runRelayCommand(args);
    return;
  }

  // Mission Charter v2 M1: deterministic three-file mission scaffold. Pure
  // local file generation — no provisioning, binding, relay access, or landing.
  if (command === 'mission-scaffold') {
    process.exitCode = await runMissionScaffoldCommand(args.slice(1));
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
    console.log(`[buzz] agent ${runtime.agent.publicKey} disabled; graceful stop requested`);
    return;
  }

  if (command === 'pair') {
    if (args.length === 2 && (args[1] === '--help' || args[1] === '-h')) {
      pairUsage();
      return;
    }
    await runPairCommand(args, llmEnvFile, agentPrivateKey);
    return;
  }

  // Load body config.
  const config = loadBodyConfig({
    workspaceRoot,
    llmEnvFile,
  });

  // Create body identity (operator key or fresh).
  const bodyKey = process.env.BUZZ_BODY_KEY;
  const bodyIdentity = identityFromKey(bodyKey, DEFAULT_BODY_IDENTITY_NAME);
  const agentIdentity = identityFromKey(agentPrivateKey, DEFAULT_AGENT_IDENTITY_NAME);

  const body = new Body(config, bodyIdentity, agentIdentity);

  console.log(`[body] identity pubkey: ${body.identity.publicKey}`);
  console.log(`[body] agent pubkey: ${body.agent.publicKey}`);
  console.log(`[body] workspace root: ${config.workspaceRoot}`);
  console.log(
    `[body] agent binary: ${formatAgentCommand({
      kind: config.agentKind ?? 'reference',
      command: config.agentCommand ?? config.agentBinary,
      args: config.agentArgs ?? [],
    })}`,
  );
  console.log(`[body] mcp binary: ${config.mcpBinary}`);
  console.log(`[body] read-only mcp: ${config.readonlyMcpCommand}`);
  console.log(`[body] relay: ${config.relayWsUrl}`);

  try {
    switch (command) {
      case 'provision': {
        const channelId = args[1]!;
        if (!channelId) {
          usage();
          return;
        }
        const session = await withSpinner(
          interactiveUi,
          `Provisioning ${channelId}…`,
          'Provisioned.',
          () => body.provision(channelId),
        );
        console.log(`[body] provisioned: session=${session.sessionId} mode=${session.mode}`);
        break;
      }

      case 'open': {
        const channelId = args[1]!;
        const ownerHex = args[2]!;
        const repo = args[3]!;
        if (!channelId || !ownerHex || !repo) {
          usage();
          return;
        }
        const info = await withSpinner(
          interactiveUi,
          `Opening a corner on ${repo}…`,
          'Corner opened.',
          () => body.openSubchannel(channelId, { ownerHex, repo }),
        );
        console.log(`[body] subchannel opened: id=${info.subchannelId}`);
        console.log(`[body]   worktree: ${info.worktreePath}`);
        console.log(`[body]   branch: ${info.featureBranch}`);
        console.log(`[body]   session: ${info.session.sessionId}`);
        break;
      }

      case 'serve': {
        const channelId = args[1]!;
        const ownerHex = args[2]!;
        const repo = args[3]!;
        if (!channelId || !ownerHex || !repo) {
          usage();
          return;
        }
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        console.log(
          `${pc.dim('[body] watching channel requests addressed to agent')} ${body.agent.publicKey}`,
        );
        await body.runChannelLoop(
          channelId,
          { ownerHex, repo, targetBranch: 'refs/heads/main' },
          { signal: controller.signal },
        );
        break;
      }

      case 'archive': {
        const subchannelId = args[1]!;
        if (!subchannelId) {
          usage();
          return;
        }
        await withSpinner(interactiveUi, `Archiving ${subchannelId}…`, 'Archived.', () =>
          body.archiveSubchannel(subchannelId),
        );
        console.log(`[body] archived: subchannel=${subchannelId}`);
        break;
      }

      default:
        usage();
    }
  } finally {
    await body.dispose();
  }
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
