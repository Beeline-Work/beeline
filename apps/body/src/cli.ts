#!/usr/bin/env node
/**
 * Buzzy body CLI — run a body against a TLC channel.
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
import { unlink } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { loadBodyConfig, BASE_URL } from './config.js';
import { formatAgentCommand, type AgentCommand, type AgentKind } from './agent-command.js';
import { selectPairAgentCommand } from './pair-agent-selection.js';
import {
  DEFAULT_ACCESS_POLICY,
  isAgentAccessPolicy,
  type AgentAccessPolicy,
} from './access-policy.js';
import { assertModelSelectionAdvertised } from './model-config.js';
import { fetchAgentModelCatalog } from './model-catalog.js';
import { pickModelAndEffort, resolveAccessSettings } from './agent-settings-prompts.js';
import { withSpinner } from './clack-support.js';
import { Body } from './body.js';
import { WorkspaceSupervisor } from './supervisor.js';
import {
  assertAgentNotPushAllowed,
  createRelayClient,
  createChannel,
  newIdentity,
  setMemberRole,
  type Identity,
} from '@beeline/gate';
import { createBuzzClient } from '@beeline/buzz-client';
import {
  findAgentRuntimeConfigPaths,
  findRuntimeConfigPaths,
  identityFromKey,
  launchRuntimeDaemon,
  pairRepositoryAgent,
  readRuntimeRecord,
  removeAgentRuntime,
  resolveRuntimeConfigPath,
  runtimeDaemonPid,
  runtimeAgentCommand,
  runtimeIdentity,
  type AgentRuntimeRecord,
  type PairRuntimeResult,
} from './runtime.js';

function usage(exitCode = 1): void {
  console.error(`
${pc.bold('Buzzy Body — agent session manager.')}

${pc.dim('Usage:')}
  beeline provision <channel-uuid>          Attach read-only agent to a TLC
  beeline serve <channel-uuid> <owner> <repo>  Internal: serve one explicitly-wired Room
  beeline open <channel-uuid> <owner> <repo>  Open subchannel + edit session
  beeline archive <subchannel-uuid>         Archive subchannel
  beeline create-and-provision <name>       Create a new TLC + provision agent
  beeline pair <BUZZ-XXXX-XXXX> [options]   Pair this repo and start its durable Room agent
  beeline start [agent-pubkey]              Restart a paired repo's durable agent
  beeline start --agent <agent-pubkey>      Restart it from anywhere (no repo needed)

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
  beeline pair <BUZZ-XXXX-XXXX> [--agent <codex|claude|goose|pi|reference|custom>]
               [--agent-command '<command> [args...]'] [--repo <path>]
               [--access <everyone|creator>] [--auto-response '<text>']
               [--model <model>] [--effort <level>]

  beeline pair <CODE1> <CODE2> ... --agents <kind1,kind2,...> [--repo <path>]
               [--access <everyone|creator>] [--auto-response '<text>']
               [--model <model>] [--effort <level>]

Agent choices:
  codex      Operator's Codex through the codex-acp adapter
  claude     Operator's Claude Code through a Claude ACP adapter
  goose      Operator's Goose through its native 'goose acp' server
  pi         Operator's Pi through the pi-acp adapter
  reference  Bundled buzz-agent (explicit fallback; requires an LLM key)
  custom     Explicit ACP command supplied with --agent-command

With no --agent flag, beeline detects supported installed coding agents. Missing
ACP adapters stay visible and can be installed when selected on a terminal. In a
non-interactive session, beeline prints the manual adapter install command and
never installs packages automatically. Several ready matches require --agent.

Multiple runtimes in one Workspace: pass one single-use pairing code per agent
plus a matching --agents list. Each agent gets its own fresh keypair/identity
and its own daemon — three distinct agents live in one Room, each addressed by
its own @-mention. Reusing an identity is refused (unset BUZZ_AGENT_KEY).

Repository: beeline pair resolves the repository to bind in this order:
  1. --repo <path>          explicit, works from any cwd
  2. current directory      only if it IS a git repository
  If neither applies, pairing fails with an actionable error instead of a
  stack trace. There is no way to infer an existing Room's bound repository
  from the pairing code alone (pairing codes are Workspace-scoped, not
  Room-scoped) — --repo is required when pairing a second agent into an
  existing repository Room from a directory that isn't that checkout.

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
  everyone  any Room member may address the agent (default)
  creator   only the inviting owner may; anyone else gets the auto-response

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

interface PairOptions {
  codes: string[];
  kinds?: AgentKind[];
  singleKind?: AgentKind;
  customCommand?: string;
  repo?: string;
  /** Undefined means `--access` was omitted — the interactive flow (or the default) decides. */
  access?: AgentAccessPolicy;
  autoResponse?: string;
  model?: string;
  effort?: string;
}

function parsePairOptions(args: string[]): PairOptions {
  // args[0] === 'pair'; positionals after it are pairing codes.
  const codes: string[] = [];
  let kinds: AgentKind[] | undefined;
  let singleKind: AgentKind | undefined;
  let customCommand: string | undefined;
  let repo: string | undefined;
  let access: AgentAccessPolicy | undefined;
  let autoResponse: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  const flags = new Set([
    '--agent',
    '--agents',
    '--agent-command',
    '--repo',
    '--access',
    '--auto-response',
    '--model',
    '--effort',
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (!token.startsWith('--')) {
      codes.push(token);
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
    else if (token === '--access') {
      if (!isAgentAccessPolicy(value)) {
        throw new Error(`--access must be one of everyone|creator (got: ${value})`);
      }
      access = value;
    }
  }
  if (kinds && (singleKind || customCommand)) {
    throw new Error('--agents cannot be combined with --agent or --agent-command');
  }
  return {
    codes,
    ...(kinds ? { kinds } : {}),
    ...(singleKind !== undefined ? { singleKind } : {}),
    ...(customCommand !== undefined ? { customCommand } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(access !== undefined ? { access } : {}),
    ...(autoResponse !== undefined ? { autoResponse } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

/**
 * Resolve the repository directory `beeline pair` binds: explicit `--repo`
 * first, else the cwd if it IS a git repository. `inspectLocalRepository`
 * (runtime.ts) still does the actual git check and gives the actionable
 * "pass --repo" error; this only handles a `--repo` path that doesn't exist
 * at all, so that failure surfaces before spending time on redemption.
 */
function resolvePairCwd(repoFlag: string | undefined): string {
  if (!repoFlag) return process.cwd();
  const resolved = resolve(repoFlag);
  if (!existsSync(resolved)) {
    throw new Error(`--repo path does not exist: ${resolved}`);
  }
  return resolved;
}

/**
 * Validate `--model`/`--effort` against the agent's own live advertised
 * catalog before pairing commits to anything, and throw a clear error if
 * either value isn't one the agent actually offers. A no-op when neither
 * flag was passed. Picker-sourced selections skip this — they're already
 * drawn from the same live catalog, so they can't be invalid by construction.
 */
async function validateModelSelection(
  agent: AgentCommand,
  agentEnv: Record<string, string>,
  selection: { model?: string; effort?: string },
): Promise<void> {
  if (!selection.model && !selection.effort) return;
  try {
    const { raw } = await fetchAgentModelCatalog(agent, agentEnv);
    assertModelSelectionAdvertised(raw, selection);
  } catch (error) {
    throw new Error(
      `--model/--effort check failed for ${formatAgentCommand(agent)}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

async function assertRuntimeSafe(runtime: AgentRuntimeRecord): Promise<void> {
  const agent = runtimeIdentity(runtime.agent);
  const relay = createRelayClient(agent, {
    baseUrl: runtime.relayBaseUrl,
    host: new URL(runtime.relayBaseUrl).host,
  });
  for (const room of runtime.rooms) {
    if (!room.repo.relayRepo) continue;
    await assertAgentNotPushAllowed({
      ownerHex: room.repo.relayRepo.ownerHex,
      repo: room.repo.relayRepo.repo,
      agentPubkey: runtime.agent.publicKey,
      protectedRef: `refs/heads/${room.repo.targetBranch}`,
      relay,
    });
  }
}

async function waitToRestart(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, 2_000);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolveWait();
      },
      { once: true },
    );
  });
}

async function runStoredDaemon(pathOrPointer: string): Promise<void> {
  // `--config` may point at the repo-anchored compatibility pointer; every
  // per-daemon path below (workspace, daemon.pid, Room roots) must hang off the
  // real runtime directory, not the pointer's.
  const configPath = await resolveRuntimeConfigPath(pathOrPointer);
  const runtime = await readRuntimeRecord(configPath);
  const agent = runtimeAgentCommand(runtime);
  // This assertion deliberately sits outside the retry loop: unsafe branch
  // policy is a fatal startup error, not a transient Room-loop failure.
  await assertRuntimeSafe(runtime);
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
  // per-Room config spread carries it to every Body.
  config.accessPolicy = runtime.accessPolicy ?? DEFAULT_ACCESS_POLICY;
  config.accessOwnerPubkey = runtime.pairedBy;
  if (runtime.accessAutoResponse) config.accessAutoResponse = runtime.accessAutoResponse;
  if (runtime.modelSelection) config.modelSelection = runtime.modelSelection;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(
    `[buzz] Workspace supervisor ${runtime.communityId} starting with ${runtime.rooms.length} Room binding(s)`,
  );
  console.log(`[body] agent binary: ${formatAgentCommand(agent)}`);

  try {
    while (!controller.signal.aborted) {
      const supervisor = new WorkspaceSupervisor(runtime, configPath, config);
      try {
        const result = await supervisor.run({ signal: controller.signal });
        if (result === 'agent-removed') {
          controller.abort();
          await removeAgentRuntime(
            configPath,
            runtime.agent.publicKey,
            runtime.rooms.map((room) => room.repo.gitCommonDir),
          );
          console.log(`[buzz] agent ${runtime.agent.publicKey} removed; runtime deleted`);
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        console.error('[buzz] Workspace supervisor stopped; retrying:', error);
        await waitToRestart(controller.signal);
      }
    }
  } finally {
    await unlink(resolve(dirname(configPath), 'daemon.pid')).catch(() => undefined);
  }
}

/** Pair one agent (fresh or pinned identity) and launch its durable daemon. */
async function pairOneAgent(input: {
  code: string;
  selectedAgent: AgentCommand;
  agentIdentity: Identity;
  bodyIdentity: Identity;
  cwd: string;
  llmEnvFile?: string;
  /** Undefined defers to the interactive picker (or `DEFAULT_ACCESS_POLICY` non-interactively). */
  access?: AgentAccessPolicy;
  autoResponse?: string;
  modelSelection?: { model?: string; effort?: string };
  /** Offer the clack model/effort/access/auto-response pickers when their flags weren't given. */
  interactiveUi?: boolean;
}): Promise<PairRuntimeResult> {
  const { code, selectedAgent, agentIdentity, bodyIdentity } = input;
  const mergeWorkerIdentity = newIdentity('buzzy-merge-worker');
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
  let modelSelection = input.modelSelection;
  if (modelSelection) {
    await validateModelSelection(selectedAgent, localConfig.agentEnv, modelSelection);
  } else if (input.interactiveUi) {
    const picked = await pickModelAndEffort(selectedAgent, localConfig.agentEnv);
    if (picked.model || picked.effort) modelSelection = picked;
  }
  const { access, autoResponse } = await resolveAccessSettings({
    ...(input.access !== undefined ? { access: input.access } : {}),
    ...(input.autoResponse !== undefined ? { autoResponse: input.autoResponse } : {}),
    interactiveUi: Boolean(input.interactiveUi),
  });
  return pairRepositoryAgent(
    {
      code,
      cwd: input.cwd,
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
      ...(autoResponse ? { accessAutoResponse: autoResponse } : {}),
      ...(modelSelection ? { modelSelection } : {}),
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
    },
  );
}

function printPairResult(result: PairRuntimeResult): void {
  console.log(`[buzz] paired agent ${pc.bold(result.pairing.agent.displayName)}`);
  console.log(`[buzz] workspace: ${result.pairing.communityId}`);
  console.log(
    `[buzz] room: ${result.room.channelId} (${result.room.created ? 'created' : 'joined'})`,
  );
  console.log(`[buzz] repo: ${result.runtime.rooms[0]!.repo.root}`);
  console.log(`[buzz] agent pubkey: ${result.pairing.agent.pubkey}`);
  console.log(`[buzz] access policy: ${result.runtime.accessPolicy ?? DEFAULT_ACCESS_POLICY}`);
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
  if (interactiveUi) clack.intro(pc.bold('beeline pair'));
  try {
    const pairOptions = parsePairOptions(args);
    if (pairOptions.codes.length === 0) usage();
    const pairCwd = resolvePairCwd(pairOptions.repo);
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
      // A pinned key would make every agent share one identity — refuse (S0).
      if (agentPrivateKey) {
        throw new Error(
          'pairing multiple agents mints a fresh identity for each; unset BUZZ_AGENT_KEY/BUZZ_PRIVATE_KEY first',
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
        const spinner = interactiveUi ? clack.spinner() : undefined;
        spinner?.start(`Pairing agent ${index + 1}/${codes.length} (${kind})…`);
        const result = await pairOneAgent({
          code: codes[index]!,
          selectedAgent,
          agentIdentity: newIdentity('buzzy-agent'),
          bodyIdentity: newIdentity('buzzy-body'),
          cwd: pairCwd,
          ...(llmEnvFile ? { llmEnvFile } : {}),
          access: pairOptions.access,
          ...(pairOptions.autoResponse ? { autoResponse: pairOptions.autoResponse } : {}),
          ...(flagModelSelection ? { modelSelection: flagModelSelection } : {}),
          interactiveUi,
        });
        spinner?.stop(`Paired ${kind} (pid ${result.pid}).`);
        printPairResult(result);
      }
      if (interactiveUi) clack.outro(pc.green('All agents paired.'));
      return;
    }

    if (pairOptions.codes.length > 1) {
      throw new Error('multiple pairing codes require --agents <kind1,kind2,...>');
    }
    const selectedAgent = await selectPairAgentCommand({
      explicitKind: pairOptions.singleKind,
      customCommand: pairOptions.customCommand,
      env: process.env,
      cwd: process.cwd(),
    });
    console.log(`[body] agent binary: ${formatAgentCommand(selectedAgent)}`);
    const spinner = interactiveUi ? clack.spinner() : undefined;
    spinner?.start('Pairing…');
    const result = await pairOneAgent({
      code: pairOptions.codes[0]!,
      selectedAgent,
      agentIdentity: identityFromKey(agentPrivateKey, 'buzzy-agent'),
      bodyIdentity: identityFromKey(process.env.BUZZ_BODY_KEY, 'buzzy-body'),
      cwd: pairCwd,
      ...(llmEnvFile ? { llmEnvFile } : {}),
      access: pairOptions.access,
      ...(pairOptions.autoResponse ? { autoResponse: pairOptions.autoResponse } : {}),
      ...(flagModelSelection ? { modelSelection: flagModelSelection } : {}),
      interactiveUi,
    });
    spinner?.stop(`Paired (pid ${result.pid}).`);
    printPairResult(result);
    if (interactiveUi) clack.outro(pc.green('Done.'));
  } catch (error) {
    if (interactiveUi) clack.cancel(error instanceof Error ? error.message : String(error));
    else console.error(`[beeline] pair failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/** Launch one stored runtime daemon (or report it already running). */
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
  const report = (text: string) => (spinnerHandle ? spinnerHandle.message(text) : console.log(text));
  const runtime = await readRuntimeRecord(configPath);
  const selectedAgent = runtimeAgentCommand(runtime);
  await assertRuntimeSafe(runtime);
  report(`[body] agent ${runtime.agent.publicKey} binary: ${formatAgentCommand(selectedAgent)}`);
  const existingPid = await runtimeDaemonPid(configPath);
  if (existingPid) {
    report(`[buzz] agent daemon is already running (pid ${existingPid})`);
    return;
  }
  const pid = await launchRuntimeDaemon(configPath);
  report(`[buzz] agent daemon started (pid ${pid})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const command = args[0];
  if (command === '--help' || command === '-h') usage(0);

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
    console.log(`${pc.dim('[body] agent binary:')} ${config.agentCommand ?? config.agentBinary}`);
    console.log(`${pc.dim('[body] mcp binary:')} ${config.mcpBinary}`);
    console.log(`${pc.dim('[body] read-only mcp:')} ${config.readonlyMcpCommand}`);
    return;
  }

  if (command === 'daemon') {
    const configFlag = args.indexOf('--config');
    const configPath = configFlag >= 0 ? args[configFlag + 1] : undefined;
    if (!configPath) throw new Error('daemon requires --config <runtime.json>');
    await runStoredDaemon(resolve(configPath));
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
    const configs =
      allFlag || flagPubkey
        ? await findAgentRuntimeConfigPaths()
        : await findRuntimeConfigPaths(process.cwd());
    const matching = requestedPubkey
      ? configs.filter((path) => dirname(path).endsWith(requestedPubkey))
      : configs;
    // Pointers resolve to the same real record; start each runtime once.
    const unique = [...new Set(matching)];
    if (unique.length === 0) {
      throw new Error(
        requestedPubkey
          ? `no paired agent runtime found for ${requestedPubkey}`
          : allFlag
            ? 'no paired agent runtime found on this host'
            : 'no paired agent runtime found in this repository',
      );
    }
    if (requestedPubkey && unique.length > 1) {
      throw new Error(
        'multiple paired agents match that pubkey; pass the full agent pubkey shown by `beeline pair`',
      );
    }
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
  const bodyIdentity = identityFromKey(bodyKey, 'buzzy-body');
  const agentIdentity = identityFromKey(agentPrivateKey, 'buzzy-agent');

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

      case 'create-and-provision': {
        const name = args[1] ?? 'buzzy-tlc';
        const channelId = await withSpinner(
          interactiveUi,
          `Creating ${name}…`,
          'Created.',
          () => createChannel(bodyIdentity, name),
        );
        console.log(`[body] created TLC: ${channelId} name=${name}`);

        // Add agent as member.
        await setMemberRole(bodyIdentity, channelId, agentIdentity.publicKey, 'member');

        const session = await withSpinner(
          interactiveUi,
          `Provisioning ${channelId}…`,
          'Provisioned.',
          () => body.provision(channelId),
        );
        console.log(`[body] provisioned: session=${session.sessionId}`);
        console.log(`CHANNEL=${channelId}`);
        break;
      }

      default:
        usage();
    }
  } finally {
    await body.dispose();
  }
}

main().catch((err) => {
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
