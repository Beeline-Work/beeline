import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_PRESENCE_STALE_MS,
  agentPresenceKey,
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

  it('tolerates the daemon clock running ahead of the reader (ordinary clock skew)', () => {
    // A live agent whose observedAt lands after the reader's own `now` must
    // still read online — this is the bug: a stale-forever "AGENT OFFLINE"
    // banner for a genuinely online, actively-replying agent.
    expect(isAgentPresenceOnline(online, 999)).toBe(true);
    expect(isAgentPresenceOnline(online, 1_000 - AGENT_PRESENCE_STALE_MS)).toBe(true);
    expect(isAgentPresenceOnline(online, 999 - AGENT_PRESENCE_STALE_MS)).toBe(false);
  });

  it('lets an explicit offline marker win a same-second timestamp tie', () => {
    expect(newerAgentPresence(online, { ...online, status: 'offline' }).status).toBe('offline');
    expect(newerAgentPresence({ ...online, status: 'offline' }, online).status).toBe('offline');
    expect(
      newerAgentPresence(online, { ...online, status: 'offline', observedAt: 2_000 }).status,
    ).toBe('offline');
  });
});


/**
 * A presence record is a parameterized-replaceable kind:30078 event, and the
 * relay indexes those by `d`. A `#h` filter over kind 30078 matches NOTHING —
 * even though the record does carry an `h` tag — so a reader that asks by `#h`
 * silently sees no presence at all and reports every agent offline forever.
 *
 * That is not a hypothetical: the Workspace-wide agents directory asked by
 * `#h` and did exactly this, while the per-Room readers (which spelled the `d`
 * key out by hand) worked. `agentPresenceKey` is the one builder they all
 * share now, and this is the assertion that keeps a future reader from
 * reaching for the tag that looks right and isn't.
 */
describe('presence is addressed by `d`, never by `h`', () => {
  const source = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

  it('builds the key the publisher writes', () => {
    expect(agentPresenceKey('7f2f9a35-eadd-4a25-812c-25deb554448d')).toBe(
      'agent-presence:7f2f9a35-eadd-4a25-812c-25deb554448d',
    );
  });

  it('never filters a presence read by `#h` anywhere in the client', () => {
    const client = source('client.ts');
    for (const [index, line] of client.split('\n').entries()) {
      if (!line.includes('KIND_AGENT_PRESENCE')) continue;
      // The filter object is the few lines around the kind.
      const window = client.split('\n').slice(index, index + 4).join('\n');
      expect(window, `client.ts:${index + 1} filters presence by #h`).not.toContain("'#h'");
    }
    expect(client).toContain('agentPresenceKey(channelId)');
  });

  it('leaves nobody spelling the key out by hand', () => {
    // A second literal is how the publisher and the readers drift apart.
    expect(source('client.ts')).not.toContain("`agent-presence:");
  });
});
