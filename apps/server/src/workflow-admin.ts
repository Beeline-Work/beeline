import type { SqlDatabase } from './database.js';

export class WorkflowAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409,
  ) {
    super(message);
  }
}

/**
 * A human Room or Workspace admin, room-scoped or workspace-wide: the gate for
 * attributing a directly-started run or an edited room schedule to the
 * calling human rather than an agent.
 */
export async function humanRoomAdmin(
  db: SqlDatabase,
  roomId: string,
  actorId: string,
): Promise<boolean> {
  return Boolean(
    (
      await db.query(
        `SELECT 1 FROM rooms room
    JOIN identities actor ON actor.id=$2 AND actor.kind='human'
    JOIN memberships member ON member.identity_id=actor.id AND member.workspace_id=room.workspace_id
      AND (member.room_id=room.id OR member.room_id IS NULL)
      AND member.removed_at IS NULL AND member.role IN ('owner','admin') WHERE room.id=$1`,
        [roomId, actorId],
      )
    ).rowCount,
  );
}

/** One resolver for schedule writes and the legacy schedule backfill. */
export function scheduleWorkflowSlugSql(workspace: string, message: string): string {
  return `(SELECT skill.slug FROM workspace_skills skill
    CROSS JOIN LATERAL (SELECT ${message} message) prompt
    WHERE skill.workspace_id=${workspace} AND skill.kind='workflow'
      AND (prompt.message ~ ('(?i)\\m(start_workflow|start workflow|workflow)[[:space:]]+["\`]?' || skill.slug || '([^[:alnum:]_-]|$)')
        OR prompt.message ~ ('(?i)\\m' || skill.slug || '["\`]?[[:space:]]+workflow\\M'))
    ORDER BY strpos(lower(prompt.message),skill.slug),skill.slug LIMIT 1)`;
}

/** Explicit targets and old prompts naming a saved workflow share the same gate. */
export async function scheduleWorkflowName(
  db: SqlDatabase,
  roomId: string,
  prompt: string,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit !== undefined) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(explicit)) throw new Error('workflow name is invalid');
    return explicit;
  }
  const resolved = await db.query<{ slug: string | null }>(
    `SELECT ${scheduleWorkflowSlugSql('room.workspace_id', '$2::text')} slug
    FROM rooms room WHERE room.id=$1`,
    [roomId, prompt],
  );
  return resolved.rows[0]?.slug ?? undefined;
}

/**
 * Every still-live run id of `name` visible from `roomId`: the parent Room
 * and its corners (sibling runs), limited to Rooms `viewerId` can read.
 */
export async function activeWorkflowRunIds(
  db: SqlDatabase,
  roomId: string,
  name: string,
  viewerId: string,
): Promise<string[]> {
  const skill = (
    await db.query<{ id: string }>(
      `SELECT skill.id FROM workspace_skills skill JOIN rooms room ON room.workspace_id=skill.workspace_id
      WHERE room.id=$1 AND skill.slug=$2 AND skill.kind='workflow'`,
      [roomId, name],
    )
  ).rows[0];
  if (!skill) return [];
  const active = await db.query<{ run_id: string }>(
    `WITH latest AS (
    SELECT DISTINCT ON (message.card->>'runId') message.card->>'runId' run_id,
      message.card->>'toState' state,message.card->>'workflowVersion' version,message.card->>'status' status
    FROM messages message JOIN rooms surface ON surface.id=message.room_id
    JOIN rooms requested ON requested.id=$1 AND requested.workspace_id=surface.workspace_id
    JOIN memberships readable ON readable.room_id=surface.id AND readable.identity_id=$4 AND readable.removed_at IS NULL
    WHERE (surface.id=COALESCE(requested.parent_id,requested.id)
      OR surface.parent_id=COALESCE(requested.parent_id,requested.id))
      AND message.card_type='workflow-handoff' AND message.card->>'workflowSlug'=$2
      AND message.deleted_at IS NULL
    ORDER BY message.card->>'runId',(message.card->>'seq')::int DESC NULLS LAST,
      message.created_at DESC,message.id DESC
  ) SELECT latest.run_id FROM latest JOIN workspace_skill_versions version
    ON version.skill_id=$3 AND version.version=latest.version::int
    WHERE latest.status IS NULL AND (version.markdown::jsonb->'handoffs'->latest.state->>'kind') IS DISTINCT FROM 'terminal'
    ORDER BY latest.run_id`,
    [roomId, name, skill.id, viewerId],
  );
  return active.rows.map((row) => row.run_id);
}
