import { describe, expect, it } from 'vitest';
import {
  AGENT_PRESENCE_STALE_MS,
  isAgentPresenceOnline,
  newerAgentPresence,
  type AgentPresence,
} from './agent-presence.js';

const online: AgentPresence = {
  agentPubkey: 'a'.repeat(64),
  status: 'online',
  observedAt: 1_000,
};

describe('agent presence lease', () => {
  it('expires an online heartbeat after the staleness window', () => {
    expect(isAgentPresenceOnline(online, 1_000 + AGENT_PRESENCE_STALE_MS)).toBe(true);
    expect(isAgentPresenceOnline(online, 1_001 + AGENT_PRESENCE_STALE_MS)).toBe(false);
    expect(isAgentPresenceOnline({ ...online, status: 'offline' }, 1_000)).toBe(false);
    expect(isAgentPresenceOnline(undefined, 1_000)).toBe(false);
  });

  it('lets an explicit offline marker win a same-second timestamp tie', () => {
    expect(newerAgentPresence(online, { ...online, status: 'offline' }).status).toBe('offline');
    expect(newerAgentPresence({ ...online, status: 'offline' }, online).status).toBe('offline');
    expect(
      newerAgentPresence(online, { ...online, status: 'offline', observedAt: 2_000 }).status,
    ).toBe('offline');
  });
});
