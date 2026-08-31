import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { projectEvent } from '@beeline/push-gateway/projection';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

export interface LegacyIdentity {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  handle?: string;
  avatar?: string;
  ownerId?: string;
  soul?: unknown;
  model?: string;
  effort?: string;
  catalog?: unknown[];
}
export interface LegacyWorkspace {
  id: string;
  name: string;
  about?: string;
  avatar?: string;
  visibility: 'public' | 'invite-only';
  createdAt: number;
  updatedAt: number;
}
export interface LegacyRoom {
  id: string;
  workspaceId: string;
  parentId?: string;
  name: string;
  about?: string;
  avatar?: string;
  visibility: 'public' | 'invite-only';
  archived: boolean;
  directParticipants?: string[];
  repository?: {
    key: string;
    remote: string;
    targetBranch: string;
    githubInstallationId?: number;
    githubEventsEnabled?: boolean;
  };
  createdAt: number;
  updatedAt: number;
}
export interface LegacyMembership {
  workspaceId: string;
  roomId?: string;
  identityId: string;
  role: 'owner' | 'admin' | 'member';
  removed: boolean;
  generation?: number;
}
export interface LegacyEvent {
  id: string;
  roomId: string;
  authorId: string;
  authorKind: 'human' | 'agent';
  authorName: string;
  authorHandle?: string;
  authorAvatar?: string;
  kind: number;
  tags: string[][];
  content: string;
  createdAt: number;
  rootId?: string;
}
export interface LegacyReadMark {
  roomId: string;
  identityId: string;
  messageId: string;
  createdAt: number;
}
export interface LegacySchedule {
  scheduleId: string;
  agentId: string;
  roomId: string;
  revision: number;
  schedule: unknown;
}
export interface LegacyGitHub {
  identityLinks: Array<{ subject: string; identityId: string; issuer: string; audience: string }>;
  identitySuccessions: Array<{ subject: string; oldIdentityId: string; newIdentityId: string }>;
  userTokens: Array<{ subject: string; encryptedToken: string; staleAt?: string }>;
  installations: Array<{
    installationId: number;
    ownerId: string;
    accountLogin: string;
    accountType: string;
  }>;
  repositories: Array<{
    repositoryId: number;
    installationId: number;
    fullName: string;
    defaultBranch: string;
  }>;
}
export interface LegacyRegistry {
  registrations: Array<{ pubkey: string; tokens: string[] }>;
  updateReceipts?: Array<
    Record<string, unknown> & {
      pubkey: string;
      deviceId: string;
      environment: 'physical' | 'emulator';
    }
  >;
}
export interface MediaManifestEntry {
  legacyUrl: string;
  path?: string;
  bytesBase64?: string;
  ownerId: string;
  mimeType: string;
  name: string;
}
export interface LegacySnapshot {
  identities: LegacyIdentity[];
  workspaces: LegacyWorkspace[];
  rooms: LegacyRoom[];
  memberships: LegacyMembership[];
  events: LegacyEvent[];
  readMarks: LegacyReadMark[];
  schedules: LegacySchedule[];
  github: LegacyGitHub;
  registry: LegacyRegistry;
  media: MediaManifestEntry[];
}

export interface ImportReport {
  importId: string;
  imported: Record<string, number>;
  skipped: Record<string, number>;
  mediaBytes: number;
}

function fingerprint(snapshot: LegacySnapshot): string {
  const digest = createHash('sha256');
  digest.update(JSON.stringify({ ...snapshot, media: undefined }));
  for (const media of snapshot.media)
    digest
      .update(
        JSON.stringify({
          legacyUrl: media.legacyUrl,
          path: media.path,
          ownerId: media.ownerId,
          mimeType: media.mimeType,
          name: media.name,
        }),
      )
      .update(media.bytesBase64 ?? '');
  return digest.digest('hex');
}
function date(seconds: number): Date {
  return new Date(seconds * 1_000);
}
function card(message: RoomViewMessage): { type: string | null; value: unknown } {
  if (message.permission) return { type: 'permission', value: message.permission };
  if (message.targetBranch) return { type: 'target-branch', value: message.targetBranch };
  if (message.githubEvent) return { type: 'github-event', value: message.githubEvent };
  if (message.daemonFact) return { type: 'daemon-fact', value: message.daemonFact };
  if (message.corner) return { type: 'corner', value: message.corner };
  return { type: null, value: null };
}

export class SnapshotImporter {
  constructor(private readonly target: SqlDatabase) {}

  async import(
    snapshot: LegacySnapshot,
    requestedImportId?: string,
    failAfter?: number,
  ): Promise<ImportReport> {
    const sourceFingerprint = fingerprint(snapshot);
    const importId = requestedImportId ?? sourceFingerprint.slice(0, 24);
    const existing = await this.target.query<{ source_fingerprint: string }>(
      `SELECT source_fingerprint FROM import_runs WHERE import_id=$1`,
      [importId],
    );
    if (existing.rows[0] && existing.rows[0].source_fingerprint !== sourceFingerprint)
      throw new Error('import id belongs to a different snapshot');
    await this.target.query(
      `INSERT INTO import_runs(import_id,source_fingerprint,state) VALUES($1,$2,'running') ON CONFLICT(import_id) DO UPDATE SET state='running',error=NULL`,
      [importId, sourceFingerprint],
    );
    const imported: Record<string, number> = {};
    const skipped: Record<string, number> = {};
    let processed = 0;
    let mediaBytes = 0;
    const one = async (
      type: string,
      sourceId: string,
      work: (database: SqlDatabase) => Promise<void>,
    ) => {
      const didImport = await this.target.transaction(async (database) => {
        const claim = await database.query(
          `INSERT INTO import_items(import_id,source_type,source_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [importId, type, sourceId],
        );
        if (!claim.rowCount) return false;
        await work(database);
        return true;
      });
      (didImport ? imported : skipped)[type] = ((didImport ? imported : skipped)[type] ?? 0) + 1;
      processed += 1;
      if (failAfter !== undefined && processed >= failAfter)
        throw new Error('injected importer interruption');
    };
    try {
      for (const row of snapshot.identities)
        await one('identity', row.id, async (db) => {
          await db.query(
            `INSERT INTO identities(id,kind,name,handle,avatar) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,name=EXCLUDED.name,handle=EXCLUDED.handle,avatar=EXCLUDED.avatar,updated_at=now()`,
            [row.id, row.kind, row.name, row.handle ?? null, row.avatar ?? null],
          );
          if (row.kind === 'agent')
            await db.query(
              `INSERT INTO agents(agent_id,owner_id,soul,selected_model,selected_effort,model_catalog) VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb) ON CONFLICT(agent_id) DO UPDATE SET soul=EXCLUDED.soul,selected_model=EXCLUDED.selected_model,selected_effort=EXCLUDED.selected_effort,model_catalog=EXCLUDED.model_catalog,updated_at=now()`,
              [
                row.id,
                row.ownerId ?? row.id,
                JSON.stringify(row.soul ?? null),
                row.model ?? null,
                row.effort ?? null,
                JSON.stringify(row.catalog ?? []),
              ],
            );
        });
      for (const row of snapshot.workspaces)
        await one('workspace', row.id, async (db) => {
          await db.query(
            `INSERT INTO workspaces(id,name,about,avatar,visibility,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,about=EXCLUDED.about,avatar=EXCLUDED.avatar,visibility=EXCLUDED.visibility,updated_at=EXCLUDED.updated_at`,
            [
              row.id,
              row.name,
              row.about ?? null,
              row.avatar ?? null,
              row.visibility,
              date(row.createdAt),
              date(row.updatedAt),
            ],
          );
        });
      for (const row of snapshot.rooms)
        await one('room', row.id, async (db) => {
          await db.query(
            `INSERT INTO rooms(id,workspace_id,parent_id,name,about,avatar,visibility,archived_at,direct_participants,repository_key,repository_remote,repository_target_branch,github_installation_id,github_events_enabled,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,about=EXCLUDED.about,avatar=EXCLUDED.avatar,visibility=EXCLUDED.visibility,archived_at=EXCLUDED.archived_at,repository_key=EXCLUDED.repository_key,repository_remote=EXCLUDED.repository_remote,repository_target_branch=EXCLUDED.repository_target_branch,updated_at=EXCLUDED.updated_at`,
            [
              row.id,
              row.workspaceId,
              row.parentId ?? null,
              row.name,
              row.about ?? null,
              row.avatar ?? null,
              row.visibility,
              row.archived ? date(row.updatedAt) : null,
              JSON.stringify(row.directParticipants ?? null),
              row.repository?.key ?? null,
              row.repository?.remote ?? null,
              row.repository?.targetBranch ?? 'main',
              row.repository?.githubInstallationId ?? null,
              row.repository?.githubEventsEnabled !== false,
              date(row.createdAt),
              date(row.updatedAt),
            ],
          );
        });
      for (const row of snapshot.memberships)
        await one(
          'membership',
          `${row.workspaceId}:${row.roomId ?? 'workspace'}:${row.identityId}`,
          async (db) => {
            await db.query(
              `INSERT INTO memberships(workspace_id,room_id,identity_id,role,generation,removed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
              [
                row.workspaceId,
                row.roomId ?? null,
                row.identityId,
                row.role,
                row.generation ?? 1,
                row.removed ? new Date() : null,
              ],
            );
          },
        );
      for (const media of snapshot.media)
        await one('media', media.legacyUrl, async (db) => {
          const bytes = media.bytesBase64
            ? Buffer.from(media.bytesBase64, 'base64')
            : await readFile(media.path!);
          mediaBytes += bytes.length;
          const digest = createHash('sha256').update(bytes).digest('hex');
          const mediaId = randomUUID();
          const stored = await db.query<{ id: string }>(
            `INSERT INTO media(id,owner_id,bytes,mime_type,name,sha256) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,sha256) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
            [mediaId, media.ownerId, bytes, media.mimeType, media.name, digest],
          );
          await db.query(
            `INSERT INTO legacy_media_urls(legacy_url,media_id) VALUES($1,$2) ON CONFLICT(legacy_url) DO UPDATE SET media_id=EXCLUDED.media_id`,
            [media.legacyUrl, stored.rows[0]!.id],
          );
        });
      await this.target.query(
        `UPDATE identities i SET avatar='/v1/media/'||l.media_id::text FROM legacy_media_urls l WHERE i.avatar=l.legacy_url`,
      );
      await this.target.query(
        `UPDATE workspaces w SET avatar='/v1/media/'||l.media_id::text FROM legacy_media_urls l WHERE w.avatar=l.legacy_url`,
      );
      await this.target.query(
        `UPDATE rooms r SET avatar='/v1/media/'||l.media_id::text FROM legacy_media_urls l WHERE r.avatar=l.legacy_url`,
      );
      const mediaMappings = await this.target.query<{ legacy_url: string; media_id: string }>(
        `SELECT legacy_url,media_id FROM legacy_media_urls`,
      );
      const mediaByUrl = new Map(mediaMappings.rows.map((row) => [row.legacy_url, row.media_id]));
      for (const row of snapshot.events)
        await one('event', row.id, async (db) => {
          const original = projectEvent(
            {
              id: row.id,
              pubkey: row.authorId,
              agent: row.authorKind === 'agent',
              name: row.authorName,
              handle: row.authorHandle,
              avatar: row.authorAvatar,
              kind: row.kind,
              tags: row.tags,
              content: row.content,
              createdAt: row.createdAt,
              rootId: row.rootId ?? row.id,
            },
            row.roomId,
          );
          const projected = original
            ? {
                ...original,
                ...(original.attachments
                  ? {
                      attachments: original.attachments.map((attachment) => {
                        const mediaId = mediaByUrl.get(attachment.url);
                        return mediaId
                          ? { ...attachment, url: `/v1/media/${mediaId}` }
                          : attachment;
                      }),
                    }
                  : {}),
              }
            : undefined;
          if (!projected) return;
          const typed = card(projected);
          await db.query(
            `INSERT INTO messages(id,room_id,author_id,text,presentation,attachments,mention_ids,reply_to_message_id,root_message_id,request_id,turn_id,activity,durable_fact,card_type,card,legacy_event,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb,$16::jsonb,$17) ON CONFLICT(id) DO NOTHING`,
            [
              projected.id,
              row.roomId,
              row.authorId,
              projected.text,
              projected.presentation,
              JSON.stringify(projected.attachments ?? []),
              JSON.stringify(projected.mentionPubkeys ?? []),
              projected.reply?.eventId ?? null,
              projected.reply?.rootId ?? projected.reference?.rootId ?? row.rootId ?? row.id,
              projected.requestId ?? null,
              projected.liveTurnId ?? null,
              JSON.stringify(projected.activity ?? null),
              projected.durableFact ?? null,
              typed.type,
              JSON.stringify(typed.value),
              JSON.stringify(row),
              date(projected.createdAt),
            ],
          );
          const plan = projected.activity
            ?.flatMap((activity) => (activity.plan ? [activity.plan] : []))
            .at(-1);
          if (plan)
            await db.query(
              `INSERT INTO corner_facts(corner_id,plan) VALUES($1,$2::jsonb) ON CONFLICT(corner_id) DO UPDATE SET plan=EXCLUDED.plan`,
              [row.roomId, JSON.stringify(plan)],
            );
        });
      for (const row of snapshot.readMarks)
        await one('read-mark', `${row.roomId}:${row.identityId}`, async (db) => {
          await db.query(
            `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id) VALUES($1,$2,$3,$4) ON CONFLICT(room_id,identity_id) DO UPDATE SET message_created_at=EXCLUDED.message_created_at,message_id=EXCLUDED.message_id`,
            [row.roomId, row.identityId, date(row.createdAt), row.messageId],
          );
        });
      for (const row of snapshot.schedules)
        await one('schedule', `${row.scheduleId}:${row.revision}`, async (db) => {
          await db.query(
            `INSERT INTO work_schedules(schedule_id,agent_id,room_id,revision,schedule) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
            [row.scheduleId, row.agentId, row.roomId, row.revision, JSON.stringify(row.schedule)],
          );
        });
      for (const row of snapshot.github.identityLinks)
        await one('github-identity-link', row.subject, async (db) => {
          await db.query(
            `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience) VALUES('github',$1,$2,$3,$4) ON CONFLICT(provider,subject) DO UPDATE SET identity_id=EXCLUDED.identity_id,issuer=EXCLUDED.issuer,audience=EXCLUDED.audience`,
            [row.subject, row.identityId, row.issuer, row.audience],
          );
        });
      for (const row of snapshot.github.identitySuccessions)
        await one('github-identity-succession', row.oldIdentityId, async (db) => {
          await db.query(
            `INSERT INTO identity_successions(old_identity_id,new_identity_id,provider,subject) VALUES($1,$2,'github',$3) ON CONFLICT(old_identity_id) DO UPDATE SET new_identity_id=EXCLUDED.new_identity_id,subject=EXCLUDED.subject`,
            [row.oldIdentityId, row.newIdentityId, row.subject],
          );
        });
      for (const row of snapshot.github.userTokens)
        await one('github-user-token', row.subject, async (db) => {
          await db.query(
            `INSERT INTO github_user_tokens(subject,encrypted_token,stale_at) VALUES($1,$2,$3) ON CONFLICT(subject) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,stale_at=EXCLUDED.stale_at,updated_at=now()`,
            [row.subject, row.encryptedToken, row.staleAt ?? null],
          );
        });
      for (const row of snapshot.github.installations)
        await one('github-installation', String(row.installationId), async (db) => {
          await db.query(
            `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [row.installationId, row.ownerId, row.accountLogin, row.accountType],
          );
        });
      for (const row of snapshot.github.repositories)
        await one('github-repository', String(row.repositoryId), async (db) => {
          await db.query(
            `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [row.repositoryId, row.installationId, row.fullName, row.defaultBranch],
          );
        });
      for (const registration of snapshot.registry.registrations)
        for (const pushToken of registration.tokens)
          await one('push-device', pushToken, async (db) => {
            await db.query(
              `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES($1,$2,'ios','physical') ON CONFLICT(token) DO UPDATE SET identity_id=EXCLUDED.identity_id`,
              [pushToken, registration.pubkey],
            );
          });
      for (const receipt of snapshot.registry.updateReceipts ?? [])
        await one('update-receipt', `${receipt.pubkey}:${receipt.deviceId}`, async (db) => {
          await db.query(
            `INSERT INTO device_update_receipts(identity_id,device_id,receipt) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,
            [receipt.pubkey, receipt.deviceId, JSON.stringify(receipt)],
          );
        });
      await this.target.query(
        `UPDATE import_runs SET state='complete',completed_at=now(),checkpoint=$2::jsonb WHERE import_id=$1`,
        [importId, JSON.stringify({ imported, skipped, mediaBytes })],
      );
      return { importId, imported, skipped, mediaBytes };
    } catch (error) {
      await this.target.query(`UPDATE import_runs SET state='failed',error=$2 WHERE import_id=$1`, [
        importId,
        error instanceof Error ? error.message : String(error),
      ]);
      throw error;
    }
  }
}

/** Read a transaction-consistent old Postgres snapshot without RoomView HTTP. */
export async function readOldPostgresSnapshot(
  old: SqlDatabase,
  registry: LegacyRegistry,
  media: MediaManifestEntry[],
): Promise<LegacySnapshot> {
  return old.transaction(async (database) => {
    await database.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const channelRows = await database.query<{
      id: string;
      name: string;
      description: string | null;
      visibility: string;
      created_by: string;
      created_at: Date;
      updated_at: Date;
      archived: boolean;
      tags: string[][];
    }>(`
      SELECT c.id::text,c.name,c.description,c.visibility::text,encode(c.created_by,'hex') created_by,c.created_at,c.updated_at,c.archived_at IS NOT NULL archived,g.tags
      FROM channels c JOIN LATERAL(SELECT e.tags FROM events e WHERE e.community_id=c.community_id AND e.channel_id=c.id AND e.kind=9007 AND e.deleted_at IS NULL ORDER BY e.created_at,e.id LIMIT 1)g ON true
      WHERE c.deleted_at IS NULL`);
    const channelById = new Map(channelRows.rows.map((row) => [row.id, row]));
    const workspaceIdFor = (row: (typeof channelRows.rows)[number]) =>
      tagValue(row.tags, 'community') ?? row.id;
    const workspaceRows = channelRows.rows.filter((row) => workspaceIdFor(row) === row.id);
    const workspaces: LegacyWorkspace[] = workspaceRows.map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.description ? { about: row.description } : {}),
      ...((tagValue(row.tags, 'avatar') ?? tagValue(row.tags, 'picture'))
        ? { avatar: (tagValue(row.tags, 'avatar') ?? tagValue(row.tags, 'picture'))! }
        : {}),
      visibility: visibility(row.visibility),
      createdAt: Math.floor(row.created_at.getTime() / 1000),
      updatedAt: Math.floor(row.updated_at.getTime() / 1000),
    }));
    const roomRows = channelRows.rows.filter((row) => workspaceIdFor(row) !== row.id);
    const repositoryEvents = await database.query<{ channel_id: string; content: string }>(
      `SELECT channel_id::text,content FROM events WHERE deleted_at IS NULL AND kind=30078 AND channel_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(tags)t WHERE t->>0='t' AND t->>1='buzz-room-repository') ORDER BY created_at,id`,
    );
    const repositoryByRoom = new Map<string, LegacyRoom['repository']>();
    for (const event of repositoryEvents.rows) {
      const parsed = parseObject(event.content);
      if (typeof parsed.key === 'string' && typeof parsed.remote === 'string')
        repositoryByRoom.set(event.channel_id, {
          key: parsed.key,
          remote: parsed.remote,
          targetBranch: typeof parsed.targetBranch === 'string' ? parsed.targetBranch : 'main',
          ...(typeof parsed.githubInstallationId === 'number'
            ? { githubInstallationId: parsed.githubInstallationId }
            : {}),
          githubEventsEnabled: parsed.githubEventsEnabled !== false,
        });
    }
    const rooms: LegacyRoom[] = roomRows.map((row) => {
      const participants = row.tags
        .filter((item) => item[0] === 'p' && /^[0-9a-f]{64}$/.test(item[1] ?? ''))
        .map((item) => item[1]!);
      return {
        id: row.id,
        workspaceId: workspaceIdFor(row),
        ...(tagValue(row.tags, 'parent') ? { parentId: tagValue(row.tags, 'parent') } : {}),
        name: row.name,
        ...(row.description ? { about: row.description } : {}),
        ...((tagValue(row.tags, 'avatar') ?? tagValue(row.tags, 'picture'))
          ? { avatar: (tagValue(row.tags, 'avatar') ?? tagValue(row.tags, 'picture'))! }
          : {}),
        visibility: visibility(row.visibility),
        archived: row.archived,
        ...(participants.length === 2 ? { directParticipants: participants.sort() } : {}),
        ...(repositoryByRoom.get(row.id) ? { repository: repositoryByRoom.get(row.id) } : {}),
        createdAt: Math.floor(row.created_at.getTime() / 1000),
        updatedAt: Math.floor(row.updated_at.getTime() / 1000),
      };
    });
    const identityRows = await database.query<{
      id: string;
      name: string | null;
      handle: string | null;
      avatar: string | null;
      agent: boolean;
    }>(`
      WITH keys AS (
        SELECT community_id,pubkey FROM channel_members
        UNION SELECT community_id,pubkey FROM events WHERE deleted_at IS NULL
        UNION SELECT community::uuid,pubkey FROM beeline_identity_links
        UNION SELECT community::uuid,old_pubkey FROM beeline_key_successions
        UNION SELECT community::uuid,new_pubkey FROM beeline_key_successions
        UNION SELECT community::uuid,pubkey FROM beeline_github_installations
      ), declarations AS (SELECT DISTINCT community_id,pubkey FROM events WHERE deleted_at IS NULL AND kind=9 AND tags @> '[["t","buzz-agent"]]'::jsonb)
      SELECT encode(k.pubkey,'hex') id,NULLIF(u.display_name,'') name,u.nip05_handle handle,u.avatar_url avatar,d.pubkey IS NOT NULL agent FROM keys k LEFT JOIN users u ON u.community_id=k.community_id AND u.pubkey=k.pubkey AND u.deactivated_at IS NULL LEFT JOIN declarations d ON d.community_id=k.community_id AND d.pubkey=k.pubkey`);
    const identities: LegacyIdentity[] = identityRows.rows.map((row) => ({
      id: row.id,
      kind: row.agent ? 'agent' : 'human',
      name: row.name ?? `${row.agent ? 'Agent' : 'Person'} ${row.id.slice(0, 8)}`,
      ...(row.handle ? { handle: row.handle } : {}),
      ...(row.avatar ? { avatar: row.avatar } : {}),
    }));
    const identityById = new Map(identities.map((row) => [row.id, row]));
    const ownerByWorkspace = new Map(workspaceRows.map((row) => [row.id, row.created_by]));
    const overlayRows = await database.query<{ pubkey: string; tags: string[][]; content: string }>(
      `SELECT encode(pubkey,'hex') pubkey,tags,content FROM events WHERE deleted_at IS NULL AND kind=30078 ORDER BY created_at,id`,
    );
    const schedules: LegacySchedule[] = [];
    for (const event of overlayRows.rows) {
      const current = identityById.get(event.pubkey);
      const marker = tagValue(event.tags, 't');
      const parsed = parseObject(event.content);
      if (current?.kind === 'agent' && marker === 'buzz-agent-soul')
        current.soul = {
          name: parsed.name,
          instructions: parsed.soul ?? parsed.instructions ?? '',
          avatarSeed: parsed.avatarSeed ?? event.pubkey,
        };
      if (current?.kind === 'agent' && marker === 'buzz-agent-model-catalog') {
        current.catalog = Array.isArray(parsed.options) ? parsed.options : [];
        const selection = parseObject(parsed.selection);
        if (typeof selection.model === 'string') current.model = selection.model;
        if (typeof selection.effort === 'string') current.effort = selection.effort;
      }
      if (marker?.startsWith('buzz-work-schedule')) {
        const roomId = tagValue(event.tags, 'h');
        const scheduleId = String(parsed.scheduleId ?? tagValue(event.tags, 'd') ?? '');
        const revision = Number(parsed.revision ?? 1);
        if (roomId && scheduleId && Number.isSafeInteger(revision))
          schedules.push({ scheduleId, agentId: event.pubkey, roomId, revision, schedule: parsed });
      }
    }
    const memberRows = await database.query<{
      channel_id: string;
      identity_id: string;
      role: 'owner' | 'admin' | 'member';
      removed: boolean;
      joined_at: Date;
    }>(
      `SELECT channel_id::text,encode(pubkey,'hex') identity_id,role::text,removed_at IS NOT NULL removed,joined_at FROM channel_members`,
    );
    const memberships: LegacyMembership[] = memberRows.rows.flatMap((row) => {
      const channel = channelById.get(row.channel_id);
      if (!channel) return [];
      const workspaceId = workspaceIdFor(channel);
      return [
        {
          workspaceId,
          ...(row.channel_id === workspaceId ? {} : { roomId: row.channel_id }),
          identityId: row.identity_id,
          role: row.role,
          removed: row.removed,
          generation: Math.floor(row.joined_at.getTime() / 1000),
        },
      ];
    });
    for (const entry of identities.filter((row) => row.kind === 'agent')) {
      const workspaceMembership = memberships.find(
        (member) => !member.roomId && member.identityId === entry.id && !member.removed,
      );
      entry.ownerId = workspaceMembership
        ? (ownerByWorkspace.get(workspaceMembership.workspaceId) ?? entry.id)
        : entry.id;
    }
    const rawEvents = await database.query<{
      id: string;
      room_id: string;
      author_id: string;
      kind: number;
      tags: string[][];
      content: string;
      created_at: Date;
    }>(
      `SELECT encode(e.id,'hex') id,e.channel_id::text room_id,encode(e.pubkey,'hex') author_id,e.kind,e.tags,e.content,e.created_at FROM events e JOIN channels c ON c.community_id=e.community_id AND c.id=e.channel_id WHERE e.deleted_at IS NULL AND c.deleted_at IS NULL AND e.kind IN(9,30078) ORDER BY e.created_at,e.id`,
    );
    const events: LegacyEvent[] = rawEvents.rows.map((row) => {
      const author = identityById.get(row.author_id);
      const reply = row.tags.find((item) => item[0] === 'e' && item[3] === 'reply')?.[1];
      const explicitRoot = row.tags.find((item) => item[0] === 'e' && item[3] === 'root')?.[1];
      return {
        id: row.id,
        roomId: row.room_id,
        authorId: row.author_id,
        authorKind: author?.kind ?? 'human',
        authorName: author?.name ?? `Person ${row.author_id.slice(0, 8)}`,
        ...(author?.handle ? { authorHandle: author.handle } : {}),
        ...(author?.avatar ? { authorAvatar: author.avatar } : {}),
        kind: row.kind,
        tags: row.tags,
        content: row.content,
        createdAt: Math.floor(row.created_at.getTime() / 1000),
        rootId: explicitRoot ?? reply ?? row.id,
      };
    });
    const readMarks = await database.query<LegacyReadMark>(
      `SELECT room_id::text "roomId",encode(viewer_pubkey,'hex') "identityId",encode(message_id,'hex') "messageId",extract(epoch from message_created_at)::int "createdAt" FROM beeline_room_read_marks`,
    );
    const identityLinks = await database.query<LegacyGitHub['identityLinks'][number]>(
      `SELECT subject,encode(pubkey,'hex') "identityId",issuer,audience FROM beeline_identity_links WHERE issuer='https://github.com'`,
    );
    const identitySuccessions = await database.query<LegacyGitHub['identitySuccessions'][number]>(
      `SELECT subject,encode(old_pubkey,'hex') "oldIdentityId",encode(new_pubkey,'hex') "newIdentityId" FROM beeline_key_successions WHERE issuer='https://github.com'`,
    );
    const userTokens = await database.query<LegacyGitHub['userTokens'][number]>(
      `SELECT subject,encrypted_token "encryptedToken",stale_at::text "staleAt" FROM beeline_github_user_tokens`,
    );
    const installations = await database.query<LegacyGitHub['installations'][number]>(
      `SELECT installation_id::int "installationId",pubkey "ownerId",account_login "accountLogin",account_type "accountType" FROM beeline_github_installations`,
    );
    const repositories = await database.query<LegacyGitHub['repositories'][number]>(
      `SELECT repository_id::int "repositoryId",installation_id::int "installationId",full_name "fullName",default_branch "defaultBranch" FROM beeline_github_repositories`,
    );
    return {
      identities,
      workspaces,
      rooms,
      memberships,
      events,
      readMarks: readMarks.rows,
      schedules,
      github: {
        identityLinks: identityLinks.rows,
        identitySuccessions: identitySuccessions.rows,
        userTokens: userTokens.rows,
        installations: installations.rows,
        repositories: repositories.rows,
      },
      registry,
      media,
    };
  });
}

function tagValue(tags: readonly string[][], name: string) {
  return tags.find((tag) => tag[0] === name)?.[1];
}
function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function visibility(value: string): 'public' | 'invite-only' {
  return value === 'private' || value === 'invite-only' ? 'invite-only' : 'public';
}
