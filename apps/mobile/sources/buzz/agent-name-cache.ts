import { MMKV } from 'react-native-mmkv';
import { create } from 'zustand';
import type { Agent } from '@beeline/buzz-client';
import { canIdentifyAgent as namesItsAgent } from '@/buzz/agent-display';

/**
 * Device-wide best-known agent identity, keyed by pubkey.
 *
 * An agent's name must be ONE identity across every Room, corner, DM, and
 * Workspace on this device. The name lives in two relay records — the
 * self-signed registration (`displayName`) and the human-authored soul
 * overlay (`soulProfile.name`, which wins) — and both reach a surface only
 * through THAT surface's own roster read (`listAgents` of one community,
 * delivered per channel). A Room whose roster read failed, was cancelled by a
 * quick back-navigation, or painted from a cache written before the soul
 * existed has no cross-check: its resolver then produces
 * `fallbackAgentName(pubkey)` — a random-looking first name ("Pia"),
 * indistinguishable from the registered placeholder, in a Room sitting right
 * next to one that correctly shows "Ox" for the same key.
 *
 * This store is the cross-check. Every successful roster read anywhere (Rooms
 * list, Members directory, corners list, any chat hydration) warms it; every
 * name resolution may fold it under its own roster (`withKnownAgentNames`).
 *
 * Merge rules, deliberately narrow:
 * - a NEWER human-authored soul always replaces an older one (renames land);
 * - once any source supplies a soul it is never lost to a soulless record;
 * - a real registered name fills a placeholder gap but never displaces one;
 * - a fresher surface read wins everything else.
 *
 * Deliberately its own tiny MMKV store, same reasoning as
 * `room-read-state.ts`: written synchronously on a successful read, never
 * part of the transcript cache's background serialization.
 */
const STORAGE_KEY = 'buzz-agent-names-v1';
const MAX_TRACKED_AGENTS = 200;

const storage = new MMKV({ id: 'buzz-agent-names' });

type AgentNameState = {
  /** pubkey → best-known agent record (soul included when known anywhere). */
  byPubkey: Record<string, Agent>;
  rememberAgents: (agents: readonly Agent[]) => void;
};

/** Strip bulk we persist but never render: the full signed events. */
function stripRaw(agent: Agent): Agent {
  const { raw: _raw, ...rest } = agent;
  const soul = agent.soulProfile
    ? (omitRaw(agent.soulProfile) as NonNullable<Agent['soulProfile']>)
    : undefined;
  return {
    ...rest,
    // The event bytes are re-fetchable relay data; the persisted record keeps
    // only what name resolution reads.
    raw: {} as Agent['raw'],
    ...(soul ? { soulProfile: soul } : {}),
  };
}

function omitRaw<T extends { raw?: unknown }>(record: T): Omit<T, 'raw'> {
  const { raw: _raw, ...rest } = record;
  return rest;
}

function stripRawDeep<T extends { raw?: unknown }>(record: T): Omit<T, 'raw'> {
  const { raw: _raw, ...rest } = record;
  return rest;
}

function hydrate(): Record<string, Agent> {
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, Agent] =>
          Boolean(entry[1]) &&
          typeof entry[1] === 'object' &&
          typeof (entry[1] as Agent).pubkey === 'string' &&
          typeof (entry[1] as Agent).displayName === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function bounded(byPubkey: Record<string, Agent>): Record<string, Agent> {
  const entries = Object.entries(byPubkey);
  if (entries.length <= MAX_TRACKED_AGENTS) return byPubkey;
  return Object.fromEntries(
    entries.sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0)).slice(0, MAX_TRACKED_AGENTS),
  );
}

/**
 * Fold two records of ONE physical agent into the best-known identity.
 * `incoming` wins outright when it carries the newer human authority (the
 * soul); otherwise `existing` does — but whichever record loses still fills
 * gaps: its real registered name survives a placeholder on the winner, and
 * its avatar survives an absent one.
 */
export function mergeKnownAgent(existing: Agent, incoming: Agent): Agent {
  const incomingSoulNewer = Boolean(
    incoming.soulProfile &&
      (!existing.soulProfile || incoming.soulProfile.updatedAt > existing.soulProfile.updatedAt),
  );
  const base = incomingSoulNewer ? incoming : existing;
  const other = incomingSoulNewer ? existing : incoming;
  return {
    ...base,
    displayName: namesItsAgent(base)
      ? base.displayName
      : namesItsAgent(other)
        ? other.displayName
        : base.displayName,
    ...(base.avatar || !other.avatar ? {} : { avatar: other.avatar }),
  };
}

export const useAgentNameCache = create<AgentNameState>((set, get) => ({
  byPubkey: hydrate(),
  rememberAgents: (agents) => {
    if (agents.length === 0) return;
    const current = get().byPubkey;
    let changed = false;
    const next = { ...current };
    for (const agent of agents) {
      if (!agent?.pubkey) continue;
      const stripped = stripRaw(agent);
      const incumbent = next[agent.pubkey];
      const merged = incumbent ? mergeKnownAgent(incumbent, stripped) : stripped;
      if (incumbent === merged) continue;
      if (incumbent !== undefined && incumbent.soulProfile?.name === merged.soulProfile?.name) {
        // Same soul; only refresh when something else actually moved.
        if (
          incumbent.displayName === merged.displayName &&
          incumbent.avatar === merged.avatar &&
          incumbent.communityId === merged.communityId
        ) {
          continue;
        }
      }
      next[agent.pubkey] = merged;
      changed = true;
    }
    if (!changed) return;
    set({ byPubkey: bounded(next) });
    storage.set(STORAGE_KEY, JSON.stringify(get().byPubkey));
  },
}));

/**
 * Fold a surface's own roster with the device-wide best-known records.
 *
 * The surface's roster keeps precedence per field, but a soul known ANYWHERE
 * always survives the fold — so a Room whose own roster entry predates the
 * overlay (or never got one) still renders the human-chosen name its author
 * gave the agent elsewhere.
 */
export function withKnownAgentNames(
  cachedByPubkey: Record<string, Agent>,
  roster: readonly Agent[],
): Agent[] {
  const merged = new Map<string, Agent>();
  for (const agent of roster) {
    if (!agent?.pubkey) continue;
    const cached = cachedByPubkey[agent.pubkey];
    merged.set(agent.pubkey, cached ? mergeKnownAgent(cached, agent) : agent);
  }
  for (const [pubkey, agent] of Object.entries(cachedByPubkey)) {
    if (!merged.has(pubkey)) merged.set(pubkey, agent);
  }
  return [...merged.values()];
}
