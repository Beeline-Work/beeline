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
 */
export type LedgerSpeakerEntry = {
  id: string;
  /** A stable key for the voice, or `null` for anything that is not one. */
  speaker: string | null;
};

/** Ids of entries whose speaker already announced itself on the entry above. */
export function continuedSpeakerIds(entries: readonly LedgerSpeakerEntry[]): Set<string> {
  const continued = new Set<string>();
  let previous: string | null = null;
  for (const entry of entries) {
    if (entry.speaker !== null && entry.speaker === previous) continued.add(entry.id);
    previous = entry.speaker;
  }
  return continued;
}
