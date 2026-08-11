/** Live proof that both explicit serve and paired-daemon startup fail closed. */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { signEvent } from '@beeline/nostr';
import {
  BASE_URL,
  HOST,
  createChannel,
  newIdentity,
  publishEvent,
  setMemberRole,
} from '@beeline/gate';
import { Body } from './body.js';
import type { BodyConfig } from './config.js';

async function relayReachable(): Promise<boolean> {
  try {
    return (
      await fetch(`${BASE_URL}/health`, {
        headers: { host: HOST },
        signal: AbortSignal.timeout(3_000),
      })
    ).ok;
  } catch {
    return false;
  }
}

const relayUp = await relayReachable();

describe.runIf(relayUp)('live startup branch protection', () => {
  it('refuses body serve and paired Room startup when protection is absent', async () => {
    const human = newIdentity('startup-human');
    const agent = newIdentity('startup-agent');
    const room = await createChannel(human, `unsafe-${randomUUID()}`);
    await setMemberRole(human, room, agent.publicKey, 'member');
    const repo = `unsafe-${randomUUID()}`;
    await publishEvent(
      signEvent(
        {
          pubkey: human.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 30617,
          tags: [
            ['d', repo],
            ['name', repo],
            ['buzz-channel', room],
          ],
          content: '',
        },
        human.secretKey,
      ),
      human,
    );
    const config: BodyConfig = {
      agentBinary: '/bin/false',
      mcpBinary: '/bin/false',
      agentEnv: {},
      workspaceRoot: '/tmp',
      relayBaseUrl: BASE_URL,
      relayHost: HOST,
      relayScheme: 'http',
      relayWsUrl: BASE_URL.replace(/^http/, 'ws'),
      autoApprovePermissions: false,
    };
    const boundRepo = {
      ownerHex: human.publicKey,
      repo,
      targetBranch: 'refs/heads/main',
      repositoryKey: 'unsafe-repository',
    };

    const serveBody = new Body(config, human, agent);
    await expect(serveBody.runChannelLoop(room, boundRepo)).rejects.toThrow(
      'provisioning check failed',
    );

    const pairedBody = new Body(config, human, agent);
    await expect(pairedBody.runRepositoryRoomLoop('workspace', room, boundRepo)).rejects.toThrow(
      'provisioning check failed',
    );
    console.log('[live-startup-protection] missing-protection=FAILED-CLOSED');
  });
});

if (!relayUp) {
  describe('live startup branch protection (prerequisite)', () => {
    it('SKIPPED — requires relay', () => {
      console.warn('Start with `npm run stack:up`.');
    });
  });
}
