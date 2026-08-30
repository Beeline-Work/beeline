#!/usr/bin/env node
/**
 * End-to-end acceptance proof for agent pairing in an invite-only Workspace.
 *
 * The proof deliberately starts the agent as a fresh outsider and first
 * asserts that it cannot see the Workspace roster. The relay stays globally
 * open: NIP-29 visibility on this one Workspace must enforce the boundary.
 *
 * Local invocation:
 *   docker compose -p buzzy-private-pairing -f relay-stack/compose.yml up -d
 *   npm run prove:private-pairing
 */
import { createBuzzClient, createIdentity, type BuzzClient } from '@beeline/buzz-client';
import { randomUUID } from 'node:crypto';

const relayUrl = (process.env.RELAY_URL ?? 'http://127.0.0.1:3010').replace(/\/$/, '');
const relayHost = process.env.BUZZY_RELAY_HOST ?? new URL(relayUrl).host;

async function cleanUp(
  ownerClient: BuzzClient,
  workspaceId: string,
  agentPubkey: string,
): Promise<void> {
  await ownerClient.removeAgent(workspaceId, agentPubkey).catch(() => undefined);
  await ownerClient.archiveRoom(workspaceId).catch(() => undefined);
}

async function main(): Promise<void> {
  const runId = randomUUID();
  const owner = createIdentity(`private-pairing-owner-${runId}`);
  const agent = createIdentity(`private-pairing-agent-${runId}`);
  const ownerClient = createBuzzClient({ baseUrl: relayUrl, host: relayHost, identity: owner });
  const agentClient = createBuzzClient({ baseUrl: relayUrl, host: relayHost, identity: agent });
  let workspaceId = '';

  try {
    workspaceId = await ownerClient.createCommunity(`Private pairing acceptance ${runId}`, {
      visibility: 'invite-only',
    });
    await ownerClient.waitUntilMember(workspaceId, owner.publicKey);

    const pairing = await ownerClient.createAgentPairingCode(workspaceId, 600);
    const outsiderRoster = await agentClient.communityMembers(workspaceId);
    if (outsiderRoster.length !== 0) {
      throw new Error(
        'acceptance precondition failed: outsider can read the Workspace roster; ' +
          'the Workspace must be created with invite-only visibility',
      );
    }

    const redemption = await agentClient.redeemAgentPairingCode(pairing.code);
    const [members, agents] = await Promise.all([
      ownerClient.communityMembers(workspaceId),
      ownerClient.listAgents(workspaceId, { forceRefresh: true }),
    ]);
    if (
      redemption.communityId !== workspaceId ||
      redemption.pairedBy !== owner.publicKey ||
      !redemption.joined ||
      !members.some((member) => member.pubkey === agent.publicKey) ||
      !agents.some((candidate) => candidate.pubkey === agent.publicKey)
    ) {
      throw new Error('private pairing redemption did not produce a visible joined agent');
    }

    console.log(
      JSON.stringify({
        ok: true,
        relayUrl,
        workspaceId,
        owner: owner.publicKey,
        agent: agent.publicKey,
        outsiderRosterBeforeJoin: outsiderRoster.length,
        joined: redemption.joined,
      }),
    );
  } finally {
    if (workspaceId) await cleanUp(ownerClient, workspaceId, agent.publicKey);
    ownerClient.disconnect();
    agentClient.disconnect();
  }
}

main().catch((error) => {
  console.error(`[private-pairing] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
