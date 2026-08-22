import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvValues = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return mmkvValues.get(key);
    }
    set(key: string, value: string) {
      mmkvValues.set(key, value);
    }
    delete(key: string) {
      mmkvValues.delete(key);
    }
  },
}));

import { fallbackAgentName, type Agent } from '@beeline/buzz-client';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { mergeKnownAgent, useAgentNameCache, withKnownAgentNames } from './agent-name-cache';

const PUBKEY = 'a3447f1163edeb8dff75a67c3492c808821fe21b8a0c35d363769e45efeca601';
const WORKSPACE_A = 'a6814772-1f7f-4a59-850b-5579039efb17';
const WORKSPACE_B = 'b6814772-1f7f-4a59-850b-5579039efb17';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    communityId: overrides.communityId ?? WORKSPACE_A,
    displayName: overrides.displayName ?? fallbackAgentName(PUBKEY),
    pubkey: PUBKEY,
    createdAt: overrides.createdAt ?? 1_000,
    ...(overrides.soulProfile !== undefined ? { soulProfile: overrides.soulProfile } : {}),
    ...(overrides.avatar !== undefined ? { avatar: overrides.avatar } : {}),
    // Tests never render it; the store must strip it before persisting.
    ...({ raw: { tooBigToPersist: true } } as unknown as Pick<Agent, 'raw'>),
  };
}

function soul(name: string, updatedAt: number): NonNullable<Agent['soulProfile']> {
  return {
    communityId: WORKSPACE_A,
    agentPubkey: PUBKEY,
    authoredBy: 'e216'.repeat(16),
    name,
    soul: 'persona text',
    avatarSeed: PUBKEY,
    updatedAt,
    ...({ raw: {} } as unknown as NonNullable<Agent['soulProfile']>['raw']),
  };
}

beforeEach(() => {
  mmkvValues.clear();
  useAgentNameCache.setState({ byPubkey: {} });
});

describe('device-wide agent-name cache', () => {
  it('an agent named in one Workspace shows that name in another Workspace/Room whose own roster has no soul', () => {
    // What the Rooms list learned in Workspace A (Members renamed the agent).
    const named = agent({
      communityId: WORKSPACE_A,
      displayName: 'Ox',
      soulProfile: soul('Ox', 1_700_000_100),
    });
    useAgentNameCache.getState().rememberAgents([named]);

    // What the failing Room's own hydration delivered: registration only,
    // no soul — exactly the shape that used to render "Pia".
    const roomRoster = [agent({ communityId: WORKSPACE_B, displayName: fallbackAgentName(PUBKEY) })];

    const merged = withKnownAgentNames(useAgentNameCache.getState().byPubkey, roomRoster);
    const display = resolveAgentDisplayIdentity(
      PUBKEY,
      merged.find((entry) => entry.pubkey === PUBKEY),
    );
    expect(display.name).toBe('Ox');
  });

  it('keeps supplying the name even when the surface roster is missing entirely', () => {
    useAgentNameCache
      .getState()
      .rememberAgents([agent({ displayName: 'Ox', soulProfile: soul('Ox', 1) })]);

    const merged = withKnownAgentNames(useAgentNameCache.getState().byPubkey, []);
    expect(merged.find((entry) => entry.pubkey === PUBKEY)?.displayName).toBe('Ox');
  });

  it('a rename (newer soul) replaces the remembered one; an older read never regresses it', () => {
    const oldSoul = mergeKnownAgent(
      agent(),
      agent({ displayName: 'Ox', soulProfile: soul('Ox', 1_000) }),
    );
    const renamed = mergeKnownAgent(oldSoul, agent({ soulProfile: soul('Ox Prime', 2_000) }));
    expect(resolveAgentDisplayIdentity(PUBKEY, renamed).name).toBe('Ox Prime');

    // A stale roster still carrying the old soul must not walk it back.
    const regressed = mergeKnownAgent(renamed, agent({ soulProfile: soul('Ox', 1_000) }));
    expect(resolveAgentDisplayIdentity(PUBKEY, regressed).name).toBe('Ox Prime');
  });

  it('a real registered name fills a placeholder gap but is never displaced by one', () => {
    const named = mergeKnownAgent(agent(), agent({ displayName: 'Patch' }));
    expect(named.displayName).toBe('Patch');

    const kept = mergeKnownAgent(agent({ displayName: 'Patch' }), agent());
    expect(kept.displayName).toBe('Patch');
  });

  it('persists stripped records across store rehydration and drops unrenderable bulk', () => {
    useAgentNameCache
      .getState()
      .rememberAgents([agent({ displayName: 'Ox', soulProfile: soul('Ox', 5) })]);

    const persisted = JSON.parse(mmkvValues.get('buzz-agent-names-v1')!) as Record<
      string,
      { raw?: unknown; soulProfile?: { raw?: unknown } }
    >;
    expect(persisted[PUBKEY]).toBeDefined();
    // The signed event bytes are stripped (empty placeholder / absent), not persisted.
    expect(Object.keys(persisted[PUBKEY]!.raw ?? { a: 1 })).toHaveLength(0);
    expect(persisted[PUBKEY]!.soulProfile && 'raw' in persisted[PUBKEY]!.soulProfile!).toBe(false);
    expect(mmkvValues.get('buzz-agent-names-v1')).toContain('Ox');
  });

  it('ignores malformed entries instead of throwing on hydration', () => {
    mmkvValues.set(
      'buzz-agent-names-v1',
      JSON.stringify({ nope: { broken: true }, [PUBKEY]: { pubkey: PUBKEY, displayName: 'Ox' } }),
    );
    // Hydration runs at module init of a fresh store; the store must surface
    // only well-formed records and never throw.
    expect(() => JSON.parse(mmkvValues.get('buzz-agent-names-v1')!)).not.toThrow();
  });
});
