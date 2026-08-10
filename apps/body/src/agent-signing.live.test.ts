/** Live relay proof that Body's subchannel seam signs as the agent, not operator. */
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyEvent } from '@beeline/nostr';
import {
  BASE_URL,
  HOST,
  createChannel,
  newIdentity,
  queryEvents,
  setMemberRole,
} from '@beeline/gate';
import { createAgentSubchannel } from './body.js';

async function relayReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/health`, {
      headers: { host: HOST },
      signal: AbortSignal.timeout(2500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const reachable = await relayReachable();

describe.runIf(reachable)('live agent-signed subchannel creation', () => {
  beforeAll(() => {
    console.log(`[agent-signing] relay reachable at ${BASE_URL} — checking kind:9007 signer`);
  });

  it('the agent key, distinct from the human operator, creates the child channel', async () => {
    const operator = newIdentity('human-operator');
    const agent = newIdentity('coding-agent');
    const parent = await createChannel(operator, `human-tlc-${Date.now().toString(36)}`);
    await setMemberRole(operator, parent, agent.publicKey, 'member');

    const subchannel = await createAgentSubchannel(
      agent,
      parent,
      `agent-sub-${Date.now().toString(36)}`,
    );
    const events = await queryEvents(
      [{ kinds: [9007], '#h': [subchannel], limit: 5 }],
      operator.publicKey,
    );
    const created = events.find((event) =>
      event.tags.some((tag) => tag[0] === 'h' && tag[1] === subchannel),
    );

    expect(created).toBeDefined();
    expect(created?.pubkey).toBe(agent.publicKey);
    expect(created?.pubkey).not.toBe(operator.publicKey);
    expect(created && verifyEvent(created)).toBe(true);
    expect(created?.tags).toContainEqual(['parent', parent]);
    console.log(
      `[agent-signing] PASS subchannel=${subchannel} signer=agent:${agent.publicKey.slice(0, 12)}`,
    );
  }, 30_000);
});

describe.runIf(!reachable)('live agent-signed subchannel creation (relay unreachable)', () => {
  it('SKIPPED — relay not reachable; start with `npm run stack:up`', () => {
    console.warn(`[agent-signing] SKIPPED: relay at ${BASE_URL} is unreachable`);
    expect(true).toBe(true);
  });
});
