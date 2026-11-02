import { queueMcpMentionEvents, deliverMcpEvents } from './rooms-mcp-events.js';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, request as httpsRequest } from 'node:https';
import { MCP_STARTER_ROUTINE, uniqueAgentHandle } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';
import { fetchMcpLogo, mcpMemberAvatar, mcpClientName } from './rooms-mcp-logos.js';
import { normalizeAvatar } from './durable-avatar.js';
import { openSecrets, sealSecrets } from './free-agents.js';
import { publicMcpAddress } from './company-mcp-discovery.js';
import { routeAgentResult, type CommandRow } from './agent-command.js';

/** The identity id a connection's member always has, derived from its grant. */
function mcpMemberIdentityId(clientId: string, ownerId: string): string {
  return createHash('sha256').update(`rooms-mcp-member:v1:${clientId}:${ownerId}`).digest('hex');
}

/**
 * Joins public top-level Rooms in the Room's own Workspace. A fresh member (a
 * first connection, or a reconnect after Disconnect) rejoins every public
 * Room; an existing member keeps the Rooms a person removed it from.
 */
const JOIN_PUBLIC_ROOMS = `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
  SELECT room.workspace_id,room.id,$1,'member' FROM rooms room
  WHERE room.workspace_id=ANY($2::uuid[]) AND room.parent_id IS NULL
    AND room.direct_participants IS NULL AND room.archived_at IS NULL AND room.visibility='public'
  ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL
  DO UPDATE SET removed_at=NULL WHERE memberships.removed_at IS NOT NULL AND $3::boolean`;

/** A refusal the calling client can act on; its message is returned as is. */
export class McpToolError extends Error {}

/** The largest set_profile avatar value: a data URI of about 200 KB of image. */
export const MCP_AVATAR_MAX_CHARS = 280_000;

/**
 * Every member picture takes one path: decoded image bytes, re-encoded by
 * normalizeAvatar like any portrait, then stored in agent_avatars and served
 * from /v1/agent-avatars/<id>, the only agent picture the app renders.
 */
async function mcpAvatarBytes(raw: string): Promise<Buffer> {
  const data = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  let bytes: Buffer;
  if (data) bytes = Buffer.from(data[1]!, 'base64');
  else if (/^https:\/\//i.test(raw)) {
    // Fetched once with the logo guards: public address, pinned DNS, no redirects, 256 KiB.
    const png = await fetchMcpLogo(raw, 256).catch(() => {
      throw new McpToolError('avatar URL did not return a PNG, JPEG or WebP image from a public HTTPS address');
    });
    bytes = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
  } else throw new McpToolError('avatar must be a data:image/png, data:image/jpeg or data:image/webp base64 URI, or an https URL');
  return normalizeAvatar(bytes).catch(() => { throw new McpToolError('avatar image is invalid or too large'); });
}

/** The client's logo on a bone plate, through the same normalization. */
async function mcpLogoAvatar(name: string, logo: string | null): Promise<Buffer | undefined> {
  const plate = await mcpMemberAvatar(name, logo).catch(() => undefined);
  return plate ? normalizeAvatar(plate).catch(() => undefined) : undefined;
}

/**
 * A member with no picture shows its client's logo, served like a generated
 * portrait. A picture the member already has, including one it set itself
 * with set_profile, is never replaced.
 */
async function defaultMcpMemberAvatar(db: SqlDatabase, memberId: string, avatar: Buffer): Promise<void> {
  const id = randomUUID();
  const inserted = await db.query(
    `INSERT INTO agent_avatars(id,agent_id,bytes,request_id,drawing)
     SELECT $1,$2,$3,'rooms-mcp-client-logo','{"source":"client-logo"}'::jsonb
     WHERE EXISTS(SELECT 1 FROM identities WHERE id=$2 AND avatar IS NULL)
     ON CONFLICT(agent_id) DO NOTHING RETURNING id`,
    [id, memberId, avatar],
  );
  if (inserted.rowCount)
    await db.query(`UPDATE identities SET avatar=$2,updated_at=now() WHERE id=$1 AND avatar IS NULL`,
      [memberId, `/v1/agent-avatars/${id}`]);
}

/** Store a member's own picture, replacing any earlier one; returns its path. */
async function replaceMcpMemberAvatar(db: SqlDatabase, memberId: string, avatar: Buffer, source = 'set_profile'): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_avatars(id,agent_id,bytes,request_id,drawing)
     VALUES($1,$2,$3,'rooms-mcp-'||$4,jsonb_build_object('source',$4::text))
     ON CONFLICT(agent_id) DO UPDATE SET id=EXCLUDED.id,bytes=EXCLUDED.bytes,
       request_id=EXCLUDED.request_id,drawing=EXCLUDED.drawing,generated_at=now()`,
    [id, memberId, avatar, source],
  );
  await db.query('UPDATE identities SET avatar=$2,updated_at=now() WHERE id=$1', [memberId, `/v1/agent-avatars/${id}`]);
  return `/v1/agent-avatars/${id}`;
}

/**
 * Approving a connection creates one member owned by the person. Like any
 * agent it joins public top-level Rooms in the approved Workspaces;
 * other Rooms add or remove it through the normal Members sheet.
 */
export async function ensureMcpMember(
  db: SqlDatabase,
  input: { clientId: string; ownerId: string; modelLabel: string; workspaceIds?: string[] },
): Promise<string | undefined> {
  const client = (await db.query<{ name: string; redirects: string[]; logo: string | null }>(
    'SELECT name,redirects,logo FROM rooms_mcp_clients WHERE id=$1', [input.clientId])).rows[0];
  const clientName = client ? mcpClientName(client.name, client.redirects) : input.modelLabel;
  const modelLabel = client && input.modelLabel === client.name ? clientName : input.modelLabel;
  const avatar = client ? await mcpLogoAvatar(clientName, client.logo) : undefined;
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
    // Lock Workspaces in a stable order, then recheck and lock the owner's
    // membership. A concurrent leave cannot race an approval into granting access.
    for (const workspaceId of [...owner.workspaces].sort()) {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
    }
    const current = await tx.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL
       AND removed_at IS NULL AND workspace_id=ANY($2::uuid[]) FOR SHARE`, [input.ownerId, owner.workspaces]);
    const eligible = current.rows.map(row => row.workspace_id);
    const previous = (await tx.query<{ workspace_ids: string[] | null }>(
      `SELECT workspace_ids FROM rooms_mcp_members WHERE client_id=$1 AND owner_id=$2 FOR UPDATE`,
      [input.clientId, input.ownerId])).rows[0];
    if (input.workspaceIds !== undefined && (!input.workspaceIds.length
      || new Set(input.workspaceIds).size !== input.workspaceIds.length
      || input.workspaceIds.some(id => !eligible.includes(id)))) {
      throw new McpToolError('Choose at least one of your current Workspaces');
    }
    const selection = input.workspaceIds ?? previous?.workspace_ids ?? null;
    const workspaces = selection === null ? eligible : selection.filter(id => eligible.includes(id));
    const previousMemberships = await tx.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL`, [memberId]);
    const addedWorkspaces = input.workspaceIds === undefined ? [] : workspaces.filter(
      id => !previousMemberships.rows.some(row => row.workspace_id === id));
    const taken = await tx.query<{ handle: string }>(
      `SELECT DISTINCT identity.handle FROM memberships membership
       JOIN identities identity ON identity.id=membership.identity_id
       WHERE membership.workspace_id=ANY($1::uuid[]) AND membership.removed_at IS NULL
         AND identity.handle IS NOT NULL`,
      [workspaces],
    );
    const created = await tx.query(
      `INSERT INTO identities(id,kind,name,handle,hidden_from_roster) VALUES($1,'agent',$2,$3,false)
       ON CONFLICT(id) DO UPDATE SET hidden_from_roster=false,updated_at=now()
       RETURNING id`,
      [memberId, modelLabel, uniqueAgentHandle(modelLabel, taken.rows.map((row) => row.handle))],
    );
    if (!created.rowCount) return undefined;
    await tx.query(
      `INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$2,$3)
       ON CONFLICT(agent_id) DO UPDATE SET selected_model=EXCLUDED.selected_model`,
      [memberId, input.ownerId, modelLabel],
    );
    const fresh = (await tx.query<{ fresh: boolean }>(
      `INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label,workspace_ids) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(client_id,owner_id) DO UPDATE SET model_label=EXCLUDED.model_label,workspace_ids=EXCLUDED.workspace_ids
       RETURNING (xmax=0) fresh`,
      [input.clientId, input.ownerId, memberId, modelLabel, selection],
    )).rows[0]?.fresh ?? false;
    if (workspaces.length) {
      await tx.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         SELECT workspace_id,NULL,$1,'member' FROM unnest($2::uuid[]) workspace_id
         ON CONFLICT(workspace_id,identity_id) WHERE room_id IS NULL
         DO UPDATE SET removed_at=NULL`,
        [memberId, workspaces],
      );
      await tx.query(JOIN_PUBLIC_ROOMS, [memberId, workspaces, fresh]);
      if (!fresh && addedWorkspaces.length) await tx.query(JOIN_PUBLIC_ROOMS, [memberId, addedWorkspaces, true]);
    }
    if (avatar) await defaultMcpMemberAvatar(tx, memberId, avatar);
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

export const MCP_WEBHOOK_TABLE = 'rooms_mcp_webhook_outbox';

/** Webhook bearer secrets use the free-agent sealing helpers under their own key. */
function webhookKey(): string {
  const key = process.env.BEELINE_MCP_WEBHOOK_KEY;
  if (!key) throw new McpToolError('webhook secrets are not enabled on this server; set the webhook without a secret');
  return key;
}

/** What a tagged client is told, in the instructions and on every webhook POST. */
export const MCP_TAG_INSTRUCTION = `A Room member tagged you. Your owner's Allow is standing approval to answer. ${MCP_STARTER_ROUTINE}`;

/**
 * Every tag or direct message addressed to an AI-client member, in order.
 * list_mentions reads it after a wake; send_message reads its latest row for
 * wake provenance. Both are index lookups, never a scan of Room text.
 */
export async function recordMcpMention(
  db: SqlDatabase, memberId: string, roomId: string, messageId: string,
): Promise<void> {
  await db.transaction(async tx => {
    const inserted = await tx.query(
      `INSERT INTO rooms_mcp_mentions(member_id,room_id,message_id) VALUES($1,$2,$3)
       ON CONFLICT(member_id,message_id) DO NOTHING RETURNING seq`,
      [memberId, roomId, messageId],
    );
    if (inserted.rowCount) await queueMcpMentionEvents(tx, memberId, roomId, messageId);
  });
}

/**
 * A webhook POST to a public address only. The host resolves once, every
 * answer must be public, and the TLS socket is pinned to the checked address;
 * redirects are not followed.
 */
export async function postMcpWebhook(target: string, init: { headers: Record<string, string>; body: string; readResponse?: boolean }): Promise<Response> {
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid webhook');
  const signal = AbortSignal.timeout(5_000);
  const answers = await lookup(url.hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some(answer => !publicMcpAddress(answer.address))) throw new Error('Non-public webhook address');
  const address = answers[0]!;
  const agent = new Agent({ autoSelectFamily: false, lookup(host, _options, callback) {
    if (host !== url.hostname) return callback(new Error('Webhook hostname mismatch'), '', 4);
    callback(null, address.address, address.family);
  } });
  try {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpsRequest(url, { method: 'POST', agent, signal, headers: { ...init.headers, 'content-length': String(Buffer.byteLength(init.body)) } }, res => {
        if (!init.readResponse) {
          res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: '' })); res.on('error', reject);
          return;
        }
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) { res.destroy(new Error('Webhook response too large')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('error', reject); req.end(init.body);
    });
    return new Response([204, 205, 304].includes(result.status) ? null : result.body,
      { status: result.status >= 200 && result.status <= 599 ? result.status : 502 });
  } finally { agent.destroy(); }
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
  // Delivered on commit: a listener sends it at once, with no polling.
  await db.query('SELECT pg_notify($1,$2)', [POSTGRES_LIVE_CHANNEL,
    JSON.stringify({ table: MCP_WEBHOOK_TABLE, operation: 'INSERT', roomId })]);
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
  transport: (url: string, init: { headers: Record<string, string>; body: string }) => Promise<Response> = postMcpWebhook,
  limit = 50,
): Promise<number> {
  let delivered = 0;
  for (let index = 0; index < limit; index++) {
    const claimed = await db.query<{
      call_id: string; member_id: string; room_id: string; message_id: string;
      body: string; callback_url: string | null; callback_secret: string | null; deliverable: boolean;
      author_id: string | null; author_handle: string | null; author_name: string | null; author_kind: string | null; cursor: string | null;
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
         COALESCE(member.callback_url,client.callback_url) callback_url,
         CASE WHEN member.callback_url IS NOT NULL THEN member.callback_secret END callback_secret,
         message.author_id,author.handle author_handle,author.name author_name,author.kind author_kind,mention.seq::text cursor,(
           room.id IS NOT NULL AND room.archived_at IS NULL
           AND EXISTS (SELECT 1 FROM room_access room_member
             WHERE room_member.room_id=claimed.room_id AND room_member.identity_id=claimed.member_id
               AND room_member.removed_at IS NULL)
           AND EXISTS (SELECT 1 FROM memberships workspace_member
             WHERE workspace_member.workspace_id=room.workspace_id AND workspace_member.room_id IS NULL
               AND workspace_member.identity_id=claimed.member_id AND workspace_member.removed_at IS NULL)
         ) deliverable
       FROM claimed
       LEFT JOIN rooms_mcp_members member ON member.member_id=claimed.member_id
       LEFT JOIN rooms_mcp_clients client ON client.id=member.client_id
       LEFT JOIN rooms room ON room.id=claimed.room_id
       LEFT JOIN messages message ON message.id=claimed.message_id
       LEFT JOIN identities author ON author.id=message.author_id
       LEFT JOIN rooms_mcp_mentions mention ON mention.member_id=claimed.member_id AND mention.message_id=claimed.message_id`,
    );
    const row = claimed.rows[0];
    if (!row) break;
    if (!row.deliverable || !row.callback_url) {
      await db.query('UPDATE rooms_mcp_webhook_outbox SET delivered_at=now() WHERE call_id=$1', [row.call_id]);
      await db.query(
        `UPDATE subscription_webhook_calls SET outcome='skipped',reason=$2 WHERE id=$1`,
        [row.call_id, row.deliverable ? 'webhook disabled' : 'membership ended'],
      );
      continue;
    }
    let accepted = false;
    try {
      if (!row.callback_url) throw new Error('no callback url');
      const response = await transport(row.callback_url, {
        headers: { 'content-type': 'application/json',
          ...(row.callback_secret ? { authorization: `Bearer ${openSecrets<string>(webhookKey(), row.callback_secret)}` } : {}) },
        body: JSON.stringify({ memberId: row.member_id, roomId: row.room_id, messageId: row.message_id,
          author: row.author_id ? { id: row.author_id, handle: row.author_handle, name: row.author_name } : null,
          text: row.body, cursor: row.cursor, instruction: row.author_kind === 'agent' && row.author_handle
            ? `${MCP_TAG_INSTRUCTION} Start your reply with @${row.author_handle} to wake the asking agent.`
            : MCP_TAG_INSTRUCTION }),
      });
      accepted = response.ok;
    } catch { accepted = false; }
    await db.query(`UPDATE rooms_mcp_webhook_outbox SET delivered_at=now() WHERE call_id=$1`, [row.call_id]);
    if (!accepted)
      await db.query(`UPDATE subscription_webhook_calls SET outcome='refused',reason='delivery failed' WHERE id=$1`, [row.call_id]);
    else delivered++;
  }
  return delivered + await deliverMcpEvents(db, transport, limit);
}

/**
 * Existing connections predate members. Give each an owned member; approving
 * creates the same member, so it joins every public Room.
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

/**
 * Members made before public Rooms and logos applied: join the public Rooms
 * they never had a row in (a Room a person removed them from stays removed),
 * and show the client logo where no picture is set.
 */
export async function backfillMcpMemberRoomsAndAvatars(db: SqlDatabase): Promise<number> {
  const members = await db.query<{ member_id: string; name: string; redirects: string[]; logo: string | null; avatar: string | null; workspaces: string[] }>(
    `SELECT member.member_id,client.name,client.redirects,client.logo,identity.avatar,
       COALESCE((SELECT array_agg(workspace_id) FROM memberships
         WHERE identity_id=member.member_id AND room_id IS NULL AND removed_at IS NULL),'{}') workspaces
     FROM rooms_mcp_members member
     JOIN rooms_mcp_clients client ON client.id=member.client_id
     JOIN identities identity ON identity.id=member.member_id`,
  );
  for (const member of members.rows) {
    if (member.workspaces.length) await db.query(JOIN_PUBLIC_ROOMS, [member.member_id, member.workspaces, false]);
    await db.transaction(async tx => {
      // Serialize with set_profile, whose identity update precedes its avatar write.
      const current = (await tx.query<{ avatar: string | null }>(
        'SELECT avatar FROM identities WHERE id=$1 FOR UPDATE', [member.member_id])).rows[0];
      if (!current) return;
      const stored = (await tx.query<{ request_id: string | null; drawing: { source?: string } | null }>(
        'SELECT request_id,drawing FROM agent_avatars WHERE agent_id=$1 FOR UPDATE', [member.member_id])).rows[0];
      if (stored && (stored.request_id !== 'rooms-mcp-client-logo' || stored.drawing?.source !== 'client-logo')) return;
      if (current.avatar?.startsWith('/v1/agent-avatars/') && !stored) return;
      const own = !stored && current.avatar ? await mcpAvatarBytes(current.avatar).catch(() => undefined) : undefined;
      const avatar = own ?? await mcpLogoAvatar(mcpClientName(member.name, member.redirects), member.logo);
      if (avatar) {
        // Avoid changing the URL and generating a new portrait on every run.
        const same = await tx.query('SELECT 1 FROM agent_avatars WHERE agent_id=$1 AND bytes=$2', [member.member_id, avatar]);
        if (!same.rowCount) await replaceMcpMemberAvatar(tx, member.member_id, avatar, own ? 'set_profile' : 'client-logo');
      } else if (current.avatar) await tx.query('UPDATE identities SET avatar=NULL WHERE id=$1', [member.member_id]);
    });
  }
  return members.rowCount;
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
  /** False when the approving person names the member on the consent page. */
  byMember = true,
): Promise<{ avatar?: string }> {
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : undefined;
  if (name !== undefined && (!name || name.length > 60)) throw new McpToolError('Invalid name');
  const rawHandle = typeof input.handle === 'string' ? input.handle.trim().replace(/^@+/, '').toLowerCase() : undefined;
  if (rawHandle !== undefined && !HANDLE.test(rawHandle)) throw new McpToolError('Invalid handle');
  const rawAvatar = typeof input.avatar === 'string' ? input.avatar.trim() : undefined;
  if (rawAvatar !== undefined && rawAvatar.length > MCP_AVATAR_MAX_CHARS)
    throw new McpToolError('avatar is larger than about 200 KB');
  if (name === undefined && rawHandle === undefined && !rawAvatar)
    throw new McpToolError('Nothing to update');
  // Never a raw caller string in identities.avatar: the app renders only a
  // stored portrait, so an image is decoded and stored before anything changes.
  const avatar = rawAvatar ? await mcpAvatarBytes(rawAvatar) : undefined;
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
      if (clash.rowCount) throw new McpToolError('Handle already taken');
    }
    await tx.query(
      `UPDATE identities SET name=COALESCE($2,name),handle=COALESCE($3,handle),updated_at=now() WHERE id=$1`,
      [memberId, name ?? null, rawHandle ?? null],
    );
    const stored = avatar ? await replaceMcpMemberAvatar(tx, memberId, avatar) : undefined;
    if (byMember) await tx.query('UPDATE rooms_mcp_members SET profile_set=true WHERE member_id=$1', [memberId]);
    if (name !== undefined)
      await tx.query('UPDATE agents SET updated_at=now() WHERE agent_id=$1', [memberId]);
    return stored ? { avatar: stored } : {};
  });
}

/**
 * A member sets where its tags are pushed. The webhook belongs to this member
 * only, so clients that share a published client id never share a receiver.
 * NULL inherits the registration callback; an empty url explicitly disables it.
 * Disabling also retires queued deliveries. The bearer secret is never read back.
 */
export async function setMcpMemberWebhook(
  db: SqlDatabase,
  memberId: string,
  input: { url?: unknown; secret?: unknown },
): Promise<{ webhook: string | null; secret: boolean }> {
  const raw = typeof input.url === 'string' ? input.url.trim() : input.url === undefined ? '' : undefined;
  if (raw === undefined || raw.length > 2048) throw new McpToolError('Invalid webhook');
  if (raw) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new McpToolError('Invalid webhook'); }
    if (url.protocol !== 'https:' || url.hash || url.username || url.password || url.hostname === 'localhost') throw new McpToolError('Invalid webhook');
    // An address literal must be public now; a name is checked on every delivery.
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !publicMcpAddress(literal)) throw new McpToolError('Invalid webhook');
  }
  const secret = typeof input.secret === 'string' ? input.secret.trimStart().replace(/^Bearer /i, '').trim() : input.secret;
  if (secret !== undefined && (typeof secret !== 'string' || !secret || secret.length > 512 || /[\u0000-\u0020\u007f]/.test(secret)))
    throw new McpToolError('Invalid webhook secret');
  if (secret !== undefined && !raw) throw new McpToolError('A webhook secret needs a webhook url');
  const sealed = secret === undefined ? null : sealSecrets(webhookKey(), secret);
  await db.transaction(async tx => {
    // Keep the empty string: COALESCE must not restore the registration callback.
    await tx.query(
      'UPDATE rooms_mcp_members SET callback_url=$2,callback_secret=$3 WHERE member_id=$1',
      [memberId, raw, sealed],
    );
    if (!raw)
      await tx.query(`WITH cancelled AS (
        UPDATE rooms_mcp_webhook_outbox SET delivered_at=now()
        WHERE member_id=$1 AND delivered_at IS NULL RETURNING call_id
      ) UPDATE subscription_webhook_calls SET outcome='skipped',reason='webhook disabled'
        WHERE id IN (SELECT call_id FROM cancelled)`, [memberId]);
  });
  return { webhook: raw || null, secret: Boolean(sealed) };
}

/**
 * The wake chain a member's reply continues: the helper command behind the
 * latest message addressed to it in this Room, read from the mentions ledger
 * by index. Bounded, so a slow read can never hold a wake.
 */
export async function mcpProvenance(db: SqlDatabase, memberId: string, roomId: string, messageId?: string) {
  return db.transaction(async tx => {
    await tx.query("SET LOCAL statement_timeout='2s'");
    return (await tx.query<{ command: CommandRow | null }>(
      `SELECT to_jsonb(command) command FROM rooms_mcp_mentions mention
       JOIN messages m ON m.id=mention.message_id AND m.deleted_at IS NULL
       LEFT JOIN LATERAL (SELECT c.* FROM agent_commands c
         WHERE c.room_id=m.room_id AND c.agent_id=m.author_id AND c.turn_request_id=m.request_id
         ORDER BY c.created_at DESC,c.id DESC LIMIT 1) command ON true
       WHERE mention.member_id=$1 AND mention.room_id=$2 AND ($3::text IS NULL OR mention.message_id<>$3)
       ORDER BY mention.seq DESC LIMIT 1`,
      [memberId, roomId, messageId ?? null],
    )).rows[0];
  });
}

/**
 * Wake every agent a member's post tags. A durable row is written first and
 * removed only after routing commits, so a failed route is retried by
 * maintenance; agent commands and webhook calls dedupe per (message, target),
 * so a retry never wakes twice. A failed provenance read only loses the
 * chain: the post still routes, as one hop from a person.
 */
export async function routeMcpMemberPost(
  db: SqlDatabase, memberId: string, roomId: string, messageId: string,
  provenance: typeof mcpProvenance = mcpProvenance,
): Promise<{ woken: string[]; routing: 'done' | 'retrying' }> {
  await db.query(
    `INSERT INTO rooms_mcp_pending_routes(message_id,room_id,member_id) VALUES($1,$2,$3)
     ON CONFLICT(message_id) DO NOTHING`,
    [messageId, roomId, memberId],
  );
  let incoming: Awaited<ReturnType<typeof mcpProvenance>> | null = null;
  try {
    incoming = await provenance(db, memberId, roomId, messageId);
  } catch (error) {
    console.error('[rooms-mcp] provenance lookup failed; routing without a parent', error);
  }
  const parent = incoming?.command
    ? { ...incoming.command, agent_depth: incoming.command.agent_depth + 1 } : undefined;
  try {
    const delivery = await routeAgentResult(db, parent, messageId,
      { roomId, agentId: memberId, initialAgentDepth: incoming === null || incoming ? 1 : undefined });
    await db.query('DELETE FROM rooms_mcp_pending_routes WHERE message_id=$1', [messageId]);
    return { woken: delivery.woken, routing: 'done' };
  } catch (error) {
    console.error('[rooms-mcp] wake routing failed; maintenance retries it', error);
    await db.query(
      'UPDATE rooms_mcp_pending_routes SET attempts=attempts+1,last_error=$2 WHERE message_id=$1',
      [messageId, String(error instanceof Error ? error.message : error).slice(0, 500)],
    ).catch(() => undefined);
    return { woken: [], routing: 'retrying' };
  }
}

/** Maintenance: retry member posts whose routing failed, at most five times each. */
export async function retryMcpMemberRoutes(db: SqlDatabase, limit = 20): Promise<number> {
  const pending = await db.query<{ message_id: string; room_id: string; member_id: string }>(
    `SELECT message_id,room_id,member_id FROM rooms_mcp_pending_routes
     WHERE attempts<5 AND created_at<now()-interval '30 seconds' ORDER BY created_at LIMIT $1`,
    [limit],
  );
  let routed = 0;
  for (const row of pending.rows)
    if ((await routeMcpMemberPost(db, row.member_id, row.room_id, row.message_id)).routing === 'done') routed++;
  return routed;
}
