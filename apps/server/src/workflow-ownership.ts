import type { WorkflowOwnershipView } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

export class WorkflowOwnershipError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409,
  ) {
    super(message);
  }
}

export async function workflowHumanAdmin(
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

export async function readWorkflowOwnership(
  db: SqlDatabase,
  roomId: string,
  name: string,
  viewerId: string,
): Promise<WorkflowOwnershipView> {
  const row = (
    await db.query<{
      id: string;
      creator_agent_id: string | null;
      owner_agent_id: string | null;
      name: string | null;
      avatar_url: string | null;
      creator_owner: string | null;
    }>(
      `SELECT skill.id,skill.creator_agent_id,skill.owner_agent_id,identity.name,identity.avatar avatar_url,
      creator.owner_id creator_owner FROM workspace_skills skill
    JOIN rooms room ON room.workspace_id=skill.workspace_id AND room.id=$1
    LEFT JOIN identities identity ON identity.id=skill.owner_agent_id
    LEFT JOIN agents creator ON creator.agent_id=skill.creator_agent_id
    WHERE skill.slug=$2 AND skill.kind='workflow'`,
      [roomId, name],
    )
  ).rows[0];
  if (!row) throw new Error('workflow is unavailable');
  const active = await db.query<{ run_id: string }>(
    `WITH latest AS (
    SELECT DISTINCT ON (message.card->>'runId') message.card->>'runId' run_id,
      message.card->>'toState' state,message.card->>'workflowVersion' version
    FROM messages message JOIN rooms surface ON surface.id=message.room_id
    JOIN rooms requested ON requested.id=$1 AND requested.workspace_id=surface.workspace_id
    JOIN memberships readable ON readable.room_id=surface.id AND readable.identity_id=$4 AND readable.removed_at IS NULL
    WHERE (surface.id=requested.id OR surface.parent_id=requested.id)
      AND message.card_type='workflow-handoff' AND message.card->>'workflowSlug'=$2
      AND message.deleted_at IS NULL
    ORDER BY message.card->>'runId',message.created_at DESC,message.id DESC
  ) SELECT latest.run_id FROM latest JOIN workspace_skill_versions version
    ON version.skill_id=$3 AND version.version=latest.version::int
    WHERE (version.markdown::jsonb->'handoffs'->latest.state->>'kind') IS DISTINCT FROM 'terminal'
    ORDER BY latest.run_id`,
    [roomId, name, row.id, viewerId],
  );
  const human =
    (await db.query(`SELECT 1 FROM identities WHERE id=$1 AND kind='human'`, [viewerId])).rowCount >
    0;
  const canTransfer =
    human && (row.creator_owner === viewerId || (await workflowHumanAdmin(db, roomId, viewerId)));
  const candidates = canTransfer
    ? (
        await db.query<{ id: string; name: string; avatar: string | null }>(
          `SELECT identity.id,identity.name,identity.avatar FROM identities identity JOIN memberships member ON member.identity_id=identity.id
      WHERE member.room_id=$1 AND member.removed_at IS NULL AND identity.kind='agent' ORDER BY identity.name,identity.id`,
          [roomId],
        )
      ).rows
    : [];
  return {
    owner: row.owner_agent_id
      ? {
          id: row.owner_agent_id,
          name: row.name ?? row.owner_agent_id,
          kind: 'agent',
          ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
        }
      : null,
    activeRunIds: active.rows.map((run) => run.run_id),
    canTransfer,
    ...(canTransfer
      ? {
          ownerCandidates: candidates.map((agent) => ({
            id: agent.id,
            name: agent.name,
            kind: 'agent' as const,
            ...(agent.avatar ? { avatarUrl: agent.avatar } : {}),
          })),
        }
      : {}),
  };
}

export async function requireWorkflowOwner(
  db: SqlDatabase,
  roomId: string,
  name: string,
  actorId: string,
): Promise<WorkflowOwnershipView> {
  await db.query(
    `SELECT skill.id FROM workspace_skills skill JOIN rooms room ON room.workspace_id=skill.workspace_id
    WHERE room.id=$1 AND skill.slug=$2 AND skill.kind='workflow' FOR SHARE OF skill`,
    [roomId, name],
  );
  const ownership = await readWorkflowOwnership(db, roomId, name, actorId);
  if (!ownership.owner)
    throw new WorkflowOwnershipError(
      `${name}: no owner, starts blocked. Ask an authorized human to assign an owner. Active run IDs: ${ownership.activeRunIds.join(', ') || 'none'}.`,
      409,
    );
  if (ownership.owner.id !== actorId && !(await workflowHumanAdmin(db, roomId, actorId))) {
    throw new WorkflowOwnershipError(
      `Only ${ownership.owner.name} can start runs of ${name}. Ask them, or hand off to the active run by its run ID. Owner: ${ownership.owner.id}. Active run IDs: ${ownership.activeRunIds.join(', ') || 'none'}.`,
      403,
    );
  }
  const member = await db.query(
    `SELECT 1 FROM memberships member JOIN identities identity
    ON identity.id=member.identity_id AND identity.kind='agent'
    WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL`,
    [roomId, ownership.owner.id],
  );
  if (!member.rowCount)
    throw new WorkflowOwnershipError(
      `Owner ${ownership.owner.name} is not a current agent member of this Room; starts blocked.`,
      409,
    );
  return ownership;
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
  const match =
    /(?:start_workflow|start workflow|workflow)\s+["`]?([a-z0-9]+(?:-[a-z0-9]+)*)\b/i.exec(
      prompt,
    ) ?? /\b([a-z0-9]+(?:-[a-z0-9]+)*)["`]?\s+workflow\b/i.exec(prompt);
  if (!match) return undefined;
  const exists = await db.query(
    `SELECT 1 FROM workspace_skills skill JOIN rooms room ON room.workspace_id=skill.workspace_id
    WHERE room.id=$1 AND skill.slug=$2 AND skill.kind='workflow'`,
    [roomId, match[1]],
  );
  return exists.rowCount ? match[1] : undefined;
}

export async function transferWorkflowOwner(
  db: SqlDatabase,
  roomId: string,
  name: string,
  actorId: string,
  ownerId: string,
): Promise<WorkflowOwnershipView> {
  return db.transaction(async (tx) => {
    await tx.query(
      `SELECT skill.id FROM workspace_skills skill JOIN rooms room ON room.workspace_id=skill.workspace_id
      WHERE room.id=$1 AND skill.slug=$2 FOR UPDATE OF skill`,
      [roomId, name],
    );
    const before = await readWorkflowOwnership(tx, roomId, name, actorId);
    if (!before.canTransfer)
      throw new WorkflowOwnershipError(
        'Only the workflow creator’s human owner or a human Room/Workspace admin can change owner. Agents cannot transfer ownership.',
        403,
      );
    const member = await tx.query(
      `SELECT 1 FROM memberships member JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
      WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL`,
      [roomId, ownerId],
    );
    if (!member.rowCount) throw new Error('New owner must be a current agent member of this Room');
    const updated = await tx.query<{ id: string }>(
      `UPDATE workspace_skills skill SET owner_agent_id=$3,ownership_initialized=true,updated_at=now()
      FROM rooms room WHERE room.id=$1 AND room.workspace_id=skill.workspace_id AND skill.slug=$2 AND skill.kind='workflow' RETURNING skill.id`,
      [roomId, name, ownerId],
    );
    await tx.query(
      `INSERT INTO workflow_owner_transfers(workflow_id,room_id,actor_id,previous_owner_id,new_owner_id)
      VALUES($1,$2,$3,$4,$5)`,
      [updated.rows[0]!.id, roomId, actorId, before.owner?.id ?? null, ownerId],
    );
    await tx.query(
      `UPDATE agent_schedules SET agent_id=$3 WHERE workspace_id=(SELECT workspace_id FROM rooms WHERE id=$1) AND workflow_slug=$2`,
      [roomId, name, ownerId],
    );
    return readWorkflowOwnership(tx, roomId, name, actorId);
  });
}
