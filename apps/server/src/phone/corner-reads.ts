import { assetUrl, phoneIdentity as identity, type PhoneIdentityRow as IdentityRow } from '../phone-identity.js';
import { roomMessageTagsSql } from '../room-router-read.js';
import { workingTurnFreshSql } from '../turn-ownership.js';
import { cornerLifecycleSql } from '../corner-github-cache.js';
import { cornerObjectiveSql } from '../corner-objective.js';
import { cornerCommissionerSql } from '../corner-opening.js';
import { cornerOwnerSql } from '../corner-worker.js';
import { turnRootMessageSql } from '../agent-command.js';
import { ROOM_VIEW_AGENT_LIMIT, ROOM_VIEW_BRIEFING_LIMIT, ROOM_VIEW_MEMBER_LIMIT, ROOM_VIEW_MESSAGE_LIMIT, ROOM_VIEW_TOOL_ROW_LIMIT } from '@beeline/api-contract/phone';
import type { CornerListView, RoomView, RoomViewMessage } from '@beeline/api-contract/phone';
import { cornerFactsSql, cornerRowMine, cornerRowState, openCornerFactsSql, roomAttentionActorSql, roomNeedsYouSql, roomWorkingSql } from '../chat-corner-counts.js';
import { cornerRoomColumnsSql } from '../corner-row-projection.js';
import { cornerOwedLookupSql } from '../corner-owed.js';
import { visibleMessageSql, viewerReadCursorSql } from '../read-cursor.js';
import { mediaIdFromUrl } from '../media-ttl.js';
import type { PhoneContext } from './context.js';
import { ArchivedCornerCursor, ARCHIVED_CORNER_PAGE, OPEN_CORNER_PAGE, unix } from './values.js';
import { deckCornerSummary, DeckCornerFacts, RoomRow, CornerRow, RoomReadRow, MemberRow, AttachmentFacts, RoomReadEnrichment } from './types.js';
import { reviveDates, roomHeader, reactionIdentitiesSql, projectedMessage } from './read-projection.js';
import { phoneOptionalEnrichment } from './optional-enrichment.js';



  /**
   * The Room's corner list. `archived` swaps the live set for the closed one:
   * the phone's corners screen reads the live list on open and asks for the
   * closed list only when a reader taps the archived footer, so a Room with
   * years of finished work never pays for it on the default read. The closed
   * list comes a page at a time, newest closure first; `archivedBefore` is the
   * `nextArchived` cursor of the page before.
   */
  export async function phoneReadCorners(ctx: PhoneContext,
    roomId: string,
    viewerId: string,
    roomViewFamilyOrder = false,
    archived = false,
    archivedBefore?: ArchivedCornerCursor,
    openBefore?: ArchivedCornerCursor,
  ): Promise<CornerListView | null> {
    // The first open page carries the Room list row's summary from the same
    // snapshot, so a reader replaces its summary whole.
    const firstPage = !archived && !archivedBefore && !openBefore;
    const loaded = await phoneLoadCorners(ctx, roomId, viewerId, {
      roomViewFamilyOrder, archived, before: archivedBefore ?? openBefore, deck: firstPage,
    });
    if (!loaded) return null;
    return loaded.deck
      ? { ...loaded.view, summary: deckCornerSummary(roomId, loaded.deck) }
      : loaded.view;
  }


  /**
   * `readCorners`, and with `deck` the parent Room row's corner facts from the
   * same statement, so a live frame's list and counts share one snapshot.
   * `deck` is null when the Room is a corner or archived.
   */
  export async function phoneLoadCorners(ctx: PhoneContext,
    roomId: string,
    viewerId: string,
    {
      roomViewFamilyOrder = false,
      archived = false,
      before,
      deck = false,
    }: {
      roomViewFamilyOrder?: boolean;
      archived?: boolean;
      /** The keyset cursor of the page before, open or archived. */
      before?: ArchivedCornerCursor;
      deck?: boolean;
    } = {},
  ): Promise<{ view: CornerListView; deck: DeckCornerFacts | null } | null> {
    const cornerQuery = phoneCornerRowsSql(ctx, roomViewFamilyOrder, archived, before);
    const result = await ctx.database.query<{
      room_row: RoomRow & {
        workspace_role: 'owner' | 'admin' | 'member' | 'spectator';
      };
      corner_rows: CornerRow[];
      viewer_row: IdentityRow;
      deck: DeckCornerFacts | null;
    }>(`WITH authorized AS (
        SELECT r.*,workspace_member.role workspace_role
        FROM rooms r JOIN memberships m ON m.room_id=r.id
        JOIN memberships workspace_member ON workspace_member.workspace_id=r.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
          AND workspace_member.removed_at IS NULL
        WHERE r.id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL
      ), selected_corners AS (${cornerQuery})
      SELECT to_jsonb(authorized) room_row,
        COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY ${archived
          ? 'c.archived_at DESC,c.id DESC' : 'c.created_at DESC,c.id DESC'})
          FROM selected_corners c),'[]'::jsonb) corner_rows,
        jsonb_build_object('id',viewer.id,'kind',viewer.kind,'name',viewer.name,
          'handle',viewer.handle,'avatar',viewer.avatar,'face_id',viewer.face_id) viewer_row,
        ${deck ? `CASE WHEN authorized.parent_id IS NULL AND authorized.archived_at IS NULL
          THEN jsonb_build_object(
            'needs_you',${roomNeedsYouSql('authorized')},
            'working',${roomWorkingSql('authorized')},
            'attention_actor',${roomAttentionActorSql('authorized')},
            'corner_rows',COALESCE((SELECT jsonb_agg(to_jsonb(deck_corner)
              ORDER BY deck_corner.created_at DESC,deck_corner.id DESC)
              FROM (${openCornerFactsSql('=authorized.id', '$2')}) deck_corner),'[]'::jsonb))
          END` : 'NULL::jsonb'} deck
      FROM authorized JOIN identities viewer ON viewer.id=$2`,
      before ? [roomId, viewerId, before.micros, before.id] : [roomId, viewerId], 'phone-corners-0',
    );
    const loaded = result.rows[0];
    if (!loaded) return null;
    const room = reviveDates(loaded.room_row,
      ['created_at','updated_at','archived_at','repository_updated_at']);
    const fetched = loaded.corner_rows.map((row) => reviveDates(row,
      ['created_at','updated_at','archived_at','repository_updated_at',
        'latest_created_at','latest_turn_created_at']));
    const viewerIdentity = identity(loaded.viewer_row, ctx.publicOrigin);
    // The archived read asks for one row past the page; its presence is what
    // says another page exists.
    const pageSize = archived ? ARCHIVED_CORNER_PAGE : OPEN_CORNER_PAGE;
    const more = fetched.length > pageSize;
    const rows = more ? fetched.slice(0, pageSize) : fetched;
    const last = rows.at(-1);
    const view: CornerListView = {
      room: roomHeader(room, ctx.publicOrigin),
      corners: phoneProjectCorners(ctx, rows),
      ...(archived && more && last?.archived_us ? { nextArchived: `${last.archived_us},${last.id}` } : {}),
      ...(!archived && more && last?.created_us ? { nextOpen: `${last.created_us},${last.id}` } : {}),
      viewer: {
        identity: viewerIdentity,
        // The Workspace role: a Room, corner or DM role grants nothing.
        role: room.workspace_role,
        permissions: {
          send: room.workspace_role !== 'spectator' && !room.archived_at,
          manage: room.workspace_role === 'owner' || room.workspace_role === 'admin',
        },
      },
      watchFilters: [],
    };
    return { view, deck: loaded.deck };
  }


  /** Bound each authorized message window before identity/reaction decoration.
   * The author foreign key preserves the original inner-join membership. */
  export async function phoneRoomRows(ctx: PhoneContext, roomId: string, viewerId: string): Promise<RoomReadRow | undefined> {

    const row = (
      await ctx.database.query<RoomReadRow>(
        `WITH authorized_room AS (
           SELECT room.*,
             CASE WHEN room.parent_id IS NULL THEN membership.push_muted ELSE COALESCE(
               (SELECT state.push_muted FROM corner_person_state state
                WHERE state.corner_id=room.id AND state.identity_id=$2),false) END viewer_push_muted,
             workspace_member.role workspace_role,
             (workspace_member.role IN ('owner','admin') AND NOT EXISTS (
               SELECT 1 FROM memberships other_room
               JOIN memberships other_workspace ON other_workspace.workspace_id=room.workspace_id
                 AND other_workspace.room_id IS NULL
                 AND other_workspace.identity_id=other_room.identity_id
                 AND other_workspace.removed_at IS NULL
                 AND other_workspace.role IN ('owner','admin')
               WHERE other_room.room_id=COALESCE(room.parent_id,room.id) AND other_room.removed_at IS NULL
                 AND other_room.identity_id<>$2
             )) leave_deletes_room,
             ${('NULL::jsonb')} read_cursor
           FROM rooms room
           JOIN memberships membership ON membership.room_id=COALESCE(room.parent_id,room.id)
             AND membership.identity_id=$2 AND membership.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
             AND workspace_member.removed_at IS NULL
           WHERE room.id=$1 ${('')}
         ), member_rows AS (
           SELECT i.id,i.kind,i.name,i.handle,i.avatar,i.face_id,
             COALESCE(roster_workspace.role,roster_member.role) role,NULL::jsonb presence_body,
             NULL::timestamptz presence_updated_at
           FROM authorized_room room
           JOIN memberships roster_member ON roster_member.workspace_id=room.workspace_id
             AND roster_member.room_id=COALESCE(room.parent_id,room.id)
           LEFT JOIN memberships roster_workspace ON roster_workspace.workspace_id=room.workspace_id
             AND roster_workspace.room_id IS NULL AND roster_workspace.identity_id=roster_member.identity_id
             AND roster_workspace.removed_at IS NULL
           JOIN identities i ON i.id=roster_member.identity_id
           WHERE roster_member.removed_at IS NULL AND i.hidden_from_roster=false
           ORDER BY (i.id<>$2),i.id LIMIT (SELECT CASE WHEN parent_id IS NULL THEN 2147483647
             ELSE ${ROOM_VIEW_MEMBER_LIMIT} END FROM authorized_room)
         ), turn_rows AS (
           SELECT turn.request_id,turn.agent_id,turn.status,turn.started_at,turn.created_at,turn.generation_id,
             requester.id requested_by
           FROM authorized_room room
           CROSS JOIN LATERAL (
             SELECT DISTINCT ON(agent_id) * FROM agent_turns
             WHERE room_id=room.id AND (status<>'working' OR ${workingTurnFreshSql('agent_turns')})
             ORDER BY agent_id,(status='working') DESC,created_at DESC,request_id DESC
           ) turn
           LEFT JOIN messages trigger ON trigger.id=${turnRootMessageSql('turn')}
           LEFT JOIN identities requester ON requester.id=trigger.author_id AND requester.kind='human'
           ORDER BY turn.agent_id
         ), pending_command_rows AS (
           SELECT DISTINCT ON(command.agent_id)
             command.agent_id,command.turn_request_id,command.created_at
           FROM authorized_room room
           JOIN agent_commands command ON command.room_id=room.id
           JOIN messages source ON source.id=command.source_message_id AND source.room_id=room.id
           JOIN identities author ON author.id=source.author_id AND author.kind='human'
           WHERE command.state='pending' AND command.action='input'
             AND command.reason IN ('human_tag','direct_message')
           ORDER BY command.agent_id,command.created_at ASC,command.id ASC
           LIMIT ${ROOM_VIEW_AGENT_LIMIT}
         ), projected_turn_rows AS (
           SELECT agent_id,status,created_at FROM turn_rows
           ORDER BY date_trunc('second',created_at) DESC,agent_id ASC
           LIMIT ${ROOM_VIEW_AGENT_LIMIT}
         ), active_turn_rows AS (
           SELECT agent_id,created_at FROM projected_turn_rows WHERE status='working'
         ), transcript_rows AS (
           SELECT m.*,i.kind author_kind,i.name author_name,i.handle author_handle,
             i.avatar author_avatar,i.face_id author_face,
             ${reactionIdentitiesSql('m')} reaction_identities,
             (room.parent_id IS NULL AND EXISTS(SELECT 1 FROM message_bookmarks bookmark
               WHERE bookmark.identity_id=$2 AND bookmark.message_id=m.id)) bookmarked,
             (room.parent_id IS NULL AND EXISTS(SELECT 1 FROM feedback_items report
               WHERE report.source_kind='human' AND report.trigger_message_id=m.id)) feedback_reported,
             '{}'::text[] tagged_ids
           FROM authorized_room room
           JOIN LATERAL (
             SELECT m.* FROM messages m WHERE m.room_id=room.id
               AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
               AND ${visibleMessageSql('m')}
             ORDER BY m.created_at DESC,m.id DESC LIMIT ${ROOM_VIEW_MESSAGE_LIMIT}
           ) m ON true
           JOIN identities i ON i.id=m.author_id
         ), activity_rows AS (
           SELECT m.*,i.kind author_kind,i.name author_name,i.handle author_handle,
             i.avatar author_avatar,i.face_id author_face,
             ${reactionIdentitiesSql('m')} reaction_identities,
             (room.parent_id IS NULL AND EXISTS(SELECT 1 FROM message_bookmarks bookmark
               WHERE bookmark.identity_id=$2 AND bookmark.message_id=m.id)) bookmarked,
             (room.parent_id IS NULL AND EXISTS(SELECT 1 FROM feedback_items report
               WHERE report.source_kind='human' AND report.trigger_message_id=m.id)) feedback_reported,
             '{}'::text[] tagged_ids
           FROM authorized_room room
           JOIN LATERAL (
             SELECT m.* FROM messages m JOIN active_turn_rows turn ON turn.agent_id=m.author_id
               AND m.created_at>=date_trunc('second',turn.created_at)
             WHERE m.room_id=room.id AND m.presentation='activity' AND m.durable_fact IS NULL
               ${('')}
             ORDER BY m.created_at DESC,m.id DESC LIMIT ${ROOM_VIEW_MESSAGE_LIMIT}
           ) m ON true
           JOIN identities i ON i.id=m.author_id
         ), corner_tool_rows AS (
           SELECT m.*,i.kind author_kind,i.name author_name,i.handle author_handle,
             i.avatar author_avatar,i.face_id author_face,
             ${reactionIdentitiesSql('m')} reaction_identities,
             false bookmarked,false feedback_reported,'{}'::text[] tagged_ids
           FROM authorized_room room
           JOIN LATERAL (
             SELECT m.* FROM messages m WHERE m.room_id=room.id
               AND room.parent_id IS NOT NULL ${('')} AND m.presentation='activity'
               AND m.durable_fact IS NULL AND EXISTS(
                 SELECT 1 FROM jsonb_array_elements(m.activity) item
                 WHERE item->>'kind' IN ('tool','output'))
             ORDER BY m.created_at DESC,m.id DESC LIMIT ${ROOM_VIEW_TOOL_ROW_LIMIT}
           ) m ON true
           JOIN identities i ON i.id=m.author_id
         ), corner_briefing_rows AS (
           SELECT m.*,i.kind author_kind,i.name author_name,i.handle author_handle,
             i.avatar author_avatar,i.face_id author_face,
             ${reactionIdentitiesSql('m')} reaction_identities,
             false bookmarked,false feedback_reported,'{}'::text[] tagged_ids
           FROM authorized_room room
           JOIN LATERAL (
             SELECT m.* FROM messages m WHERE m.room_id=room.parent_id
               AND room.parent_id IS NOT NULL AND m.created_at<=room.created_at
             ORDER BY m.created_at DESC,m.id ASC LIMIT ${ROOM_VIEW_BRIEFING_LIMIT}
           ) m ON true
           JOIN identities i ON i.id=m.author_id
         )
         ${('')}
         SELECT
           EXISTS(SELECT 1 FROM starter_onboarding_runs onboarding
             WHERE onboarding.room_id=authorized_room.id AND onboarding.user_id=$2
               AND onboarding.status<>'complete') starter_onboarding_pending,
           (to_jsonb(authorized_room) - 'github_installation_id')
             || jsonb_build_object(
               'github_installation_id',authorized_room.github_installation_id::text
             ) room,
           COALESCE((SELECT jsonb_agg(to_jsonb(member_rows)) FROM member_rows),'[]'::jsonb) members,
           COALESCE((SELECT jsonb_agg(to_jsonb(turn_rows)) FROM turn_rows),'[]'::jsonb) turns,
           COALESCE((SELECT jsonb_agg(to_jsonb(pending_command_rows))
             FROM pending_command_rows),'[]'::jsonb) pending_commands,
           COALESCE((SELECT jsonb_agg(to_jsonb(transcript_rows)
             ORDER BY transcript_rows.created_at DESC,transcript_rows.id DESC)
             FROM transcript_rows),'[]'::jsonb) transcript,
           COALESCE((SELECT jsonb_agg(to_jsonb(activity_rows)
             ORDER BY activity_rows.created_at DESC,activity_rows.id DESC)
             FROM activity_rows),'[]'::jsonb) activity,
           CASE WHEN authorized_room.parent_id IS NOT NULL THEN jsonb_build_object(
             'parent',(SELECT (to_jsonb(parent) - 'github_installation_id') ||
               jsonb_build_object('github_installation_id',parent.github_installation_id::text)
               FROM rooms parent WHERE parent.id=authorized_room.parent_id),
             'facts',(SELECT (to_jsonb(f)-'objective') || jsonb_build_object('lifecycle',${cornerLifecycleSql('f.corner_id')},'objective',${cornerObjectiveSql('authorized_room')},'owner_agent_id',${cornerOwnerSql('f.corner_id')}) FROM corner_facts f WHERE f.corner_id=authorized_room.id),
             'owed',(SELECT owed.owed FROM rooms c
               ${cornerOwedLookupSql('c', '$2')} WHERE c.id=authorized_room.id),
             'brief',(SELECT to_jsonb(brief) || jsonb_build_object('approver_name',approver.name,'author_handle',brief_author.handle)
               FROM corner_brief_revisions brief
               LEFT JOIN identities approver ON approver.id=brief.approval_basis->>'approvedBy'
               LEFT JOIN identities brief_author ON brief_author.id=brief.author_id
               WHERE brief.corner_id=authorized_room.id
               ORDER BY brief.revision DESC LIMIT 1),
             'briefing',COALESCE((SELECT jsonb_agg(to_jsonb(corner_briefing_rows)
               ORDER BY corner_briefing_rows.created_at DESC,corner_briefing_rows.id ASC)
               FROM corner_briefing_rows),'[]'::jsonb),
             'tools',COALESCE((SELECT jsonb_agg(to_jsonb(corner_tool_rows)
               ORDER BY corner_tool_rows.created_at DESC,corner_tool_rows.id DESC)
               FROM corner_tool_rows),'[]'::jsonb)
           ) END corner
           ${('')}
         FROM authorized_room ${('')}`,
        ([roomId, viewerId]), 'phone-room-0',
      )
    ).rows[0];
    if (!row) return undefined;

    if ((row.corner)) {
      reviveDates(row.room, ['archived_at', 'repository_updated_at', 'created_at', 'updated_at']);
      if (row.corner?.parent)
        reviveDates(row.corner.parent, [
          'archived_at',
          'repository_updated_at',
          'created_at',
          'updated_at',
        ]);
      for (const turn of row.turns) reviveDates(turn, ['started_at', 'created_at']);
      for (const message of [
        ...row.transcript,
        ...row.activity,
        ...(row.corner?.briefing??[]),
        ...(row.corner?.tools??[]),
      ])
        reviveDates(message, ['created_at']);
      return row;
    }
    const repositoryId = row.room.repository_key?.match(/^github:(\d+)$/)?.[1];
    const [cursor, presence, tags, autoMerge] = await Promise.all([
      phoneOptionalEnrichment(ctx,
        'read-cursor',
        ctx.enrichmentDatabase.query<{
          read_cursor: NonNullable<RoomView['viewer']['readCursor']>;
        }>(`SELECT ${viewerReadCursorSql()} read_cursor FROM rooms room WHERE room.id=$1`, [
          roomId,
          viewerId,
        ], 'phone-room-1'),
      ),
      phoneOptionalEnrichment(ctx,
        'presence',
        ctx.enrichmentDatabase.query<{
          id: string;
          presence_body: MemberRow['presence_body'];
          presence_updated_at: Date | null;
        }>(
          `SELECT member.identity_id id,presence.body presence_body,
             presence.updated_at presence_updated_at
           FROM memberships member
           LEFT JOIN LATERAL(
             SELECT body,updated_at FROM live_outputs
             WHERE agent_id=member.identity_id AND kind='presence'
             ORDER BY updated_at DESC LIMIT 1
           ) presence ON true
           WHERE member.room_id=$1 AND member.removed_at IS NULL`,
          [roomId], 'phone-room-2',
        ),
      ),
      phoneOptionalEnrichment(ctx,
        'message-tags',
        ctx.enrichmentDatabase.query<{ id: string; tagged_ids: string[] }>(
          `SELECT m.id,${roomMessageTagsSql('m')} tagged_ids
           FROM messages m WHERE m.id=ANY($1::text[])`,
          [row.transcript.map((message) => message.id)], 'phone-room-3',
        ),
      ),
      repositoryId
        ? phoneOptionalEnrichment(ctx,
            'repository-auto-merge',
            ctx.enrichmentDatabase
              .query<{ allow_auto_merge: boolean | null }>(
                `SELECT allow_auto_merge FROM github_repositories WHERE repository_id=$1`,
                [repositoryId], 'phone-room-4',
              )
              .then((result) => result.rows[0]?.allow_auto_merge ?? undefined),
          )
        : Promise.resolve(undefined),
    ]);
    row.allow_auto_merge = autoMerge;
    row.room.read_cursor = cursor?.rows[0]?.read_cursor ?? null;
    const presenceByMember = new Map(presence?.rows.map((item) => [item.id, item]) ?? []);
    for (const member of row.members) {
      const item = presenceByMember.get(member.id);
      member.presence_body = item?.presence_body ?? null;
      member.presence_updated_at = item?.presence_updated_at ?? null;
    }
    const tagsByMessage = new Map(tags?.rows.map((item) => [item.id, item.tagged_ids]) ?? []);
    for (const message of row.transcript) message.tagged_ids = tagsByMessage.get(message.id) ?? [];
    reviveDates(row.room, ['archived_at', 'repository_updated_at', 'created_at', 'updated_at']);
    for (const member of row.members) reviveDates(member, ['presence_updated_at']);
    for (const turn of row.turns) reviveDates(turn, ['started_at', 'created_at']);
    for (const message of [...row.transcript, ...row.activity])
      reviveDates(message, ['created_at']);
    return row;
  }


  /** One independently failing statement for facts that do not authorize a corner read. */
  export async function phoneCornerRoomEnrichment(ctx: PhoneContext,
    room: RoomReadRow['room'],
    rows: RoomReadRow,
    messageResult: { messages: RoomViewMessage[]; toolRows: RoomViewMessage[] },
    viewerId: string,
  ): Promise<
    | {
        presence: Array<{
          id: string;
          presence_body: MemberRow['presence_body'];
          presence_updated_at: Date | null;
        }>;
        tags: Array<{ id: string; tagged_ids: string[] }>;
        bookmarks: Array<{ message_id: string }>;
        reports: Array<{ trigger_message_id: string }>;
        attachmentFacts: AttachmentFacts;
        allow_auto_merge: boolean | null;
      }
    | undefined
  > {
    const messageIds = [
      ...new Set([...rows.transcript, ...rows.corner!.briefing].map((message) => message.id)),
    ];
    const visibleIds = [
      ...new Set(
        [...rows.transcript, ...rows.activity, ...rows.corner!.tools].map((message) => message.id),
      ),
    ];
    const mediaIds = new Set<string>();
    for (const message of [
      ...messageResult.messages,
      ...messageResult.toolRows,
      ...rows.corner!.briefing.map((row) => projectedMessage(row, ctx.publicOrigin)),
    ]) {
      for (const attachment of message.attachments ?? []) {
        const id = mediaIdFromUrl(attachment.url);
        if (id) mediaIds.add(id);
      }
    }
    const repositoryId =
      (rows.corner?.parent ?? room).repository_key?.match(/^github:(\d+)$/)?.[1] ?? null;
    const result = await phoneOptionalEnrichment(ctx,
      'corner-room',
      ctx.enrichmentDatabase.query<{
        presence: Array<{
          id: string;
          presence_body: MemberRow['presence_body'];
          presence_updated_at: Date | null;
        }>;
        tags: Array<{ id: string; tagged_ids: string[] }>;
        bookmarks: Array<{ message_id: string }>;
        reports: Array<{ trigger_message_id: string }>;
        expired: Array<{ id: string }>;
        objects: Array<{ id: string; title: string; mime: string; size: string; author: string }>;
        allow_auto_merge: boolean | null;
      }>(
        `SELECT
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id',member.identity_id,
             'presence_body',presence.body,'presence_updated_at',presence.updated_at))
             FROM memberships member LEFT JOIN LATERAL(
               SELECT body,updated_at FROM live_outputs
               WHERE agent_id=member.identity_id AND kind='presence'
               ORDER BY updated_at DESC LIMIT 1) presence ON true
             WHERE member.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=$1)
               AND member.removed_at IS NULL
               AND member.identity_id=ANY($3::text[])),'[]'::jsonb) presence,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,
             'tagged_ids',${roomMessageTagsSql('m')}))
             FROM messages m WHERE m.id=ANY($4::text[])),'[]'::jsonb) tags,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('message_id',message_id))
             FROM message_bookmarks WHERE identity_id=$2
               AND message_id=ANY($5::text[])),'[]'::jsonb) bookmarks,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('trigger_message_id',trigger_message_id))
             FROM feedback_items WHERE source_kind='human'
               AND trigger_message_id=ANY($5::text[])),'[]'::jsonb) reports,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id::text))
             FROM object_expirations WHERE id=ANY($6::uuid[])),'[]'::jsonb) expired,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id::text,
             'title',COALESCE(o.title,''),'mime',o.mime,'size',o.size::text,
             'author',COALESCE(i.handle,i.name)))
             FROM objects o JOIN identities i ON i.id=o.owner_id
             WHERE o.state='ready' AND o.id=ANY($6::uuid[])),'[]'::jsonb) objects,
           (SELECT allow_auto_merge FROM github_repositories WHERE repository_id=$7) allow_auto_merge`,
        [
          room.id,
          viewerId,
          rows.members.map((member) => member.id),
          messageIds,
          visibleIds,
          [...mediaIds],
          repositoryId,
        ], 'phone-room-enrichment-0',
      ),
    );
    const value = result?.rows[0];
    if (!value) return undefined;
    return phoneProjectRoomEnrichment(ctx, value);
  }


  export function phoneProjectRoomEnrichment(ctx: PhoneContext, value:RoomReadEnrichment){
    for (const member of value.presence) reviveDates(member, ['presence_updated_at']);
    return {
      ...value,
      attachmentFacts: {
        expired: new Set(value.expired.map((item) => item.id)),
        artifacts: new Map(
          value.objects.map((item) => [
            item.id,
            {
              kind: 'artifact' as const,
              title: item.title,
              mimeType: item.mime,
              size: Number(item.size),
              author: item.author,
            },
          ]),
        ),
      },
    };
  }


  export function phoneCornerRowsSql(ctx: PhoneContext,
    roomViewFamilyOrder = false,
    archived = false,
    before?: ArchivedCornerCursor,
  ): string {
    // The archived list is ordered by when work CLOSED, not when it opened: a
    // corner opened first can close last, and a reader looking for what just
    // finished expects it at the top.
    const order = archived
      ? 'ORDER BY c.archived_at DESC,c.id DESC'
      : roomViewFamilyOrder
        ? ''
        : 'ORDER BY c.created_at DESC,c.id DESC';
    // Keyset paging on the same (archived_at, id) order, compared in exact
    // microseconds, so no row is skipped or repeated between pages.
    const archivedMicros = '(extract(epoch FROM c.archived_at)*1000000)::bigint';
    const createdMicros = '(extract(epoch FROM c.created_at)*1000000)::bigint';
    const keyset =
      before ? `AND (${archived ? archivedMicros : createdMicros},c.id) < ($3::bigint,$4::uuid)` : '';
    const limit = `LIMIT ${(archived ? ARCHIVED_CORNER_PAGE : OPEN_CORNER_PAGE) + 1}`;
    const facts = cornerFactsSql('$2');
    return `
      SELECT ${cornerRoomColumnsSql},${facts.columns},${cornerObjectiveSql('c')} objective,lm.id latest_id,lm.text latest_text,lm.author_id latest_author_id,
        initiator.id initiator_id,initiator.name initiator_name,
        initiator.handle initiator_handle,initiator.avatar initiator_avatar,
        initiator.face_id initiator_face,
        li.kind latest_author_kind,li.name latest_author_name,agent.identity_id agent_id,
        agent.name agent_name,agent.handle agent_handle,agent.avatar agent_avatar,
        ${archivedMicros}::text archived_us,
        ${createdMicros}::text created_us,
        (SELECT max(brief.revision) FROM corner_brief_revisions brief WHERE brief.corner_id=c.id) brief_revision
      FROM rooms c ${facts.joins}
      LEFT JOIN identities initiator
        ON initiator.id=${cornerCommissionerSql('c.id')} AND initiator.kind='human'
      LEFT JOIN identities li ON li.id=lm.author_id
      LEFT JOIN LATERAL (
        SELECT i.id identity_id,
          i.name,i.handle,i.avatar
        FROM identities i
        LEFT JOIN memberships member ON member.room_id=c.id AND member.identity_id=i.id
          AND member.removed_at IS NULL
        WHERE i.id=${cornerOwnerSql('c.id')}
          AND i.kind='agent' LIMIT 1
      ) agent ON true
      WHERE c.parent_id=$1 AND c.archived_at IS ${archived ? 'NOT NULL' : 'NULL'} AND ${facts.member}
        AND EXISTS (SELECT 1 FROM authorized) ${keyset} ${order} ${limit}`;
  }


  export function phoneProjectCorners(ctx: PhoneContext, rows: readonly CornerRow[]): CornerListView['corners'] {
    return rows.map((corner) => {
      const lifecycle = corner.lifecycle ?? {
        lifecycle: corner.archived_at ? 'done' : 'unknown',
        checks: 'unknown',
      };
      const hasLiveWorkingTurn = corner.latest_turn_status === 'working';
      const derived = cornerRowState({ ...corner, lifecycle });
      const header = roomHeader(corner, ctx.publicOrigin);
      const about = corner.objective?.trim() || header.about;
      return {
        corner: about ? { ...header, about } : header,
        lifecycle,
        ...derived,
        stateAt:
          hasLiveWorkingTurn && corner.latest_turn_created_at
            ? unix(corner.latest_turn_created_at)
            : unix(corner.updated_at),
        // `updated_at` moves with any later write, so the closure stamp reads
        // the archive time itself rather than the row's last touch.
        ...(corner.archived_at ? { closedAt: unix(corner.archived_at) } : {}),
        ...(cornerRowMine(corner) ? { mine: true as const } : {}),
        ...(corner.initiator_id && corner.initiator_name
          ? {
              initiator: {
                pubkey: corner.initiator_id,
                kind: 'human' as const,
                name: corner.initiator_name,
                ...(corner.initiator_handle ? { handle: corner.initiator_handle } : {}),
                ...(corner.initiator_avatar
                  ? { avatar: assetUrl(corner.initiator_avatar, ctx.publicOrigin) }
                  : {}),
                ...(corner.initiator_face ? { face: corner.initiator_face } : {}),
              },
            }
          : {}),
        ...(corner.agent_id && corner.agent_name
          ? {
              agent: {
                pubkey: corner.agent_id,
                kind: 'agent' as const,
                name: corner.agent_name,
                ...(corner.agent_handle ? { handle: corner.agent_handle } : {}),
                ...(corner.agent_avatar
                  ? { avatar: assetUrl(corner.agent_avatar, ctx.publicOrigin) }
                  : {}),
              },
            }
          : {}),
        ...(corner.brief_revision !== null ? { briefRevision: corner.brief_revision } : {}),
        ...(corner.latest_id &&
        corner.latest_created_at &&
        corner.latest_author_id &&
        corner.latest_author_kind &&
        corner.latest_author_name
          ? {
              latestMessage: {
                id: corner.latest_id,
                text: corner.latest_text ?? '',
                createdAt: unix(corner.latest_created_at),
                author: {
                  pubkey: corner.latest_author_id,
                  kind: corner.latest_author_kind,
                  name: corner.latest_author_name,
                },
              },
            }
          : {}),
      };
    });
  }
