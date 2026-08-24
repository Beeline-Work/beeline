/**
 * A voice announces itself once per run, not once per paragraph.
 *
 * A Room names each agent inline because several agents can write there, but
 * one agent very often lands consecutive entries — streamed narrative
 * segments, a reply followed by its collapsed tool line. Repeating the mark and
 * the name on each of those turns the ledger back into the chat feed it
 * replaced, so only the first entry of a run carries attribution.
 *
 * Anything that is not that voice — a person steering, a corner card, a merge
 * summary — ends the run, so the agent re-announces itself on the far side of
 * the interruption. That is the whole rule; `speaker` is opaque here, and the
 * caller decides what counts as one voice.
 *
 * CORNERS attribute exactly like Rooms: several people can sit in one corner,
 * so bare turns are indistinguishable there too. One voice = one key, on both
 * surfaces.
 */
export type LedgerSpeakerEntry = {
  id: string;
  /** A stable key for the voice, or `null` for anything that is not one. */
  speaker: string | null;
  /** A collapsed tool-call/thought run — mechanism, not prose. It may fold
   *  into the voice above it (no repeated compact header), but it cannot lend
   *  its own continuation to the PROSE below it: prose always re-announces
   *  across machine noise, so an agent's text turn is never left without its
   *  mark and name just because a tool block opened the run.
   */
  isMachine?: boolean;
};

/** Ids of entries whose speaker already announced itself on the entry above. */
export function continuedSpeakerIds(entries: readonly LedgerSpeakerEntry[]): Set<string> {
  const continued = new Set<string>();
  let previous: LedgerSpeakerEntry | null = null;
  for (const entry of entries) {
    // Same voice continues the run — except across machine noise: a collapsed
    // tool/thought block between two prose turns visually separates them, so
    // the later prose re-announces instead of riding the earlier prose's
    // byline past the block. Machine rows following each other (or following
    // their own prose) still fold: the compact header stays once per run.
    const foldsIntoRun =
      entry.speaker !== null &&
      previous !== null &&
      entry.speaker === previous.speaker &&
      !(previous.isMachine === true && !entry.isMachine);
    if (foldsIntoRun) continued.add(entry.id);
    previous = entry;
  }
  return continued;
}

/** The projected transcript shape attribution reads — a structural subset of
 * `ChatDisplayMessage` so this module stays testable with no React Native
 * mocks. */
export type LedgerAttributionMessage = {
  id: string;
  pubkey?: string;
  isUser?: boolean;
  isAgentAuthor?: boolean;
  isAgentActivity?: boolean;
  /** A corner lifecycle card — mechanism, never a voice. */
  corner?: unknown;
  roomUpdate?: unknown;
  isMergeSummary?: boolean;
  isArchivedNotice?: boolean;
  isSystemNotice?: boolean;
  writePermission?: unknown;
  targetBranchProposal?: unknown;
};

/**
 * The one speaker key per transcript entry, shared by Rooms AND corners.
 *
 * The agent test runs before the person test on purpose, so this agrees with
 * the renderer's own `isAgent ? LedgerEntry : LedgerSteer` choice for the one
 * case where a message is both: an agent viewing its own messages, where
 * `isUser` and `isAgentAuthor` are true together. Deriving the two differently
 * would fold a run the renderer draws as two voices.
 *
 * `knownAgentPubkeys` is the caller's roster union (registered agents plus any
 * daemon-published body keys), so an agent whose narration arrives without the
 * `agent-message` tag still keys as an agent.
 */
export function ledgerSpeakerKey(
  message: LedgerAttributionMessage,
  knownAgentPubkeys: ReadonlySet<string>,
): string | null {
  if (
    message.corner ||
    message.roomUpdate ||
    message.isMergeSummary ||
    message.isArchivedNotice ||
    message.isSystemNotice
  )
    return null;
  if (message.writePermission || message.targetBranchProposal) return null;
  const isAgent =
    message.isAgentAuthor ||
    message.isAgentActivity ||
    Boolean(message.pubkey && knownAgentPubkeys.has(message.pubkey));
  if (isAgent) return `agent:${message.pubkey ?? 'unknown-agent'}`;
  // An optimistic own message has no pubkey until it reconciles, so it keys on
  // the viewer rather than on a shared "unknown" bucket.
  return `person:${message.pubkey ?? (message.isUser ? 'self' : 'unknown-person')}`;
}
