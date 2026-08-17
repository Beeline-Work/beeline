import { describe, expect, it } from 'vitest';

import {
  agentRosterCommunityId,
  fallbackAgentName,
  resolveAgentDisplayIdentity,
  resolveCornerCardAgentPubkey,
} from './agent-display';

describe('agent display identity', () => {
  it('creates a stable friendly fallback without exposing key fragments', () => {
    const pubkey = 'abcdef0123456789abcdef0123456789';
    const first = resolveAgentDisplayIdentity(pubkey);

    expect(first).toEqual(resolveAgentDisplayIdentity(pubkey));
    expect(first.name).toMatch(/^[A-Z][a-z]+$/);
    expect(first.handle).toBe(first.name.toLowerCase());
    expect(first.name.toLowerCase()).not.toContain(pubkey.slice(0, 6));
    expect(first.avatarSeed).toBe(pubkey);
  });

  it('uses a validated soul overlay for name, personality, and avatar seed', () => {
    const pubkey = 'agent-public-key';
    const display = resolveAgentDisplayIdentity(pubkey, {
      pubkey,
      avatar: 'https://example.test/agent.png',
      soulProfile: {
        communityId: 'workspace',
        agentPubkey: pubkey,
        authoredBy: 'human-public-key',
        name: 'Ada',
        personality: 'Keeps the suite green.',
        avatarSeed: 'chrome-warden-soul',
        avatar: 'https://example.test/ada-soul.png',
        updatedAt: 1,
        raw: {} as never,
      },
    });

    expect(display).toMatchObject({
      name: 'Ada',
      handle: 'ada',
      personality: 'Keeps the suite green.',
      avatarSeed: 'chrome-warden-soul',
      avatarUrl: 'https://example.test/ada-soul.png',
      hasSoul: true,
    });
  });

  it('does not expose a legacy compound overlay as an agent handle', () => {
    const pubkey = 'legacy-agent';
    const display = resolveAgentDisplayIdentity(pubkey, {
      pubkey,
      soulProfile: {
        communityId: 'workspace',
        agentPubkey: pubkey,
        authoredBy: 'human',
        name: 'Chrome Warden',
        personality: 'Legacy copy.',
        avatarSeed: pubkey,
        updatedAt: 1,
        raw: {} as never,
      },
    });
    expect(display.name).toMatch(/^[A-Z][a-z]+$/);
    expect(display.handle).not.toContain('chrome');
    expect(display.hasSoul).toBe(false);
  });

  it('produces different names across representative keys', () => {
    expect(fallbackAgentName('agent-a')).not.toBe(fallbackAgentName('agent-b'));
  });

  it('uses the agent record displayName when there is no soul overlay', () => {
    const pubkey = 'beebee-pubkey';
    const display = resolveAgentDisplayIdentity(pubkey, {
      pubkey,
      displayName: 'Beebee',
    });

    expect(display.name).toBe('Beebee');
    expect(display.handle).toBe('beebee');
    expect(display.hasSoul).toBe(false);
  });

  it('prefers a validated soul overlay name over the agent record displayName', () => {
    const pubkey = 'beebee-pubkey';
    const display = resolveAgentDisplayIdentity(pubkey, {
      pubkey,
      displayName: 'Beebee',
      soulProfile: {
        communityId: 'workspace',
        agentPubkey: pubkey,
        authoredBy: 'human-public-key',
        name: 'Ada',
        personality: 'Keeps the suite green.',
        avatarSeed: 'chrome-warden-soul',
        updatedAt: 1,
        raw: {} as never,
      },
    });

    expect(display.name).toBe('Ada');
  });

  it('falls back to the pubkey-derived name only when neither an overlay nor a displayName is known', () => {
    const pubkey = 'no-name-known-pubkey';
    const display = resolveAgentDisplayIdentity(pubkey, { pubkey });

    expect(display.name).toBe(fallbackAgentName(pubkey));
  });
});

describe('corner card agent identity resolution', () => {
  const registered = new Set(['beebee-pubkey']);
  const isRegisteredAgent = (pubkey: string) => registered.has(pubkey);

  it('uses the declared agent pubkey when it is a registered agent', () => {
    expect(
      resolveCornerCardAgentPubkey('beebee-pubkey', 'someone-else', isRegisteredAgent),
    ).toBe('beebee-pubkey');
  });

  it('falls back to the message signer when the declared tag misses the roster', () => {
    // A stale/mismatched `agent` tag must not force the pubkey-hash fallback
    // name ("Alden") when the event's own signer is a known registered agent.
    expect(
      resolveCornerCardAgentPubkey('stale-tag-pubkey', 'beebee-pubkey', isRegisteredAgent),
    ).toBe('beebee-pubkey');
  });

  it('prefers the declared pubkey when both resolve (no signer ambiguity)', () => {
    const bothRegistered = (pubkey: string) => pubkey === 'a' || pubkey === 'b';
    expect(resolveCornerCardAgentPubkey('a', 'b', bothRegistered)).toBe('a');
  });

  it('falls back to whatever is available when neither resolves', () => {
    expect(resolveCornerCardAgentPubkey('unknown', 'also-unknown', isRegisteredAgent)).toBe(
      'unknown',
    );
    expect(resolveCornerCardAgentPubkey(undefined, 'also-unknown', isRegisteredAgent)).toBe(
      'also-unknown',
    );
    expect(resolveCornerCardAgentPubkey(undefined, undefined, isRegisteredAgent)).toBeUndefined();
  });
});

describe('the transcript’s agent roster', () => {
  const beebee = 'beebee-agent-pubkey';
  /** Exactly what `client.listAgents(communityId)` hydrates for one agent. */
  const rosterEntry = {
    pubkey: beebee,
    displayName: 'Beebee',
    soulProfile: {
      communityId: 'workspace-1',
      agentPubkey: beebee,
      authoredBy: 'human-public-key',
      name: 'Beebee',
      personality: 'Reads the whole file before touching it.',
      avatarSeed: 'beebee-soul',
      updatedAt: 1,
      raw: {} as never,
    },
  };

  it('reads the channel’s own Workspace whenever the channel resolves one', () => {
    expect(agentRosterCommunityId('workspace-1', 'workspace-2')).toBe('workspace-1');
    expect(agentRosterCommunityId('workspace-1', null)).toBe('workspace-1');
  });

  it('falls back to the viewer’s selected Workspace when the channel resolves none', () => {
    // A Room whose kind:9007 predates the redundant `community` tag, a
    // local-only Room, or a corner beneath either.
    expect(agentRosterCommunityId(null, 'workspace-1')).toBe('workspace-1');
    expect(agentRosterCommunityId(undefined, 'workspace-1')).toBe('workspace-1');
    expect(agentRosterCommunityId('', 'workspace-1')).toBe('workspace-1');
  });

  it('has nothing to read when neither is known', () => {
    expect(agentRosterCommunityId(null, null)).toBeNull();
    expect(agentRosterCommunityId(undefined, undefined)).toBeNull();
  });

  it('is what decides between the real soul name and the seed placeholder', () => {
    // This is the whole reason the fallback above matters: with the roster, the
    // transcript names the agent exactly as the Members screen does; without
    // it, the identical pubkey renders a confident placeholder instead.
    const withRoster = new Map([[beebee, rosterEntry]]);
    const withoutRoster = new Map<string, typeof rosterEntry>();

    expect(resolveAgentDisplayIdentity(beebee, withRoster.get(beebee)).name).toBe('Beebee');
    expect(resolveAgentDisplayIdentity(beebee, withRoster.get(beebee)).handle).toBe('beebee');
    expect(resolveAgentDisplayIdentity(beebee, withoutRoster.get(beebee)).name).toBe(
      fallbackAgentName(beebee),
    );
    expect(fallbackAgentName(beebee)).not.toBe('Beebee');
  });

  it('still prefers the registered displayName when no human overlay exists', () => {
    const { soulProfile: _overlay, ...registeredOnly } = rosterEntry;
    expect(resolveAgentDisplayIdentity(beebee, registeredOnly).name).toBe('Beebee');
  });
});
