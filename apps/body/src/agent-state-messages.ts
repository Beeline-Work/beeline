/**
 * Human-friendly, hard-coded copy for the daemon's real errored/blocked
 * states — reused by `Body` wherever an already-caught, already-classified
 * failure should speak in the Room instead of retrying in silence. Kept in
 * one place so the wording is easy to find and edit later.
 *
 * This intentionally does not cover a fully DOWN daemon: a dead daemon can't
 * publish anything, including this. That case is a client-side render from
 * stale/absent `#t=agent-presence` (see `apps/mobile/sources/buzz/agent-presence.ts`'s
 * `addressedAgentOfflineNotice`), not a message this module ever produces.
 */

export type AgentErrorState =
  /** The Room's live WS reconnect loop is failing (`runRoomPushLoop`). */
  | 'relay-disconnected'
  /** The ACP child process exited/failed to spawn, and its exit text or
   *  captured stderr looks auth/credential-shaped (see `AcpClient.start()`). */
  | 'harness-auth-missing'
  /** The ACP child process exited or failed to spawn for any other reason. */
  | 'harness-unavailable'
  /** `WorkspaceSupervisor.resolveServingRepo()` could not clone/verify the
   *  Room's bound repository (`ensureCanonicalCheckout`/`materializeNamedRepository`). */
  | 'repo-unavailable'
  /** The underlying model/provider reported a rate limit or quota error. */
  | 'rate-limited';

export const AGENT_ERROR_STATE_MESSAGES: Record<AgentErrorState, string> = {
  'relay-disconnected': "I lost my connection to the relay — reconnecting.",
  'harness-auth-missing': "I can't reach my model — my host's credentials need a refresh.",
  'harness-unavailable': "My coding backend won't start — the host may need attention.",
  'repo-unavailable': "I can't get to this room's repo — check the repo link or my access.",
  'rate-limited': "I've hit a usage limit for now.",
};

const AUTH_SHAPED_PATTERN =
  /(api[_-]?key|unauthorized|\b401\b|authentication|please\s+(?:run|log\s?in)|invalid\s+credentials?|credentials?\s+(?:missing|expired|invalid))/i;
const ACP_EXIT_PATTERN = /^ACP agent .* exited/i;
const RATE_LIMIT_PATTERN = /(rate[-\s]?limit(?:ed)?|\b429\b|quota\s+exceeded|too many requests)/i;

/**
 * Classify an already-caught turn/session error into one of the real daemon
 * error states above, or `null` when it doesn't match anything hard-coded
 * here (e.g. the existing ACP idle-stall path, which has its own dedicated
 * notice — see `isAcpPromptStallError`/`postAgentStallNotice`). Never invents
 * a state: every branch traces to an actual error shape the daemon produces.
 */
export function classifyAgentErrorState(error: unknown): AgentErrorState | null {
  const message = String(error instanceof Error ? error.message : error);
  if (ACP_EXIT_PATTERN.test(message)) {
    return AUTH_SHAPED_PATTERN.test(message) ? 'harness-auth-missing' : 'harness-unavailable';
  }
  if (RATE_LIMIT_PATTERN.test(message)) return 'rate-limited';
  return null;
}
