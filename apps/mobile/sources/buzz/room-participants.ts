export type MentionableAgent = { pubkey: string; name: string; handle?: string };
type RoomRosterMember = { pubkey: string };
type RoomParticipant = RoomRosterMember & { kind: 'person' | 'agent' };

export type MentionCandidate = {
  name: string;
  handle: string;
};

export type ActiveMention = {
  start: number;
  end: number;
  query: string;
};

const MENTION_QUERY_PATTERN = /(?:^|[\s([{])@([\p{L}\p{M}\p{N}_-]*)$/u;

function normalizeMentionSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

/** Find the mention fragment ending at a collapsed composer cursor. */
export function activeMentionAtCursor(text: string, cursor: number): ActiveMention | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return null;
  const beforeCursor = text.slice(0, cursor);
  const match = MENTION_QUERY_PATTERN.exec(beforeCursor);
  if (!match) return null;
  const query = match[1] ?? '';
  return {
    start: cursor - query.length - 1,
    end: cursor,
    query,
  };
}

/** Prefix matches lead substring matches while preserving Room roster order within each group. */
export function filterMentionCandidates<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string,
  limit = 6,
): { matches: T[]; overflow: number } {
  const normalizedQuery = normalizeMentionSearch(query);
  const matching = candidates
    .map((candidate, index) => {
      const name = normalizeMentionSearch(candidate.name);
      const handle = normalizeMentionSearch(candidate.handle);
      if (!name.includes(normalizedQuery) && !handle.includes(normalizedQuery)) return null;
      return {
        candidate,
        index,
        prefix: name.startsWith(normalizedQuery) || handle.startsWith(normalizedQuery),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => Number(b.prefix) - Number(a.prefix) || a.index - b.index);
  const safeLimit = Math.max(0, limit);
  return {
    matches: matching.slice(0, safeLimit).map((item) => item.candidate),
    overflow: Math.max(0, matching.length - safeLimit),
  };
}

/** Replace only the active @fragment and return the cursor position after the inserted handle. */
export function replaceActiveMention(
  text: string,
  mention: ActiveMention,
  handle: string,
): { text: string; cursor: number } {
  const inserted = `@${handle}`;
  return {
    text: `${text.slice(0, mention.start)}${inserted}${text.slice(mention.end)}`,
    cursor: mention.start + inserted.length,
  };
}

/**
 * Resolve person-facing Room participants from direct Room membership.
 * Workspace Rooms exclude infrastructure-only keys that have Room authority
 * but are neither a Workspace person nor a registered Agent.
 */
export function roomParticipantPubkeys(
  roomMemberPubkeys: ReadonlySet<string>,
  workspacePeople?: readonly RoomRosterMember[],
  workspaceAgents?: readonly RoomRosterMember[],
  /**
   * The person reading the screen. They are in this Room — they are reading and
   * writing in it — so no Workspace roster read is allowed to conclude
   * otherwise.
   *
   * The visibility filter exists to hide infrastructure keys that hold Room
   * authority without being a person or a registered agent, and it decides
   * that by asking whether the key appears in the Workspace's people/agents
   * lists. Those lists are a separate relay read: slow, partial or failed, and
   * the filter quietly removes whoever is missing from them — which is how the
   * captain came to be absent from the roster of their own Room. Being the
   * viewer is direct evidence no roster can outrank.
   */
  viewerPubkey?: string,
): Set<string> {
  if (!workspacePeople && !workspaceAgents) return new Set(roomMemberPubkeys);

  const visiblePubkeys = new Set([
    ...(workspacePeople ?? []).map((member) => member.pubkey),
    ...(workspaceAgents ?? []).map((agent) => agent.pubkey),
  ]);
  return new Set(
    [...roomMemberPubkeys].filter(
      (pubkey) => visiblePubkeys.has(pubkey) || (Boolean(viewerPubkey) && pubkey === viewerPubkey),
    ),
  );
}

/** Keep one Workspace roster, ordered as current Room members followed by addable members. */
export function sectionRoomRoster<T extends RoomRosterMember>(
  roster: T[],
  roomMemberPubkeys: ReadonlySet<string>,
): { inRoom: T[]; addable: T[] } {
  const inRoom: T[] = [];
  const addable: T[] = [];
  for (const member of roster) {
    (roomMemberPubkeys.has(member.pubkey) ? inRoom : addable).push(member);
  }
  return { inRoom, addable };
}

/** Split the authoritative Room roster by visible identity kind. */
export function sectionRoomParticipants<T extends RoomParticipant>(
  participants: T[],
): {
  people: T[];
  agents: T[];
} {
  return {
    people: participants.filter((participant) => participant.kind === 'person'),
    agents: participants.filter((participant) => participant.kind === 'agent'),
  };
}

/** Slack-style participant copy: five names at most, with overflow folded into the fifth slot. */
export function formatRoomParticipantList(names: string[]): string {
  if (names.length <= 5) return names.join(', ');
  return `${names.slice(0, 4).join(', ')} and ${names.length - 4} others`;
}

/** Compact header count; the unified participant bar carries the actual names. */
export function formatRoomParticipantTotal(total: number): string {
  return `${total} ${total === 1 ? 'participant' : 'participants'}`;
}

/**
 * Resolve an agent the user picked from the mention dropdown, but only while
 * its handle is still literally present in the text being sent — the picker's
 * selections outlive the message they were made in.
 */
export function selectedMentionAgentPubkey(
  text: string,
  selections: ReadonlyMap<string, string>,
): string | undefined {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  return [...selections.entries()]
    .sort(([left], [right]) => right.length - left.length)
    .find(([handle]) => {
      const mention = `@${handle.normalize('NFKC').toLocaleLowerCase()}`;
      const offset = normalized.indexOf(mention);
      if (offset < 0) return false;
      const trailing = normalized[offset + mention.length];
      return trailing === undefined || /[\s,.:;!?)}\]]/.test(trailing);
    })?.[1];
}

/** Resolve the first visible @Agent name into the member pubkey written to the Nostr p-tag. */
export function mentionedAgentPubkey(text: string, agents: MentionableAgent[]): string | undefined {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const candidates = [...agents]
    .flatMap((agent) =>
      [agent.name, agent.handle]
        .filter((value): value is string => Boolean(value))
        .map((mention) => ({ agent, mention })),
    )
    .sort((a, b) => b.mention.length - a.mention.length);
  for (const agent of candidates) {
    const mention = `@${agent.mention.normalize('NFKC').toLocaleLowerCase()}`;
    let offset = normalized.indexOf(mention);
    while (offset >= 0) {
      const trailing = normalized[offset + mention.length];
      if (trailing === undefined || /[\s,.:;!?)}\]]/.test(trailing)) return agent.agent.pubkey;
      offset = normalized.indexOf(mention, offset + mention.length);
    }
  }
  return undefined;
}
