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
import { buildAgentEnv, loadBodyConfig, BASE_URL } from './config.js';
import { Body } from './body.js';
import { newIdentity, type Identity } from '@buzzy/gate';
import { createChannel, setMemberRole, queryEvents } from '@buzzy/gate';
import { decodeNsec, getPublicKey } from '@buzzy/nostr';
import { createBuzzClient } from '@buzzy/buzz-client';
import { createSoulServer } from './soul-server.js';

function identityFromKey(value: string | undefined, name: string): Identity {
  if (!value) return newIdentity(name);
  const secretKey = value.startsWith('nsec1')
    ? decodeNsec(value)
    : Uint8Array.from(Buffer.from(value, 'hex'));
  if (secretKey.length !== 32) throw new Error(`${name} key must be 32-byte hex or nsec`);
  return { name, secretKey, publicKey: getPublicKey(secretKey) };
}

function usage(): void {
  console.error(`
Buzzy Body — agent session manager.

Usage:
  body provision <channel-uuid>          Attach read-only agent to a TLC
  body serve <channel-uuid> <owner> <repo>  Watch human requests and run the full branch loop
  body open <channel-uuid> <owner> <repo>  Open subchannel + edit session
  body archive <subchannel-uuid>         Archive subchannel
  body create-and-provision <name>       Create a new TLC + provision agent
  buzz pair <BUZZ-XXXX-XXXX>             Pair this machine's agent identity
  buzz serve-souls                       Run the server-held soul generator

Options:
  --workspace-root <path>   Agent workspace (default: ./body-workspace)
  --llm-env-file <path>     Path to LLM credentials env file
  --agent-key <nsec>        Agent Nostr secret (hex or nsec)

All other config via env vars (see config.ts).
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const command = args[0];

  // Parse optional flags.
  const llmEnvFile = process.env.BUZZY_BODY_LLM_FILE;
  const workspaceRoot = process.env.BUZZY_BODY_WORKSPACE ?? './body-workspace';
  const agentPrivateKey = process.env.BUZZ_AGENT_KEY ?? process.env.BUZZ_PRIVATE_KEY;

  if (command === 'pair') {
    const code = args[1];
    if (!code) usage();
    if (!agentPrivateKey) {
      throw new Error('BUZZ_AGENT_KEY is required so the paired identity remains on this machine');
    }
    const agentIdentity = identityFromKey(agentPrivateKey, 'buzzy-agent');
    const relayBaseUrl = (process.env.BUZZY_RELAY_URL ?? BASE_URL)
      .replace(/^ws/, 'http')
      .replace(/\/$/, '');
    const client = createBuzzClient({
      baseUrl: relayBaseUrl,
      ...(process.env.BUZZY_RELAY_HOST ? { host: process.env.BUZZY_RELAY_HOST } : {}),
      identity: agentIdentity,
    });
    const result = await client.redeemAgentPairingCode(code!);
    console.log(`[buzz] paired agent ${result.agent.displayName}`);
    console.log(`[buzz] community: ${result.communityId}`);
    console.log(`[buzz] agent pubkey: ${result.agent.pubkey}`);
    return;
  }

  if (command === 'serve-souls') {
    const agentEnv = buildAgentEnv(process.env, llmEnvFile);
    const port = Number(process.env.BUZZY_SOUL_PORT ?? '8789');
    const host = process.env.BUZZY_SOUL_HOST ?? '127.0.0.1';
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('BUZZY_SOUL_PORT must be a valid port');
    }
    const server = createSoulServer(agentEnv);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    console.log(`[buzz] soul generator listening on http://${host}:${port}`);
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
