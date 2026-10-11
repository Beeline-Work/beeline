import { createHash, randomUUID } from 'node:crypto';
import { isSubscribableEventKind } from '@beeline/api-contract/phone';
import { isRepositorySubscriptionEvent, type RoomSubscriptionView, type SubscriptionSource } from '@beeline/api-contract/phone';
import { subscriptionActionPrompt } from '@beeline/api-contract/phone';
import type { ComposioApps } from './composio-apps.js';
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
 source text NOT NULL CHECK(source IN ('room','repository','service')),
 event text NOT NULL,
 repository text,
 service_app_id uuid REFERENCES workspace_apps(id) ON DELETE CASCADE,
 service_account_id text,
 service_channel_id text,
 service_channel_name text,
 trigger_id text,
 prompt text NOT NULL,
 workflow_slug text,
 fired_count integer NOT NULL DEFAULT 0 CHECK(fired_count>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 last_fired_at timestamptz,
 CHECK ((source='room' AND repository IS NULL) OR (source='repository' AND repository IS NOT NULL)
   OR (source='service' AND service_app_id IS NOT NULL AND trigger_id IS NOT NULL))
);
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS service_app_id uuid REFERENCES workspace_apps(id) ON DELETE CASCADE;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS service_account_id text;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS service_channel_id text;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS service_channel_name text;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS trigger_id text;
ALTER TABLE agent_subscriptions DROP CONSTRAINT IF EXISTS agent_subscriptions_source_check;
ALTER TABLE agent_subscriptions DROP CONSTRAINT IF EXISTS agent_subscriptions_check;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_subscriptions_source_v2_check') THEN
  ALTER TABLE agent_subscriptions ADD CONSTRAINT agent_subscriptions_source_v2_check
   CHECK(source IN ('room','repository','service'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_subscriptions_shape_v2_check') THEN
  ALTER TABLE agent_subscriptions ADD CONSTRAINT agent_subscriptions_shape_v2_check CHECK (
   (source='room' AND repository IS NULL) OR (source='repository' AND repository IS NOT NULL)
   OR (source='service' AND service_app_id IS NOT NULL AND trigger_id IS NOT NULL));
 END IF;
END $$;
DROP INDEX IF EXISTS agent_subscriptions_unique;
CREATE UNIQUE INDEX IF NOT EXISTS agent_subscriptions_unique_v2
 ON agent_subscriptions(room_id,agent_id,source,event,COALESCE(repository,''),
   COALESCE(service_app_id::text,''),COALESCE(service_channel_id,''));
CREATE INDEX IF NOT EXISTS agent_subscriptions_workspace ON agent_subscriptions(workspace_id);
CREATE INDEX IF NOT EXISTS agent_subscriptions_agent ON agent_subscriptions(agent_id);
CREATE INDEX IF NOT EXISTS agent_subscriptions_repository ON agent_subscriptions(repository,source,event);
CREATE INDEX IF NOT EXISTS agent_subscriptions_trigger ON agent_subscriptions(trigger_id) WHERE trigger_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_subscriptions_service_app ON agent_subscriptions(service_app_id) WHERE service_app_id IS NOT NULL;
`;

type Row = {
  id: string; room_id: string; agent_id: string; source: SubscriptionSource;
  event: string; repository: string | null; prompt: string; workflow_slug: string | null; fired_count: number;
  service_app_id: string | null; service_account_id: string | null; service_channel_id: string | null;
  service_channel_name: string | null; trigger_id: string | null;
  created_at: Date; last_fired_at: Date | null;
  parent_id?: string | null; room_name?: string | null;
};
function view(row: Row): RoomSubscriptionView {
  return {
    id: row.id, roomId: row.room_id, agentId: row.agent_id,
    source: row.source, event: row.event,
    ...(row.repository ? { repository: row.repository } : {}),
    ...(row.source === 'service' ? { service: 'Slack' as const,
      channel: `#${row.service_channel_name ?? row.service_channel_id ?? 'channel'}`,
      when: `On new message in #${row.service_channel_name ?? row.service_channel_id ?? 'channel'}` } : {}),
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
    : source === 'repository' ? isRepositorySubscriptionEvent(event) : event === 'new_message';
}

/** Agent writes need only current Room membership. Repository scope is checked against the installed app catalog. */
export async function createAgentSubscription(
  db: SqlDatabase, agentId: string,
  input: { roomId: string; source: SubscriptionSource; event: string; repository?: string;
    channelId?: string; channelName?: string; prompt: string; workflowName?: string },
  service?: { composio: ComposioApps; receiverUrl: string },
): Promise<RoomSubscriptionView> {
  const prompt = input.prompt?.trim();
  if (!prompt || prompt.length > 4000) throw new Error('prompt must be 1–4000 characters');
  if (!['room', 'repository', 'service'].includes(input.source) || !validEvent(input.source, input.event))
    throw new Error('event is not available for this subscription source');
  const repository = input.source === 'repository' ? input.repository?.trim().toLowerCase() : undefined;
  if (input.source === 'repository' && (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)))
    throw new Error('repository must be an installed owner/name repository');
  if (input.source === 'room' && input.repository !== undefined)
    throw new Error('Room subscriptions do not name a repository');
  if (input.source === 'service' && (!input.channelId || !/^[A-Z0-9]{2,30}$/.test(input.channelId)))
    throw new Error('A Slack channel ID is required');
  if (input.channelName && !/^[a-zA-Z0-9_-]{1,80}$/.test(input.channelName))
    throw new Error('channelName must be a channel name without #');
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
  let app: { id: string; composio_account_id: string } | undefined;
  let triggerId: string | undefined;
  if (input.source === 'service') {
    if (!service) throw new Error('Connected service events are unavailable');
    app = (await db.query<{ id: string; composio_account_id: string }>(
      `SELECT app.id,app.composio_account_id FROM workspace_apps app
       JOIN memberships owner ON owner.workspace_id=$1 AND owner.room_id IS NULL
         AND owner.identity_id=app.owner_identity_id AND owner.removed_at IS NULL
       WHERE app.workspace_id=$1 AND app.app_key='slack' AND app.transport='composio'
         AND app.state='active' AND app.composio_account_id IS NOT NULL
       ORDER BY app.updated_at DESC LIMIT 1`, [room.rows[0]!.workspace_id],
    )).rows[0];
    if (!app) throw new Error('Slack is not connected in this Workspace');
    await service.composio.ensureTriggerReceiver(service.receiverUrl);
    triggerId = await service.composio.upsertWebhookTrigger('SLACK_NEW_MESSAGE',
      app.composio_account_id, { channel_id: input.channelId, message_type: 'channel' });
  }
  const rows = await db.query<Row>(
    `INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,repository,prompt,workflow_slug,
       service_app_id,service_account_id,service_channel_id,service_channel_name,trigger_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT(room_id,agent_id,source,event,COALESCE(repository,''),
       COALESCE(service_app_id::text,''),COALESCE(service_channel_id,'')) DO UPDATE
       SET prompt=EXCLUDED.prompt,workflow_slug=EXCLUDED.workflow_slug,
         service_channel_name=EXCLUDED.service_channel_name,trigger_id=EXCLUDED.trigger_id
     RETURNING *`,
    [randomUUID(), room.rows[0]!.workspace_id, input.roomId, agentId, input.source, input.event,
      repository ?? null, prompt, workflowSlug ?? null, app?.id ?? null, app?.composio_account_id ?? null,
      input.source === 'service' ? input.channelId : null,
      input.source === 'service' ? input.channelName ?? null : null, triggerId ?? null],
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

async function removeUnusedTrigger(db: SqlDatabase, composio: ComposioApps | undefined, triggerId: string | null) {
  if (!triggerId || !composio) return;
  const remaining = await db.query(`SELECT 1 FROM agent_subscriptions WHERE trigger_id=$1 LIMIT 1`, [triggerId]);
  if (!remaining.rowCount) await composio.deleteWebhookTrigger(triggerId);
}

export async function deleteAgentSubscription(db: SqlDatabase, roomId: string, agentId: string, id: string,
  composio?: ComposioApps) {
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
  const deleted = await db.query<{ trigger_id: string | null }>(
    `DELETE FROM agent_subscriptions subscription USING memberships member
     WHERE subscription.id=$1 AND subscription.room_id=$2 AND subscription.agent_id=$3
       AND member.room_id=subscription.room_id AND member.identity_id=$3 AND member.removed_at IS NULL
     RETURNING subscription.trigger_id`,
    [id, roomId, agentId],
  );
  if (!deleted.rowCount) throw new Error('subscription not found');
  await removeUnusedTrigger(db, composio, deleted.rows[0]!.trigger_id);
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

export async function deleteRoomSubscription(db: SqlDatabase, roomId: string, id: string,
  composio?: ComposioApps) {
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
  const deleted = await db.query<{ trigger_id: string | null }>(
    `DELETE FROM agent_subscriptions subscription USING rooms surface
     WHERE subscription.id=$1 AND surface.id=subscription.room_id
       AND (surface.id=$2 OR surface.parent_id=$2)
     RETURNING subscription.trigger_id`, [id, roomId],
  );
  if (!deleted.rowCount) throw new Error('subscription not found');
  await removeUnusedTrigger(db, composio, deleted.rows[0]!.trigger_id);
}

/** The per-Room catalog reflects actual active connected accounts. */
export async function listServiceSubscriptionEvents(db: SqlDatabase, roomId: string, agentId: string) {
  const rows = await db.query(
    `SELECT 1 FROM rooms room
     JOIN memberships agent ON agent.room_id=room.id AND agent.identity_id=$2 AND agent.removed_at IS NULL
     JOIN workspace_apps app ON app.workspace_id=room.workspace_id AND app.app_key='slack'
       AND app.transport='composio' AND app.state='active' AND app.composio_account_id IS NOT NULL
     JOIN memberships owner ON owner.workspace_id=room.workspace_id AND owner.room_id IS NULL
       AND owner.identity_id=app.owner_identity_id AND owner.removed_at IS NULL
     WHERE room.id=$1 AND room.archived_at IS NULL LIMIT 1`, [roomId, agentId],
  );
  return { events: rows.rowCount ? [{ service: 'Slack' as const, event: 'new_message' as const,
    label: 'new message in a Slack channel' as const }] : [] };
}

/** A signed provider delivery is routed by its account and trigger, never by payload claims alone. */
export async function fireServiceSubscriptions(db: SqlDatabase, body: Record<string, unknown>, deliveryId: string) {
  if (body.type !== 'composio.trigger.message') return [];
  const meta = body.metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [];
  const { trigger_id: triggerId, connected_account_id: accountId, trigger_slug: slug } =
    meta as Record<string, unknown>;
  if (typeof triggerId !== 'string' || typeof accountId !== 'string' || slug !== 'SLACK_NEW_MESSAGE') return [];
  const rows = await db.query<Row>(
    `SELECT subscription.* FROM agent_subscriptions subscription
     JOIN rooms room ON room.id=subscription.room_id AND room.archived_at IS NULL
     JOIN memberships agent ON agent.room_id=room.id AND agent.identity_id=subscription.agent_id
       AND agent.removed_at IS NULL
     JOIN workspace_apps app ON app.id=subscription.service_app_id AND app.workspace_id=room.workspace_id
       AND app.state='active' AND app.transport='composio' AND app.app_key='slack'
       AND app.composio_account_id=subscription.service_account_id
     JOIN memberships owner ON owner.workspace_id=room.workspace_id AND owner.room_id IS NULL
       AND owner.identity_id=app.owner_identity_id AND owner.removed_at IS NULL
     WHERE subscription.source='service' AND subscription.event='new_message'
       AND subscription.trigger_id=$1 AND subscription.service_account_id=$2`,
    [triggerId, accountId],
  );
  if (!rows.rowCount) return [];
  await ensureSystemIdentity(db);
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? body.data as Record<string, unknown> : {};
  const changed: string[] = [];
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
        verb: 'received', object: 'a Slack message', consequence: row.service_channel_name
          ? `#${row.service_channel_name}` : undefined,
        kind: 'subscription-fired', wakes: [row.agent_id],
        payload: { source: 'service', service: 'Slack', event: 'new_message',
          channel: row.service_channel_name ? `#${row.service_channel_name}` : row.service_channel_id,
          message: typeof data.message === 'string' ? data.message.slice(0, 8000) : undefined,
          sender: data.sender && typeof data.sender === 'object' && !Array.isArray(data.sender)
            ? { name: typeof (data.sender as Record<string, unknown>).name === 'string'
              ? ((data.sender as Record<string, unknown>).name as string).slice(0, 100) : undefined }
            : undefined },
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
