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
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { loadBodyConfig, BASE_URL } from './config.js';
import { formatAgentCommand, type AgentCommand, type AgentKind } from './agent-command.js';
import { selectPairAgentCommand } from './pair-agent-selection.js';
import {
  DEFAULT_ACCESS_POLICY,
  isAgentAccessPolicy,
  LEGACY_ACCESS_POLICY,
  type AgentAccessPolicy,
} from './access-policy.js';
import {
  decodeNpub,
  DEFAULT_AGENT_IDENTITY_NAME,
  DEFAULT_BODY_IDENTITY_NAME,
} from '@beeline/buzz-client';
import { validateAgentModelSelection } from './model-catalog.js';
import { applyRuntimeModelPreflight } from './runtime-model-validation.js';
import { pickModelAndEffort, resolveAccessSettings } from './agent-settings-prompts.js';
import { withSpinner } from './clack-support.js';
import { readOperatorMcpServers } from './operator-mcp.js';
import { Body } from './body.js';
import { runCornerGitCredentialCommand } from './corner-git-credential.js';
import { ThinDaemonCore } from './thin-core.js';
import {
  assertAgentNotPushAllowed,
  createRelayClient,
  newIdentity,
  type Identity,
} from '@beeline/gate';
import { createBuzzClient } from '@beeline/buzz-client';
import {
  assertAgentIdentityUnpaired,
  defaultSupervisorRoot,
  findAgentRuntimeConfigPaths,
  findRuntimeConfigPaths,
  identityFromKey,
  launchRuntimeDaemon,
  migrateRuntimeRecordAccessPolicy,
  mintAgentIdentityForPairing,
  pairRepositoryAgent,
  readRuntimeRecord,
  removeAgentRuntime,
  resolveRuntimeConfigPath,
  runtimeAgentCommand,
  runtimeDaemonPid,
  runtimeIdentity,
  selectRuntimeConfigPaths,
  stopRuntimeDaemon,
  tryInspectLocalRepository,
  type AgentRuntimeRecord,
  type LocalRepositoryBinding,
  type PairRuntimeResult,
} from './runtime.js';
import { runRelayCommand } from './relay-command.js';
import { startStoredRuntime } from './start-command.js';
import { runMissionScaffoldCommand } from './mission-scaffold-command.js';
import { runUpdateCommand } from './self-update-cli.js';
import { migrateLegacyRepositoryPaths } from './repository-truth.js';
import { detectBwrapSandbox } from './bwrap-sandbox.js';
import {
  isExternalMcpCapability,
  type ExternalMcpCapability,
} from './external-mcp-capabilities.js';
import { connectTrustySquireForPair } from './trusty-squire-onboarding.js';
import { isSharedSkillName, validateSharedSkills } from './agent-home.js';
import {
  trustySquireConfigRoot,
  trustySquireConfigRootForRuntimeConfig,
} from './trusty-squire-storage.js';
import { DurableBodyState } from './durable-state.js';
import {
  activeReleaseId,
  beelineInstallLayout,
  describeIdentity,
  readInstalledBundleIdentity,
  repairInstallForwarders,
  settlePendingUpdateOnStart,
} from './self-update.js';
import {
  DELIBERATE_REMOVAL_EXIT_STATUS,
  SystemdNotifier,
  disableAgentService,
  installAgentService,
} from './systemd.js';
import {
  coordinateManagedUpdateHandoff,
  gateManagedSuccessor,
  ManagedUpdateHandoff,
  readUpdateHandoff,
  rollbackFailedSuccessor,
  runningRuntimeProbeIds,
  runManagedUpdateWorker,
} from './managed-update.js';
import { runUpdateFunctionalProbe } from './update-functional-probe.js';
import {
  publishPendingUpdateRollbackAlert,
  queueUpdateRollbackAlert,
} from './update-rollback-alert.js';
import {
  dailyAgentSpend,
  dailyRestartReprimes,
  formatAgentSpendReport,
  formatReprimeReport,
  type ModelTurnSpend,
  type SessionReprimeRecord,
} from './model-spend.js';

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

const PAIRING_CODE_SHAPE = /^BUZZ-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
const INSTALL_AND_PAIR_COMMAND =
  'curl -fsSL https://usebeeline.app/install | sh && beeline pair BUZZ-XXXX-XXXX';

/**
 * Reject incomplete pairing invocations before even the terminal framing is
 * shown. Selecting an agent can load its live catalog and prompt for access,
 * so a missing or malformed code must never reach that work.
 */
function pairingCodeUsage(): never {
  console.error(`
${pc.bold('A pairing code matching BUZZ-XXXX-XXXX is required.')}

${pc.dim('Usage:')}
  beeline pair <BUZZ-XXXX-XXXX> [options]

${pc.dim('Install and pair:')}
  ${INSTALL_AND_PAIR_COMMAND}
`);
  process.exit(1);
}

function stableBeelineEntrypoint(): string {
  const layout = beelineInstallLayout(process.env);
  return layout ? resolve(layout.binDir, 'beeline') : resolve(process.argv[1]!);
}

interface PairOptions {
  codes: string[];
  kinds?: AgentKind[];
  singleKind?: AgentKind;
  customCommand?: string;
  repo?: string;
  /** Undefined means `--access` was omitted — the interactive flow (or the default) decides. */
  access?: AgentAccessPolicy;
  accessAllowlist?: string[];
  autoResponse?: string;
  model?: string;
  effort?: string;
  externalMcpCapabilities?: ExternalMcpCapability[];
  sharedSkills?: string[];
  /** The rare deliberate opt-in to reuse the ambient agent key instead of minting a fresh one. */
  useEnvKey?: boolean;
}

function parsePairOptions(args: string[]): PairOptions {
  // args[0] === 'pair'; positionals after it are pairing codes.
  const codes: string[] = [];
  let kinds: AgentKind[] | undefined;
  let singleKind: AgentKind | undefined;
  let customCommand: string | undefined;
  let repo: string | undefined;
  let access: AgentAccessPolicy | undefined;
  let accessAllowlist: string[] | undefined;
  let autoResponse: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let externalMcpCapabilities: ExternalMcpCapability[] | undefined;
  let sharedSkills: string[] | undefined;
  let useEnvKey = false;
  const flags = new Set([
    '--agent',
    '--agents',
    '--agent-command',
    '--repo',
    '--access',
    '--allow',
    '--auto-response',
    '--model',
    '--effort',
    '--mcp',
    '--share-skill',
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (!token.startsWith('--')) {
      codes.push(token);
      continue;
    }
    if (token === '--use-env-key') {
      useEnvKey = true;
      continue;
    }
    if (!flags.has(token)) throw new Error(`unknown beeline pair option: ${token}`);
    const value = args[index + 1];
    if (!value) throw new Error(`${token} requires a value`);
    index += 1;
    if (token === '--agent') singleKind = value as AgentKind;
    else if (token === '--agents')
      kinds = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean) as AgentKind[];
    else if (token === '--agent-command') customCommand = value;
    else if (token === '--repo') repo = value;
    else if (token === '--auto-response') autoResponse = value;
    else if (token === '--model') model = value;
    else if (token === '--effort') effort = value;
    else if (token === '--mcp') {
      const capabilities = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      const invalid = capabilities.find((capability) => !isExternalMcpCapability(capability));
      if (invalid) {
        throw new Error(
          `--mcp must contain only squire-credential-use or squire-app-access (got: ${invalid})`,
        );
      }
      externalMcpCapabilities = capabilities as ExternalMcpCapability[];
    } else if (token === '--share-skill') {
      const names = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      const invalid = names.find((name) => !isSharedSkillName(name));
      if (invalid) throw new Error(`--share-skill contains an invalid skill name: ${invalid}`);
      sharedSkills = [...new Set([...(sharedSkills ?? []), ...names])];
    } else if (token === '--access') {
      if (!isAgentAccessPolicy(value)) {
        throw new Error(`--access must be one of everyone|creator|allowlist (got: ${value})`);
      }
      access = value;
    } else if (token === '--allow') {
      const entries = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          if (/^[0-9a-fA-F]{64}$/.test(entry)) return entry.toLowerCase();
          if (entry.startsWith('npub1')) {
            try {
              return decodeNpub(entry);
            } catch {
              // Fall through to the single stable CLI error below.
            }
          }
          throw new Error(
            `--allow must contain only npub or 64-character hex keys (got: ${entry})`,
          );
        });
      accessAllowlist = [...new Set(entries)];
    }
  }
  if (kinds && (singleKind || customCommand)) {
    throw new Error('--agents cannot be combined with --agent or --agent-command');
  }
  if (kinds && useEnvKey) {
    throw new Error('--agents cannot be combined with --use-env-key');
  }
  if (access === 'allowlist' && !accessAllowlist?.length) {
    throw new Error('--access allowlist requires --allow <npub-or-hex,...>');
  }
  if (access !== 'allowlist' && accessAllowlist !== undefined) {
    throw new Error('--allow requires --access allowlist');
  }
  return {
    codes,
    ...(kinds ? { kinds } : {}),
    ...(singleKind !== undefined ? { singleKind } : {}),
    ...(customCommand !== undefined ? { customCommand } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(access !== undefined ? { access } : {}),
    ...(accessAllowlist !== undefined ? { accessAllowlist } : {}),
    ...(autoResponse !== undefined ? { autoResponse } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(externalMcpCapabilities?.length ? { externalMcpCapabilities } : {}),
    ...(sharedSkills?.length ? { sharedSkills } : {}),
    ...(useEnvKey ? { useEnvKey } : {}),
  };
}

/**
 * Resolve the OPTIONAL repository binding `beeline pair` records at pair
 * time. Only an explicit `--repo` creates a binding; cwd is process context,
 * never repository intent.
 *
 * `--repo` is an explicit statement of intent, so a path that doesn't exist
 * or isn't a git repository is fatal. A bare `beeline pair <code>` from a
 * non-repo directory is NOT — since room-owns-repo the repository is a
 * property of the Room, and an agent with no local repository serves
 * chat-only Rooms and materializes a Room's repository when one is bound.
 *
 * Both failures are raised here, up front, before any interactive question.
 */
function resolvePairRepository(repoFlag: string | undefined): {
  cwd: string;
  repo: LocalRepositoryBinding | null;
} {
  if (!repoFlag) {
    return { cwd: process.cwd(), repo: null };
  }
  const resolved = resolve(repoFlag);
  if (!existsSync(resolved)) {
    throw new Error(`--repo path does not exist: ${resolved}`);
  }
  const repo = tryInspectLocalRepository(resolved);
  if (!repo) {
    throw new Error(`--repo path is not a git repository: ${resolved}`);
  }
  return { cwd: resolved, repo };
}

/**
 * Check model/effort against the agent's live catalog and exercise the ACP
 * setter before anything is persisted. Unknown values, missing axes, catalog
 * outages, and provider retirement refusals all fail closed here.
 */
async function validateModelSelection(
  agent: AgentCommand,
  agentEnv: Record<string, string>,
  selection: { model?: string; effort?: string },
): Promise<void> {
  if (!selection.model && !selection.effort) return;
  await validateAgentModelSelection(agent, agentEnv, selection);
}

async function assertRuntimeSafe(runtime: AgentRuntimeRecord): Promise<void> {
  const agent = runtimeIdentity(runtime.agent);
  const relay = createRelayClient(agent, {
    baseUrl: runtime.relayBaseUrl,
    host: new URL(runtime.relayBaseUrl).host,
  });
  await Promise.all(
    runtime.rooms.map(async (room) => {
      if (!room.repo.relayRepo) return;
      try {
        await assertAgentNotPushAllowed({
          ownerHex: room.repo.relayRepo.ownerHex,
          repo: room.repo.relayRepo.repo,
          agentPubkey: runtime.agent.publicKey,
          protectedRef: `refs/heads/${room.repo.targetBranch}`,
          relay,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // A definitive policy violation is fatal. Relay availability is not a
        // verdict: the push broker and credential boundary still fail closed,
        // while READY must remain independent from network health so an outage
        // cannot turn systemd into a kill loop. Run every Room concurrently so
        // the bounded relay retry policy is paid once, never N times.
        if (detail.startsWith('provisioning check failed:')) throw error;
        if (!/relay|queryEvents|HTTP|fetch|network|timed? out|ECONN|socket/i.test(detail)) {
          throw error;
        }
        console.warn(
          `[thin-core] startup push-policy read degraded for Room ${room.channelId}; ` +
            `continuing behind the fail-closed push broker: ${detail}`,
        );
      }
    }),
  );
}

async function runStoredDaemon(pathOrPointer: string): Promise<void> {
  // `--config` may point at the repo-anchored compatibility pointer; every
  // per-daemon path below (workspace, daemon.pid, Room roots) must hang off the
  // real runtime directory, not the pointer's.
  const configPath = await resolveRuntimeConfigPath(pathOrPointer);
  // One-time, idempotent migration: a runtime record that predates per-agent
  // access policies gets an explicit `accessPolicy: 'everyone'` stamped on it,
  // so flipping DEFAULT_ACCESS_POLICY to owner-only never re-gates an
  // already-paired agent. A record with any explicit policy is untouched.
  const accessMigration = await migrateRuntimeRecordAccessPolicy(configPath);
  const { runtime } = await migrateLegacyRepositoryPaths(accessMigration.runtime, {
    log: console.log,
  });
  const agent = runtimeAgentCommand(runtime);
  // This assertion deliberately sits outside the retry loop: unsafe branch
  // policy is a fatal startup error, not a transient Room-loop failure.
  await assertRuntimeSafe(runtime);
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
  const daemonIdentity = runtimeIdentity(runtime.agent);
  const rollbackAlertRelay = createRelayClient(daemonIdentity, {
    baseUrl: runtime.relayBaseUrl,
    host: runtime.relayHost ?? new URL(runtime.relayBaseUrl).host,
  });
  let rollbackAlertDrain: Promise<void> | undefined;
  const drainRollbackAlert = (channelId: string | undefined): Promise<void> => {
    if (!channelId) return Promise.resolve();
    if (rollbackAlertDrain) return rollbackAlertDrain;
    rollbackAlertDrain = publishPendingUpdateRollbackAlert({
      runtimeDir,
      channelId,
      identity: daemonIdentity,
      publishEvent: (event) => rollbackAlertRelay.publishEvent(event),
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
  let update: ManagedUpdateHandoff | undefined;
  let pendingSuccessor = false;
  let successorRolledBack = false;
  if (layout) {
    const settle = await settlePendingUpdateOnStart(layout);
    const handoff = await readUpdateHandoff(runtimeDir);
    if (settle.kind === 'rolled-back') {
      await unlink(resolve(runtimeDir, 'update-handoff.json')).catch(() => undefined);
      await queueUpdateRollbackAlert(runtimeDir, settle.record.releaseId);
      await drainRollbackAlert(runtime.rooms[0]?.channelId);
      console.error(
        `[body] self-update ROLLED BACK: bundle ${describeIdentity(settle.record.to)} never confirmed healthy; ` +
          `restored ${settle.record.previousReleaseId ?? 'previous release'}`,
      );
      throw new Error('stale unconfirmed release rolled back; supervisor must restart');
    } else if (settle.kind === 'pending') {
      pendingSuccessor = true;
    }
    loadedRelease = await activeReleaseId(layout);
    if (handoff && settle.kind === 'none' && handoff.desiredRelease !== loadedRelease) {
      // Another daemon already confirmed a later globally-active release.
      // This instance's older per-runtime request is superseded, not a reason
      // to crash-loop on an anchor the shared coordinator has accepted.
      await unlink(resolve(runtimeDir, 'update-handoff.json')).catch(() => undefined);
    } else if (handoff) {
      pendingSuccessor = true;
    }
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
    const core = new ThinDaemonCore(runtime, configPath, config);
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
          async ({ handoff, forced }) => {
            if (forced) await core.prepareForForcedUpdateRestart();
            core.setDrainDeadlineAt(handoff.drainDeadlineAt);
            stoppingStatus =
              `update pending, converging; loaded_release=${loadedRelease ?? 'unknown'}; ` +
              `desired_release=${handoff.desiredRelease}; ` +
              `${forced ? 'drain deadline reached, forcing restart' : 'active work drained'}; ` +
              `intake quiesced; exit_deadline=${new Date(handoff.drainDeadlineAt).toISOString()}`;
            await notifier.stopping(stoppingStatus);
            controller.abort();
          },
          async (handoff) => {
            await notifier.progress(
              `loaded_release=${loadedRelease ?? 'unknown'}; update ready; ` +
                `active agent work is still running; handoff deferred; ` +
                `exit_deadline=${new Date(handoff.drainDeadlineAt).toISOString()}`,
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

/**
 * Pair one agent (fresh or pinned identity) and launch its durable daemon.
 *
 * This function owns the whole interactive-then-working sequence for one
 * agent, and the ordering is load-bearing: every clack prompt runs FIRST and
 * the live spinner starts only once the last question is answered. A spinner
 * started by the caller around this call would render on the same stdout line
 * as `pickModelAndEffort`'s own catalog spinner (each clack spinner drives its
 * own ~80ms `setInterval` that erases and rewrites that line), which is
 * exactly the rapid flicker between "Pairing…" and "Reading … models…" — and
 * it would keep spinning underneath the model/access prompts too.
 */
async function pairOneAgent(input: {
  code: string;
  selectedAgent: AgentCommand;
  agentIdentity: Identity;
  bodyIdentity: Identity;
  cwd: string;
  /** Resolved by `resolvePairRepository`; `null` pairs with no repository. */
  repo: LocalRepositoryBinding | null;
  /** Spinner copy for the non-interactive work phase (interactive runs only). */
  progressLabel: string;
  progressDone: (pid: number) => string;
  llmEnvFile?: string;
  /** Undefined defers to the interactive picker (or `DEFAULT_ACCESS_POLICY` non-interactively). */
  access?: AgentAccessPolicy;
  accessAllowlist?: string[];
  autoResponse?: string;
  modelSelection?: { model?: string; effort?: string };
  externalMcpCapabilities?: ExternalMcpCapability[];
  sharedSkills?: string[];
  /** Offer the clack model/effort/access/auto-response pickers when their flags weren't given. */
  interactiveUi?: boolean;
}): Promise<PairRuntimeResult> {
  const { code, selectedAgent, agentIdentity, bodyIdentity } = input;
  const mergeWorkerIdentity = newIdentity('beeline-merge-worker');
  const relayBaseUrl = (process.env.BUZZY_RELAY_URL ?? BASE_URL)
    .replace(/^ws/, 'http')
    .replace(/\/$/, '');
  const client = createBuzzClient({
    baseUrl: relayBaseUrl,
    ...(process.env.BUZZY_RELAY_HOST ? { host: process.env.BUZZY_RELAY_HOST } : {}),
    identity: agentIdentity,
  });
  // Fail before consuming the one-shot code if the local agent runtime is absent.
  const localConfig = loadBodyConfig({
    workspaceRoot: process.cwd(),
    ...(input.llmEnvFile ? { llmEnvFile: input.llmEnvFile } : {}),
    agent: selectedAgent,
  });
  const flagSelection = input.modelSelection;
  let modelSelection = flagSelection;
  // Each flag skips only its own prompt. `--model` alone must still offer the
  // effort picker (and the reverse); both flags skip the pickers entirely.
  const bothFlags = Boolean(flagSelection?.model && flagSelection?.effort);
  if (input.interactiveUi && !bothFlags) {
    const picked = await pickModelAndEffort(
      selectedAgent,
      localConfig.agentEnv,
      flagSelection ?? {},
    );
    if (picked.model || picked.effort) modelSelection = picked;
  }
  if (modelSelection?.model || modelSelection?.effort) {
    await withSpinner(
      Boolean(input.interactiveUi),
      `Validating ${selectedAgent.kind}'s live model selection…`,
      'Model/effort selection validated.',
      () => validateModelSelection(selectedAgent, localConfig.agentEnv, modelSelection ?? {}),
    );
  }
  const { access, autoResponse } = await resolveAccessSettings({
    ...(input.access !== undefined ? { access: input.access } : {}),
    ...(input.autoResponse !== undefined ? { autoResponse: input.autoResponse } : {}),
    interactiveUi: Boolean(input.interactiveUi),
  });
  if (input.externalMcpCapabilities?.length && access !== 'creator') {
    throw new Error('external MCP capabilities require --access creator');
  }
  if (
    input.externalMcpCapabilities?.length &&
    /^BUZZ-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/i.test(code.trim())
  ) {
    console.log("[beeline] checking this machine's Trusty Squire vault/link…");
    const configRoot = trustySquireConfigRoot(defaultSupervisorRoot(process.env));
    const connected = await connectTrustySquireForPair({
      agentKind: selectedAgent.kind,
      configRoot,
    });
    console.log(
      `[beeline] Trusty Squire connected locally; skill loaded at ${connected.skillPath}`,
    );
  }
  await validateSharedSkills(homedir(), [
    ...(input.sharedSkills ?? []),
    ...(input.externalMcpCapabilities?.length ? ['trusty-squire'] : []),
  ]);
  // Every question is answered — only now is one spinner alone on the line.
  const spinner = input.interactiveUi ? clack.spinner() : undefined;
  spinner?.start(input.progressLabel);
  try {
    const result = await pairRepositoryAgent(
      {
        code,
        cwd: input.cwd,
        repo: input.repo,
        relayBaseUrl,
        ...(process.env.BUZZY_RELAY_HOST ? { relayHost: process.env.BUZZY_RELAY_HOST } : {}),
        ...(input.llmEnvFile ? { llmEnvFile: input.llmEnvFile } : {}),
        agentIdentity,
        bodyIdentity,
        mergeWorkerIdentity,
        agentBinary: localConfig.agentBinary,
        agentKind: selectedAgent.kind,
        agentCommand: selectedAgent.command,
        agentArgs: selectedAgent.args,
        accessPolicy: access,
        ...(input.accessAllowlist ? { accessAllowlist: input.accessAllowlist } : {}),
        ...(autoResponse ? { accessAutoResponse: autoResponse } : {}),
        ...(modelSelection ? { modelSelection } : {}),
        ...(input.externalMcpCapabilities?.length
          ? { externalMcpCapabilities: input.externalMcpCapabilities }
          : {}),
        ...(input.sharedSkills?.length ? { sharedSkills: input.sharedSkills } : {}),
        mcpBinary: localConfig.mcpBinary,
      },
      {
        redeem: (pairingCode) => client.redeemAgentPairingCode(pairingCode),
        resolveRoom: (pairing, repository, mergeWorkerPubkey) =>
          client.resolveRepositoryRoom(
            pairing.communityId,
            repository,
            pairing.pairedBy,
            mergeWorkerPubkey,
          ),
        // Undo this agent's own Workspace registration when a later pair step
        // fails, so a failed run leaves no permanently-offline ghost behind.
        abandonPairing: async (pairing) => {
          if (await client.abandonAgentPairing(pairing.communityId)) return;
          console.error(
            `[beeline] could not unregister agent ${agentIdentity.publicKey} after the failed ` +
              'pairing; remove it from the Workspace in the app to clear the offline entry.',
          );
        },
        validate: async (_pairing, _room, repo) => {
          if (!repo.relayRepo) return;
          await assertAgentNotPushAllowed({
            ownerHex: repo.relayRepo.ownerHex,
            repo: repo.relayRepo.repo,
            agentPubkey: agentIdentity.publicKey,
            protectedRef: `refs/heads/${repo.targetBranch}`,
            relay: createRelayClient(agentIdentity, {
              baseUrl: relayBaseUrl,
              host: new URL(relayBaseUrl).host,
            }),
          });
        },
        launch: async (configPath) => {
          const stored = await readRuntimeRecord(configPath);
          return process.platform === 'linux' && process.env.BEELINE_SYSTEMD_USER !== '0'
            ? installAgentService(stored.agent.publicKey, {
                entrypoint: stableBeelineEntrypoint(),
              })
            : launchRuntimeDaemon(configPath);
        },
      },
    );
    spinner?.stop(pc.green(input.progressDone(result.pid)));
    return result;
  } catch (error) {
    spinner?.stop(pc.red('Pairing failed.'));
    throw error;
  }
}

function printPairResult(result: PairRuntimeResult): void {
  console.log(`[buzz] paired agent ${pc.bold(result.pairing.agent.displayName)}`);
  console.log(`[buzz] workspace: ${result.pairing.communityId}`);
  const pairedRoom = result.runtime.rooms[0];
  if (result.room && pairedRoom) {
    console.log(
      `[buzz] room: ${result.room.channelId} (${result.room.created ? 'created' : 'joined'})`,
    );
    console.log(`[buzz] repo: ${pairedRoom.repo.root}`);
  } else {
    console.log(
      '[buzz] repo: none — add this agent to a Room from the app; each Room supplies its own',
    );
  }
  console.log(`[buzz] agent pubkey: ${result.pairing.agent.pubkey}`);
  console.log(`[buzz] access policy: ${result.runtime.accessPolicy ?? DEFAULT_ACCESS_POLICY}`);
  if (result.runtime.externalMcpCapabilities?.length) {
    console.log(`[buzz] external MCP: ${result.runtime.externalMcpCapabilities.join(', ')}`);
  }
  if (result.runtime.modelSelection) {
    console.log(
      `[buzz] model/effort default: ${pc.cyan(result.runtime.modelSelection.model ?? '(unset)')} / ${pc.cyan(
        result.runtime.modelSelection.effort ?? '(unset)',
      )}`,
    );
  }
  console.log(`[buzz] daemon started ${pc.green(`(pid ${result.pid})`)}`);
}

/**
 * Parse, validate, and execute `beeline pair`. Every failure mode here — a
 * bad flag, an unresolvable repo, an unadvertised model/effort, a
 * redemption failure — is meant for the operator to read and act on, so
 * it's caught here and reported as a plain message, not a stack trace.
 */
async function runPairCommand(
  args: string[],
  llmEnvFile: string | undefined,
  agentPrivateKey: string | undefined,
): Promise<void> {
  // A picker on a stream that isn't a real TTY would just hang — never
  // attempted then. `--model`/`--effort` (or accepting no selection at all,
  // same as before this feature existed) remain the non-interactive path.
  const interactiveUi = Boolean(stdin.isTTY && stdout.isTTY);
  try {
    const pairOptions = parsePairOptions(args);
    if (
      pairOptions.codes.length === 0 ||
      pairOptions.codes.some((code) => !PAIRING_CODE_SHAPE.test(code.trim()))
    ) {
      pairingCodeUsage();
    }
    if (interactiveUi) clack.intro(pc.bold('beeline pair'));
    if (pairOptions.useEnvKey && !agentPrivateKey) {
      throw new Error('--use-env-key requires BUZZ_AGENT_KEY or BUZZ_PRIVATE_KEY to be set');
    }
    if (agentPrivateKey) {
      console.warn(
        pairOptions.useEnvKey
          ? '[beeline] pair is reusing the ambient BUZZ_AGENT_KEY/BUZZ_PRIVATE_KEY as this agent identity (--use-env-key)'
          : '[beeline] pair ignores BUZZ_AGENT_KEY/BUZZ_PRIVATE_KEY and is minting a fresh agent identity',
      );
    }
    const { cwd: pairCwd, repo: pairRepo } = resolvePairRepository(pairOptions.repo);
    const flagModelSelection: { model?: string; effort?: string } | undefined =
      pairOptions.model || pairOptions.effort
        ? {
            ...(pairOptions.model ? { model: pairOptions.model } : {}),
            ...(pairOptions.effort ? { effort: pairOptions.effort } : {}),
          }
        : undefined;

    if (pairOptions.kinds) {
      // Multi-runtime: one single-use pairing code per agent, each minting its
      // own fresh keypair and launching its own daemon. Three distinct agents
      // in one Workspace/Room, each independently @-mentionable. --model/
      // --effort flags (if given) apply identically to every agent, same
      // convention as --access/--auto-response; the interactive picker below
      // instead runs once per agent against that agent's own live catalog,
      // which is the more correct behaviour across differing harnesses.
      const { codes, kinds } = pairOptions;
      if (codes.length !== kinds.length) {
        throw new Error(
          `--agents expects one pairing code per agent: got ${codes.length} code(s) for ${kinds.length} agent(s)`,
        );
      }
      for (let index = 0; index < codes.length; index += 1) {
        const kind = kinds[index]!;
        const selectedAgent = await selectPairAgentCommand({
          explicitKind: kind,
          env: process.env,
          cwd: process.cwd(),
        });
        console.log(
          `[body] agent ${index + 1}/${codes.length} (${kind}) binary: ${formatAgentCommand(selectedAgent)}`,
        );
        const result = await pairOneAgent({
          code: codes[index]!,
          selectedAgent,
          agentIdentity: mintAgentIdentityForPairing(),
          bodyIdentity: newIdentity(DEFAULT_BODY_IDENTITY_NAME),
          cwd: pairCwd,
          repo: pairRepo,
          progressLabel: `Pairing agent ${index + 1}/${codes.length} (${kind})…`,
          progressDone: (pid) => `Paired ${kind} (pid ${pid}).`,
          ...(llmEnvFile ? { llmEnvFile } : {}),
          access: pairOptions.access,
          accessAllowlist: pairOptions.accessAllowlist,
          ...(pairOptions.autoResponse ? { autoResponse: pairOptions.autoResponse } : {}),
          ...(flagModelSelection ? { modelSelection: flagModelSelection } : {}),
          interactiveUi,
          externalMcpCapabilities: pairOptions.externalMcpCapabilities,
          sharedSkills: pairOptions.sharedSkills,
        });
        printPairResult(result);
      }
      if (interactiveUi) clack.outro(pc.green('All agents paired.'));
      return;
    }

    if (pairOptions.codes.length > 1) {
      throw new Error('multiple pairing codes require --agents <kind1,kind2,...>');
    }
    // Pairing always creates one new identity by default. In particular, the
    // legacy BUZZ_PRIVATE_KEY used by human clients is never an ambient
    // agent-key fallback — reusing it requires the explicit --use-env-key opt-in.
    const agentIdentity = pairOptions.useEnvKey
      ? identityFromKey(agentPrivateKey, DEFAULT_AGENT_IDENTITY_NAME)
      : mintAgentIdentityForPairing();
    await assertAgentIdentityUnpaired(defaultSupervisorRoot(process.env), agentIdentity.publicKey);
    const selectedAgent = await selectPairAgentCommand({
      explicitKind: pairOptions.singleKind,
      customCommand: pairOptions.customCommand,
      env: process.env,
      cwd: process.cwd(),
    });
    console.log(`[body] agent binary: ${formatAgentCommand(selectedAgent)}`);
    const result = await pairOneAgent({
      code: pairOptions.codes[0]!,
      selectedAgent,
      agentIdentity,
      bodyIdentity: identityFromKey(process.env.BUZZ_BODY_KEY, DEFAULT_BODY_IDENTITY_NAME),
      cwd: pairCwd,
      repo: pairRepo,
      progressLabel: 'Pairing…',
      progressDone: (pid) => `Paired (pid ${pid}).`,
      ...(llmEnvFile ? { llmEnvFile } : {}),
      access: pairOptions.access,
      accessAllowlist: pairOptions.accessAllowlist,
      ...(pairOptions.autoResponse ? { autoResponse: pairOptions.autoResponse } : {}),
      ...(flagModelSelection ? { modelSelection: flagModelSelection } : {}),
      interactiveUi,
      externalMcpCapabilities: pairOptions.externalMcpCapabilities,
      sharedSkills: pairOptions.sharedSkills,
    });
    printPairResult(result);
    if (interactiveUi) clack.outro(pc.green('Done.'));
  } catch (error) {
    if (interactiveUi) clack.cancel(error instanceof Error ? error.message : String(error));
    else console.error(`[beeline] pair failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/** Launch one stored runtime daemon — restarting it when already running. */
/**
 * `spinnerHandle`, when given (interactive `start` only), receives status
 * updates via `.message()` instead of `console.log` so they render inside
 * the live spinner rather than racing it. Non-interactive callers omit it and
 * get the exact same plain `console.log` lines as before this existed.
 */
async function startRuntime(
  configPath: string,
  spinnerHandle?: ReturnType<typeof clack.spinner>,
): Promise<void> {
  const report = (text: string) =>
    spinnerHandle ? spinnerHandle.message(text) : console.log(text);
  const runtime = await readRuntimeRecord(configPath);
  const selectedAgent = runtimeAgentCommand(runtime);
  await assertRuntimeSafe(runtime);
  report(`[body] agent ${runtime.agent.publicKey} binary: ${formatAgentCommand(selectedAgent)}`);
  if (process.platform === 'linux' && process.env.BEELINE_SYSTEMD_USER !== '0') {
    const existingPid = await runtimeDaemonPid(configPath);
    if (existingPid) {
      report(`[buzz] agent daemon is running (pid ${existingPid}); draining it before supervision`);
      await stopRuntimeDaemon(configPath, { timeoutMs: 30 * 60_000 });
    }
    const pid = await installAgentService(runtime.agent.publicKey, {
      entrypoint: stableBeelineEntrypoint(),
    });
    report(`[buzz] agent daemon supervised by systemd (pid ${pid})`);
    return;
  }
  await startStoredRuntime(configPath, { report });
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
  // READS (`corner-read-token.ts`). Non-interactive by construction: git is
  // never a human at a keyboard. Mints only ever carry read-only permissions
  // pinned to one repository id — never a push-capable credential (#376).
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
    // `--agent <pubkey>` and `--all` scan the machine-local agent state home,
    // so starting an agent no longer requires standing in the repo it was
    // paired in. With no pubkey, `beeline start` starts *every* agent paired
    // in this repository (three runtimes = three daemons = three identities in
    // one Room); `--all` does the same for every agent paired on this host.
    const allFlag = args.includes('--all');
    const agentFlag = args.indexOf('--agent');
    const flagPubkey = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
    if (agentFlag >= 0 && !flagPubkey) throw new Error('--agent requires an agent pubkey');
    const positionalPubkey = args
      .slice(1)
      .find((token) => !token.startsWith('--') && token !== flagPubkey);
    const requestedPubkey = flagPubkey ?? positionalPubkey;
    // An agent paired with no repository leaves no repo-anchored pointer to
    // find, and a repo-less operator has no checkout to stand in — so a bare
    // `beeline start` outside any git repository scans the machine-local
    // agent state home instead of failing. Inside a repository the scope
    // stays that repository's paired agents, unchanged.
    const { paths: unique } = await selectRuntimeConfigPaths({
      cwd: process.cwd(),
      all: allFlag,
      requestedPubkey,
      findHostRuntimes: (cwd) => findAgentRuntimeConfigPaths(process.env, cwd),
      findRepositoryRuntimes: findRuntimeConfigPaths,
      noRuntimeMessage: (hostScope) =>
        requestedPubkey
          ? `no paired agent runtime found for ${requestedPubkey}`
          : hostScope
            ? 'no paired agent runtime found on this host'
            : 'no paired agent runtime found in this repository',
      multipleRuntimeMessage:
        'multiple paired agents match that pubkey; pass the full agent pubkey shown by `beeline pair`',
    });
    if (interactiveUi) clack.intro(pc.bold('beeline start'));
    for (const path of unique) {
      if (!interactiveUi) {
        await startRuntime(path);
        continue;
      }
      const spinnerHandle = clack.spinner();
      spinnerHandle.start(`Starting ${dirname(path)}…`);
      try {
        await startRuntime(path, spinnerHandle);
        spinnerHandle.stop(pc.green('Started.'));
      } catch (error) {
        spinnerHandle.stop(pc.red('Failed.'));
        throw error;
      }
    }
    if (interactiveUi) {
      clack.outro(pc.green(unique.length > 1 ? 'All agents started.' : 'Done.'));
    }
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
  process.exit(1);
});
