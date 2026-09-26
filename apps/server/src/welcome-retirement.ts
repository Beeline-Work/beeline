import { DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { retireAgentFromWorkspace } from './agent-retirement.js';
import { ensureSystemIdentity } from './system-line.js';

/**
 * Release-owned retirement of the shared "Beeline Welcome" Workspace and its
 * Greeter agent: one versioned, idempotent, retry-safe transaction.
 *
 * Nothing runs by default. The release migration (`index.ts`) calls
 * `retireWelcomeWorkspace` only when the release owner arms it with
 * `BEELINE_RETIRE_WELCOME_GREETER_ID`, after the create-or-join onboarding is
 * live on every supported client. The boot reseed and the sign-in landing are
 * already gone from this server image, so nothing refills the Workspace
 * while — or after — this runs.
 *
 * In one transaction, under an advisory lock:
 *   1. a recorded marker means this already ran: return quietly;
 *   2. a missing Welcome Workspace means it is already gone: record and return;
 *   3. resolve the EXACT configured Greeter id — an agent identity with an
 *      agents row and a Welcome membership — never by name; anything else
 *      refuses and changes nothing;
 *   4. retire the Greeter with the same effects as `removeAgent`
 *      (`retireAgentFromWorkspace`), keeping its identity/agent rows,
 *      messages, turns and corners;
 *   5. revoke the daemon tokens of any other agent whose only membership was
 *      here, exactly as an owner's `deleteWorkspace` does;
 *   6. write the system-owned audit row and DELETE the Workspace — the schema
 *      cascades its Rooms, memberships and everything scoped to them. No
 *      per-person deletion notices: this is a system migration, not an owner
 *      deleting a place people chose;
 *   7. write the completion marker last.
 * A failure anywhere rolls the whole transaction back.
 */
export const WELCOME_RETIREMENT_STEP = 'welcome-workspace-retirement-v1';

export type WelcomeRetirementResult =
  | { readonly status: 'already-complete'; readonly detail: Record<string, unknown> }
  | { readonly status: 'absent' }
  | {
      readonly status: 'retired';
      readonly greeterAgentId: string;
      readonly members: number;
      readonly welcomeOnlyPeople: number;
    };

export class WelcomeRetirementRefusedError extends Error {
  override readonly name = 'WelcomeRetirementRefusedError';
}

async function recordMarker(database: SqlDatabase, detail: Record<string, unknown>) {
  await database.query(
    `INSERT INTO beeline_release_steps(name,detail) VALUES($1,$2::jsonb)
     ON CONFLICT(name) DO NOTHING`,
    [WELCOME_RETIREMENT_STEP, JSON.stringify(detail)],
  );
}

async function readIdentity(database: SqlDatabase, id: string): Promise<RoomViewIdentity> {
  const row = (
    await database.query<{ id: string; kind: 'human' | 'agent'; name: string; handle: string | null }>(
      `SELECT id,kind,name,handle FROM identities WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new WelcomeRetirementRefusedError(`identity ${id} not found`);
  return {
    pubkey: row.id,
    kind: row.kind,
    name: row.name,
    ...(row.handle ? { handle: row.handle } : {}),
  };
}

export async function retireWelcomeWorkspace(
  database: SqlDatabase,
  input: { readonly greeterAgentId: string },
): Promise<WelcomeRetirementResult> {
  const greeterInput = input.greeterAgentId.trim();
  if (!greeterInput)
    throw new WelcomeRetirementRefusedError('the exact Greeter agent id is required');
  return database.transaction(async (database) => {
    await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [WELCOME_RETIREMENT_STEP]);
    const marker = (
      await database.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM beeline_release_steps WHERE name=$1`,
        [WELCOME_RETIREMENT_STEP],
      )
    ).rows[0];
    if (marker) return { status: 'already-complete', detail: marker.detail };

    const workspace = (
      await database.query<{ name: string }>(`SELECT name FROM workspaces WHERE id=$1 FOR UPDATE`, [
        DEFAULT_WORKSPACE_ID,
      ])
    ).rows[0];
    if (!workspace) {
      await recordMarker(database, { absent: true });
      return { status: 'absent' };
    }

    const greeter = await database.query(
      `SELECT 1 FROM identities i
       JOIN agents a ON a.agent_id=i.id
       JOIN memberships m ON m.identity_id=i.id AND m.workspace_id=$2 AND m.room_id IS NULL
       WHERE i.id=$1 AND i.kind='agent'`,
      [greeterInput, DEFAULT_WORKSPACE_ID],
    );
    if (!greeter.rowCount)
      throw new WelcomeRetirementRefusedError(
        `${greeterInput} is not an agent member of the Welcome Workspace`,
      );
    const greeterAgentId = greeterInput;

    const members = await database.query<{ identity_id: string; kind: 'human' | 'agent' }>(
      `SELECT m.identity_id,i.kind FROM memberships m JOIN identities i ON i.id=m.identity_id
       WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL`,
      [DEFAULT_WORKSPACE_ID],
    );
    const welcomeOnlyPeople = (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM memberships m JOIN identities i ON i.id=m.identity_id
         WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
           AND i.kind='human' AND i.hidden_from_roster=false
           AND NOT EXISTS (SELECT 1 FROM memberships other
             WHERE other.identity_id=m.identity_id AND other.room_id IS NULL
               AND other.removed_at IS NULL AND other.workspace_id<>$1)`,
        [DEFAULT_WORKSPACE_ID],
      )
    ).rows[0]!.count;

    await ensureSystemIdentity(database);
    await retireAgentFromWorkspace(database, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      agentId: greeterAgentId,
      remover: await readIdentity(database, SYSTEM_IDENTITY_ID),
      removed: await readIdentity(database, greeterAgentId),
    });

    const otherAgents = members.rows
      .filter((member) => member.kind === 'agent' && member.identity_id !== greeterAgentId)
      .map((member) => member.identity_id);
    if (otherAgents.length)
      await database.query(
        `UPDATE daemon_tokens SET revoked_at=now()
         WHERE agent_id=ANY($1) AND revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM memberships m
             WHERE m.identity_id=daemon_tokens.agent_id AND m.removed_at IS NULL
               AND m.workspace_id<>$2
           )`,
        [otherAgents, DEFAULT_WORKSPACE_ID],
      );

    await database.query(
      `INSERT INTO workspace_deletions(workspace_id,workspace_name,deleted_by)
       VALUES ($1,$2,$3) ON CONFLICT (workspace_id) DO NOTHING`,
      [DEFAULT_WORKSPACE_ID, workspace.name, SYSTEM_IDENTITY_ID],
    );
    await database.query(`DELETE FROM workspaces WHERE id=$1`, [DEFAULT_WORKSPACE_ID]);

    const result = {
      status: 'retired' as const,
      greeterAgentId,
      members: members.rowCount,
      welcomeOnlyPeople,
    };
    await recordMarker(database, result);
    return result;
  });
}

/**
 * The read-only preflight the release owner reviews before arming the
 * retirement. Mutates nothing.
 */
export async function welcomeRetirementPreflight(database: SqlDatabase) {
  const one = async (sql: string) =>
    (await database.query<{ count: number }>(sql, [DEFAULT_WORKSPACE_ID])).rows[0]!.count;
  const workspace = (
    await database.query<{ name: string }>(`SELECT name FROM workspaces WHERE id=$1`, [
      DEFAULT_WORKSPACE_ID,
    ])
  ).rows[0];
  const marker = (
    await database.query<{ completed_at: Date; detail: unknown }>(
      `SELECT completed_at,detail FROM beeline_release_steps WHERE name=$1`,
      [WELCOME_RETIREMENT_STEP],
    )
  ).rows[0];
  if (!workspace) return { workspace: null, marker: marker ?? null };
  const agents = await database.query<{
    agent_id: string;
    name: string;
    owner_id: string | null;
    active: boolean;
    other_workspaces: number;
    live_tokens: number;
    live_grants: number;
    schedules: number;
    open_corners: number;
  }>(
    `SELECT i.id agent_id,i.name,a.owner_id,m.removed_at IS NULL active,
       (SELECT count(*)::int FROM memberships o WHERE o.identity_id=i.id AND o.room_id IS NULL
          AND o.removed_at IS NULL AND o.workspace_id<>$1) other_workspaces,
       (SELECT count(*)::int FROM daemon_tokens t WHERE t.agent_id=i.id AND t.revoked_at IS NULL) live_tokens,
       (SELECT count(*)::int FROM agent_grants g WHERE g.agent_id=i.id AND g.workspace_id=$1
          AND g.status IN ('pending','approved','once')) live_grants,
       (SELECT count(*)::int FROM agent_schedules s WHERE s.agent_id=i.id AND s.workspace_id=$1) schedules,
       (SELECT count(*)::int FROM corner_facts f JOIN rooms c ON c.id=f.corner_id
          WHERE f.owner_agent_id=i.id AND c.workspace_id=$1 AND c.archived_at IS NULL) open_corners
     FROM memberships m JOIN identities i ON i.id=m.identity_id LEFT JOIN agents a ON a.agent_id=i.id
     WHERE m.workspace_id=$1 AND m.room_id IS NULL AND i.kind='agent'
     ORDER BY i.name,i.id`,
    [DEFAULT_WORKSPACE_ID],
  );
  return {
    workspace: { id: DEFAULT_WORKSPACE_ID, name: workspace.name },
    marker: marker ?? null,
    activeMembers: await one(
      `SELECT count(*)::int count FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND removed_at IS NULL`,
    ),
    activePeople: await one(
      `SELECT count(*)::int count FROM memberships m JOIN identities i ON i.id=m.identity_id
       WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL AND i.kind='human'`,
    ),
    peopleWithNoOtherWorkspace: await one(
      `SELECT count(*)::int count FROM memberships m JOIN identities i ON i.id=m.identity_id
       WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL AND i.kind='human'
         AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.identity_id=m.identity_id
           AND o.room_id IS NULL AND o.removed_at IS NULL AND o.workspace_id<>$1)`,
    ),
    agents: agents.rows,
    rooms: await one(`SELECT count(*)::int count FROM rooms WHERE workspace_id=$1`),
    welcomeRoomPresent:
      (await database.query(`SELECT 1 FROM rooms WHERE id=$1`, [WELCOME_ROOM_ID])).rowCount > 0,
    messages: await one(
      `SELECT count(*)::int count FROM messages m JOIN rooms r ON r.id=m.room_id WHERE r.workspace_id=$1`,
    ),
    // Per-person rows scoped to this Workspace that the delete cascades.
    cascadingPersonalRows: {
      walletBindings: await one(`SELECT count(*)::int count FROM wallet_bindings WHERE workspace_id=$1`),
      workbenchConnectors: await one(
        `SELECT count(*)::int count FROM workspace_connectors WHERE workspace_id=$1`,
      ),
      googleGrants: await one(`SELECT count(*)::int count FROM google_oauth_grants WHERE workspace_id=$1`),
      agentGrants: await one(`SELECT count(*)::int count FROM agent_grants WHERE workspace_id=$1`),
      schedules: await one(`SELECT count(*)::int count FROM agent_schedules WHERE workspace_id=$1`),
    },
  };
}
