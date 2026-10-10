/**
 * Process-wide provenance for live Squire browser sessions.
 *
 * One helper process serves every Room, DM and corner an agent belongs to, and
 * each of those conversations owns its own `SquireTaskRelay` and MCP
 * connection. A browser session is owned by the MCP connection that opened it,
 * so a second conversation cannot drive it directly. The registry is what lets
 * a *scheduled* turn inherit a session opened by the conversation that created
 * the schedule, or by an earlier run of that same schedule: the owning relay's
 * client stays the one that issues the call, and this table is the authority
 * for whether the borrowing turn is allowed to.
 *
 * Ordinary conversations never consult it: a turn may only use a session it
 * owns or one a schedule it is a run of is allowed to inherit.
 */
import type { StdioSquireMcpClient } from './squire-mcp-client.js';

export type SquireSessionOwner = {
  readonly agentId: string;
  /** The Room/DM/corner whose turn opened the session. */
  readonly conversationId: string;
  /** The live MCP connection that owns the session at the broker. */
  readonly client: StdioSquireMcpClient;
  /** Schedules whose runs have legitimately created or used this session. */
  readonly scheduleIds: Set<string>;
};

const owners = new Map<string, SquireSessionOwner>();

/** Record one live session. Re-registering the same id replaces its provenance. */
export function registerSquireSession(
  sessionId: string,
  owner: Omit<SquireSessionOwner, 'scheduleIds'>,
): void {
  owners.set(sessionId, { ...owner, scheduleIds: new Set() });
}

export function forgetSquireSessions(sessionIds: Iterable<string>): void {
  for (const sessionId of sessionIds) owners.delete(sessionId);
}

export function squireSessionOwner(sessionId: string): SquireSessionOwner | undefined {
  return owners.get(sessionId);
}

/** Remember that a schedule's run legitimately created or used this session. */
export function tagSquireSessionSchedule(sessionId: string, scheduleId: string): void {
  owners.get(sessionId)?.scheduleIds.add(scheduleId);
}

/**
 * Whether a scheduled turn in `conversationId` may inherit every requested
 * session: same agent, and either the session came from the schedule's own
 * conversation or an earlier run of the same schedule opened it.
 */
export function squireSessionInheritable(
  sessionId: string,
  agentId: string,
  conversationId: string,
  scheduleId: string,
): boolean {
  const owner = owners.get(sessionId);
  if (!owner || owner.agentId !== agentId) return false;
  // A schedule that has already claimed this session owns it outright; the
  // creating conversation only grants the FIRST schedule to run there, so a
  // second schedule in the same conversation is refused (story 3).
  if (owner.scheduleIds.has(scheduleId)) return true;
  return owner.scheduleIds.size === 0 && owner.conversationId === conversationId;
}
