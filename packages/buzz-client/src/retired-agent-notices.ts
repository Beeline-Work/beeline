/**
 * These sentences were once published by the daemon as ordinary agent
 * messages. Nostr events cannot be unpublished, so the server projection and
 * mobile cache must both suppress an event only when its whole trimmed text is
 * one of these retired notices. Keep this as their shared authority: adding a
 * sentence on only one side of the wire would let it reappear after a cache
 * restore or a fresh server read.
 */
export const RETIRED_AGENT_NOTICES: readonly string[] = [
  'I lost my connection to the relay — reconnecting.',
  "I can't reach my model — my host's credentials need a refresh.",
  "My coding backend won't start — the host may need attention.",
  "I can't get to this room's repo — check the repo link or my access.",
  "I've hit a usage limit for now.",
  'Still working on this — my coding backend is taking longer than usual to respond.',
];

const RETIRED = new Set(RETIRED_AGENT_NOTICES);

/** Whole-message only: a real response may legitimately quote a notice. */
export function isRetiredAgentNotice(text: string): boolean {
  return RETIRED.has(text.trim());
}
