/** Card surfaces with controls implemented by the transcript. Unknown notices
 * default to a system line, so adding a notice never adds a System speaker. */
const CONTROL_CARDS = new Set([
  'permission', 'grant-request', 'squire-approval', 'computer-session',
  'connector-offer', 'app-sign-in', 'agent-sign-in', 'choice',
  'target-branch', 'github-event', 'daemon-fact', 'corner', 'corner-app', 'voice-call',
]);

export function systemNoticePresentation<T extends string>(
  presentation: T,
  cardType: string | null | undefined,
): T | 'system' {
  return presentation === 'card' && !CONTROL_CARDS.has(cardType ?? '')
    ? 'system'
    : presentation;
}
