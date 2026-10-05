import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { isWebhookSource, quoteOutsideData, type RoomWebhooksResult, type WebhookRequestCard } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';

export const ROOM_WEBHOOK_SCHEMA = `
CREATE TABLE IF NOT EXISTS room_webhooks (
 id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 source text NOT NULL CHECK(source ~ '^[a-z0-9-]{1,40}$'), token_hash text NOT NULL UNIQUE,
 signing_secret_enc text, created_by text NOT NULL REFERENCES identities(id),
 approved_by text NOT NULL REFERENCES identities(id), created_at timestamptz NOT NULL DEFAULT now(),
 rotated_at timestamptz, revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS room_webhooks_room ON room_webhooks(room_id);
CREATE UNIQUE INDEX IF NOT EXISTS room_webhooks_live_source ON room_webhooks(room_id,source) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS room_webhook_requests (
 id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 agent_id text NOT NULL REFERENCES identities(id), source text NOT NULL, reason text NOT NULL,
 status text NOT NULL DEFAULT 'pending', request_id text NOT NULL,
 message_id text REFERENCES messages(id) ON DELETE SET NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 result_enc text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_webhook_requests_room ON room_webhook_requests(room_id);
CREATE INDEX IF NOT EXISTS room_webhook_requests_message ON room_webhook_requests(message_id);
CREATE UNIQUE INDEX IF NOT EXISTS room_webhook_requests_pending ON room_webhook_requests(room_id,source) WHERE status='pending';
CREATE TABLE IF NOT EXISTS room_webhook_deliveries (
 id uuid PRIMARY KEY, webhook_id uuid NOT NULL REFERENCES room_webhooks(id) ON DELETE CASCADE,
 received_at timestamptz NOT NULL DEFAULT now(), delivered integer NOT NULL
);
CREATE INDEX IF NOT EXISTS room_webhook_deliveries_hook ON room_webhook_deliveries(webhook_id,received_at DESC);
CREATE TABLE IF NOT EXISTS room_webhook_idempotency (
 webhook_id uuid NOT NULL REFERENCES room_webhooks(id) ON DELETE CASCADE,
 key_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(webhook_id,key_hash)
);
CREATE INDEX IF NOT EXISTS room_webhook_idempotency_expiry ON room_webhook_idempotency(webhook_id,received_at);
CREATE TABLE IF NOT EXISTS room_webhook_rates (
 webhook_id uuid PRIMARY KEY REFERENCES room_webhooks(id) ON DELETE CASCADE,
 started_at timestamptz NOT NULL DEFAULT now(), count integer NOT NULL DEFAULT 0
);
`;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class WebhookError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** One seam for subscriptions now and wait/trigger consumers later. */
export async function hasWebhookConsumer(db: SqlDatabase, roomId: string, kind: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int n FROM memberships m JOIN identities i ON i.id=m.identity_id AND i.kind='agent'
     WHERE m.room_id=$1 AND m.removed_at IS NULL AND m.event_subscriptions @> $2::jsonb`,
    [roomId, JSON.stringify([kind])],
  );
  return result.rows[0]?.n ?? 0;
}

export class RoomWebhooks {
  constructor(private readonly db: SqlDatabase,
    private readonly origin = process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080',
    private readonly secret = process.env.GITHUB_CLIENT_SECRET) {}

  private key(): Buffer {
    if (!this.secret) throw new WebhookError(503, 'webhook secret encryption unavailable');
    return createHash('sha256').update('room-webhooks:' + this.secret).digest();
  }
  private seal(value: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map((v) => v.toString('base64url')).join('.');
  }
  private open(value: string): string {
    const [iv, tag, bytes] = value.split('.').map((v) => Buffer.from(v, 'base64url'));
    if (!iv || !tag || !bytes) throw new Error('invalid stored webhook secret');
    const cipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8');
  }
  private validateSecret(value: string | null | undefined): void {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !value.length || value.length > 1024))
      throw new WebhookError(400, 'signing secret must contain 1–1024 characters');
  }
  private async member(db: SqlDatabase, roomId: string, identityId: string, admin: boolean): Promise<void> {
    const result = await db.query(
      `SELECT 1 FROM rooms r JOIN memberships m ON m.room_id=r.id AND m.identity_id=$2 AND m.removed_at IS NULL
       JOIN identities i ON i.id=m.identity_id
       LEFT JOIN memberships w ON w.workspace_id=r.workspace_id AND w.room_id IS NULL AND w.identity_id=$2 AND w.removed_at IS NULL
       WHERE r.id=$1 AND r.archived_at IS NULL AND (NOT $3 OR (i.kind='human' AND
       (m.role IN ('owner','admin') OR w.role IN ('owner','admin')))) FOR SHARE OF r,m,i`,
      [roomId, identityId, admin],
    );
    if (!result.rowCount) throw new WebhookError(403, admin ? 'Room admin required' : 'Room access denied');
  }
  private async adminMentions(db: SqlDatabase, roomId: string): Promise<string> {
    const admins = await db.query<{ handle: string }>(
      `SELECT DISTINCT i.handle FROM memberships m JOIN identities i ON i.id=m.identity_id AND i.kind='human'
       JOIN rooms r ON r.id=$1 WHERE m.removed_at IS NULL AND m.role IN ('owner','admin') AND i.handle IS NOT NULL
       AND (m.room_id=r.id OR (m.room_id IS NULL AND m.workspace_id=r.workspace_id))`, [roomId]);
    return `approval needed from ${admins.rows.map((v) => '@'+v.handle).join(', ') || 'Room admins'}`;
  }
  async expireRequests(): Promise<number> {
    return this.db.transaction(async (db) => {
      const rooms = await db.query<{ room_id: string }>(
        `SELECT DISTINCT room_id FROM room_webhook_requests WHERE status='pending' AND expires_at<=now()`);
      for (const row of rooms.rows) await this.expire(db, row.room_id);
      return rooms.rowCount;
    });
  }
  private async expire(db: SqlDatabase, roomId: string): Promise<void> {
    const expired = await db.query<{ id: string; message_id: string | null; agent_id: string; request_id: string; source: string }>(
      `UPDATE room_webhook_requests SET status='expired',result_enc=NULL WHERE room_id=$1 AND status='pending' AND expires_at<=now() RETURNING *`, [roomId]);
    for (const row of expired.rows) {
      await db.query(`UPDATE messages SET card=jsonb_set(card,'{status}','"expired"'::jsonb) WHERE id=$1`, [row.message_id]);
      await this.decisionLine(db, roomId, row, 'expired');
    }
  }
  private async decisionLine(db: SqlDatabase, roomId: string,
    row: { id: string; agent_id: string; request_id: string; source: string }, status: string): Promise<void> {
    await ensureSystemIdentity(db);
    await systemLine(db, { roomId, authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', name: 'Beeline' }, verb: status === 'approved' ? 'approved' : status === 'denied' ? 'denied' : 'expired',
      object: { text: `webhook ${row.source}`, id: row.id }, consequence: `request ${row.id}`, kind: 'webhook-request-decided',
      wakes: [row.agent_id], requestId: row.request_id,
    });
  }
  async request(roomId: string, agentId: string, source: string, reason: string, requestId: string) {
    if (!isWebhookSource(source) || typeof reason !== 'string' || !reason.trim() || reason.length > 1000)
      throw new WebhookError(400, 'invalid webhook source or reason');
    return this.db.transaction(async (db) => {
      await this.member(db, roomId, agentId, false);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`webhook:${roomId}:${source}`]);
      await this.expire(db, roomId);
      const pending = await db.query<{ id: string; agent_id: string }>(
        `SELECT id,agent_id FROM room_webhook_requests WHERE room_id=$1 AND source=$2 AND status='pending'`, [roomId, source]);
      if (pending.rows[0]) {
        if (pending.rows[0].agent_id !== agentId) throw new WebhookError(409, 'source already has a pending webhook request');
        return { requestId: pending.rows[0].id, status: 'pending' };
      }
      const id = randomUUID();
      const expiresAt = Math.floor(Date.now()/1000) + 7*86400;
      const names = await db.query<{ name: string }>(`SELECT name FROM identities WHERE id=$1`, [agentId]);
      const card: WebhookRequestCard = { requestId: id, agentId, agentName: names.rows[0]!.name, source, reason: reason.trim(), status: 'pending', expiresAt };
      await db.query(`INSERT INTO room_webhook_requests(id,room_id,agent_id,source,reason,request_id) VALUES($1,$2,$3,$4,$5,$6)`,
        [id, roomId, agentId, source, reason.trim(), requestId]);
      await ensureSystemIdentity(db);
      const line = await systemLine(db, { roomId, authorId: SYSTEM_IDENTITY_ID,
        subject: { kind: 'agent', id: agentId, name: agentId }, verb: 'requested', object: `webhook ${source}`,
        presentation: 'card', cardType: 'webhook-request', card,
        consequence: await this.adminMentions(db, roomId) });
      await db.query(`UPDATE room_webhook_requests SET message_id=$2 WHERE id=$1`, [id, line.id]);
      return { requestId: id, status: 'pending' };
    });
  }
  private async mint(db: SqlDatabase, roomId: string, source: string, creator: string, approver: string, signingSecret?: string | null) {
    if (!isWebhookSource(source)) throw new WebhookError(400, 'invalid webhook source');
    const token = randomBytes(32).toString('base64url');
    const live = await db.query<{ id: string; created_by: string }>(
      `SELECT id,created_by FROM room_webhooks WHERE room_id=$1 AND source=$2 AND revoked_at IS NULL FOR UPDATE`, [roomId, source]);
    const row = live.rows[0];
    if (row) {
      if (row.created_by !== creator) throw new WebhookError(409, 'webhook source already exists');
      await db.query(`UPDATE room_webhooks SET token_hash=$2,rotated_at=now(),approved_by=$3 WHERE id=$1`, [row.id, hash(token), approver]);
      if (signingSecret !== undefined) await db.query(`UPDATE room_webhooks SET signing_secret_enc=$2 WHERE id=$1`, [row.id, signingSecret ? this.seal(signingSecret) : null]);
    } else {
      await db.query(`INSERT INTO room_webhooks(id,room_id,source,token_hash,signing_secret_enc,created_by,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), roomId, source, hash(token), signingSecret ? this.seal(signingSecret) : null, creator, approver]);
    }
    return `${this.origin.replace(/\/$/, '')}/v1/hooks/${token}`;
  }
  async decide(roomId: string, adminId: string, id: string, approve: boolean, signingSecret?: string, revealSecret = false) {
    this.validateSecret(signingSecret);
    if (typeof approve !== 'boolean') throw new WebhookError(400, 'invalid webhook decision');
    return this.db.transaction(async (db) => {
      await this.member(db, roomId, adminId, true);
      await this.expire(db, roomId);
      const result = await db.query<{ id: string; agent_id: string; source: string; request_id: string; message_id: string; status: string }>(
        `SELECT * FROM room_webhook_requests WHERE id=$1 AND room_id=$2 FOR UPDATE`, [id, roomId]);
      const row = result.rows[0];
      if (!row) throw new WebhookError(404, 'webhook request not found');
      if (row.status !== 'pending') return { status: row.status };
      await this.member(db, roomId, row.agent_id, false);
      const status = approve ? 'approved' : 'denied';
      if (approve) await db.query(`UPDATE room_webhook_requests SET result_enc=NULL WHERE room_id=$1 AND source=$2`, [roomId, row.source]);
      const url = approve ? await this.mint(db, roomId, row.source, row.agent_id, adminId, signingSecret) : undefined;
      await db.query(`UPDATE room_webhook_requests SET status=$2,result_enc=$3 WHERE id=$1`,
        [id, status, url ? this.seal(JSON.stringify({ url, ...(revealSecret && signingSecret ? { signingSecret } : {}) })) : null]);
      await db.query(`UPDATE messages SET card=jsonb_set(card,'{status}',$2::jsonb) WHERE id=$1`, [row.message_id, JSON.stringify(status)]);
      await this.decisionLine(db, roomId, row, status);
      return { status };
    });
  }
  async takeUrl(roomId: string, agentId: string, id: string): Promise<{ url?: string; signingSecret?: string }> {
    return this.db.transaction(async (db) => {
      await this.member(db, roomId, agentId, false);
      const row = await db.query<{ result_enc: string | null }>(
        `SELECT result_enc FROM room_webhook_requests WHERE id=$1 AND room_id=$2 AND agent_id=$3 AND status='approved' FOR UPDATE`, [id, roomId, agentId]);
      if (!row.rows[0]?.result_enc) return {};
      const value = JSON.parse(this.open(row.rows[0].result_enc)) as { url: string; signingSecret?: string };
      await db.query(`UPDATE room_webhook_requests SET result_enc=NULL WHERE id=$1`, [id]);
      return value;
    });
  }
  async manage(roomId: string, adminId: string, input: { action: string; source?: string; webhookId?: string; signingSecret?: string | null }): Promise<{ url?: string }> {
    this.validateSecret(input.signingSecret);
    return this.db.transaction(async (db) => {
      await this.member(db, roomId, adminId, true);
      if (input.action === 'create') {
        if (!isWebhookSource(input.source)) throw new WebhookError(400, 'invalid webhook source');
        const exists = await db.query(`SELECT 1 FROM room_webhooks WHERE room_id=$1 AND source=$2 AND revoked_at IS NULL`, [roomId, input.source]);
        if (exists.rowCount) throw new WebhookError(409, 'webhook source already exists');
        return { url: await this.mint(db, roomId, input.source, adminId, adminId, input.signingSecret) };
      }
      const rows = await db.query<{ id: string }>(`SELECT id FROM room_webhooks WHERE id=$1 AND room_id=$2 AND revoked_at IS NULL FOR UPDATE`, [input.webhookId, roomId]);
      if (!rows.rowCount) throw new WebhookError(404, 'webhook not found');
      if (input.action === 'rotate') {
        const token = randomBytes(32).toString('base64url');
        await db.query(`UPDATE room_webhooks SET token_hash=$2,rotated_at=now() WHERE id=$1`, [input.webhookId, hash(token)]);
        await db.query(`UPDATE room_webhook_requests SET result_enc=NULL WHERE room_id=$1 AND source=(SELECT source FROM room_webhooks WHERE id=$2)`, [roomId, input.webhookId]);
        return { url: `${this.origin.replace(/\/$/, '')}/v1/hooks/${token}` };
      }
      if (input.action === 'revoke') {
        await db.query(`UPDATE room_webhooks SET revoked_at=now() WHERE id=$1`, [input.webhookId]);
        await db.query(`UPDATE room_webhook_requests SET result_enc=NULL WHERE room_id=$1 AND source=(SELECT source FROM room_webhooks WHERE id=$2)`, [roomId, input.webhookId]);
      } else if (input.action === 'secret') {
        if (input.signingSecret === undefined) throw new WebhookError(400, 'signing secret required');
        await db.query(`UPDATE room_webhooks SET signing_secret_enc=$2 WHERE id=$1`, [input.webhookId, input.signingSecret ? this.seal(input.signingSecret) : null]);
      } else throw new WebhookError(400, 'invalid webhook action');
      return {};
    });
  }
  async list(roomId: string, identityId: string): Promise<RoomWebhooksResult> {
    return this.db.transaction(async (db) => {
      await this.member(db, roomId, identityId, false);
      await this.expire(db, roomId);
      const sources = await db.query<RoomWebhooksResult['sources'][number]>(
        `SELECT id,source,(signing_secret_enc IS NOT NULL) signed,(revoked_at IS NOT NULL) revoked FROM room_webhooks WHERE room_id=$1 ORDER BY source`, [roomId]);
      const requests = await db.query<WebhookRequestCard>(
        `SELECT q.id "requestId",q.agent_id "agentId",i.name "agentName",q.source,q.reason,q.status,floor(extract(epoch FROM q.expires_at))::int "expiresAt" FROM room_webhook_requests q JOIN identities i ON i.id=q.agent_id WHERE q.room_id=$1 AND q.status='pending' ORDER BY q.created_at`, [roomId]);
      const deliveries = await db.query<RoomWebhooksResult['deliveries'][number]>(
        `SELECT d.id,w.source,floor(extract(epoch FROM d.received_at))::int "receivedAt",d.delivered FROM room_webhook_deliveries d JOIN room_webhooks w ON w.id=d.webhook_id WHERE w.room_id=$1 ORDER BY d.received_at DESC LIMIT 200`, [roomId]);
      return { sources: sources.rows, requests: requests.rows, deliveries: deliveries.rows };
    });
  }
  async receive(token: string, raw: Buffer, timestamp: string | undefined, signature: string | undefined,
    idempotencyKey: string | undefined, signatureMatches: (secret: string, bytes: Buffer, header: string | undefined) => boolean) {
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new WebhookError(400, 'invalid webhook JSON'); }
    if (idempotencyKey && idempotencyKey.length > 200) throw new WebhookError(400, 'invalid idempotency key');
    return this.db.transaction(async (db) => {
      const rows = await db.query<{ id: string; room_id: string; source: string; signing_secret_enc: string | null }>(
        `SELECT w.* FROM room_webhooks w JOIN rooms r ON r.id=w.room_id AND r.archived_at IS NULL WHERE w.token_hash=$1 AND w.revoked_at IS NULL FOR UPDATE OF w`, [hash(token)]);
      const hook = rows.rows[0];
      if (!hook) throw new WebhookError(404, 'webhook not found');
      if (hook.signing_secret_enc) {
        if (!timestamp || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp)) > 300 ||
          !signatureMatches(this.open(hook.signing_secret_enc), Buffer.concat([Buffer.from(timestamp+'.'), raw]), signature))
          throw new WebhookError(401, 'invalid webhook signature');
      }
      const rate = await db.query<{ count: number }>(
        `INSERT INTO room_webhook_rates(webhook_id,count) VALUES($1,1) ON CONFLICT(webhook_id) DO UPDATE SET
         count=CASE WHEN room_webhook_rates.started_at<=now()-interval '1 minute' THEN 1 ELSE room_webhook_rates.count+1 END,
         started_at=CASE WHEN room_webhook_rates.started_at<=now()-interval '1 minute' THEN now() ELSE room_webhook_rates.started_at END RETURNING count`, [hook.id]);
      if (rate.rows[0]!.count > 60) throw new WebhookError(429, 'webhook rate limit exceeded');
      await db.query(`DELETE FROM room_webhook_idempotency WHERE webhook_id=$1 AND received_at<=now()-interval '24 hours'`, [hook.id]);
      if (idempotencyKey) {
        const inserted = await db.query(`INSERT INTO room_webhook_idempotency(webhook_id,key_hash) VALUES($1,$2) ON CONFLICT DO NOTHING`, [hook.id, hash(idempotencyKey)]);
        if (!inserted.rowCount) return { delivered: 0, duplicate: true };
      }
      const kind = `webhook:${hook.source}` as const;
      const delivered = await hasWebhookConsumer(db, hook.room_id, kind);
      if (delivered) {
        await ensureSystemIdentity(db);
        await systemLine(db, { roomId: hook.room_id, authorId: SYSTEM_IDENTITY_ID,
          subject: { kind: 'system', name: hook.source }, verb: 'delivered', object: 'outside data', kind, payload,
        });
      }
      await db.query(`INSERT INTO room_webhook_deliveries(id,webhook_id,delivered) VALUES($1,$2,$3)`, [randomUUID(), hook.id, delivered]);
      await db.query(`DELETE FROM room_webhook_deliveries WHERE webhook_id=$1 AND id NOT IN
        (SELECT id FROM room_webhook_deliveries WHERE webhook_id=$1 ORDER BY received_at DESC,id DESC LIMIT 200)`, [hook.id]);
      return { delivered };
    });
  }
}

/** Applied to daemon reads, including direct message reads and history windows. */
export function webhookPromptBody(text: string, event: { kind?: string; payload?: unknown } | null): string {
  if (event?.kind === 'webhook-request-decided') return text + '\nApproval returns the URL once to the requesting agent when this resume is claimed. Configure the sender without posting the URL in the Room.';
  return event?.kind?.startsWith('webhook:') ? quoteOutsideData(event.kind, event.payload) : text;
}
