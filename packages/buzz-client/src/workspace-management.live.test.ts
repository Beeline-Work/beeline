/** Relay-backed proof for every write used by the mobile Members management surface. */
import { describe, expect, it, onTestFinished } from 'vitest';
import { publishAgentModelCatalog } from './agent-model-config.js';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_HOST,
  isRelayUp,
  uniqueMarker,
  waitFor,
} from './live-helpers.js';

const reachable = await isRelayUp();
const identityResolverAvailable =
  reachable &&
  (await fetch(`${DEFAULT_BASE_URL}/auth/oidc/current/${'0'.repeat(64)}`, {
    headers: { host: DEFAULT_HOST },
    signal: AbortSignal.timeout(3_000),
  })
    .then((response) => response.status !== 404)
    .catch(() => false));

describe.runIf(identityResolverAvailable)('live Workspace member management', () => {
  it('invites, changes role, configures and renames an agent, then removes it', async () => {
    const marker = uniqueMarker('workspace-management');
    const owner = createIdentity(`${marker}-owner`);
    const invitee = createIdentity(`${marker}-invitee`);
    const agent = createIdentity(`${marker}-agent`);
    const ownerClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: owner,
    });
    const inviteeClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: invitee,
    });
    const agentClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: agent,
    });
    onTestFinished(() => {
      ownerClient.disconnect();
      inviteeClient.disconnect();
      agentClient.disconnect();
    });

    const workspaceId = await ownerClient.createCommunity(`workspace-${marker}`);
    await ownerClient.waitUntilMember(workspaceId, owner.publicKey);

    const invite = await ownerClient.createInvite(workspaceId, { expiresInSeconds: 3_600 });
    await expect(inviteeClient.redeemInvite(invite.token)).resolves.toMatchObject({
      communityId: workspaceId,
      joined: true,
    });
    await ownerClient.waitUntilMemberRole(workspaceId, invitee.publicKey, 'member');
    await ownerClient.addMember(workspaceId, invitee.publicKey, 'admin');
    await ownerClient.waitUntilMemberRole(workspaceId, invitee.publicKey, 'admin');

    const pairing = await ownerClient.createAgentPairingCode(workspaceId);
    await expect(agentClient.redeemAgentPairingCode(pairing.code)).resolves.toMatchObject({
      communityId: workspaceId,
      joined: true,
    });
    await ownerClient.waitUntilMember(workspaceId, agent.publicKey);

    await publishAgentModelCatalog(
      {
        http: { baseUrl: DEFAULT_BASE_URL, host: DEFAULT_HOST, identity: agent },
        identity: agent,
      },
      workspaceId,
      [
        {
          id: 'model',
          category: 'model',
          currentValue: 'gpt-5.6',
          options: [{ id: 'gpt-5.6' }, { id: 'gpt-5.6-mini' }],
        },
        {
          id: 'effort',
          category: 'effort',
          currentValue: 'medium',
          options: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
        },
        {
          id: 'mode',
          category: 'mode',
          currentValue: 'read-only',
          options: [{ id: 'read-only' }, { id: 'edit' }],
        },
      ],
    );
    await ownerClient.setAgentModelConfig(workspaceId, agent.publicKey, {
      model: 'gpt-5.6-mini',
      effort: 'high',
    });
    const soul = await ownerClient.setAgentSoul(workspaceId, agent.publicKey, {
      name: 'Renamed Agent',
      soul: 'Keeps Workspace changes small, safe, and verified.',
      avatarSeed: agent.publicKey,
    });
    expect(soul).toMatchObject({
      communityId: workspaceId,
      agentPubkey: agent.publicKey,
      name: 'Renamed Agent',
      authoredBy: owner.publicKey,
    });

    let observed = '';
    await waitFor(
      async () => {
        const [catalog, config] = await Promise.all([
          ownerClient.getAgentModelCatalog(workspaceId, agent.publicKey),
          ownerClient.getAgentModelConfig(workspaceId, agent.publicKey),
        ]);
        observed = JSON.stringify({
          categories: catalog?.options.map((axis) => axis.category),
          config: config ? { model: config.model, effort: config.effort } : null,
        });
        return (
          catalog?.options.map((axis) => axis.category).join(',') === 'model,effort' &&
          config?.model === 'gpt-5.6-mini' &&
          config.effort === 'high'
        );
      },
      { timeoutMs: 30_000, label: 'agent catalog, config, and soul projection' },
    ).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; last=${observed}`,
      );
    });

    await ownerClient.removeAgent(workspaceId, agent.publicKey);
    await waitFor(
      async () =>
        !(await ownerClient.isMember(workspaceId, agent.publicKey)) &&
        !(await ownerClient.listAgents(workspaceId)).some(
          (candidate) => candidate.pubkey === agent.publicKey,
        ),
      { timeoutMs: 30_000, label: 'agent removal projection' },
    );

    console.log(
      `[live-workspace-management] workspace=${workspaceId} invite=true role=admin ` +
        'owner-protected=true model=gpt-5.6-mini effort=high mode-hidden=true ' +
        'name="Renamed Agent" removed=true',
    );
  }, 120_000);
});
