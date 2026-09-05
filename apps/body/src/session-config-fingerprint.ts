/**
 * What a live harness session baked in, as one comparable string.
 *
 * Retention (C104) is a saving only while the session it keeps is still the
 * session the operator configured. A harness session is opened ONCE with the
 * agent's persona in its system prompt and its model/effort applied over ACP;
 * neither can be changed afterwards from outside, so a retained session that
 * outlives a soul edit or a model switch would keep answering as the old
 * agent. Under the previous five-minute window that staleness was bounded by
 * the window itself; a thirty-minute one has to invalidate explicitly.
 *
 * This is deliberately the *whole* server-owned configuration a session bakes
 * in and nothing else: a fingerprint that skipped a field would reintroduce
 * exactly the bug it exists to prevent, and one that included session-local
 * state (a C92 provider re-pin, say) would throw away a good session for a
 * fact the session itself chose.
 */
export interface SessionConfigInput {
  /** The model this activation would select, after the Room's own override. */
  model?: string | undefined;
  /** The effort/thought level that selection carries. */
  effort?: string | undefined;
  /** The persona the session prompt would carry, from configuration or roster. */
  soul?: { readonly name: string; readonly instructions: string } | undefined;
  /** The name the session introduces itself by. */
  agentName?: string | undefined;
}

export function sessionConfigFingerprint(input: SessionConfigInput): string {
  return JSON.stringify([
    input.model ?? '',
    input.effort ?? '',
    input.soul?.name ?? '',
    input.soul?.instructions ?? '',
    input.agentName ?? '',
  ]);
}
