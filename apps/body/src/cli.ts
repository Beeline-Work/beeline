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
import { unlink } from 'node:fs/promises';
import { loadBodyConfig, BASE_URL } from './config.js';
import { formatAgentCommand, type AgentCommand, type AgentKind } from './agent-command.js';
import { selectPairAgentCommand } from './pair-agent-selection.js';
import {
  DEFAULT_ACCESS_POLICY,
  isAgentAccessPolicy,
  type AgentAccessPolicy,
} from './access-policy.js';
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
Buzzy Body — agent session manager.

Usage:
  beeline provision <channel-uuid>          Attach read-only agent to a TLC
  beeline serve <channel-uuid> <owner> <repo>  Internal: serve one explicitly-wired Room
  beeline open <channel-uuid> <owner> <repo>  Open subchannel + edit session
  beeline archive <subchannel-uuid>         Archive subchannel
  beeline create-and-provision <name>       Create a new TLC + provision agent
  beeline pair <BUZZ-XXXX-XXXX> [options]   Pair this repo and start its durable Room agent
  beeline start [agent-pubkey]              Restart a paired repo's durable agent
  beeline start --agent <agent-pubkey>      Restart it from anywhere (no repo needed)

Options:
  --workspace-root <path>   Agent workspace (default: ./body-workspace)
  --llm-env-file <path>     Path to LLM credentials env file
  --agent-key <nsec>        Agent Nostr secret (hex or nsec)

All other config via env vars (see config.ts).
`);
  process.exit(exitCode);
}

function pairUsage(): void {
  console.log(`
Pair this repository and start its durable Room agent(s).

Usage:
  beeline pair <BUZZ-XXXX-XXXX> [--agent <codex|claude|goose|pi|reference|custom>]
               [--agent-command '<command> [args...]']
               [--access <everyone|creator>] [--auto-response '<text>']

  beeline pair <CODE1> <CODE2> ... --agents <kind1,kind2,...>
               [--access <everyone|creator>] [--auto-response '<text>']

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

Access policy (per agent, set here at invite time):
  everyone  any Room member may address the agent (default)
  creator   only the inviting owner may; anyone else gets the auto-response

Examples:
  beeline pair BUZZ-XXXX-XXXX --agent codex
  beeline pair BUZZ-XXXX-XXXX --agent claude --access creator
  beeline pair BUZZ-AAAA-AAAA BUZZ-BBBB-BBBB BUZZ-CCCC-CCCC --agents claude,codex,pi
  beeline pair BUZZ-XXXX-XXXX --agent custom --agent-command 'my-agent serve --acp'
`);
}

interface PairOptions {
  codes: string[];
  kinds?: AgentKind[];
  singleKind?: AgentKind;
  customCommand?: string;
  access: AgentAccessPolicy;
  autoResponse?: string;
}

function parsePairOptions(args: string[]): PairOptions {
  // args[0] === 'pair'; positionals after it are pairing codes.
  const codes: string[] = [];
  let kinds: AgentKind[] | undefined;
  let singleKind: AgentKind | undefined;
  let customCommand: string | undefined;
  let access: AgentAccessPolicy = DEFAULT_ACCESS_POLICY;
  let autoResponse: string | undefined;
  const flags = new Set(['--agent', '--agents', '--agent-command', '--access', '--auto-response']);
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
    else if (token === '--auto-response') autoResponse = value;
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
    access,
    ...(autoResponse !== undefined ? { autoResponse } : {}),
  };
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
  llmEnvFile?: string;
  access: AgentAccessPolicy;
  autoResponse?: string;
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
  return pairRepositoryAgent(
    {
      code,
      cwd: process.cwd(),
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
      accessPolicy: input.access,
      ...(input.autoResponse ? { accessAutoResponse: input.autoResponse } : {}),
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
  console.log(`[buzz] paired agent ${result.pairing.agent.displayName}`);
  console.log(`[buzz] workspace: ${result.pairing.communityId}`);
  console.log(
    `[buzz] room: ${result.room.channelId} (${result.room.created ? 'created' : 'joined'})`,
  );
  console.log(`[buzz] repo: ${result.runtime.rooms[0]!.repo.root}`);
  console.log(`[buzz] agent pubkey: ${result.pairing.agent.pubkey}`);
  console.log(`[buzz] access policy: ${result.runtime.accessPolicy ?? DEFAULT_ACCESS_POLICY}`);
  console.log(`[buzz] daemon started (pid ${result.pid})`);
}

/** Launch one stored runtime daemon (or report it already running). */
async function startRuntime(configPath: string): Promise<void> {
  const runtime = await readRuntimeRecord(configPath);
  const selectedAgent = runtimeAgentCommand(runtime);
  await assertRuntimeSafe(runtime);
  console.log(
    `[body] agent ${runtime.agent.publicKey} binary: ${formatAgentCommand(selectedAgent)}`,
  );
  const existingPid = await runtimeDaemonPid(configPath);
  if (existingPid) {
    console.log(`[buzz] agent daemon is already running (pid ${existingPid})`);
    return;
  }
  const pid = await launchRuntimeDaemon(configPath);
  console.log(`[buzz] agent daemon started (pid ${pid})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const command = args[0];
  if (command === '--help' || command === '-h') usage(0);

  // Parse optional flags.
  const llmEnvFile = process.env.BUZZY_BODY_LLM_FILE;
  const workspaceRoot = process.env.BUZZY_BODY_WORKSPACE ?? './body-workspace';
  const agentPrivateKey = process.env.BUZZ_AGENT_KEY ?? process.env.BUZZ_PRIVATE_KEY;

  if (command === '--version' || command === 'version') {
    const config = loadBodyConfig({ workspaceRoot, llmEnvFile });
    console.log('beeline 0.0.0');
    console.log(`[body] agent binary: ${config.agentCommand ?? config.agentBinary}`);
    console.log(`[body] mcp binary: ${config.mcpBinary}`);
    console.log(`[body] read-only mcp: ${config.readonlyMcpCommand}`);
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
    for (const path of unique) await startRuntime(path);
    return;
  }

  if (command === 'pair') {
    if (args.length === 2 && (args[1] === '--help' || args[1] === '-h')) {
      pairUsage();
      return;
    }
    const pairOptions = parsePairOptions(args);
    if (pairOptions.codes.length === 0) usage();

    if (pairOptions.kinds) {
      // Multi-runtime: one single-use pairing code per agent, each minting its
      // own fresh keypair and launching its own daemon. Three distinct agents
      // in one Workspace/Room, each independently @-mentionable.
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
        const result = await pairOneAgent({
          code: codes[index]!,
          selectedAgent,
          agentIdentity: newIdentity('buzzy-agent'),
          bodyIdentity: newIdentity('buzzy-body'),
          ...(llmEnvFile ? { llmEnvFile } : {}),
          access: pairOptions.access,
          ...(pairOptions.autoResponse ? { autoResponse: pairOptions.autoResponse } : {}),
        });
        printPairResult(result);
      }
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
    const result = await pairOneAgent({
      code: pairOptions.codes[0]!,
      selectedAgent,
      agentIdentity: identityFromKey(agentPrivateKey, 'buzzy-agent'),
      bodyIdentity: identityFromKey(process.env.BUZZ_BODY_KEY, 'buzzy-body'),
      ...(llmEnvFile ? { llmEnvFile } : {}),
      access: pairOptions.access,
      ...(pairOptions.autoResponse ? { autoResponse: pairOptions.autoResponse } : {}),
    });
    printPairResult(result);
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
        const session = await body.provision(channelId);
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
        const info = await body.openSubchannel(channelId, { ownerHex, repo });
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
        console.log(`[body] watching channel requests addressed to agent ${body.agent.publicKey}`);
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
        await body.archiveSubchannel(subchannelId);
        console.log(`[body] archived: subchannel=${subchannelId}`);
        break;
      }

      case 'create-and-provision': {
        const name = args[1] ?? 'buzzy-tlc';
        const channelId = await createChannel(bodyIdentity, name);
        console.log(`[body] created TLC: ${channelId} name=${name}`);

        // Add agent as member.
        await setMemberRole(bodyIdentity, channelId, agentIdentity.publicKey, 'member');

        const session = await body.provision(channelId);
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
  console.error('[body] fatal:', err);
  process.exit(1);
});
