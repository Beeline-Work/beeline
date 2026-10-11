import { createHash, randomUUID } from 'node:crypto';
import { isSubscribableEventKind } from '@beeline/api-contract/phone';
import { isRepositorySubscriptionEvent, type RoomSubscriptionView, type SubscriptionSource } from '@beeline/api-contract/phone';
import { subscriptionActionPrompt } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { scheduleWorkflowName } from './workflow-admin.js';

export const AGENT_SUBSCRIPTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_subscriptions (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
 source text NOT NULL CHECK(source IN ('room','repository')),
 event text NOT NULL,
 repository text,
 prompt text NOT NULL,
 workflow_slug text,
 fired_count integer NOT NULL DEFAULT 0 CHECK(fired_count>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 last_fired_at timestamptz,
 CHECK ((source='room' AND repository IS NULL) OR (source='repository' AND repository IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_subscriptions_unique
 ON agent_subscriptions(room_id,agent_id,source,event,COALESCE(repository,''));
CREATE INDEX IF NOT EXISTS agent_subscriptions_workspace ON agent_subscriptions(workspace_id);
CREATE INDEX IF NOT EXISTS agent_subscriptions_agent ON agent_subscriptions(agent_id);
CREATE INDEX IF NOT EXISTS agent_subscriptions_repository ON agent_subscriptions(repository,source,event);
`;

type Row = {
  id: string; room_id: string; agent_id: string; source: SubscriptionSource;
  event: string; repository: string | null; prompt: string; workflow_slug: string | null; fired_count: number;
  created_at: Date; last_fired_at: Date | null;
  parent_id?: string | null; room_name?: string | null;
};
function view(row: Row): RoomSubscriptionView {
  return {
    id: row.id, roomId: row.room_id, agentId: row.agent_id,
    source: row.source, event: row.event,
    ...(row.repository ? { repository: row.repository } : {}),
    prompt: row.prompt, ...(row.workflow_slug ? { workflowSlug: row.workflow_slug } : {}), firedCount: row.fired_count,
    createdAt: Math.floor(row.created_at.getTime() / 1000),
    ...(row.last_fired_at ? { lastFiredAt: Math.floor(row.last_fired_at.getTime() / 1000) } : {}),
    ...(row.parent_id ? { corner: { id: row.room_id, name: row.room_name ?? 'Corner' } } : {}),
  };
}

type LegacyRow = {
  room_id: string; agent_id: string; event: string; joined_at: Date;
  parent_id: string | null; room_name: string; reviewer_agent_id: string | null;
};
function legacyView(row: LegacyRow): RoomSubscriptionView | undefined {
  if (!isSubscribableEventKind(row.event) ||
    (row.event === 'check-passed' && row.reviewer_agent_id === row.agent_id)) return undefined;
  return {
    id: `legacy:${row.room_id}:${row.agent_id}:${row.event}`,
    roomId: row.room_id, agentId: row.agent_id, source: 'room', event: row.event,
    createdAt: Math.floor(row.joined_at.getTime() / 1000),
    ...(row.parent_id ? { corner: { id: row.room_id, name: row.room_name } } : {}),
  };
}
async function legacySubscriptions(db: SqlDatabase, roomId: string, agentId?: string) {
  const rows = await db.query<LegacyRow>(
    `SELECT surface.id room_id,member.identity_id agent_id,kind.event,
       member.joined_at,surface.parent_id,surface.name room_name,parent.reviewer_agent_id
     FROM rooms surface
     JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
     JOIN memberships member ON member.room_id=surface.id AND member.removed_at IS NULL
     JOIN identities agent ON agent.id=member.identity_id AND agent.kind='agent'
     CROSS JOIN LATERAL jsonb_array_elements_text(member.event_subscriptions) kind(event)
     WHERE (surface.id=$1 OR ($2::text IS NULL AND surface.parent_id=$1))
       AND ($2::text IS NULL OR member.identity_id=$2)
       AND surface.archived_at IS NULL`, [roomId, agentId ?? null],
  );
  return rows.rows.flatMap((row) => legacyView(row) ?? []);
}
function legacyId(id: string) {
  const match = /^legacy:([0-9a-f-]{36}):([^:]+):([^:]+)$/.exec(id);
  return match ? { roomId: match[1]!, agentId: match[2]!, event: match[3]! } : undefined;
}

function validEvent(source: SubscriptionSource, event: string): boolean {
  return source === 'room'
    ? isSubscribableEventKind(event)
    : isRepositorySubscriptionEvent(event);
}

/** Agent writes need only current Room membership. Repository scope is checked against the installed app catalog. */
export async function createAgentSubscription(
  db: SqlDatabase, agentId: string,
  input: { roomId: string; source: SubscriptionSource; event: string; repository?: string; prompt: string; workflowName?: string },
): Promise<RoomSubscriptionView> {
  const prompt = input.prompt?.trim();
  if (!prompt || prompt.length > 4000) throw new Error('prompt must be 1–4000 characters');
  if (!['room', 'repository'].includes(input.source) || !validEvent(input.source, input.event))
    throw new Error('event is not available for this subscription source');
  const repository = input.source === 'repository' ? input.repository?.trim().toLowerCase() : undefined;
  if (input.source === 'repository' && (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)))
    throw new Error('repository must be an installed owner/name repository');
  if (input.source === 'room' && input.repository !== undefined)
    throw new Error('Room subscriptions do not name a repository');
  const room = await db.query<{ workspace_id: string }>(
    `SELECT room.workspace_id FROM rooms room
     JOIN memberships member ON member.room_id=room.id AND member.identity_id=$2 AND member.removed_at IS NULL
     JOIN identities agent ON agent.id=$2 AND agent.kind='agent'
     WHERE room.id=$1 AND room.archived_at IS NULL`, [input.roomId, agentId],
  );
  if (!room.rowCount) throw new Error('agent is not a current Room member');
  const workflowSlug = await scheduleWorkflowName(db, input.roomId, prompt, input.workflowName);
  if (repository) {
    const covered = await db.query(
      `SELECT 1 FROM github_repositories repo
       JOIN github_installations installation ON installation.installation_id=repo.installation_id
       JOIN memberships owner ON owner.identity_id=installation.owner_id
         AND owner.workspace_id=$1 AND owner.room_id IS NULL AND owner.removed_at IS NULL
       WHERE lower(repo.full_name)=$2 AND repo.active AND installation.status='active' LIMIT 1`,
      [room.rows[0]!.workspace_id, repository],
    );
    if (!covered.rowCount) throw new Error('repository is not covered by this Workspace connection');
  }
  const rows = await db.query<Row>(
    `INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,repository,prompt,workflow_slug)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(room_id,agent_id,source,event,COALESCE(repository,'')) DO UPDATE
       SET prompt=EXCLUDED.prompt,workflow_slug=EXCLUDED.workflow_slug
     RETURNING *`,
    [randomUUID(), room.rows[0]!.workspace_id, input.roomId, agentId, input.source, input.event, repository ?? null, prompt, workflowSlug ?? null],
  );
  return view(rows.rows[0]!);
}

export async function listAgentSubscriptions(db: SqlDatabase, roomId: string, agentId: string) {
  const rows = await db.query<Row>(
    `SELECT subscription.* FROM agent_subscriptions subscription
     JOIN memberships member ON member.room_id=subscription.room_id AND member.identity_id=$2 AND member.removed_at IS NULL
     WHERE subscription.room_id=$1 AND subscription.agent_id=$2
     ORDER BY subscription.created_at,subscription.id`, [roomId, agentId],
  );
  return { subscriptions: [...rows.rows.map(view), ...await legacySubscriptions(db, roomId, agentId)] };
}

export async function deleteAgentSubscription(db: SqlDatabase, roomId: string, agentId: string, id: string) {
  const legacy = legacyId(id);
  if (legacy) {
    if (legacy.roomId !== roomId || legacy.agentId !== agentId) throw new Error('subscription not found');
    const updated = await db.query(
      `UPDATE memberships member SET event_subscriptions=member.event_subscriptions - $3
       FROM rooms surface JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
       WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL
         AND surface.id=member.room_id AND member.event_subscriptions ? $3
         AND NOT ($3='check-passed' AND parent.reviewer_agent_id=$2)`,
      [roomId, agentId, legacy.event],
    );
    if (!updated.rowCount) throw new Error('subscription not found');
    return;
  }
  const deleted = await db.query(
    `DELETE FROM agent_subscriptions subscription USING memberships member
     WHERE subscription.id=$1 AND subscription.room_id=$2 AND subscription.agent_id=$3
       AND member.room_id=subscription.room_id AND member.identity_id=$3 AND member.removed_at IS NULL`,
    [id, roomId, agentId],
  );
  if (!deleted.rowCount) throw new Error('subscription not found');
}

export async function listRoomSubscriptions(db: SqlDatabase, roomId: string) {
  const rows = await db.query<Row>(
    `SELECT subscription.*,surface.parent_id,surface.name room_name
     FROM agent_subscriptions subscription
     JOIN rooms surface ON surface.id=subscription.room_id AND surface.archived_at IS NULL
     JOIN memberships member ON member.room_id=subscription.room_id
       AND member.identity_id=subscription.agent_id AND member.removed_at IS NULL
     WHERE surface.id=$1 OR surface.parent_id=$1
     ORDER BY subscription.created_at,subscription.id`, [roomId],
  );
  return { subscriptions: [...rows.rows.map(view), ...await legacySubscriptions(db, roomId)] };
}

export async function deleteRoomSubscription(db: SqlDatabase, roomId: string, id: string) {
  const legacy = legacyId(id);
  if (legacy) {
    const updated = await db.query(
      `UPDATE memberships member SET event_subscriptions=member.event_subscriptions - $4
       FROM rooms surface JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
       WHERE member.room_id=$2 AND member.identity_id=$3 AND member.removed_at IS NULL
         AND surface.id=member.room_id AND (surface.id=$1 OR surface.parent_id=$1)
         AND member.event_subscriptions ? $4
         AND NOT ($4='check-passed' AND parent.reviewer_agent_id=$3)`,
      [roomId, legacy.roomId, legacy.agentId, legacy.event],
    );
    if (!updated.rowCount) throw new Error('subscription not found');
    return;
  }
  const deleted = await db.query(
    `DELETE FROM agent_subscriptions subscription USING rooms surface
     WHERE subscription.id=$1 AND surface.id=subscription.room_id
       AND (surface.id=$2 OR surface.parent_id=$2)`, [id, roomId],
  );
  if (!deleted.rowCount) throw new Error('subscription not found');
}

/** GitHub's signed app delivery is the only receiver. One delivery makes at most one wake per subscription. */
export async function fireRepositorySubscriptions(
  db: SqlDatabase, installationId: number, event: string, body: Record<string, unknown>, deliveryId: string,
): Promise<string[]> {
  const action = typeof body.action === 'string' ? body.action : '';
  const eventName = `${event === 'issues' ? 'issue' : event}.${action}`;
  if (!isRepositorySubscriptionEvent(eventName)) return [];
  const repositoryObject = body.repository;
  const repository = repositoryObject && typeof repositoryObject === 'object' && !Array.isArray(repositoryObject)
    ? (repositoryObject as Record<string, unknown>).full_name : undefined;
  if (typeof repository !== 'string') return [];
  const rows = await db.query<Row>(
    `SELECT subscription.* FROM agent_subscriptions subscription
     JOIN rooms room ON room.id=subscription.room_id AND room.archived_at IS NULL
     JOIN memberships agent ON agent.room_id=room.id AND agent.identity_id=subscription.agent_id AND agent.removed_at IS NULL
     JOIN github_repositories repo ON lower(repo.full_name)=subscription.repository
       AND repo.installation_id=$1 AND repo.active
     JOIN github_installations installation ON installation.installation_id=repo.installation_id AND installation.status='active'
     JOIN memberships owner ON owner.identity_id=installation.owner_id
       AND owner.workspace_id=room.workspace_id AND owner.room_id IS NULL AND owner.removed_at IS NULL
     WHERE subscription.source='repository' AND subscription.event=$2 AND subscription.repository=lower($3)`,
    [installationId, eventName, repository],
  );
  if (!rows.rowCount) return [];
  await ensureSystemIdentity(db);
  const changed: string[] = [];
  const actor = body.sender && typeof body.sender === 'object' && !Array.isArray(body.sender)
    ? (body.sender as Record<string, unknown>).login : undefined;
  const subject = event === 'issues' ? body.issue : event === 'pull_request' ? body.pull_request : undefined;
  const details = subject && typeof subject === 'object' && !Array.isArray(subject)
    ? subject as Record<string, unknown> : undefined;
  const payload = {
    source: 'repository', event: eventName, repository,
    ...(typeof actor === 'string' ? { actor: actor.slice(0, 100) } : {}),
    ...(typeof details?.number === 'number' && Number.isSafeInteger(details.number)
      ? { number: details.number } : {}),
    ...(typeof details?.title === 'string' ? { title: details.title.slice(0, 500) } : {}),
    ...(typeof details?.html_url === 'string' ? { url: details.html_url.slice(0, 500) } : {}),
    ...(event === 'pull_request' && action === 'closed' ? { merged: details?.merged === true } : {}),
  };
  for (const row of rows.rows) {
    const id = createHash('sha256').update(`subscription:${deliveryId}:${row.id}`).digest('hex');
    const inserted = await db.transaction(async (tx) => {
      const current = (await tx.query<Pick<Row, 'prompt' | 'workflow_slug'>>(
        `SELECT prompt,workflow_slug FROM agent_subscriptions WHERE id=$1 FOR UPDATE`, [row.id],
      )).rows[0];
      if (!current) return false;
      const line = await systemLine(tx, {
        id, roomId: row.room_id, authorId: SYSTEM_IDENTITY_ID,
        subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: 'Beeline' },
        verb: 'received', object: 'a repository event', consequence: eventName,
        kind: 'subscription-fired', payload, wakes: [row.agent_id],
        subscriptionPrompt: current.prompt, subscriptionWorkflowSlug: current.workflow_slug ?? undefined,
      });
      if (line.inserted) await tx.query(`UPDATE agent_subscriptions
        SET last_fired_at=now(),fired_count=fired_count+1 WHERE id=$1`, [row.id]);
      return line.inserted;
    });
    if (inserted) changed.push(row.room_id);
  }
  return changed;
}

export function subscriptionPromptBody(text: string, event: { kind?: string; payload?: unknown; subscriptionPrompt?: string; subscriptionWorkflowSlug?: string } | null): string {
  return event?.kind === 'subscription-fired'
    ? subscriptionActionPrompt(event) : text;
}
