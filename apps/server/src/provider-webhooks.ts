import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { notifyConnectorHelper } from './postgres-live.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

export type ProviderService = 'linear' | 'stripe';
export function providerForEvent(event: string): ProviderService | undefined {
  if (event === 'issue.created') return 'linear';
  if (event === 'payment_intent.succeeded') return 'stripe';
  return undefined;
}

export const PROVIDER_WEBHOOKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_webhooks (
 id uuid PRIMARY KEY,
 app_id uuid NOT NULL REFERENCES workspace_apps(id) ON DELETE CASCADE,
 connector_id uuid NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
 service text NOT NULL CHECK(service IN ('linear','stripe')),
 event text NOT NULL,
 receiver_url text NOT NULL,
 provider_id text,
 signing_secret text,
 account_context text,
 livemode boolean,
 status text NOT NULL CHECK(status IN ('registering','active','retiring','error')),
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(app_id,event)
);
CREATE INDEX IF NOT EXISTS provider_webhooks_connector ON provider_webhooks(connector_id);
`;

type App = { id: string; connector_id: string };
/** A service is available only on the agent's machine with its connected official MCP app. */
export async function connectedProviderApp(db: SqlDatabase, roomId: string, agentId: string,
  service: ProviderService): Promise<App | undefined> {
  return (await db.query<App>(
    `SELECT app.id,app.connector_id FROM rooms room
     JOIN memberships agent_member ON agent_member.room_id=room.id
       AND agent_member.identity_id=$2 AND agent_member.removed_at IS NULL
     JOIN agents actor ON actor.agent_id=$2
     JOIN workspace_apps app ON app.workspace_id=room.workspace_id AND app.app_key=$3
       AND app.transport='registry-mcp' AND app.state='active' AND app.connector_id IS NOT NULL
       AND app.owner_identity_id=actor.owner_id
     JOIN workspace_connectors connector ON connector.id=app.connector_id
       AND connector.status='connected' AND connector.helper_agent_id IS NOT NULL
       AND connector.owner_identity_id=app.owner_identity_id
       AND COALESCE(connector.machine_id,connector.helper_agent_id)=COALESCE(actor.machine_id,actor.agent_id)
     JOIN memberships owner ON owner.workspace_id=room.workspace_id AND owner.room_id IS NULL
       AND owner.identity_id=app.owner_identity_id AND owner.removed_at IS NULL
     WHERE room.id=$1 AND room.archived_at IS NULL LIMIT 1`,
    [roomId, agentId, service],
  )).rows[0];
}

export async function providerEventIsAvailable(db: SqlDatabase, appId: string, event: string): Promise<boolean> {
  const failed = await db.query(`SELECT 1 FROM provider_webhooks
    WHERE app_id=$1 AND event=$2 AND status='error' LIMIT 1`, [appId, event]);
  return !failed.rowCount;
}

/** One provider webhook is shared by all subscriptions to an app event. */
export async function queueProviderWebhook(db: SqlDatabase, app: App, service: ProviderService,
  event: string, composioReceiverUrl: string): Promise<{ id: string; connectorId: string; queued: boolean }> {
  const id = randomUUID();
  const receiverUrl = composioReceiverUrl.replace(/\/composio$/, `/${service}/${id}`);
  if (receiverUrl === composioReceiverUrl) throw new Error('Service receiver is unavailable');
  const row = (await db.query<{ id: string; connector_id: string; status: string }>(
    `INSERT INTO provider_webhooks(id,app_id,connector_id,service,event,receiver_url,signing_secret,provider_id,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'registering')
     ON CONFLICT(app_id,event) DO UPDATE SET id=provider_webhooks.id
     RETURNING id,connector_id,status`,
    [id, app.id, app.connector_id, service, event, receiverUrl,
      service === 'linear' ? randomBytes(32).toString('hex') : null,
      service === 'linear' ? id : null],
  )).rows[0]!;
  if (row.status === 'retiring') throw new Error('Service webhook removal is in progress; retry shortly');
  if (row.status === 'error') throw new Error('Service webhook registration failed; reconnect the app');
  return { id: row.id, connectorId: row.connector_id, queued: row.status === 'registering' };
}

export async function retireUnusedProviderWebhook(db: SqlDatabase, webhookId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const hook = (await tx.query<{ connector_id: string; status: string }>(
      `SELECT connector_id,status FROM provider_webhooks WHERE id=$1 FOR UPDATE`, [webhookId],
    )).rows[0];
    if (!hook || hook.status === 'retiring') return;
    const remaining = await tx.query(
      `SELECT 1 FROM agent_subscriptions WHERE trigger_id=$1 LIMIT 1`, [webhookId]);
    if (remaining.rowCount) return;
    // The in-flight registration will move this to retiring once it has the
    // provider id and signing secret needed for removal.
    if (hook.status === 'registering') return;
    await tx.query(`UPDATE provider_webhooks SET status='retiring' WHERE id=$1`, [webhookId]);
    await notifyConnectorHelper(tx, hook.connector_id);
  });
}

export type ProviderWebhookAssignment = {
  readonly id: string;
  readonly connectorId: string;
  readonly service: ProviderService;
  readonly event: string;
  readonly receiverUrl: string;
  readonly operation: 'register' | 'remove';
  readonly providerId?: string;
  readonly signingSecret?: string;
  readonly accountContext?: string;
  readonly livemode?: boolean;
};

export async function providerWebhookAssignments(db: SqlDatabase, helperId: string): Promise<ProviderWebhookAssignment[]> {
  const rows = await db.query<{
    id: string; connector_id: string; service: ProviderService; event: string; receiver_url: string;
    provider_id: string | null; signing_secret: string | null; account_context: string | null;
    livemode: boolean | null; status: string;
  }>(
    `SELECT hook.* FROM provider_webhooks hook
     JOIN workspace_connectors connector ON connector.id=hook.connector_id
       AND connector.helper_agent_id=$1 AND connector.status='connected'
     WHERE hook.status IN ('registering','retiring','error')
     ORDER BY hook.created_at,hook.id`, [helperId],
  );
  return rows.rows.map((row) => ({
    id: row.id, connectorId: row.connector_id, service: row.service, event: row.event,
    receiverUrl: row.receiver_url, operation: row.status === 'retiring' ? 'remove' : 'register',
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    ...(row.signing_secret ? { signingSecret: row.signing_secret } : {}),
    ...(row.account_context ? { accountContext: row.account_context } : {}),
    ...(row.livemode !== null ? { livemode: row.livemode } : {}),
  }));
}

export async function completeProviderWebhookAssignment(db: SqlDatabase, helperId: string,
  input: { id: string; operation: 'register' | 'remove'; providerId?: string;
    signingSecret?: string; accountContext?: string; livemode?: boolean; error?: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const hook = (await tx.query<{ id: string; connector_id: string; status: string }>(
      `SELECT hook.id,hook.connector_id,hook.status FROM provider_webhooks hook
       JOIN workspace_connectors connector ON connector.id=hook.connector_id
         AND connector.helper_agent_id=$2
       WHERE hook.id=$1 FOR UPDATE`, [input.id, helperId],
    )).rows[0];
    if (!hook || (input.operation === 'register' && !['registering', 'error'].includes(hook.status)) ||
      (input.operation === 'remove' && hook.status !== 'retiring'))
      throw new Error('provider webhook assignment is no longer current');
    if (input.error) {
      await tx.query(`UPDATE provider_webhooks SET status=$3,error=$2 WHERE id=$1`,
        [input.id, input.error.slice(0, 500), input.operation === 'remove' ? 'retiring' : 'error']);
      return;
    }
    if (input.operation === 'remove') {
      await tx.query(`DELETE FROM provider_webhooks WHERE id=$1`, [input.id]);
      return;
    }
    if (!input.providerId || !input.signingSecret) throw new Error('provider registration is incomplete');
    await tx.query(
      `UPDATE provider_webhooks SET status='active',provider_id=$2,signing_secret=$3,
         account_context=$4,livemode=$5,error=NULL WHERE id=$1`,
      [input.id, input.providerId, input.signingSecret,
        input.accountContext ?? null, input.livemode ?? null],
    );
    const remaining = await tx.query(`SELECT 1 FROM agent_subscriptions WHERE trigger_id=$1 LIMIT 1`,
      [input.id]);
    if (!remaining.rowCount) {
      await tx.query(`UPDATE provider_webhooks SET status='retiring' WHERE id=$1`, [input.id]);
      await notifyConnectorHelper(tx, hook.connector_id);
    }
  });
}

function sameHexSignature(expected: Buffer, value: unknown): boolean {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return false;
  const received = Buffer.from(value, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** The route calls this on raw bytes. A signed retry is idempotent per subscription. */
export async function ingestProviderWebhook(db: SqlDatabase, service: ProviderService, id: string,
  raw: Buffer, headers: Record<string, string | string[] | undefined>, now = Date.now()): Promise<boolean> {
  const hook = (await db.query<{ id: string; event: string; provider_id: string; signing_secret: string }>(
    `SELECT id,event,provider_id,signing_secret FROM provider_webhooks
     WHERE id=$1 AND service=$2 AND status='active'`, [id, service],
  )).rows[0];
  if (!hook?.signing_secret) return false;
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')) as unknown; } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  let deliveryId: string;
  if (service === 'linear') {
    const signature = createHmac('sha256', hook.signing_secret).update(raw).digest();
    if (!sameHexSignature(signature, headers['linear-signature']) ||
      typeof body.webhookTimestamp !== 'number' ||
      Math.abs(now - body.webhookTimestamp) > 60_000 ||
      body.webhookId !== hook.provider_id || body.type !== 'Issue' || body.action !== 'create' ||
      headers['linear-event'] !== 'Issue') return false;
    const delivery = headers['linear-delivery'];
    if (typeof delivery !== 'string' || !delivery) return false;
    deliveryId = delivery;
  } else {
    const header = headers['stripe-signature'];
    if (typeof header !== 'string' || body.type !== hook.event) return false;
    const parts = new Map(header.split(',').map((part) => part.trim().split('=', 2) as [string,string]));
    const timestamp = parts.get('t');
    if (!timestamp || !/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300)
      return false;
    const signature = createHmac('sha256', hook.signing_secret)
      .update(`${timestamp}.`).update(raw).digest();
    if (!header.split(',').some((part) => sameHexSignature(signature,
      part.trim().startsWith('v1=') ? part.trim().slice(3) : undefined))) return false;
    if (typeof body.id !== 'string' || !body.id) return false;
    deliveryId = body.id;
  }
  const rows = await db.query<{ id: string; room_id: string; agent_id: string; prompt: string;
    workflow_slug: string | null }>(
    `SELECT subscription.id,subscription.room_id,subscription.agent_id,
       subscription.prompt,subscription.workflow_slug
     FROM agent_subscriptions subscription
     JOIN rooms room ON room.id=subscription.room_id AND room.archived_at IS NULL
     JOIN memberships agent ON agent.room_id=room.id AND agent.identity_id=subscription.agent_id
       AND agent.removed_at IS NULL
     JOIN provider_webhooks hook ON hook.id::text=subscription.trigger_id AND hook.status='active'
     JOIN workspace_apps app ON app.id=hook.app_id AND app.workspace_id=room.workspace_id
       AND app.state='active' AND app.transport='registry-mcp'
     JOIN memberships owner ON owner.workspace_id=room.workspace_id AND owner.room_id IS NULL
       AND owner.identity_id=app.owner_identity_id AND owner.removed_at IS NULL
     WHERE subscription.trigger_id=$1 AND subscription.event=$2`, [id, hook.event],
  );
  if (!rows.rowCount) return true;
  await ensureSystemIdentity(db);
  for (const row of rows.rows) {
    const messageId = createHash('sha256').update(`subscription:${service}:${deliveryId}:${row.id}`).digest('hex');
    await db.transaction(async (tx) => {
      const current = (await tx.query<{ prompt: string; workflow_slug: string | null }>(
        `SELECT prompt,workflow_slug FROM agent_subscriptions WHERE id=$1 FOR UPDATE`, [row.id],
      )).rows[0];
      if (!current) return;
      const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
        ? body.data as Record<string, unknown> : {};
      const subject = service === 'linear' ? data :
        data.object && typeof data.object === 'object' && !Array.isArray(data.object)
          ? data.object as Record<string, unknown> : {};
      const line = await systemLine(tx, {
        id: messageId, roomId: row.room_id, authorId: SYSTEM_IDENTITY_ID,
        subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: 'Beeline' },
        verb: 'received', object: service === 'linear' ? 'a Linear issue' : 'a Stripe payment',
        kind: 'subscription-fired', wakes: [row.agent_id],
        payload: { source: 'service', service: service === 'linear' ? 'Linear' : 'Stripe',
          event: hook.event, id: typeof subject.id === 'string' ? subject.id : undefined,
          title: service === 'linear' && typeof subject.title === 'string'
            ? subject.title.slice(0, 500) : undefined,
          amount: service === 'stripe' && typeof subject.amount === 'number' ? subject.amount : undefined,
          currency: service === 'stripe' && typeof subject.currency === 'string'
            ? subject.currency.slice(0, 10) : undefined },
        subscriptionPrompt: current.prompt,
        subscriptionWorkflowSlug: current.workflow_slug ?? undefined,
      });
      if (line.inserted) await tx.query(
        `UPDATE agent_subscriptions SET fired_count=fired_count+1,last_fired_at=now() WHERE id=$1`,
        [row.id],
      );
    });
  }
  return true;
}
