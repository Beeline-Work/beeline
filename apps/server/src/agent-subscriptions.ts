import { routeSystemCommand } from './agent-command.js';
import { retireMembershipSubscriptionLists } from './membership-join.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerReviewerSql } from './corner-reviewer.js';
import { validateScheduleTitle } from './schedule-title.js';
import { createHash, randomUUID } from 'node:crypto';
import { isSubscribableEventKind, SUBSCRIBABLE_EVENT_KINDS } from '@beeline/api-contract/phone';
import { isRepositorySubscriptionEvent, type RoomSubscriptionView, type SubscriptionSource } from '@beeline/api-contract/phone';
import { subscriptionActionPrompt } from '@beeline/api-contract/phone';
import type { ComposioApps } from './composio-apps.js';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { scheduleWorkflowName } from './workflow-admin.js';
import { connectedProviderApp, providerForEvent, queueProviderWebhook,
  providerEventIsAvailable, retireUnusedProviderWebhook } from './provider-webhooks.js';
import { createWebhookCredentials, requireWebhookAdmin } from './subscription-webhooks.js';
import { notifyConnectorHelper } from './postgres-live.js';
import { repositorySubscriptionLine } from './repository-subscription-line.js';

export const AGENT_SUBSCRIPTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_subscriptions (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
 source text NOT NULL CHECK(source IN ('room','repository','service','webhook')),
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
   OR (source='webhook' AND event='webhook.called')
   OR (source='service' AND service_app_id IS NOT NULL AND trigger_id IS NOT NULL))
);
ALTER TABLE agent_subscriptions ALTER COLUMN prompt DROP NOT NULL;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS inherit_to_corners boolean NOT NULL DEFAULT false;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_subscriptions_room_prompt') THEN
  ALTER TABLE agent_subscriptions ADD CONSTRAINT agent_subscriptions_room_prompt CHECK(prompt IS NOT NULL OR source='room');
 END IF;
END $$;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS trigger_text text;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS service_app_id uuid REFERENCES workspace_apps(id) ON DELETE CASCADE;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS service_account_id text;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS service_channel_id text;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS service_channel_name text;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS trigger_id text;
ALTER TABLE agent_subscriptions DROP CONSTRAINT IF EXISTS agent_subscriptions_source_check;
ALTER TABLE agent_subscriptions DROP CONSTRAINT IF EXISTS agent_subscriptions_check;
ALTER TABLE agent_subscriptions DROP CONSTRAINT IF EXISTS agent_subscriptions_source_v2_check;
ALTER TABLE agent_subscriptions DROP CONSTRAINT IF EXISTS agent_subscriptions_shape_v2_check;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS webhook_token text;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS webhook_suffix text;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS webhook_token_created_at timestamptz;
ALTER TABLE agent_subscriptions ADD COLUMN IF NOT EXISTS webhook_owner_id text REFERENCES identities(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agent_subscriptions_webhook_owner ON agent_subscriptions(webhook_owner_id);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_subscriptions_source_v3_check') THEN
  ALTER TABLE agent_subscriptions ADD CONSTRAINT agent_subscriptions_source_v3_check
   CHECK(source IN ('room','repository','service','webhook'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_subscriptions_shape_v3_check') THEN
  ALTER TABLE agent_subscriptions ADD CONSTRAINT agent_subscriptions_shape_v3_check CHECK (
   (source='room' AND repository IS NULL) OR (source='repository' AND repository IS NOT NULL)
   OR (source='webhook' AND event='webhook.called')
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

/** Install after corner_person_state; both projections derive from one action table. */
export const ROOM_EVENT_SUBSCRIPTIONS_SCHEMA = `
-- One actionable store. subscribe_events inheritance stays a direct event even
-- when the same parent key has a prompt; an explicit corner preference overrides it.
CREATE OR REPLACE VIEW room_event_subscriptions AS
SELECT subscription.id,subscription.workspace_id,subscription.room_id,subscription.agent_id,
  subscription.source,subscription.event,subscription.repository,subscription.service_app_id,
  subscription.service_account_id,subscription.service_channel_id,subscription.service_channel_name,subscription.trigger_id,
  subscription.prompt,subscription.workflow_slug,subscription.fired_count,subscription.created_at,
  subscription.last_fired_at,subscription.title,subscription.trigger_text,subscription.webhook_token,
  subscription.webhook_suffix,subscription.webhook_token_created_at,subscription.webhook_owner_id,subscription.inherit_to_corners,false inherited
FROM agent_subscriptions subscription WHERE source='room'
UNION ALL
SELECT subscription.id,subscription.workspace_id,corner.id room_id,subscription.agent_id,
  subscription.source,subscription.event,subscription.repository,subscription.service_app_id,
  subscription.service_account_id,subscription.service_channel_id,subscription.service_channel_name,
  subscription.trigger_id,NULL::text prompt,NULL::text workflow_slug,0 fired_count,
  subscription.created_at,NULL::timestamptz last_fired_at,NULL::text title,NULL::text trigger_text,
  subscription.webhook_token,subscription.webhook_suffix,subscription.webhook_token_created_at,
  subscription.webhook_owner_id,subscription.inherit_to_corners,true inherited
FROM agent_subscriptions subscription JOIN rooms corner ON corner.parent_id=subscription.room_id
LEFT JOIN corner_person_state state ON state.corner_id=corner.id AND state.identity_id=subscription.agent_id
WHERE subscription.source='room' AND subscription.inherit_to_corners AND corner.archived_at IS NULL
  AND NOT COALESCE(state.subscriptions_overridden,false)
  AND NOT EXISTS (SELECT 1 FROM agent_subscriptions own WHERE own.room_id=corner.id
    AND own.agent_id=subscription.agent_id AND own.source='room' AND own.event=subscription.event);

CREATE OR REPLACE VIEW effective_agent_subscriptions AS
SELECT * FROM room_event_subscriptions
UNION ALL
SELECT subscription.id,subscription.workspace_id,subscription.room_id,subscription.agent_id,
  subscription.source,subscription.event,subscription.repository,subscription.service_app_id,
  subscription.service_account_id,subscription.service_channel_id,subscription.service_channel_name,subscription.trigger_id,
  subscription.prompt,subscription.workflow_slug,subscription.fired_count,subscription.created_at,
  subscription.last_fired_at,subscription.title,subscription.trigger_text,subscription.webhook_token,
  subscription.webhook_suffix,subscription.webhook_token_created_at,subscription.webhook_owner_id,subscription.inherit_to_corners,false inherited
FROM agent_subscriptions subscription WHERE source<>'room';
`;

type Row = {
  title?: string | null; trigger_text?: string | null; inherited?: boolean;
  id: string; room_id: string; agent_id: string; source: SubscriptionSource;
  event: string; repository: string | null; prompt: string | null; workflow_slug: string | null; fired_count: number;
  service_app_id: string | null; service_account_id: string | null; service_channel_id: string | null;
  service_channel_name: string | null; trigger_id: string | null;
  provider_status?: 'registering' | 'active' | 'retiring' | 'error' | null;
  created_at: Date; last_fired_at: Date | null;
  parent_id?: string | null; room_name?: string | null;
};
function view(row: Row): RoomSubscriptionView {
  return {
    id: row.inherited ? `legacy:${row.room_id}:${row.agent_id}:${row.event}` : row.id, roomId: row.room_id, agentId: row.agent_id,
    source: row.source, event: row.event,
    ...(row.repository ? { repository: row.repository } : {}),
    ...(row.source === 'service' && row.event === 'new_message' ? { service: 'Slack' as const,
      channel: `#${row.service_channel_name ?? row.service_channel_id ?? 'channel'}`,
      when: `On new message in #${row.service_channel_name ?? row.service_channel_id ?? 'channel'}` } : {}),
    ...(row.source === 'service' && row.event === 'issue.created'
      ? { service: 'Linear' as const, when: 'On new issue in Linear' } : {}),
    ...(row.source === 'service' && row.event === 'payment_intent.succeeded'
      ? { service: 'Stripe' as const, when: 'On payment succeeded in Stripe' } : {}),
    ...(row.source === 'service' && providerForEvent(row.event)
      ? { registrationStatus: row.provider_status ?? 'registering' } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.trigger_text ? { when: row.trigger_text } : {}),
    ...(row.source === 'webhook' ? { when: 'On webhook call' } : {}),
    ...(row.prompt ? { prompt: row.prompt } : {}), ...(row.workflow_slug ? { workflowSlug: row.workflow_slug } : {}), firedCount: row.fired_count,
    createdAt: Math.floor(row.created_at.getTime() / 1000),
    ...(row.last_fired_at ? { lastFiredAt: Math.floor(row.last_fired_at.getTime() / 1000) } : {}),
    ...(row.parent_id ? { corner: { id: row.room_id, name: row.room_name ?? 'Corner' } } : {}),
  };
}

// Older phones retain these IDs; decode them only to edit the single subscription store.
function legacyId(id: string) {
  const match = /^legacy:([0-9a-f-]{36}):([^:]+):([^:]+)$/.exec(id);
  return match ? { roomId: match[1]!, agentId: match[2]!, event: match[3]! } : undefined;
}

function validEvent(source: SubscriptionSource, event: string): boolean {
  return source === 'webhook' ? event === 'webhook.called' : source === 'room'
    ? isSubscribableEventKind(event)
    : source === 'repository' ? isRepositorySubscriptionEvent(event)
      : event === 'new_message' || Boolean(providerForEvent(event));
}

/** Agent writes need only current Room membership. Repository scope is checked against the installed app catalog. */
export async function createAgentSubscription(
  db: SqlDatabase, agentId: string,
  input: { roomId: string; source: SubscriptionSource; event: string; repository?: string;
    requestId?: string; channelId?: string; channelName?: string; title?: string; when?: string; prompt: string; workflowName?: string },
  service?: { composio?: ComposioApps; receiverUrl: string },
): Promise<RoomSubscriptionView> {
  return input.source === 'webhook' || (input.source === 'service' && providerForEvent(input.event))
    ? db.transaction((tx) => createAgentSubscriptionInDb(tx, agentId, input, service))
    : createAgentSubscriptionInDb(db, agentId, input, service);
}

async function createAgentSubscriptionInDb(
  db: SqlDatabase, agentId: string,
  input: { roomId: string; source: SubscriptionSource; event: string; repository?: string;
    requestId?: string; channelId?: string; channelName?: string; title?: string; when?: string; prompt: string; workflowName?: string },
  service?: { composio?: ComposioApps; receiverUrl: string },
): Promise<RoomSubscriptionView> {
  const title = validateScheduleTitle(input.title);
  if (!title) throw new Error('title is required when creating a subscription');
  const when = typeof input.when === 'string' ? input.when.trim().replace(/\s+/g, ' ') : '';
  if (!when || when.split(' ').length > 5)
    throw new Error('when is required: a trigger phrase of one to five words');
  const prompt = input.prompt?.trim();
  if (!prompt || prompt.length > 4000) throw new Error('prompt must be 1–4000 characters');
  if (!['room', 'repository', 'service', 'webhook'].includes(input.source) || !validEvent(input.source, input.event))
    throw new Error('event is not available for this subscription source');
  const repository = input.source === 'repository' ? input.repository?.trim().toLowerCase() : undefined;
  if (input.source === 'repository' && (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)))
    throw new Error('repository must be an installed owner/name repository');
  if (input.source === 'room' && input.repository !== undefined)
    throw new Error('Room subscriptions do not name a repository');
  if (input.source === 'service' && input.event === 'new_message' &&
    (!input.channelId || !/^[A-Z0-9]{2,30}$/.test(input.channelId)))
    throw new Error('A Slack channel ID is required');
  if (input.source === 'service' && input.event !== 'new_message' &&
    (input.channelId !== undefined || input.channelName !== undefined))
    throw new Error('This service event does not use a Slack channel');
  if (input.channelName && !/^[a-zA-Z0-9_-]{1,80}$/.test(input.channelName))
    throw new Error('channelName must be a channel name without #');
  const room = await db.query<{ workspace_id: string }>(
    `SELECT room.workspace_id FROM rooms room
     JOIN room_access member ON member.room_id=room.id AND member.identity_id=$2 AND member.removed_at IS NULL
     JOIN identities agent ON agent.id=$2 AND agent.kind='agent'
     WHERE room.id=$1 AND room.archived_at IS NULL`, [input.roomId, agentId],
  );
  if (!room.rowCount) throw new Error('agent is not a current Room member');
  const webhookOwner = input.source === 'webhook'
    ? await requireWebhookAdmin(db, input.roomId, undefined, { agentId, requestId: input.requestId }) : undefined;
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
  let app: { id: string; composio_account_id?: string } | undefined;
  let triggerId: string | undefined;
  let providerConnectorId: string | undefined;
  let providerStatus: 'registering' | 'active' | undefined;
  if (input.source === 'service') {
    if (!service) throw new Error('Connected service events are unavailable');
    if (input.event === 'new_message') {
      if (!service.composio) throw new Error('Slack events are unavailable');
      const slackApp = (await db.query<{ id: string; composio_account_id: string }>(
        `SELECT app.id,app.composio_account_id FROM workspace_apps app
         JOIN memberships owner ON owner.workspace_id=$1 AND owner.room_id IS NULL
           AND owner.identity_id=app.owner_identity_id AND owner.removed_at IS NULL
         WHERE app.workspace_id=$1 AND app.app_key='slack' AND app.transport='composio'
           AND app.state='active' AND app.composio_account_id IS NOT NULL
         ORDER BY app.updated_at DESC LIMIT 1`, [room.rows[0]!.workspace_id],
      )).rows[0];
      if (!slackApp) throw new Error('Slack is not connected in this Workspace');
      app = slackApp;
      await service.composio.ensureTriggerReceiver(service.receiverUrl);
      triggerId = await service.composio.upsertWebhookTrigger('SLACK_NEW_MESSAGE',
        slackApp.composio_account_id, { channel_id: input.channelId, message_type: 'channel' });
    } else {
      const provider = providerForEvent(input.event)!;
      const connected = await connectedProviderApp(db, input.roomId, agentId, provider);
      if (!connected) throw new Error(`${provider} is not connected on this agent's machine`);
      app = { id: connected.id };
      const webhook = await queueProviderWebhook(db, connected, provider, input.event, service.receiverUrl);
      triggerId = webhook.id;
      providerStatus = webhook.queued ? 'registering' : 'active';
      if (webhook.queued) providerConnectorId = webhook.connectorId;
    }
  }
  const id = randomUUID();
  // The existing source/event scope key also distinguishes independent webhook links.
  // Keep its index compatible with older servers during a rolling deployment.
  const channelScope = input.source === 'webhook' ? id
    : input.source === 'service' && input.event === 'new_message' ? input.channelId : null;
  const rows = await db.query<Row>(
    `INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,repository,prompt,workflow_slug,
       service_app_id,service_account_id,service_channel_id,service_channel_name,trigger_id,title,trigger_text)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT(room_id,agent_id,source,event,COALESCE(repository,''),
       COALESCE(service_app_id::text,''),COALESCE(service_channel_id,'')) DO UPDATE
       SET title=EXCLUDED.title,trigger_text=EXCLUDED.trigger_text,prompt=EXCLUDED.prompt,workflow_slug=EXCLUDED.workflow_slug,
         service_channel_name=EXCLUDED.service_channel_name,trigger_id=EXCLUDED.trigger_id
     RETURNING *`,
    [id, room.rows[0]!.workspace_id, input.roomId, agentId, input.source, input.event,
      repository ?? null, prompt, workflowSlug ?? null, app?.id ?? null, app?.composio_account_id ?? null,
      channelScope,
      input.source === 'service' && input.event === 'new_message' ? input.channelName ?? null : null, triggerId ?? null, title, when],
  );
  if (webhookOwner) await createWebhookCredentials(db, rows.rows[0]!.id, webhookOwner);
  if (providerConnectorId) await notifyConnectorHelper(db, providerConnectorId);
  if (providerStatus) rows.rows[0]!.provider_status = providerStatus;
  return view(rows.rows[0]!);
}

export async function listAgentSubscriptions(db: SqlDatabase, roomId: string, agentId: string) {
  const rows = await db.query<Row>(
    `SELECT subscription.*,hook.status provider_status FROM effective_agent_subscriptions subscription
     LEFT JOIN provider_webhooks hook ON hook.id::text=subscription.trigger_id
     JOIN room_access member ON member.room_id=subscription.room_id AND member.identity_id=$2 AND member.removed_at IS NULL
     JOIN rooms surface ON surface.id=subscription.room_id
     JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
     WHERE subscription.room_id=$1 AND subscription.agent_id=$2
       AND NOT (subscription.prompt IS NULL AND subscription.event='check-passed' AND ${cornerReviewerSql('surface')} IS NOT DISTINCT FROM subscription.agent_id)
     ORDER BY subscription.created_at,subscription.id`, [roomId, agentId],
  );
  return { subscriptions: rows.rows.map(view) };
}

async function removeUnusedTrigger(db: SqlDatabase, composio: ComposioApps | undefined, triggerId: string | null) {
  if (!triggerId) return;
  const remaining = await db.query(`SELECT 1 FROM agent_subscriptions WHERE trigger_id=$1 LIMIT 1`, [triggerId]);
  if (remaining.rowCount) return;
  if (/^[0-9a-f-]{36}$/.test(triggerId)) await retireUnusedProviderWebhook(db, triggerId);
  else if (composio) await composio.deleteWebhookTrigger(triggerId);
}

export async function deleteAgentSubscription(db: SqlDatabase, roomId: string, agentId: string, id: string,
  composio?: ComposioApps) {
  const legacy = legacyId(id);
  if (legacy) {
    if (legacy.roomId !== roomId || legacy.agentId !== agentId) throw new Error('subscription not found');
    await deleteRoomSubscription(db, roomId, id, composio);
    return;
  }
  if (await removeRoomEventSubscription(db, roomId, agentId, {id})) return;
  const deleted = await db.query<{ trigger_id: string | null }>(
    `DELETE FROM agent_subscriptions subscription USING room_access member
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
    `SELECT subscription.*,hook.status provider_status,surface.parent_id,surface.name room_name
     FROM effective_agent_subscriptions subscription
     LEFT JOIN provider_webhooks hook ON hook.id::text=subscription.trigger_id
     JOIN rooms surface ON surface.id=subscription.room_id AND surface.archived_at IS NULL
     JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
     JOIN room_access member ON member.room_id=subscription.room_id
       AND member.identity_id=subscription.agent_id AND member.removed_at IS NULL
     WHERE (surface.id=$1 OR surface.parent_id=$1)
       AND NOT (subscription.prompt IS NULL AND subscription.event='check-passed' AND ${cornerReviewerSql('surface')} IS NOT DISTINCT FROM subscription.agent_id)
     ORDER BY subscription.created_at,subscription.id`, [roomId],
  );
  return { subscriptions: rows.rows.map(view) };
}

export async function deleteRoomSubscription(db: SqlDatabase, roomId: string, id: string,
  composio?: ComposioApps) {
  const legacy = legacyId(id);
  if (legacy) {
    const surface = (await db.query(`SELECT 1 FROM rooms WHERE id=$1 AND (id=$2 OR parent_id=$2)`, [legacy.roomId, roomId])).rowCount;
    if (!surface || !await removeRoomEventSubscription(db, legacy.roomId, legacy.agentId, {event:legacy.event}))
      throw new Error('subscription not found');
    return;
  }
  const roomSubscription = (await db.query<{room_id:string;agent_id:string}>(`SELECT subscription.room_id,subscription.agent_id
    FROM agent_subscriptions subscription JOIN rooms surface ON surface.id=subscription.room_id
    WHERE subscription.id=$1 AND source='room' AND (surface.id=$2 OR surface.parent_id=$2)`, [id,roomId])).rows[0];
  if (roomSubscription) return deleteAgentSubscription(db, roomSubscription.room_id, roomSubscription.agent_id, id, composio);
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
export async function listServiceSubscriptionEvents(db: SqlDatabase, roomId: string, agentId: string,
  includeSlack = true) {
  const rows = includeSlack ? await db.query(
    `SELECT 1 FROM rooms room
     JOIN room_access agent ON agent.room_id=room.id AND agent.identity_id=$2 AND agent.removed_at IS NULL
     JOIN workspace_apps app ON app.workspace_id=room.workspace_id AND app.app_key='slack'
       AND app.transport='composio' AND app.state='active' AND app.composio_account_id IS NOT NULL
     JOIN memberships owner ON owner.workspace_id=room.workspace_id AND owner.room_id IS NULL
       AND owner.identity_id=app.owner_identity_id AND owner.removed_at IS NULL
     WHERE room.id=$1 AND room.archived_at IS NULL LIMIT 1`, [roomId, agentId],
  ) : { rowCount: 0 };
  const linearApp = await connectedProviderApp(db, roomId, agentId, 'linear');
  const stripeApp = await connectedProviderApp(db, roomId, agentId, 'stripe');
  const linear = linearApp && await providerEventIsAvailable(db, linearApp.id, 'issue.created');
  const stripe = stripeApp && await providerEventIsAvailable(db, stripeApp.id, 'payment_intent.succeeded');
  return { events: [
    ...(rows.rowCount ? [{ service: 'Slack' as const, event: 'new_message' as const,
      label: 'new message in a Slack channel' as const }] : []),
    ...(linear ? [{ service: 'Linear' as const, event: 'issue.created' as const,
      label: 'new issue in Linear' as const }] : []),
    ...(stripe ? [{ service: 'Stripe' as const, event: 'payment_intent.succeeded' as const,
      label: 'payment succeeded in Stripe' as const }] : []),
  ] };
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
     JOIN room_access agent ON agent.room_id=room.id AND agent.identity_id=subscription.agent_id
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
        subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: systemMessage("agent-subscriptions.beeline") },
        verb: systemMessage("agent-subscriptions.received"), object: systemMessage("agent-subscriptions.a-slack-message"), consequence: row.service_channel_name
          ? systemMessage("agent-subscriptions.channel-name", row.service_channel_name) : undefined,
        kind: 'subscription-fired', wakes: [row.agent_id],
        payload: { source: 'service', service: 'Slack', event: 'new_message',
          channel: row.service_channel_name ? `#${row.service_channel_name}` : row.service_channel_id,
          message: typeof data.message === 'string' ? data.message.slice(0, 8000) : undefined,
          sender: data.sender && typeof data.sender === 'object' && !Array.isArray(data.sender)
            ? { name: typeof (data.sender as Record<string, unknown>).name === 'string'
              ? ((data.sender as Record<string, unknown>).name as string).slice(0, 100) : undefined }
            : undefined },
        subscriptionPrompt: current.prompt ?? undefined, subscriptionWorkflowSlug: current.workflow_slug ?? undefined,
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
  if (event === 'pull_request' && action === 'closed' &&
      (body.pull_request as { merged?: unknown } | undefined)?.merged === true) return [];
  const eventName = `${event === 'issues' ? 'issue' : event}.${action}`;
  if (!isRepositorySubscriptionEvent(eventName)) return [];
  const repositoryObject = body.repository;
  const repository = repositoryObject && typeof repositoryObject === 'object' && !Array.isArray(repositoryObject)
    ? (repositoryObject as Record<string, unknown>).full_name : undefined;
  if (typeof repository !== 'string') return [];
  const rows = await db.query<Row>(
    `SELECT subscription.* FROM agent_subscriptions subscription
     JOIN rooms room ON room.id=subscription.room_id AND room.archived_at IS NULL
     JOIN room_access agent ON agent.room_id=room.id AND agent.identity_id=subscription.agent_id AND agent.removed_at IS NULL
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
        ...repositorySubscriptionLine(eventName, repository, details),
        kind: 'subscription-fired', payload, wakes: [row.agent_id],
        subscriptionPrompt: current.prompt ?? undefined, subscriptionWorkflowSlug: current.workflow_slug ?? undefined,
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

async function materializeCornerSubscriptions(tx: SqlDatabase, roomId: string, agentId: string): Promise<void> {
  await tx.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,created_at,inherit_to_corners)
    SELECT gen_random_uuid(),workspace_id,room_id,agent_id,'room',event,NULL,created_at,true
    FROM room_event_subscriptions WHERE room_id=$1 AND agent_id=$2 AND inherited
    ON CONFLICT DO NOTHING`, [roomId, agentId]);
  await tx.query(`INSERT INTO corner_person_state(corner_id,identity_id,subscriptions_overridden) VALUES($1,$2,true)
    ON CONFLICT(corner_id,identity_id) DO UPDATE SET subscriptions_overridden=true`, [roomId, agentId]);
}

/** Stop exactly one event. Materialize inherited siblings so deleting a corner
 * override cannot reveal the same parent subscription again. */
async function removeRoomEventSubscription(db: SqlDatabase, roomId: string, agentId: string,
  key: {id?:string;event?:string}): Promise<boolean> {
  return db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('room-subscriptions:'||$1||':'||$2))", [roomId, agentId]);
    const subscription=(await roomEventSubscriptions(tx,roomId)).find(row=>row.agent_id===agentId &&
      (key.id ? row.id===key.id : row.event===key.event));
    if(!subscription) return false;
    const surface=(await tx.query<{parent_id:string|null;reviewer:string|null}>(
      `SELECT room.parent_id,${cornerReviewerSql('room')} reviewer FROM rooms room
       JOIN rooms parent ON parent.id=COALESCE(room.parent_id,room.id) WHERE room.id=$1`,[roomId])).rows[0]!;
    if(subscription.prompt===null && subscription.event==='check-passed' && surface.reviewer===agentId)
      throw new Error('subscription not found');
    if(surface.parent_id) await materializeCornerSubscriptions(tx,roomId,agentId);
    const deleted=await tx.query(`DELETE FROM agent_subscriptions WHERE room_id=$1 AND agent_id=$2
      AND source='room' AND event=$3`,[roomId,agentId,subscription.event]);
    return Boolean(deleted.rowCount);
  });
}

/** Prompt-free subscribe_events is a wire adapter to the same room/event key as
 * prompted actions. Retained events keep their explicit prompt; removed events stop. */
export async function setRoomEventSubscriptions(db: SqlDatabase, roomId: string, agentId: string,
  kinds: readonly string[]): Promise<string[]> {
  return db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('room-subscriptions:'||$1||':'||$2))", [roomId, agentId]);
    const surface = (await tx.query<{ workspace_id: string; parent_id: string | null; reviewer: string | null }>(
      `SELECT room.workspace_id,room.parent_id,${cornerReviewerSql('room')} reviewer
       FROM rooms room JOIN rooms parent ON parent.id=COALESCE(room.parent_id,room.id)
       JOIN room_access member ON member.room_id=room.id AND member.identity_id=$2 AND member.removed_at IS NULL
       WHERE room.id=$1 AND room.archived_at IS NULL`, [roomId, agentId])).rows[0];
    if (!surface) throw new Error('daemon room access denied');
    // Reviewer duties remain described when the agent replaces its own preferences.
    const events = [...new Set([...kinds, ...(surface.reviewer === agentId ? ['check-passed'] : [])])];
    if (events.some(event => !isSubscribableEventKind(event))) throw new Error('invalid subscription event');
    // Materialize the inherited preference before setting its override flag.
    if (surface.parent_id) {
      await materializeCornerSubscriptions(tx, roomId, agentId);
    }
    await tx.query(`DELETE FROM agent_subscriptions WHERE room_id=$1 AND agent_id=$2 AND source='room'
      AND NOT event=ANY($3::text[])`, [roomId, agentId, events]);
    for (const event of events) await tx.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,inherit_to_corners)
      VALUES($1,$2,$3,$4,'room',$5,NULL,true)
      ON CONFLICT(room_id,agent_id,source,event,COALESCE(repository,''),COALESCE(service_app_id::text,''),COALESCE(service_channel_id,''))
      DO UPDATE SET inherit_to_corners=true`, [randomUUID(), surface.workspace_id, roomId, agentId, event]);
    return events;
  });
}

export async function roomEventSubscriptions(db: SqlDatabase, roomId: string, event?: string, lock = false) {
  return (await db.query<Row & { inherited: boolean }>(`SELECT subscription.* FROM room_event_subscriptions subscription
    JOIN agent_subscriptions stored ON stored.id=subscription.id
    JOIN room_access member ON member.room_id=subscription.room_id AND member.identity_id=subscription.agent_id
      AND member.removed_at IS NULL
    JOIN identities agent ON agent.id=subscription.agent_id AND agent.kind='agent'
    WHERE subscription.room_id=$1 AND ($2::text IS NULL OR subscription.event=$2)
    ORDER BY subscription.id ${lock ? 'FOR UPDATE OF stored' : ''}`, [roomId, event ?? null])).rows;
}

export async function subscriptionRooms(db: SqlDatabase, roomIds: readonly string[], event: string): Promise<string[]> {
  return (await db.query<{ room_id: string }>(`SELECT DISTINCT subscription.room_id FROM room_event_subscriptions subscription
    JOIN room_access member ON member.room_id=subscription.room_id AND member.identity_id=subscription.agent_id
      AND member.removed_at IS NULL
    JOIN identities agent ON agent.id=subscription.agent_id AND agent.kind='agent'
    WHERE subscription.room_id=ANY($1::uuid[]) AND subscription.event=$2`, [roomIds, event])).rows.map(row => row.room_id);
}

/** Upgrade-only import. Old JSON is retired after copying; it never dispatches.
 * Prompted rows win the shared event key so migration cannot create a second action. */
export async function migrateMembershipSubscriptions(db: SqlDatabase): Promise<void> {
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,created_at,inherit_to_corners)
      SELECT gen_random_uuid(),member.workspace_id,member.room_id,member.identity_id,'room',kind,NULL,member.joined_at,true
      FROM memberships member JOIN rooms room ON room.id=member.room_id AND room.parent_id IS NULL AND room.archived_at IS NULL
      CROSS JOIN LATERAL jsonb_array_elements_text(member.event_subscriptions) kind
      WHERE kind=ANY($1::text[])
      ON CONFLICT(room_id,agent_id,source,event,COALESCE(repository,''),COALESCE(service_app_id::text,''),COALESCE(service_channel_id,''))
      DO UPDATE SET inherit_to_corners=true`, [[...SUBSCRIBABLE_EVENT_KINDS]]);
    await tx.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,created_at,inherit_to_corners)
      SELECT gen_random_uuid(),room.workspace_id,state.corner_id,state.identity_id,'room',kind,NULL,state.created_at,true
      FROM corner_person_state state JOIN rooms room ON room.id=state.corner_id AND room.archived_at IS NULL
      CROSS JOIN LATERAL jsonb_array_elements_text(state.event_subscriptions) kind
      WHERE kind=ANY($1::text[])
      ON CONFLICT(room_id,agent_id,source,event,COALESCE(repository,''),COALESCE(service_app_id::text,''),COALESCE(service_channel_id,''))
      DO UPDATE SET inherit_to_corners=true`, [[...SUBSCRIBABLE_EVENT_KINDS]]);
    await tx.query(`UPDATE corner_person_state SET subscriptions_overridden=true,event_subscriptions=NULL
      WHERE event_subscriptions IS NOT NULL`);
    // The membership writer owns even the retirement write to its old column.
    await retireMembershipSubscriptionLists(tx);
    await recoverRecentLeaveFacts(tx);
  });
}

/** Upgrade-only repair for the old free-agent sweep's ten-minute window.
 * Current producers declare left and dispatch immediately through systemLine. */
async function recoverRecentLeaveFacts(db: SqlDatabase): Promise<void> {
  const leaves=(await db.query<{id:string;room_id:string;agent_id:string}>(`
    SELECT line.id,subscription.room_id,subscription.agent_id
    FROM room_event_subscriptions subscription
    JOIN room_access member ON member.room_id=subscription.room_id AND member.identity_id=subscription.agent_id AND member.removed_at IS NULL
    JOIN free_agents agent ON agent.agent_id=subscription.agent_id AND agent.state<>'failed' AND agent.removed_at IS NULL
    CROSS JOIN LATERAL (
      SELECT message.id,message.card FROM messages message WHERE message.room_id=subscription.room_id
        AND floor(extract(epoch FROM (message.created_at AT TIME ZONE 'UTC'))*1000)::bigint
          >=floor(extract(epoch FROM now()-interval '10 minutes')*1000)::bigint
        AND message.card_type IN ('member-left','member-removed') AND message.system_event->>'kind' IS NULL
        AND message.deleted_at IS NULL
    ) line
    WHERE subscription.event='left' AND subscription.inherit_to_corners
      AND line.card->>'identityId' IS DISTINCT FROM subscription.agent_id
      AND NOT EXISTS(SELECT 1 FROM agent_commands command WHERE command.agent_id=subscription.agent_id AND command.source_message_id=line.id)
  `)).rows;
  for(const leave of leaves){
    await db.query(`UPDATE messages SET system_event=system_event||'{"kind":"left"}'::jsonb WHERE id=$1`,[leave.id]);
    await routeSystemCommand(db,{roomId:leave.room_id,sourceMessageId:leave.id,kind:'left',targets:[leave.agent_id]});
  }
}

/** Restore the configured reviewer description without replacing independent user actions. */
export async function subscribeConfiguredReviewers(db: SqlDatabase, [parentRoomId]: [string | null]) {
  const rooms = (await db.query<{ id: string; reviewer_agent_id: string }>(`SELECT room.id,room.reviewer_agent_id FROM rooms room
    JOIN memberships member ON member.room_id=room.id AND member.identity_id=room.reviewer_agent_id AND member.removed_at IS NULL
    WHERE room.parent_id IS NULL AND room.archived_at IS NULL AND ($1::uuid IS NULL OR room.id=$1)
      AND NOT EXISTS(SELECT 1 FROM agent_subscriptions subscription WHERE subscription.room_id=room.id
        AND subscription.agent_id=room.reviewer_agent_id AND source='room' AND event='check-passed')`, [parentRoomId])).rows;
  for (const room of rooms) await subscribeRoomReviewer(db, [room.id, room.reviewer_agent_id]);
  return { rowCount: rooms.length };
}
export async function unsubscribeRoomReviewer(db: SqlDatabase, [room, agent]: [string, string]) {
  // A manually prompted action remains independent of reviewer configuration.
  await db.query(`DELETE FROM agent_subscriptions subscription USING rooms surface
    WHERE subscription.room_id=surface.id AND (surface.id=$1 OR surface.parent_id=$1)
      AND subscription.agent_id=$2 AND source='room' AND event='check-passed' AND prompt IS NULL`, [room, agent]);
}
export async function subscribeRoomReviewer(db: SqlDatabase, [room, agent]: [string, string]) {
  // Add the policy key without replacing any concurrently created user actions.
  await db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt,inherit_to_corners)
    SELECT gen_random_uuid(),surface.workspace_id,surface.id,$2,'room','check-passed',NULL,true
    FROM rooms surface JOIN room_access member ON member.room_id=surface.id AND member.identity_id=$2 AND member.removed_at IS NULL
    LEFT JOIN corner_person_state state ON state.corner_id=surface.id AND state.identity_id=$2
    WHERE surface.archived_at IS NULL AND (surface.id=$1 OR (surface.parent_id=$1 AND state.subscriptions_overridden))
    ON CONFLICT(room_id,agent_id,source,event,COALESCE(repository,''),COALESCE(service_app_id::text,''),COALESCE(service_channel_id,''))
    DO UPDATE SET inherit_to_corners=true`, [room, agent]);
}
