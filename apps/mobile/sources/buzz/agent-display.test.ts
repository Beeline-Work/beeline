import { describe, expect, it } from 'vitest';

import {
  agentRosterCommunityIds,
  fallbackAgentName,
  mergeAgentRosters,
  resolveAgentDisplayIdentity,
  resolveCornerCardAgentPubkey,
  resolvePendingAgentDisplay,
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

  it('uses a soul overlay for personality and avatar seed, not a competing name', () => {
    const pubkey = 'agent-public-key';
    const display = resolveAgentDisplayIdentity(pubkey, {
      pubkey,
      avatar: 'https://example.test/agent.png',
      soulProfile: {
        communityId: 'workspace',
        agentPubkey: pubkey,
        authoredBy: 'human-public-key',
        name: 'Ada',
        soul: 'Keeps the suite green.',
        avatarSeed: 'chrome-warden-soul',
        avatar: 'https://example.test/ada-soul.png',
        updatedAt: 1,
        raw: {} as never,
      },
    });

    expect(display).toMatchObject({
      name: fallbackAgentName(pubkey),
      handle: fallbackAgentName(pubkey).toLowerCase(),
      personality: 'Keeps the suite green.',
      avatarSeed: 'chrome-warden-soul',
      avatarUrl: 'https://example.test/ada-soul.png',
      hasSoul: true,
    });
  });

  it('does not let a compound soul name replace the declaration handle', () => {
    const pubkey = 'legacy-agent';
    const display = resolveAgentDisplayIdentity(pubkey, {
      pubkey,
      soulProfile: {
        communityId: 'workspace',
        agentPubkey: pubkey,
        authoredBy: 'human',
        name: 'Chrome Warden',
        soul: 'Legacy copy.',
        avatarSeed: pubkey,
        updatedAt: 1,
        raw: {} as never,
      },
    });
    expect(display.name).toBe(fallbackAgentName(pubkey));
    expect(display.handle).toBe(fallbackAgentName(pubkey).toLowerCase());
    expect(display.hasSoul).toBe(true);
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

  it('keeps the registered declaration name when a soul has a different name', () => {
    const pubkey = 'beebee-pubkey';
    const display = resolveAgentDisplayIdentity(pubkey, {
      pubkey,
      displayName: 'Beebee',
      soulProfile: {
        communityId: 'workspace',
        agentPubkey: pubkey,
        authoredBy: 'human-public-key',
        name: 'Ada',
        soul: 'Keeps the suite green.',
        avatarSeed: 'chrome-warden-soul',
        updatedAt: 1,
        raw: {} as never,
      },
    });

    expect(display.name).toBe('Beebee');
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
      soul: 'Reads the whole file before touching it.',
      avatarSeed: 'beebee-soul',
      updatedAt: 1,
      raw: {} as never,
    },
  };

  it('reads the channel’s own Workspace first, then the viewer’s, then the rest', () => {
    expect(
      agentRosterCommunityIds('workspace-1', 'workspace-2', ['workspace-2', 'workspace-3']),
    ).toEqual(['workspace-1', 'workspace-2', 'workspace-3']);
  });

  it('still reads every Workspace when the channel resolves none', () => {
    // A Room whose kind:9007 predates the redundant `community` tag, a
    // local-only Room, or a corner beneath either. Reading nothing here is what
    // left the transcript naming every agent with a placeholder.
    for (const missing of [null, undefined, '', '   ']) {
      expect(agentRosterCommunityIds(missing, 'workspace-2', ['workspace-3'])).toEqual([
        'workspace-2',
        'workspace-3',
      ]);
    }
  });

  it('never repeats a Workspace, however many ways it arrives', () => {
    expect(
      agentRosterCommunityIds('workspace-1', 'workspace-1', ['workspace-1', 'workspace-1']),
    ).toEqual(['workspace-1']);
  });

  it('has nothing to read when nothing is known', () => {
    expect(agentRosterCommunityIds(null, null, [])).toEqual([]);
    expect(agentRosterCommunityIds(undefined, undefined)).toEqual([]);
  });

  it('merges rosters with the channel’s own Workspace winning', () => {
    const channelRoster = [{ ...rosterEntry, displayName: 'Beebee' }];
    const otherRoster = [
      { ...rosterEntry, displayName: 'Elsewhere', soulProfile: undefined },
    ];
    const merged = mergeAgentRosters([channelRoster, otherRoster]);
    expect(resolveAgentDisplayIdentity(beebee, merged.get(beebee)).name).toBe('Beebee');
  });

  it('lets a later Workspace fill a gap the first one cannot name', () => {
    // A roster row that carries neither an overlay nor a displayName can only
    // produce the placeholder, so it must not block a Workspace that can name
    // the same agent.
    const unnamed = [{ pubkey: beebee, displayName: '', soulProfile: undefined }];
    const named = [rosterEntry];
    const merged = mergeAgentRosters([unnamed, named]);
    expect(resolveAgentDisplayIdentity(beebee, merged.get(beebee)).name).toBe('Beebee');
  });

  it('lets a later Workspace’s soul override an earlier Workspace’s unsouled pairing registration', () => {
    // `redeemAgentPairingCode` registers every fresh agent with
    // `displayName: fallbackAgentName(pubkey)` — never an empty string. An
    // agent paired into a second Workspace (or attached there some other way)
    // carries exactly that placeholder displayName in that Workspace's
    // roster, with no soul overlay. This regressed the transcript ("Alden")
    // while the Members screen, scoped to the one Workspace that actually
    // authored the soul, kept showing the real name ("Beebee") for the
    // identical pubkey.
    const unsouledPairingRegistration = [
      { pubkey: beebee, displayName: fallbackAgentName(beebee), soulProfile: undefined },
    ];
    const souledWorkspace = [rosterEntry];
    const merged = mergeAgentRosters([unsouledPairingRegistration, souledWorkspace]);
    expect(resolveAgentDisplayIdentity(beebee, merged.get(beebee)).name).toBe('Beebee');
  });

  it('keeps a later soulProfile without letting it rename an earlier declaration', () => {
    // The merge must UNION fields across entries for the same pubkey, not
    // keep one whole incoming object and discard the other. A pairing-only
    // entry from one Workspace (real displayName, e.g. a human-typed name
    // that happens not to be the seed fallback, so the earlier "unnamed"
    // check alone cannot catch it) must not block a later Workspace's
    // soulProfile from ever being merged in for the identical pubkey.
    const pairingOnly = [{ pubkey: beebee, displayName: 'Alden', soulProfile: undefined }];
    const souledWorkspace = [
      { pubkey: beebee, displayName: '', soulProfile: rosterEntry.soulProfile },
    ];
    const merged = mergeAgentRosters([pairingOnly, souledWorkspace]);
    expect(merged.get(beebee)?.soulProfile).toEqual(rosterEntry.soulProfile);
    expect(resolveAgentDisplayIdentity(beebee, merged.get(beebee)).name).toBe('Alden');
  });

  it('ignores roster rows with no pubkey rather than keying on undefined', () => {
    const merged = mergeAgentRosters([[{ pubkey: '', displayName: 'x' }], [rosterEntry]]);
    expect(merged.size).toBe(1);
    expect(merged.get(beebee)).toBeTruthy();
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

  it('never renders the seed fallback while the soul is still loading, only the real name once it lands', () => {
    // Before hydration, nothing is known about this agent yet — not even
    // whether it has a soul — so there must be no display at all (callers
    // fall back to a neutral placeholder), never the confident-but-wrong
    // seed name a resolved-but-empty roster would produce.
    expect(resolvePendingAgentDisplay(beebee, undefined, false)).toBeNull();
    // A resolved-but-empty roster before hydration is the same "unknown" case.
    expect(resolvePendingAgentDisplay(beebee, undefined, false)).toBeNull();
    // Once the roster has hydrated and the soul is present, it snaps straight
    // to the real name — never through the seed placeholder.
    expect(resolvePendingAgentDisplay(beebee, rosterEntry, true)?.name).toBe('Beebee');
    expect(resolvePendingAgentDisplay(beebee, rosterEntry, true)?.name).not.toBe(
      fallbackAgentName(beebee),
    );
  });
});
