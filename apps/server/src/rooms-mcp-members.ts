import { createHash, randomUUID } from 'node:crypto';
import { uniqueAgentHandle } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

/** The identity id a connection's member always has, derived from its grant. */
function mcpMemberIdentityId(clientId: string, ownerId: string): string {
  return createHash('sha256').update(`rooms-mcp-member:v1:${clientId}:${ownerId}`).digest('hex');
}

/** A member owns no Room until a person adds it; its own memberships decide access. */
export async function ensureMcpMember(
  db: SqlDatabase,
  input: { clientId: string; ownerId: string; modelLabel: string },
): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    const owner = (
      await tx.query<{ workspaces: string[] }>(
        `SELECT COALESCE(array_agg(DISTINCT workspace_id),'{}') workspaces FROM memberships
         WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL`,
        [input.ownerId],
      )
    ).rows[0];
    if (!owner) return undefined;
    const memberId = mcpMemberIdentityId(input.clientId, input.ownerId);
    const taken = await tx.query<{ handle: string }>(
      `SELECT DISTINCT identity.handle FROM memberships membership
       JOIN identities identity ON identity.id=membership.identity_id
       WHERE membership.workspace_id=ANY($1::uuid[]) AND membership.removed_at IS NULL
         AND identity.handle IS NOT NULL`,
      [owner.workspaces],
    );
    for (const workspaceId of owner.workspaces) {
      // Serialize handle allocation on the Workspace, then keep the member's
      // handle stable across reconnects by letting it win its own snapshot.
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
    }
    const created = await tx.query(
      `INSERT INTO identities(id,kind,name,handle,hidden_from_roster) VALUES($1,'agent',$2,$3,false)
       ON CONFLICT(id) DO UPDATE SET hidden_from_roster=false,updated_at=now()
       RETURNING id`,
      [memberId, input.modelLabel, uniqueAgentHandle(input.modelLabel, taken.rows.map((row) => row.handle))],
    );
    if (!created.rowCount) return undefined;
    await tx.query(
      `INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$2,$3)
       ON CONFLICT(agent_id) DO NOTHING`,
      [memberId, input.ownerId, input.modelLabel],
    );
    await tx.query(
      `INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label) VALUES($1,$2,$3,$4)
       ON CONFLICT(client_id,owner_id) DO UPDATE SET model_label=EXCLUDED.model_label`,
      [input.clientId, input.ownerId, memberId, input.modelLabel],
    );
    if (owner.workspaces.length)
      await tx.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         SELECT workspace_id,NULL,$1,'member' FROM unnest($2::uuid[]) workspace_id
         ON CONFLICT(workspace_id,identity_id) WHERE room_id IS NULL
         DO UPDATE SET removed_at=NULL`,
        [memberId, owner.workspaces],
      );
    return memberId;
  });
}

/** A member id for an active connection, or undefined before it is created. */
export async function mcpMemberId(
  db: SqlDatabase,
  clientId: string,
  ownerId: string,
): Promise<string | undefined> {
  return (
    await db.query<{ member_id: string }>(
      'SELECT member_id FROM rooms_mcp_members WHERE client_id=$1 AND owner_id=$2',
      [clientId, ownerId],
    )
  ).rows[0]?.member_id;
}

interface McpMemberWebhook {
  callId: string; memberId: string; roomId: string; messageId: string;
}

/**
 * One call per (message, member). The shared webhook ledger's own wake dedupe
 * decides: a redelivery of the same message inserts nothing and calls nobody.
 * A member that tags itself is never a wake target, so self-posts never fire.
 * The caller already knows the registered callback, so this adds no read.
 */
export async function recordMcpMemberWebhook(
  db: SqlDatabase,
  memberId: string,
  callbackUrl: string,
  roomId: string,
  messageId: string,
  text: string,
): Promise<McpMemberWebhook | undefined> {
  const id = randomUUID();
  const inserted = await db.query(
    `INSERT INTO subscription_webhook_calls(id,member_id,wake_message_id,outcome,byte_size,reason)
     VALUES($1,$2,$3,'woke',$4,'mcp-member')
     ON CONFLICT (member_id,wake_message_id) WHERE member_id IS NOT NULL DO NOTHING RETURNING id`,
    [id, memberId, messageId, Buffer.byteLength(text, 'utf8')],
  );
  if (!inserted.rowCount) return undefined;
  await db.query(
    `INSERT INTO rooms_mcp_webhook_outbox(call_id,member_id,room_id,message_id,body)
     VALUES($1,$2,$3,$4,$5)`,
    [id, memberId, roomId, messageId, text.slice(0, 16_000)],
  );
  return { callId: id, memberId, roomId, messageId };
}

/**
 * Best-effort delivery. Each pending delivery is claimed atomically immediately
 * before its own HTTP request, never as a batch, so a slow batch cannot outlive
 * its claim and two drains never call the same pending row twice. The
 * one-minute claim lease only has to outlast one request (5s timeout); it lets
 * a crashed claim retry later. The ledger row records the outcome either way,
 * and a refused call is not retried forever.
 *
 * Access is rechecked at claim time, not just when the wake was queued: a
 * member removed from the Room (or its Workspace) before the drain must not
 * receive Room text, so an ineligible claim is retired as skipped with no HTTP.
 */
export async function deliverMcpMemberWebhooks(
  db: SqlDatabase,
  transport: typeof fetch = fetch,
  limit = 50,
): Promise<number> {
  let delivered = 0;
  for (let index = 0; index < limit; index++) {
    const claimed = await db.query<{
      call_id: string; member_id: string; room_id: string; message_id: string;
      body: string; callback_url: string | null; deliverable: boolean;
    }>(
      `WITH claimed AS (
         UPDATE rooms_mcp_webhook_outbox outbox SET attempts=attempts+1,claimed_at=now()
         WHERE outbox.call_id IN (
           SELECT candidate.call_id FROM rooms_mcp_webhook_outbox candidate
           WHERE candidate.delivered_at IS NULL AND candidate.attempts<3
             AND (candidate.claimed_at IS NULL OR candidate.claimed_at<now()-interval '1 minute')
           ORDER BY candidate.created_at,candidate.call_id LIMIT 1
           FOR UPDATE SKIP LOCKED)
         RETURNING outbox.call_id,outbox.member_id,outbox.room_id,outbox.message_id,outbox.body)
       SELECT claimed.call_id,claimed.member_id,claimed.room_id,claimed.message_id,claimed.body,
         client.callback_url,(
           room.id IS NOT NULL AND room.archived_at IS NULL
           AND EXISTS (SELECT 1 FROM effective_memberships room_member
             WHERE room_member.room_id=claimed.room_id AND room_member.identity_id=claimed.member_id
               AND room_member.removed_at IS NULL)
           AND EXISTS (SELECT 1 FROM memberships workspace_member
             WHERE workspace_member.workspace_id=room.workspace_id AND workspace_member.room_id IS NULL
               AND workspace_member.identity_id=claimed.member_id AND workspace_member.removed_at IS NULL)
         ) deliverable
       FROM claimed
       LEFT JOIN rooms_mcp_members member ON member.member_id=claimed.member_id
       LEFT JOIN rooms_mcp_clients client ON client.id=member.client_id
       LEFT JOIN rooms room ON room.id=claimed.room_id`,
    );
    const row = claimed.rows[0];
    if (!row) break;
    if (!row.deliverable) {
      await db.query('UPDATE rooms_mcp_webhook_outbox SET delivered_at=now() WHERE call_id=$1', [row.call_id]);
      await db.query(
        `UPDATE subscription_webhook_calls SET outcome='skipped',reason='membership ended' WHERE id=$1`,
        [row.call_id],
      );
      continue;
    }
    let accepted = false;
    try {
      if (!row.callback_url) throw new Error('no callback url');
      const response = await transport(row.callback_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memberId: row.member_id, roomId: row.room_id,
          messageId: row.message_id, text: row.body }),
        signal: AbortSignal.timeout(5_000),
      });
      accepted = response.ok;
    } catch { accepted = false; }
    await db.query(`UPDATE rooms_mcp_webhook_outbox SET delivered_at=now() WHERE call_id=$1`, [row.call_id]);
    if (!accepted)
      await db.query(`UPDATE subscription_webhook_calls SET outcome='refused',reason='delivery failed' WHERE id=$1`, [row.call_id]);
    else delivered++;
  }
  return delivered;
}

/**
 * Existing connections predate members. Give each an owned member with no Room
 * memberships; the owner re-adds it where it should read and post.
 */
export async function backfillMcpMembers(db: SqlDatabase): Promise<number> {
  const rows = await db.query<{ client_id: string; identity_id: string; name: string }>(
    `SELECT connection.client_id,connection.identity_id,client.name
     FROM rooms_mcp_connections connection
     JOIN rooms_mcp_clients client ON client.id=connection.client_id
     WHERE connection.revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM rooms_mcp_members member
         WHERE member.client_id=connection.client_id AND member.owner_id=connection.identity_id)`,
  );
  let created = 0;
  for (const row of rows.rows) {
    const member = await ensureMcpMember(db, {
      clientId: row.client_id,
      ownerId: row.identity_id,
      modelLabel: row.name,
    });
    if (member) created++;
  }
  return created;
}

/** Disconnect removes every grant; the identity and its messages stay for history. */
export async function retireMcpMember(
  db: SqlDatabase,
  clientId: string,
  ownerId: string,
): Promise<void> {
  const member = await mcpMemberId(db, clientId, ownerId);
  if (!member) return;
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND removed_at IS NULL`,
      [member],
    );
    await tx.query(`UPDATE identities SET hidden_from_roster=true,updated_at=now() WHERE id=$1`, [
      member,
    ]);
    await tx.query('DELETE FROM rooms_mcp_members WHERE client_id=$1 AND owner_id=$2', [
      clientId,
      ownerId,
    ]);
  });
}

const HANDLE = /^[a-z0-9_]{1,40}$/;

/** The bot names itself through the connector; a person's roster shows the result. */
export async function setMcpMemberProfile(
  db: SqlDatabase,
  memberId: string,
  input: { name?: unknown; handle?: unknown; avatar?: unknown },
): Promise<void> {
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : undefined;
  if (name !== undefined && (!name || name.length > 60)) throw new Error('Invalid name');
  const rawHandle = typeof input.handle === 'string' ? input.handle.trim().replace(/^@+/, '').toLowerCase() : undefined;
  if (rawHandle !== undefined && !HANDLE.test(rawHandle)) throw new Error('Invalid handle');
  const avatar = typeof input.avatar === 'string' ? input.avatar.trim() : undefined;
  if (avatar !== undefined && (avatar.length > 2000 || /[\u0000-\u001f]/.test(avatar)))
    throw new Error('Invalid avatar');
  if (name === undefined && rawHandle === undefined && avatar === undefined)
    throw new Error('Nothing to update');
  return db.transaction(async (tx) => {
    if (rawHandle !== undefined) {
      // A member handle is unique in every Workspace where it belongs, like any agent.
      const clash = await tx.query(
        `SELECT 1 FROM identities identity
         JOIN memberships membership ON membership.identity_id=identity.id AND membership.removed_at IS NULL
         WHERE identity.handle=$1 AND identity.id<>$2 AND identity.hidden_from_roster=false
           AND membership.workspace_id IN (
             SELECT workspace_id FROM memberships WHERE identity_id=$2 AND room_id IS NULL AND removed_at IS NULL)
         LIMIT 1`,
        [rawHandle, memberId],
      );
      if (clash.rowCount) throw new Error('Handle already taken');
    }
    await tx.query(
      `UPDATE identities SET name=COALESCE($2,name),handle=COALESCE($3,handle),
         avatar=COALESCE($4,avatar),updated_at=now() WHERE id=$1`,
      [memberId, name ?? null, rawHandle ?? null, avatar ?? null],
    );
    if (name !== undefined)
      await tx.query('UPDATE agents SET updated_at=now() WHERE agent_id=$1', [memberId]);
  });
}
