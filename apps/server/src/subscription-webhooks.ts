import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RoomSubscriptionView, WebhookCallView } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { sealSecrets, openSecrets } from './free-agents.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';

export const SUBSCRIPTION_WEBHOOKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS subscription_webhook_calls (
 id uuid PRIMARY KEY,
 subscription_id uuid NOT NULL REFERENCES agent_subscriptions(id) ON DELETE CASCADE,
 called_at timestamptz NOT NULL DEFAULT now(),
 outcome text NOT NULL CHECK(outcome IN ('woke','refused','skipped')),
 reason text,
 byte_size integer NOT NULL,
 delivery_hash text,
 run_id text,
 wake_message_id text,
 repeat_at timestamptz
);
CREATE INDEX IF NOT EXISTS subscription_webhook_calls_subscription
 ON subscription_webhook_calls(subscription_id,called_at DESC);
CREATE INDEX IF NOT EXISTS subscription_webhook_calls_wake ON subscription_webhook_calls(wake_message_id);
CREATE TABLE IF NOT EXISTS subscription_webhook_deliveries (
 subscription_id uuid NOT NULL REFERENCES agent_subscriptions(id) ON DELETE CASCADE,
 delivery_hash text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(subscription_id,delivery_hash)
);
`;
export const WEBHOOK_BODY_LIMIT = 64 * 1024;
const CALLS_PER_MINUTE = 30;
function secret(): string {
  const value = process.env.GITHUB_CLIENT_SECRET;
  if (!value) throw new Error('Webhook token encryption is unavailable');
  return value;
}

/** Humans manage their own DMs; Rooms retain Workspace admin authority. */
export async function requireScheduledWorkManager(db: SqlDatabase, roomId: string, viewerId: string, allowCorner = false): Promise<void> {
  const room = (await db.query<{ parent_id: string | null; archived_at: Date | null }>(
    'SELECT parent_id,archived_at FROM rooms WHERE id=$1', [roomId])).rows[0];
  if (!room) throw new Error('room not found');
  if (room.parent_id && !allowCorner) throw new Error('room lifecycle cannot target a corner');
  if (room.archived_at) throw new Error('room is archived');
  const allowed = await db.query(
    `SELECT 1 FROM rooms room
     JOIN identities person ON person.id=$2 AND person.kind='human' AND NOT person.hidden_from_roster
     WHERE room.id=$1 AND (room.parent_id IS NULL OR $3) AND room.archived_at IS NULL AND (
       (room.direct_participants IS NOT NULL AND room.direct_participants ? $2
         AND EXISTS (SELECT 1 FROM memberships member WHERE member.room_id=room.id
           AND member.identity_id=$2 AND member.removed_at IS NULL))
       OR (room.direct_participants IS NULL AND EXISTS (
         SELECT 1 FROM memberships member WHERE member.workspace_id=room.workspace_id
           AND member.room_id IS NULL AND member.identity_id=$2 AND member.removed_at IS NULL
           AND member.role IN ('owner','admin'))))`, [roomId, viewerId, allowCorner]);
  if (!allowed.rowCount) throw new Error('Workspace admin required (workspace admins only), or human DM membership required');
}

/** One authority check for both the commanding human and phone operations. */
export async function requireWebhookAdmin(db: SqlDatabase, roomId: string, viewerId?: string,
  command?: { agentId: string; requestId?: string }): Promise<string> {
  const human = viewerId ?? (command?.requestId ? (await db.query<{ author_id: string }>(
    `SELECT root.author_id FROM agent_commands command
     JOIN messages root ON root.id=command.root_source_message_id AND root.deleted_at IS NULL
     WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
     ORDER BY command.created_at DESC LIMIT 1`, [roomId, command.agentId, command.requestId],
  )).rows[0]?.author_id : undefined);
  if (!human) throw new Error('Workspace admin required');
  await requireScheduledWorkManager(db, roomId, human, Boolean(command));
  return human!;
}

export async function createWebhookCredentials(db: SqlDatabase, id: string, ownerId: string): Promise<void> {
  const token = `bl_whk_${randomBytes(32).toString('base64url')}`;
  await db.query(`UPDATE agent_subscriptions SET webhook_token=$2,webhook_suffix=$3,
    webhook_token_created_at=now(),webhook_owner_id=$4 WHERE id=$1 AND source='webhook'`,
  [id, sealSecrets(secret(), token), token.slice(-4), ownerId]);
}

type CallRow = { id: string; called_at: Date; outcome: WebhookCallView['outcome']; reason: string | null;
  byte_size: number; run_id: string | null; wake_message_id: string | null; repeat_at: Date | null };
function callView(row: CallRow): WebhookCallView {
  return { id: row.id, at: row.called_at.getTime() / 1000, outcome: row.outcome, bytes: row.byte_size,
    ...(row.reason ? { reason: row.reason } : {}), ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.wake_message_id ? { messageId: row.wake_message_id } : {}),
    ...(row.repeat_at ? { repeatAt: row.repeat_at.getTime() / 1000 } : {}) };
}

/** No secret enters a cached projection. Only authorized human managers receive link metadata. */
export async function webhookDetails(db: SqlDatabase, roomId: string, id: string, viewerId: string,
  origin: string): Promise<Pick<RoomSubscriptionView, 'webhook' | 'recentCalls'>> {
  await requireWebhookAdmin(db, roomId, viewerId);
  const row = (await db.query<{ webhook_suffix: string; webhook_token_created_at: Date }>(
    `SELECT webhook_suffix,webhook_token_created_at FROM agent_subscriptions subscription
     JOIN rooms room ON room.id=subscription.room_id
     WHERE subscription.id=$1 AND (room.id=$2 OR room.parent_id=$2) AND subscription.source='webhook'`,
    [id, roomId])).rows[0];
  if (!row) throw new Error('subscription not found');
  const calls = await db.query<CallRow>(`SELECT * FROM subscription_webhook_calls
    WHERE subscription_id=$1 ORDER BY called_at DESC,id DESC LIMIT 50`, [id]);
  return { webhook: { url: `${origin.replace(/\/$/, '')}/hooks/${id}`, tokenSuffix: row.webhook_suffix,
    tokenCreatedAt: row.webhook_token_created_at.getTime() / 1000 }, recentCalls: calls.rows.map(callView) };
}

/** Rotation and ingress serialize on the subscription, so no old-token wake follows a rotation. */
export async function webhookToken(db: SqlDatabase, roomId: string, id: string, viewerId: string,
  rotate = false): Promise<{ token: string }> {
  return db.transaction(async (tx) => {
    await requireWebhookAdmin(tx, roomId, viewerId);
    const row = (await tx.query<{ webhook_token: string }>(
      `SELECT subscription.webhook_token FROM agent_subscriptions subscription
       JOIN rooms room ON room.id=subscription.room_id
       WHERE subscription.id=$1 AND (room.id=$2 OR room.parent_id=$2)
         AND subscription.source='webhook' FOR UPDATE OF subscription`, [id, roomId])).rows[0];
    if (!row) throw new Error('subscription not found');
    if (rotate) {
      await createWebhookCredentials(tx, id, viewerId);
      row.webhook_token = (await tx.query<{ webhook_token: string }>(
        `SELECT webhook_token FROM agent_subscriptions WHERE id=$1`, [id])).rows[0]!.webhook_token;
    }
    return { token: openSecrets<string>(secret(), row.webhook_token) };
  });
}
function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
export function webhookAuthenticated(token: string, raw: Buffer,
  headers: Record<string, string | string[] | undefined>): boolean {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && sameSecret(token, auth.slice(7))) return true;
  const signature = headers['x-beeline-signature'];
  const hex = typeof signature === 'string' ? signature.replace(/^sha256=/, '') : '';
  return /^[a-f0-9]{64}$/i.test(hex) && timingSafeEqual(Buffer.from(hex, 'hex'),
    createHmac('sha256', token).update(raw).digest());
}

export async function ingestSubscriptionWebhook(db: SqlDatabase, id: string, raw: Buffer,
  headers: Record<string, string | string[] | undefined>, byteSize = raw.length): Promise<{ status: number; outcome: string }> {
  await ensureSystemIdentity(db);
  return db.transaction(async (tx) => {
    const row = (await tx.query<{ room_id: string; agent_id: string; prompt: string;
      workflow_slug: string | null; webhook_token: string; webhook_owner_id: string }>(
      `SELECT room_id,agent_id,prompt,workflow_slug,webhook_token,webhook_owner_id
       FROM agent_subscriptions WHERE id=$1 AND source='webhook' FOR UPDATE`, [id])).rows[0];
    if (!row) return { status: 404, outcome: 'not_found' };
    const record = async (outcome: WebhookCallView['outcome'], status: number, reason?: string,
      deliveryHash?: string, messageId?: string, repeatAt?: Date) => {
      await tx.query(`INSERT INTO subscription_webhook_calls
        (id,subscription_id,outcome,reason,byte_size,delivery_hash,wake_message_id,repeat_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), id, outcome, reason ?? null, byteSize, deliveryHash ?? null, messageId ?? null, repeatAt ?? null]);
      await tx.query(`DELETE FROM subscription_webhook_calls WHERE subscription_id=$1 AND id NOT IN
        (SELECT id FROM subscription_webhook_calls WHERE subscription_id=$1 ORDER BY called_at DESC,id DESC LIMIT 50)`, [id]);
      // Touch the indexed subscription to invalidate the phone's existing scheduled-work surface.
      await tx.query(`UPDATE agent_subscriptions SET fired_count=fired_count WHERE id=$1`, [id]);
      return { status, outcome };
    };
    if (raw.length > WEBHOOK_BODY_LIMIT) return record('refused', 413, 'Body exceeds 64 KB');
    const recent = await tx.query(`SELECT 1 FROM subscription_webhook_calls
      WHERE subscription_id=$1 AND called_at>now()-interval '1 minute' LIMIT $2`, [id, CALLS_PER_MINUTE]);
    if (recent.rowCount >= CALLS_PER_MINUTE) return record('refused', 429, 'Too many calls');
    if (!webhookAuthenticated(openSecrets<string>(secret(), row.webhook_token), raw, headers))
      return record('refused', 401, 'Invalid token or signature');
    const current = await tx.query(
      `SELECT 1 FROM rooms room
       JOIN effective_memberships member ON member.room_id=room.id AND member.identity_id=$2 AND member.removed_at IS NULL
       JOIN identities agent ON agent.id=member.identity_id AND agent.kind='agent' AND NOT agent.hidden_from_roster
       JOIN agents actor ON actor.agent_id=agent.id
       JOIN memberships agent_owner ON agent_owner.workspace_id=room.workspace_id AND agent_owner.room_id IS NULL
         AND agent_owner.identity_id=actor.owner_id AND agent_owner.removed_at IS NULL
       WHERE room.id=$1 AND room.archived_at IS NULL AND (
         (room.direct_participants IS NULL AND EXISTS (
           SELECT 1 FROM memberships owner WHERE owner.workspace_id=room.workspace_id
             AND owner.room_id IS NULL AND owner.identity_id=$3 AND owner.removed_at IS NULL
             AND owner.role IN ('owner','admin')))
         OR (room.direct_participants IS NOT NULL AND room.direct_participants ? $3
           AND room.direct_participants ? $2 AND EXISTS (
             SELECT 1 FROM memberships owner JOIN identities person ON person.id=owner.identity_id
               AND person.kind='human' AND NOT person.hidden_from_roster
             WHERE owner.room_id=room.id AND owner.identity_id=$3 AND owner.removed_at IS NULL)))`, [row.room_id, row.agent_id, row.webhook_owner_id]);
    if (!current.rowCount) return record('refused', 403, 'Agent, Room or owner is no longer available');
    const delivery = headers['x-beeline-delivery'];
    if (delivery !== undefined && (typeof delivery !== 'string' || !delivery || delivery.length > 200))
      return record('refused', 400, 'Invalid delivery ID');
    const hash = createHash('sha256').update(typeof delivery === 'string' ? `id:${delivery}` : raw).digest('hex');
    // Signed retries are remembered for one day independently of the last fifty displayed calls.
    await tx.query(`DELETE FROM subscription_webhook_deliveries
      WHERE subscription_id=$1 AND received_at<now()-interval '1 day'`, [id]);
    const previous = (await tx.query<{ received_at: Date }>(`SELECT received_at FROM subscription_webhook_deliveries
      WHERE subscription_id=$1 AND delivery_hash=$2`, [id, hash])).rows[0];
    if (previous) return record('skipped', 200, 'Repeat delivery', hash, undefined, previous.received_at);
    const messageId = createHash('sha256').update(`webhook:${id}:${randomUUID()}`).digest('hex');
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { payload = raw.toString('utf8'); }
    const line = await systemLine(tx, { id: messageId, roomId: row.room_id, authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: 'Beeline' }, verb: 'received', object: 'a webhook call',
      kind: 'subscription-fired', wakes: [row.agent_id],
      payload: { source: 'webhook', event: 'webhook.called', body: payload },
      subscriptionPrompt: row.prompt, subscriptionWorkflowSlug: row.workflow_slug ?? undefined });
    await tx.query(`INSERT INTO subscription_webhook_deliveries(subscription_id,delivery_hash) VALUES($1,$2)`, [id, hash]);
    if (line.inserted) await tx.query(`UPDATE agent_subscriptions SET fired_count=fired_count+1,last_fired_at=now() WHERE id=$1`, [id]);
    return record('woke', 200, undefined, hash, line.id);
  });
}
