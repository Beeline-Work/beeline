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
 * This is deliberately the *whole* effective configuration a session bakes
 * in and nothing else: a fingerprint that skipped a field would reintroduce
 * exactly the bug it exists to prevent, and one that included session-local
 * state (a C92 provider re-pin, say) would throw away a good session for a
 * fact the session itself chose.
 *
 * The MCP input is the selected harness's post-prepare imported server names,
 * supplied by mountedImportedMcpServerNames in agent-home.ts. Retention derives
 * the next inventory using the same preparation rules, never treating stale
 * isolated copies as independent grant authority. This applies to every
 * imported server, including Trusty Squire, rather than special-casing Squire.
 * Route grant/revoke provisioning is outside this fingerprint's responsibility.
 * Only names enter the fingerprint, not server settings or credential state;
 * changing settings under an unchanged name does not invalidate the session.
 * Grant and revoke change the prepared name set, so the next activation
 * compares a different fingerprint and starts a fresh session.
 */
export interface SessionConfigInput {
  /** The model this activation would select, after the Room's own override. */
  model?: string | undefined;
  /** The effort/thought level that selection carries. */
  effort?: string | undefined;
  fastMode?: boolean | undefined;
  /** The persona the session prompt would carry, from configuration or roster. */
  soul?: { readonly name: string; readonly instructions: string } | undefined;
  /** The name the session introduces itself by. */
  agentName?: string | undefined;
  /** Merge authority baked into a corner session's Git workflow prompt. */
  yoloMode?: boolean | undefined;
  /**
   * Names of imported MCP servers this activation would mount. Order does not
   * matter; the fingerprint stores the sorted unique set.
   */
  mcpServers?: readonly string[] | undefined;
  /** Reviewer identity baked into a corner session's Git workflow prompt. */
  reviewerHandle?: string | undefined;
}

export function sessionConfigFingerprint(input: SessionConfigInput): string {
  const fingerprint: unknown[] = [
    input.model ?? '',
    input.effort ?? '',
    input.fastMode ?? false,
    input.soul?.name ?? '',
    input.soul?.instructions ?? '',
    input.agentName ?? '',
    input.yoloMode ?? false,
    mountedMcpSet(input.mcpServers),
  ];
  if (input.reviewerHandle !== undefined) fingerprint.push(input.reviewerHandle);
  return JSON.stringify(fingerprint);
}

function mountedMcpSet(servers: readonly string[] | undefined): string[] {
  return [...new Set(servers ?? [])].sort((left, right) => left.localeCompare(right));
}
