/**
 * The daemon used to publish its own health into the Room as an ordinary
 * `#t=agent-message` (`apps/body/src/agent-state-messages.ts`, #231). That
 * feature is deleted — but a published Nostr event cannot be unpublished, and
 * the captain's live Room holds a WALL of them: the reconnect notice alone
 * re-armed on every daemon restart, so ~17 restarts in one day left ~17
 * identical "I lost my connection to the relay — reconnecting." lines in the
 * transcript.
 *
 * Nothing on the wire distinguishes them. They carry no marker tag, no
 * `body-control` tag, no `status` tag — they are the agent speaking, in the
 * agent's own voice, with the same shape as a real answer. The exact sentence
 * is therefore the only discriminator there is, which is why this list is a
 * verbatim copy of the deleted `AGENT_ERROR_STATE_MESSAGES` table and matches
 * on the WHOLE trimmed message rather than on a prefix or a fragment: an agent
 * legitimately explaining a rate limit inside a real answer must still be
 * readable.
 *
 * The daemon-side half of the deletion is asserted in
 * `apps/body/src/agent-state-messages.test.ts`; a string added back on either
 * side has to be added on both.
 */
export const RETIRED_AGENT_STATE_NOTICES: readonly string[] = [
  'I lost my connection to the relay — reconnecting.',
  "I can't reach my model — my host's credentials need a refresh.",
  "My coding backend won't start — the host may need attention.",
  "I can't get to this room's repo — check the repo link or my access.",
  "I've hit a usage limit for now.",
];

const RETIRED = new Set(RETIRED_AGENT_STATE_NOTICES);

/**
 * True when a message is nothing but one retired daemon state notice, and so
 * must not reach the transcript or a Room preview.
 *
 * Whole-message only. A message that merely contains the sentence alongside
 * real words is a real message and is left alone.
 */
export function isRetiredAgentStateNotice(text: string): boolean {
  return RETIRED.has(text.trim());
}
