import { describe, expect, it } from 'vitest';
import { createIdentity } from './identity.js';
import {
  agentAccessConfigKey,
  buildAgentAccessConfig,
  parseAgentAccessConfig,
} from './agent-access-config.js';

describe('paired-owner agent access config', () => {
  it('round-trips an exact allowlist without implicitly adding the signer', () => {
    const owner = createIdentity();
    const agent = createIdentity();
    const atlas = createIdentity();
    const event = buildAgentAccessConfig(owner, {
      version: 1,
      workspaceId: 'workspace-one',
      agentPubkey: agent.publicKey,
      policy: 'allowlist',
      allowlist: [atlas.publicKey],
      revision: 1,
      updatedAt: 100,
    });
    expect(parseAgentAccessConfig(event)).toMatchObject({
      policy: 'allowlist',
      allowlist: [atlas.publicKey],
    });
    expect(parseAgentAccessConfig(event)?.allowlist).not.toContain(owner.publicKey);
    expect(event.tags).toContainEqual([
      'd',
      agentAccessConfigKey('workspace-one', agent.publicKey),
    ]);
  });

  it('rejects missing, duplicate, and malformed lists plus conflicting tags', () => {
    const owner = createIdentity();
    const agent = createIdentity();
    expect(() =>
      buildAgentAccessConfig(owner, {
        version: 1,
        workspaceId: 'workspace-one',
        agentPubkey: agent.publicKey,
        policy: 'allowlist',
        revision: 1,
        updatedAt: 100,
      }),
    ).toThrow(/invalid agent access config/);
    expect(() =>
      buildAgentAccessConfig(owner, {
        version: 1,
        workspaceId: 'workspace-one',
        agentPubkey: agent.publicKey,
        policy: 'allowlist',
        allowlist: [owner.publicKey, owner.publicKey],
        revision: 1,
        updatedAt: 100,
      }),
    ).toThrow(/invalid agent access config/);

    const valid = buildAgentAccessConfig(owner, {
      version: 1,
      workspaceId: 'workspace-one',
      agentPubkey: agent.publicKey,
      policy: 'creator',
      revision: 1,
      updatedAt: 100,
    });
    valid.tags.push(['policy', 'everyone']);
    expect(parseAgentAccessConfig(valid)).toBeUndefined();
  });
});
