import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import type { McpPrincipal } from './rooms-mcp-oauth.js';
import { openSecrets, sealSecrets } from './free-agents.js';
import { MCP_WEBHOOK_TABLE, postMcpWebhook } from './rooms-mcp-members.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

// Replay stays in list_mentions; event cursors are null so queued events cannot be skipped.
const MENTION_EVENT = {
  name: 'mention', description: 'A Room message tags this connected Beeline member, or messages it directly.',
  delivery: ['webhook'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: { type: 'object', properties: {
    roomId: { type: 'string' }, messageId: { type: 'string' }, text: { type: 'string' },
    author: { type: 'object', properties: { id: { type: 'string' }, handle: { type: ['string', 'null'] },
      name: { type: ['string', 'null'] } }, required: ['id', 'handle', 'name'], additionalProperties: false },
  }, required: ['roomId', 'messageId', 'text', 'author'], additionalProperties: false },
};
// Same next lines as pendingMcpWakes. An order is work to report; every other wake is handled or cleared.
const ORDER_WAKE_NEXT = 'Do the work, then call report with this address.';
const OTHER_WAKE_NEXT = 'Handle it, then call no_reply_needed with this address if nothing needs posting.';
const WAKE_EVENT = {
  name: 'wake', description: 'An order, report, corner assignment, or scheduled or lifecycle wake is waiting for this connected member.',
  delivery: ['webhook'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: { type: 'object', properties: {
    roomId: { type: 'string' }, commandId: { type: 'string' }, reason: { type: 'string' },
    kind: { type: 'string' }, text: { type: 'string' }, next: { type: 'string' },
  }, required: ['roomId', 'commandId', 'reason', 'next'], additionalProperties: false },
};
const EVENT_NAMES = [MENTION_EVENT.name, WAKE_EVENT.name] as const;
type Transport = typeof postMcpWebhook;
interface Subscription {
  id: string; client_id: string; owner_id: string; member_id: string; url: string; secret: string;
  previous_secret: string | null; rotation_until: Date | null; verified_at: Date; expires_at: Date;
}
export class McpEventError extends Error {
  constructor(readonly code: number, message: string, readonly data?: { reason: string }) { super(message); }
}
function key(): string {
  const value = process.env.BEELINE_MCP_WEBHOOK_KEY;
  if (!value) throw new McpEventError(-32603, 'Event signing is not configured');
  return value;
}
function invalid(): never { throw new McpEventError(-32602, 'Invalid event subscription arguments'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function signingKey(value: unknown): string {
  if (typeof value !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) return invalid();
  const decoded = Buffer.from(value.slice(6), 'base64');
  if (decoded.length < 24 || decoded.length > 64 || decoded.toString('base64').replace(/=+$/, '') !== value.slice(6).replace(/=+$/, '')) return invalid();
  return value;
}
function headers(id: string, subscriptionId: string, body: string, secret: string, previous?: string): Record<string, string> {
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error('Event payload exceeds 256 KiB');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = (value: string) => 'v1,' + createHmac('sha256', Buffer.from(value.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
    'webhook-signature': [sign(secret), ...(previous ? [sign(previous)] : [])].join(' '),
    'X-MCP-Subscription-Id': subscriptionId };
}

export class RoomsMcpEvents {
  constructor(private readonly db: SqlDatabase, private readonly transport: Transport = postMcpWebhook) {}
  async call(principal: McpPrincipal, method: string, raw: unknown): Promise<object> {
    if (!principal.member_id) throw new McpEventError(-32602, 'Reconnect this member before subscribing');
    const params = raw === undefined ? {} : object(raw);
    if (method === 'events/list') {
      if (Object.keys(params).some(k => !['cursor', '_meta'].includes(k)) || (params.cursor !== undefined && params.cursor !== null)) return invalid();
      return { events: [MENTION_EVENT, WAKE_EVENT] };
    }
    if (method !== 'events/subscribe' && method !== 'events/unsubscribe') throw new McpEventError(-32601, 'Method not found');
    const subscribing = method === 'events/subscribe';
    if (Object.keys(params).some(k => !['name', 'arguments', 'delivery', '_meta', ...(subscribing ? ['cursor', 'ttlMs'] : [])].includes(k))) return invalid();
    if (typeof params.name !== 'string' || !(EVENT_NAMES as readonly string[]).includes(params.name) || Object.keys(object(params.arguments)).length) return invalid();
    const delivery = object(params.delivery);
    if (delivery.mode !== 'webhook' || typeof delivery.url !== 'string' || delivery.url.length > 2048 ||
      Object.keys(delivery).some(k => !['mode', 'url', ...(subscribing ? ['secret'] : [])].includes(k))) return invalid();
    let url: URL;
    try { url = new URL(delivery.url); } catch { return invalid(); }
    if (url.protocol !== 'https:' || url.hash || url.username || url.password) return invalid();
    const id = 'sub_' + createHash('sha256').update(JSON.stringify([
      principal.client_id, principal.identity_id, principal.member_id, url.href, params.name, {},
    ])).digest('hex');
    if (!subscribing) {
      await this.db.query('DELETE FROM rooms_mcp_event_subscriptions WHERE id=$1 AND member_id=$2', [id, principal.member_id]);
      return {};
    }
    const secret = signingKey(delivery.secret);
    if (params.cursor !== undefined && params.cursor !== null) return invalid();
    const ttl = params.ttlMs;
    if (ttl !== undefined && ttl !== null && (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0)) return invalid();
    const expires = new Date(Date.now() + (typeof ttl === 'number' ? Math.min(ttl, 86_400_000) : 86_400_000));
    const sealingKey = key();
    const old = (await this.db.query<Subscription>('SELECT * FROM rooms_mcp_event_subscriptions WHERE id=$1', [id])).rows[0];
    const sameSecret = old && openSecrets<string>(sealingKey, old.secret) === secret;
    // Verification is cached persistently, scoped to the principal, URL and signing key.
    if (!sameSecret || old.verified_at.getTime() < Date.now() - 300_000) {
      const challenge = randomBytes(32).toString('base64url');
      const body = JSON.stringify({ type: 'verification', challenge });
      try {
        const response = await this.transport(url.href, { body, readResponse: true, headers: headers('verification_' + randomUUID(), id, body, secret) });
        const result = await response.json() as { challenge?: unknown };
        const echoed = typeof result.challenge === 'string' ? Buffer.from(result.challenge) : Buffer.alloc(0);
        if (!response.ok || echoed.length !== Buffer.byteLength(challenge) || !timingSafeEqual(echoed, Buffer.from(challenge)))
          throw new Error('challenge_failed');
      } catch (error) {
        throw new McpEventError(-32015, 'CallbackEndpointError', {
          reason: error instanceof Error && /timeout|abort/i.test(error.message) ? 'timeout' : 'challenge_failed',
        });
      }
    }
    await this.db.transaction(async tx => {
      // Serialize with refresh/disconnect, and recheck the consent after verification.
      const active = await tx.query(`SELECT c.client_id FROM rooms_mcp_connections c
        JOIN rooms_mcp_members m ON m.client_id=c.client_id AND m.owner_id=c.identity_id
        WHERE c.client_id=$1 AND c.identity_id=$2 AND c.revoked_at IS NULL AND m.member_id=$3 FOR UPDATE OF c`,
      [principal.client_id, principal.identity_id, principal.member_id]);
      if (!active.rowCount) throw new McpEventError(-32602, 'Connection ended');
      const current = (await tx.query<Subscription>('SELECT * FROM rooms_mcp_event_subscriptions WHERE id=$1', [id])).rows[0];
      const changed = current && openSecrets<string>(sealingKey, current.secret) !== secret;
      await tx.query(`INSERT INTO rooms_mcp_event_subscriptions(id,client_id,owner_id,member_id,url,secret,
        previous_secret,rotation_until,verified_at,expires_at,event_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(id) DO UPDATE SET secret=EXCLUDED.secret,previous_secret=EXCLUDED.previous_secret,
          rotation_until=EXCLUDED.rotation_until,verified_at=EXCLUDED.verified_at,expires_at=EXCLUDED.expires_at,
          event_name=EXCLUDED.event_name`,
      [id, principal.client_id, principal.identity_id, principal.member_id, url.href, sealSecrets(sealingKey, secret),
        changed ? current.secret : current?.previous_secret ?? null,
        changed ? new Date(Date.now() + 300_000) : current?.rotation_until ?? null,
        sameSecret && old.verified_at.getTime() >= Date.now() - 300_000 ? old.verified_at : new Date(), expires, params.name]);
    });
    return { id, refreshBefore: expires.toISOString(), cursor: null, truncated: false };
  }
}

function notifyMcpWebhook(db: SqlDatabase, room: string): Promise<unknown> {
  return db.query('SELECT pg_notify($1,$2)', [POSTGRES_LIVE_CHANNEL,
    JSON.stringify({ table: MCP_WEBHOOK_TABLE, operation: 'INSERT', roomId: room })]);
}

/** Called inside the existing mention write transaction, so retries cannot enqueue a tag twice. */
export async function queueMcpMentionEvents(db: SqlDatabase, member: string, room: string, message: string): Promise<void> {
  const queued = await db.query(`INSERT INTO rooms_mcp_event_deliveries(subscription_id,message_id,room_id,event_id,body)
    SELECT s.id,m.id,m.room_id,'evt_'||s.id||'_'||m.id,
      jsonb_build_object('eventId','evt_'||s.id||'_'||m.id,'name','mention','timestamp',m.created_at,
        'data',jsonb_build_object('roomId',m.room_id,'messageId',m.id,'text',left(m.text,16000),
          'author',jsonb_build_object('id',m.author_id,'handle',i.handle,'name',i.name)), 'cursor',NULL)::text
    FROM rooms_mcp_event_subscriptions s
    JOIN rooms_mcp_connections c ON c.client_id=s.client_id AND c.identity_id=s.owner_id AND c.revoked_at IS NULL
    JOIN messages m ON m.id=$3 AND m.room_id=$2 AND m.deleted_at IS NULL
    JOIN identities i ON i.id=m.author_id
    WHERE s.member_id=$1 AND s.expires_at>now() AND s.event_name='mention'
    ON CONFLICT(subscription_id,message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING subscription_id`, [member, room, message]);
  if (queued.rowCount) await notifyMcpWebhook(db, room);
}

/**
 * Called inside the agent_commands insert transaction. One delivery per live
 * subscription and command. A mention subscription receives wakes until this
 * member has a live wake subscription, so an existing watcher starts without
 * a second subscribe, and subscribing to both does not deliver twice.
 */
export async function queueMcpCommandEvents(db: SqlDatabase, member: string, room: string, commandId: string): Promise<void> {
  const queued = await db.query(`INSERT INTO rooms_mcp_event_deliveries(subscription_id,command_id,room_id,event_id,body)
    SELECT s.id,command.id,command.room_id,'evt_'||s.id||'_'||command.id,
      jsonb_build_object('eventId','evt_'||s.id||'_'||command.id,'name','wake','timestamp',command.created_at,
        'data',jsonb_strip_nulls(jsonb_build_object('roomId',command.room_id,'commandId',command.id,
          'reason',command.reason,'kind',command.private_payload->>'kind',
          'text',NULLIF(left(COALESCE(command.private_payload->>'text',source.text),16000),''),
          'next',CASE WHEN command.private_payload->>'kind'='order' THEN $4 ELSE $5 END)),
        'cursor',NULL)::text
    FROM rooms_mcp_event_subscriptions s
    JOIN rooms_mcp_connections c ON c.client_id=s.client_id AND c.identity_id=s.owner_id AND c.revoked_at IS NULL
    JOIN agent_commands command ON command.id=$3 AND command.agent_id=$1 AND command.room_id=$2::uuid
      AND command.action IN ('input','resume') AND command.reason<>'mcp_call'
      AND (command.state='pending' OR (command.state='claimed' AND command.lease_expires_at<=now()))
    LEFT JOIN messages source ON source.id=command.source_message_id
    WHERE s.member_id=$1 AND s.expires_at>now() AND s.event_name IN ('mention','wake')
      AND (s.event_name='wake' OR NOT EXISTS (
        SELECT 1 FROM rooms_mcp_event_subscriptions other
        JOIN rooms_mcp_connections other_connection ON other_connection.client_id=other.client_id
          AND other_connection.identity_id=other.owner_id AND other_connection.revoked_at IS NULL
        WHERE other.member_id=s.member_id AND other.event_name='wake' AND other.expires_at>now()))
    ON CONFLICT(subscription_id,command_id) WHERE command_id IS NOT NULL DO NOTHING RETURNING subscription_id`,
  [member, room, commandId, ORDER_WAKE_NEXT, OTHER_WAKE_NEXT]);
  if (queued.rowCount) await notifyMcpWebhook(db, room);
}

/** Drained by the existing webhook notification and maintenance loop; leases bound concurrent drains. */
export async function deliverMcpEvents(db: SqlDatabase, transport: Transport, limit: number): Promise<number> {
  let delivered = 0;
  for (let index = 0; index < limit; index++) {
    const row = (await db.query<Subscription & { delivery_id: string; message_id: string | null; command_id: string | null; event_id: string; body: string; attempts: number; deliverable: boolean }>(`
      WITH claimed AS (
        UPDATE rooms_mcp_event_deliveries d SET attempts=d.attempts+1,claimed_at=now()
        WHERE d.id IN (
          SELECT id FROM rooms_mcp_event_deliveries
          WHERE delivered_at IS NULL AND attempts<5 AND next_attempt_at<=now()
            AND (claimed_at IS NULL OR claimed_at<now()-interval '1 minute')
          ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING d.*)
      SELECT s.*,d.id delivery_id,d.message_id,d.command_id,d.event_id,d.body,d.attempts,
        (s.expires_at>now() AND c.revoked_at IS NULL AND c.client_id IS NOT NULL
         AND r.archived_at IS NULL AND r.id IS NOT NULL
         AND ((d.command_id IS NULL AND m.deleted_at IS NULL AND m.id IS NOT NULL)
           OR (d.command_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM agent_commands command WHERE command.id=d.command_id AND command.agent_id=s.member_id
               AND command.room_id=d.room_id AND command.action IN ('input','resume') AND command.reason<>'mcp_call'
               AND (command.state='pending' OR (command.state='claimed' AND command.lease_expires_at<=now())))))
         AND EXISTS(SELECT 1 FROM effective_memberships rm WHERE rm.room_id=d.room_id AND rm.identity_id=s.member_id AND rm.removed_at IS NULL)
         AND EXISTS(SELECT 1 FROM memberships wm WHERE wm.workspace_id=r.workspace_id AND wm.room_id IS NULL AND wm.identity_id=s.member_id AND wm.removed_at IS NULL)) deliverable
      FROM claimed d JOIN rooms_mcp_event_subscriptions s ON s.id=d.subscription_id
      LEFT JOIN rooms_mcp_connections c ON c.client_id=s.client_id AND c.identity_id=s.owner_id
      LEFT JOIN rooms r ON r.id=d.room_id LEFT JOIN messages m ON m.id=d.message_id`)).rows[0];
    if (!row) break;
    let finished = !row.deliverable;
    if (row.deliverable) {
      try {
        const response = await transport(row.url, { body: row.body,
          headers: headers(row.event_id, row.id, row.body, openSecrets<string>(key(), row.secret),
            row.previous_secret && row.rotation_until && row.rotation_until.getTime() > Date.now()
              ? openSecrets<string>(key(), row.previous_secret) : undefined) });
        if (response.ok) delivered++;
        finished = response.ok || response.status === 410 || response.status === 413 ||
          (response.status >= 400 && response.status < 500 && response.status !== 429);
      } catch { /* Transient connection failures use the same bounded backoff. */ }
    }
    await db.query(`UPDATE rooms_mcp_event_deliveries SET delivered_at=CASE WHEN $2 OR attempts>=5 THEN now() ELSE NULL END,
      claimed_at=NULL,next_attempt_at=now()+($3 * interval '1 second') WHERE id=$1`,
    [row.delivery_id, finished, 30 * 2 ** (row.attempts - 1)]);
  }
  return delivered;
}
