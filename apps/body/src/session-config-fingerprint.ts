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
 *
 * The mounted MCP set is part of that configuration. It is the pattern for
 * every imported server the operator currently has (Codex, Claude, Grok,
 * Goose, Cursor, a TypeScript MCP, Linear, filesystem, …), not a Squire-only
 * or TypeScript-only special case. A granted or revoked host route, or an
 * add/remove of any imported server, must change this set so a warm session
 * restarts with the route the next turn actually mounts. Names only: never
 * copy server state (cookies, `session.json`, profile bytes) into a sandbox.
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
