type MentionableAgent = { pubkey: string; name: string };

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
