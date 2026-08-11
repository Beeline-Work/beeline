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
import { Body } from './body.js';
import { WorkspaceSupervisor } from './supervisor.js';
import {
  assertAgentNotPushAllowed,
  createChannel,
  newIdentity,
  setMemberRole,
} from '@beeline/gate';
import { createBuzzClient } from '@beeline/buzz-client';
import {
  findRuntimeConfigPaths,
  identityFromKey,
  launchRuntimeDaemon,
  pairRepositoryAgent,
  readRuntimeRecord,
  runtimeDaemonPid,
  type AgentRuntimeRecord,
} from './runtime.js';

function usage(): void {
  console.error(`
Buzzy Body — agent session manager.

Usage:
  beeline provision <channel-uuid>          Attach read-only agent to a TLC
  beeline serve <channel-uuid> <owner> <repo>  Internal: serve one explicitly-wired Room
  beeline open <channel-uuid> <owner> <repo>  Open subchannel + edit session
  beeline archive <subchannel-uuid>         Archive subchannel
  beeline create-and-provision <name>       Create a new TLC + provision agent
  beeline pair <BUZZ-XXXX-XXXX>             Pair this repo and start its durable Room agent
  beeline start [agent-pubkey]              Restart a paired repo's durable agent

Options:
  --workspace-root <path>   Agent workspace (default: ./body-workspace)
  --llm-env-file <path>     Path to LLM credentials env file
  --agent-key <nsec>        Agent Nostr secret (hex or nsec)

All other config via env vars (see config.ts).
`);
  process.exit(1);
}

async function assertRuntimeSafe(runtime: AgentRuntimeRecord): Promise<void> {
  for (const room of runtime.rooms) {
    if (!room.repo.relayRepo) continue;
    await assertAgentNotPushAllowed({
      ownerHex: room.repo.relayRepo.ownerHex,
      repo: room.repo.relayRepo.repo,
      agentPubkey: runtime.agent.publicKey,
      protectedRef: `refs/heads/${room.repo.targetBranch}`,
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

async function runStoredDaemon(configPath: string): Promise<void> {
  const runtime = await readRuntimeRecord(configPath);
  // This assertion deliberately sits outside the retry loop: unsafe branch
  // policy is a fatal startup error, not a transient Room-loop failure.
  await assertRuntimeSafe(runtime);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUZZ_AGENT_BIN: runtime.agentBinary,
    BUZZ_DEV_MCP_BIN: runtime.mcpBinary,
    BUZZY_RELAY_URL: runtime.relayBaseUrl,
    ...(runtime.relayHost ? { BUZZY_RELAY_HOST: runtime.relayHost } : {}),
  };
  const config = loadBodyConfig({
    workspaceRoot: resolve(dirname(configPath), 'workspace'),
    llmEnvFile: runtime.llmEnvFile,
    env,
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(
    `[buzz] Workspace supervisor ${runtime.communityId} starting with ${runtime.rooms.length} Room binding(s)`,
  );

  try {
    while (!controller.signal.aborted) {
      const supervisor = new WorkspaceSupervisor(runtime, configPath, config);
      try {
        await supervisor.run({ signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('[buzz] Workspace supervisor stopped; retrying:', error);
          await waitToRestart(controller.signal);
        }
      }
    }
  } finally {
    await unlink(resolve(dirname(configPath), 'daemon.pid')).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const command = args[0];

  // Parse optional flags.
  const llmEnvFile = process.env.BUZZY_BODY_LLM_FILE;
  const workspaceRoot = process.env.BUZZY_BODY_WORKSPACE ?? './body-workspace';
  const agentPrivateKey = process.env.BUZZ_AGENT_KEY ?? process.env.BUZZ_PRIVATE_KEY;

  if (command === 'daemon') {
    const configFlag = args.indexOf('--config');
    const configPath = configFlag >= 0 ? args[configFlag + 1] : undefined;
    if (!configPath) throw new Error('daemon requires --config <runtime.json>');
    await runStoredDaemon(resolve(configPath));
    return;
  }

  if (command === 'start') {
    const requestedPubkey = args[1];
    const configs = await findRuntimeConfigPaths(process.cwd());
    const matching = requestedPubkey
      ? configs.filter((path) => dirname(path).endsWith(requestedPubkey))
      : configs;
    if (matching.length === 0) throw new Error('no paired agent runtime found in this repository');
    if (matching.length > 1) {
      throw new Error(
        'multiple paired agents found; pass the agent pubkey shown by `beeline pair`',
      );
    }
    const runtime = await readRuntimeRecord(matching[0]!);
    await assertRuntimeSafe(runtime);
    const existingPid = await runtimeDaemonPid(matching[0]!);
    if (existingPid) {
      console.log(`[buzz] agent daemon is already running (pid ${existingPid})`);
      return;
    }
    const pid = await launchRuntimeDaemon(matching[0]!);
    console.log(`[buzz] agent daemon started (pid ${pid})`);
    return;
  }

  if (command === 'pair') {
    const code = args[1];
    if (!code) usage();
    const agentIdentity = identityFromKey(agentPrivateKey, 'buzzy-agent');
    const bodyIdentity = identityFromKey(process.env.BUZZ_BODY_KEY, 'buzzy-body');
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
    const localConfig = loadBodyConfig({ workspaceRoot: process.cwd(), llmEnvFile });
    const result = await pairRepositoryAgent(
      {
        code: code!,
        cwd: process.cwd(),
        relayBaseUrl,
        ...(process.env.BUZZY_RELAY_HOST ? { relayHost: process.env.BUZZY_RELAY_HOST } : {}),
        ...(llmEnvFile ? { llmEnvFile } : {}),
        agentIdentity,
        bodyIdentity,
        mergeWorkerIdentity,
        agentBinary: localConfig.agentBinary,
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
          });
        },
      },
    );
    console.log(`[buzz] paired agent ${result.pairing.agent.displayName}`);
    console.log(`[buzz] workspace: ${result.pairing.communityId}`);
    console.log(
      `[buzz] room: ${result.room.channelId} (${result.room.created ? 'created' : 'joined'})`,
    );
    console.log(`[buzz] repo: ${result.runtime.rooms[0]!.repo.root}`);
    console.log(`[buzz] agent pubkey: ${result.pairing.agent.pubkey}`);
    console.log(`[buzz] daemon started (pid ${result.pid})`);
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
  console.log(`[body] agent binary: ${config.agentBinary}`);
  console.log(`[body] mcp binary: ${config.mcpBinary}`);
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
