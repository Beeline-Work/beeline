type MentionableAgent = { pubkey: string; name: string };
type RoomRosterMember = { pubkey: string };
type RoomParticipant = RoomRosterMember & { kind: 'person' | 'agent' };

/**
 * Resolve person-facing Room participants from direct Room membership.
 * Workspace Rooms exclude infrastructure-only keys that have Room authority
 * but are neither a Workspace person nor a registered Agent.
 */
export function roomParticipantPubkeys(
  roomMemberPubkeys: ReadonlySet<string>,
  workspacePeople?: readonly RoomRosterMember[],
  workspaceAgents?: readonly RoomRosterMember[],
): Set<string> {
  if (!workspacePeople && !workspaceAgents) return new Set(roomMemberPubkeys);

  const visiblePubkeys = new Set([
    ...(workspacePeople ?? []).map((member) => member.pubkey),
    ...(workspaceAgents ?? []).map((agent) => agent.pubkey),
  ]);
  return new Set([...roomMemberPubkeys].filter((pubkey) => visiblePubkeys.has(pubkey)));
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

/** Resolve the first visible @Agent name into the member pubkey written to the Nostr p-tag. */
export function mentionedAgentPubkey(text: string, agents: MentionableAgent[]): string | undefined {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const candidates = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const agent of candidates) {
    const mention = `@${agent.name.normalize('NFKC').toLocaleLowerCase()}`;
    let offset = normalized.indexOf(mention);
    while (offset >= 0) {
      const trailing = normalized[offset + mention.length];
      if (trailing === undefined || /[\s,.:;!?)}\]]/.test(trailing)) return agent.pubkey;
      offset = normalized.indexOf(mention, offset + mention.length);
    }
  }
  return undefined;
}
