import { AGENT_SIGN_IN_TABLE, USAGE_REFRESH_TABLE, USAGE_REFRESH_RESULT_TABLE, MCP_WEBHOOK_TABLE } from './postgres-live-notifications.js';
import { COMMAND_COMPLETION_CHANNEL, POSTGRES_LIVE_CHANNEL } from './postgres-live-notifications.js';
import type { UsageRefreshOutcome } from '@beeline/api-contract/daemon';
import type { AgentSignInStep } from './agent-sign-in.js';
import type { SqlDatabase } from './database.js';
export { PostgresLiveListener } from './postgres-live-decode-payload.js';



export { POSTGRES_LIVE_CHANNEL } from './postgres-live-notifications.js';


export function committedCommandNotificationSchema(): string {
  return `CREATE OR REPLACE FUNCTION beeline_notify_committed_command(payload text) RETURNS void
    LANGUAGE sql AS $$ SELECT pg_notify('beeline_command_completion',payload) $$;`;
}

export function liveControlNotificationSchema(): string {
  return `CREATE OR REPLACE FUNCTION beeline_notify_live_control(payload text) RETURNS void
    LANGUAGE sql AS $$ SELECT pg_notify('beeline_live_v1',payload) $$;`;
}


/** A command's SQL transaction owns completion; local callbacks are only hints. */
export async function notifyCommittedCommand(database: Pick<SqlDatabase, 'query'>,
  key: { principal: string; operation: string; commandId: string }): Promise<void> {
  await database.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, JSON.stringify(key)]);
}


/** Registration/takeover evidence carries no user-state projection or command
 * authority. The existing listener decodes this named agent_connection hint. */
export async function notifyAgentConnection(database: Pick<SqlDatabase, 'query'>,
  agentId: string, epoch: number): Promise<void> {
  await database.query('SELECT pg_notify($1,$2)', [POSTGRES_LIVE_CHANNEL,
    JSON.stringify({ table: 'agent_connection', operation: 'UPDATE', roomId: '', agentId, epoch })]);
}


export const PARENT_ONLY_TABLES: ReadonlySet<string> = new Set([
  'corner_owed', 'corner_follows', 'corner_merge_holds',
]);

export const PARENT_ONLY_SQL = [...PARENT_ONLY_TABLES].map((table) => `'${table}'`).join(',');


/** Publish only committed state; callers pass their current transaction. */
export type PublishedNotification = LiveNotificationPayload
  | (AgentSignInStep & Pick<LiveNotificationPayload, 'table' | 'operation' | 'roomId'>)
  | (LiveNotificationPayload & { outcome: UsageRefreshOutcome });


export async function notifyLive(
  database: Pick<SqlDatabase, 'query'>,
  payload: PublishedNotification,
): Promise<void> {
  await database.query('SELECT pg_notify($1,$2)', [POSTGRES_LIVE_CHANNEL, JSON.stringify(payload)]);
}


export function notifyMcpWebhook(database: Pick<SqlDatabase, 'query'>, roomId: string) {
  return notifyLive(database, { table: MCP_WEBHOOK_TABLE, operation: 'INSERT', roomId });
}

export function notifySentryWake(database: Pick<SqlDatabase, 'query'>) {
  return notifyLive(database, { table: 'sentry_wake_state', operation: 'UPDATE', roomId: '' });
}

export function notifyConnectorDiscovery(database: Pick<SqlDatabase, 'query'>, ownerId: string) {
  return notifyLive(database, { table: 'connector_discovery_cache', operation: 'UPDATE', roomId: '', ownerId });
}

export function notifyAgentSignIn(database: Pick<SqlDatabase, 'query'>, event: AgentSignInStep) {
  return notifyLive(database, { table: AGENT_SIGN_IN_TABLE, operation: 'UPDATE', roomId: '', ...event });
}

export function publishUsageRefreshResult(database: Pick<SqlDatabase, 'query'>, agentId: string,
  outcome: UsageRefreshOutcome, requestId?: string) {
  return notifyLive(database, { table: USAGE_REFRESH_RESULT_TABLE, operation: 'UPDATE', roomId: '', agentId,
    outcome, ...(requestId ? { requestId } : {}) });
}

export function notifyUsageRefreshRequest(database: Pick<SqlDatabase, 'query'>, agentId: string, requestId: string) {
  return notifyLive(database, { table: USAGE_REFRESH_TABLE, operation: 'UPDATE', roomId: '', agentId, requestId });
}

export function notifyAgentConfigRoom(database: Pick<SqlDatabase, 'query'>, roomId: string, agentId: string) {
  return notifyLive(database, { table: 'agent_config', operation: 'UPDATE', roomId, agentId });
}


/** SQL expressions keep notification and its source write in the same statement. */
export function notifyCornerStateSql(room: 'NEW.room_id' | 'corner'): string {
  return `pg_notify('${POSTGRES_LIVE_CHANNEL}',json_build_object('table','corner_state','operation','UPDATE','roomId',${room})::text)`;
}

export function notifyDeadlineNoticesSql(): string {
  return 'count(pg_notify($5,payload::text))';
}

export function notifyMcpWakesSql(channel: string): string {
  return `count(pg_notify(${channel}, jsonb_build_object(
        'table','${MCP_WEBHOOK_TABLE}','operation','INSERT','roomId',room_id::text)::text))`;
}


/** Agent-directed Connect / pending_ops wake. Never a catalog or availability. */
export async function notifyConnectorAssignment(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
): Promise<void> {
  await database.query(`SELECT pg_notify($1, $2)`, [
    POSTGRES_LIVE_CHANNEL,
    JSON.stringify({
      table: 'connector_assignment',
      operation: 'UPDATE',
      roomId: '',
      agentId,
    }),
  ]);
}


export async function notifyConnectorHelper(
  database: Pick<SqlDatabase, 'query'>,
  connectorId: string,
): Promise<void> {
  const row = (
    await database.query<{ helper_agent_id: string | null }>(
      `SELECT helper_agent_id FROM workspace_connectors WHERE id=$1::uuid`,
      [connectorId],
    )
  ).rows[0];
  if (row?.helper_agent_id) await notifyConnectorAssignment(database, row.helper_agent_id);
}


/**
 * Hot-restart wake: every daemon live subscription of these Rooms filters on
 * the target agent, so idle retained sessions retire and the next turn
 * cold-activates against the current MCP set.
 */
export async function notifyAgentConfigChange(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
  workspaceId?: string,
): Promise<void> {
  const rooms = await database.query<{ room_id: string }>(
    workspaceId
      ? `SELECT membership.room_id FROM room_access membership
         JOIN rooms room ON room.id=membership.room_id
         WHERE membership.identity_id=$1 AND membership.workspace_id=$2
           AND membership.removed_at IS NULL AND room.archived_at IS NULL`
      : `SELECT membership.room_id FROM room_access membership
         JOIN rooms room ON room.id=membership.room_id
         WHERE membership.identity_id=$1
           AND membership.removed_at IS NULL AND room.archived_at IS NULL`,
    workspaceId ? [agentId, workspaceId] : [agentId],
  );
  for (const room of rooms.rows) {
    await database.query(`SELECT pg_notify($1, $2)`, [
      POSTGRES_LIVE_CHANNEL,
      JSON.stringify({
        table: 'agent_config',
        operation: 'UPDATE',
        roomId: room.room_id,
        agentId,
      }),
    ]);
  }
}


/** Build after module initialization; notifier callers must not initialize dependent schemas. */
export async function postgresLiveSchema(): Promise<string> {
  const [{ cornerOwnerSql }, { askSql }, { COMMITTED_JOURNAL_SCHEMA },
    { CORNER_ROW_CACHE_COLUMNS, CORNER_ROW_FACT_COLUMNS, CORNER_ROW_MESSAGE_COLUMNS, CORNER_ROW_ROOM_COLUMNS, rowChangedSql }] = await Promise.all([
      import('./corner-worker.js'), import('./needs-you.js'), import('./committed-journal-schema.js'), import('./corner-row-projection.js'),
    ]);
  return `
${COMMITTED_JOURNAL_SCHEMA}
CREATE OR REPLACE FUNCTION beeline_notify_live() RETURNS trigger AS $$
DECLARE
  payload jsonb;
  workspace text;
  workspace_target text;
  workspace_scopes text[];
  previous_room text;
  source_room text;
  parent_room text;
  body jsonb;
  streams text[] := ARRAY[]::text[];
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'messages' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'messageId', COALESCE(NEW.id, OLD.id),
        'workflowRunsChanged', COALESCE(NEW.card_type='workflow-handoff',false) OR COALESCE(OLD.card_type='workflow-handoff',false),
        'agentId', COALESCE(NEW.author_id, OLD.author_id),
        'needsYouCandidate', COALESCE(NEW.presentation,OLD.presentation) IN ('card','system')
          OR (COALESCE(NEW.presentation,OLD.presentation)='message' AND
            ${askSql('COALESCE(NEW.text,OLD.text)')}),
        -- The newest chat message is a column of the parent's corner row, and
        -- a corner's newest handoff card is its run state.
        'cornerParentId', CASE WHEN ((NEW.presentation IN ('message','system')
            OR OLD.presentation IN ('message','system'))
            AND ${rowChangedSql(CORNER_ROW_MESSAGE_COLUMNS)})
            OR (TG_OP = 'INSERT' AND NEW.card_type = 'corner-workflow-handoff')
          THEN (SELECT parent_id FROM rooms WHERE id = COALESCE(NEW.room_id, OLD.room_id)) END
      );
    WHEN 'room_read_marks' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'identityId', COALESCE(NEW.identity_id, OLD.identity_id)
      );
    WHEN 'message_bookmarks' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '',
        'identityId', COALESCE(NEW.identity_id, OLD.identity_id),
        'workspaceId', COALESCE(NEW.workspace_id, OLD.workspace_id),
        'messageId', COALESCE(NEW.message_id, OLD.message_id)
      );
    WHEN 'needs_you_marks' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '',
        'identityId', COALESCE(NEW.identity_id, OLD.identity_id),
        'workspaceId', COALESCE(NEW.workspace_id, OLD.workspace_id),
        'sourceRoomId', (SELECT room_id FROM messages
          WHERE id=COALESCE(NEW.message_id, OLD.message_id))
      );
    WHEN 'live_outputs' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'turnId', COALESCE(NEW.turn_id, OLD.turn_id),
        'kind', COALESCE(NEW.kind, OLD.kind)
      );
    WHEN 'agent_commands' THEN
      -- A command for a corner this agent's helper has never watched carries
      -- its own parent Room and opener, exactly as a membership push does, so
      -- the agent-wide wake can start that corner's intake directly instead
      -- of waiting for the next discovery reconciliation.
      -- A claimed command that ends releases the corner: a review wake held
      -- while this agent worked becomes deliverable with no write of its own.
      payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id), 'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'cornerTextChanged', COALESCE(NEW.reason,OLD.reason)='corner_objective'
          AND NOT EXISTS(SELECT 1 FROM corner_brief_revisions WHERE corner_id=COALESCE(NEW.room_id,OLD.room_id))
          AND CASE WHEN TG_OP='INSERT' THEN true WHEN TG_OP='UPDATE'
            THEN NEW.private_payload->>'objective' IS DISTINCT FROM OLD.private_payload->>'objective' ELSE false END,
        'cornerParentId', CASE WHEN ${rowChangedSql(['state','agent_id','room_id','action'])}
          OR (COALESCE(NEW.reason,OLD.reason)='corner_objective' AND ${rowChangedSql(['private_payload'])})
          THEN (SELECT parent_id FROM rooms WHERE id=COALESCE(NEW.room_id,OLD.room_id)) END,
        'released', CASE
          WHEN TG_OP = 'UPDATE' THEN OLD.state = 'claimed' AND NEW.state <> 'claimed'
          WHEN TG_OP = 'DELETE' THEN OLD.state = 'claimed'
          ELSE false END)
        || COALESCE((
          SELECT jsonb_build_object(
            'parentRoomId', room.parent_id,
            'openedBy', CASE WHEN room.parent_id IS NOT NULL THEN COALESCE(
              ${cornerOwnerSql('room.id')},
              room.created_by
            ) END
          )
          FROM rooms room WHERE room.id = COALESCE(NEW.room_id, OLD.room_id)
        ), '{}'::jsonb);
    WHEN 'agent_turns' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'requestId', COALESCE(NEW.request_id, OLD.request_id),
        'turnStatus', COALESCE(NEW.status, OLD.status),
        'cornerParentId', CASE WHEN TG_OP <> 'UPDATE' OR NEW.status IS DISTINCT FROM OLD.status
          THEN (SELECT parent_id FROM rooms WHERE id = COALESCE(NEW.room_id, OLD.room_id)) END
      );
    WHEN 'rooms' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.id, OLD.id),
        'closeRequested', COALESCE(NEW.parent_id,OLD.parent_id) IS NOT NULL AND
          CASE WHEN TG_OP='DELETE' THEN OLD.archived_at IS NOT NULL ELSE NEW.archived_at IS NOT NULL END,
        'cornerTextChanged', CASE WHEN TG_OP = 'UPDATE' THEN NEW.name IS DISTINCT FROM OLD.name ELSE false END,
        'repositoryChanged', CASE WHEN TG_OP = 'UPDATE' THEN
          ROW(NEW.repository_key,NEW.repository_remote,NEW.repository_target_branch,
              NEW.repository_resolution,NEW.github_installation_id)
          IS DISTINCT FROM
          ROW(OLD.repository_key,OLD.repository_remote,OLD.repository_target_branch,
              OLD.repository_resolution,OLD.github_installation_id)
          ELSE false END,
        'cornerParentId', CASE WHEN ${rowChangedSql(CORNER_ROW_ROOM_COLUMNS)}
          THEN COALESCE(NEW.parent_id, OLD.parent_id) END
      );
    WHEN 'github_installations' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '',
        'installationId', COALESCE(NEW.installation_id,OLD.installation_id)
      );
    WHEN 'workspace_connectors' THEN
      payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', '', 'ownerId', COALESCE(NEW.owner_identity_id,OLD.owner_identity_id),
        'resourceId', COALESCE(NEW.id,OLD.id));
    WHEN 'workspace_connections' THEN
      payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', '', 'ownerId', COALESCE(NEW.owner_identity_id,OLD.owner_identity_id));
    WHEN 'wallet_bindings' THEN
      payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', '', 'ownerId', COALESCE(NEW.identity_id,OLD.identity_id));
    WHEN 'free_agent_usage' THEN
      payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', '', 'ownerId', COALESCE(NEW.owner_id,OLD.owner_id));
    WHEN 'usage_accounts' THEN
      IF TG_OP='UPDATE' AND NEW.usage IS NOT DISTINCT FROM OLD.usage
        AND to_jsonb(NEW)->'revision' IS NOT DISTINCT FROM to_jsonb(OLD)->'revision' THEN RETURN NULL;END IF;
      payload=jsonb_build_object('table',TG_TABLE_NAME,'operation',TG_OP,'roomId','',
        'ownerId',COALESCE(NEW.owner_id,OLD.owner_id),'accountId',COALESCE(NEW.id,OLD.id)::text);
    WHEN 'agents' THEN
      payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', '', 'ownerId', COALESCE(NEW.owner_id,OLD.owner_id),
        'resourceId', COALESCE(NEW.agent_id,OLD.agent_id),
        'usageOnly',CASE WHEN TG_OP='UPDATE' THEN
          (to_jsonb(NEW)-ARRAY['usage_snapshot','usage_account_id','usage_owner_id','updated_at']) IS NOT DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['usage_snapshot','usage_account_id','usage_owner_id','updated_at'])
          AND (to_jsonb(NEW)->'usage_snapshot' IS DISTINCT FROM to_jsonb(OLD)->'usage_snapshot'
            OR to_jsonb(NEW)->'usage_account_id' IS DISTINCT FROM to_jsonb(OLD)->'usage_account_id'
            OR to_jsonb(NEW)->'usage_owner_id' IS DISTINCT FROM to_jsonb(OLD)->'usage_owner_id') ELSE false END,
        'squireReportChanged', CASE WHEN TG_OP='UPDATE' THEN
          NEW.squire_report IS DISTINCT FROM OLD.squire_report ELSE false END,
        'squireWorkChanged', CASE WHEN TG_OP='UPDATE' THEN
          NEW.squire_work IS DISTINCT FROM OLD.squire_work ELSE false END,
        'squireAddress', 'squire:' || COALESCE(NEW.machine_id,OLD.machine_id,NEW.agent_id,OLD.agent_id),
        'version', CASE WHEN TG_OP='DELETE' THEN NULL ELSE
          floor(extract(epoch FROM NEW.updated_at)*1000000)::bigint::text END);
    WHEN 'agent_avatars' THEN
      payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', '',
        'ownerId', (SELECT owner_id FROM agents WHERE agent_id=COALESCE(NEW.agent_id,OLD.agent_id)),
        'resourceId', COALESCE(NEW.agent_id,OLD.agent_id));
    WHEN 'github_repositories' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '',
        'repositoryId', COALESCE(NEW.repository_id,OLD.repository_id)
      );
    WHEN 'registry_mcp_oauth_attempts' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '',
        'registryState', COALESCE(NEW.state,OLD.state),
        'registryConnectorId', COALESCE(NEW.connector_id,OLD.connector_id),
        'registryDueAt', CASE WHEN TG_OP = 'DELETE' OR NEW.code IS NOT NULL THEN NULL
          ELSE floor(extract(epoch FROM NEW.expires_at) * 1000)::bigint END
      );
    WHEN 'corner_person_state' THEN
      payload = jsonb_build_object('table','memberships','operation',TG_OP,
        'roomId',COALESCE(NEW.corner_id,OLD.corner_id),
        'identityId',COALESCE(NEW.identity_id,OLD.identity_id),'removed',false)
        || COALESCE((SELECT jsonb_build_object('parentRoomId',room.parent_id,
          'cornerParentId',room.parent_id,'archived',room.archived_at IS NOT NULL,
          'openedBy',COALESCE(${cornerOwnerSql('room.id')},room.created_by))
          FROM rooms room WHERE room.id=COALESCE(NEW.corner_id,OLD.corner_id)),'{}'::jsonb);
    WHEN 'memberships' THEN
      -- Removing legacy copied rows changes no inherited authority or live session.
      IF EXISTS(SELECT 1 FROM rooms WHERE id=COALESCE(NEW.room_id,OLD.room_id) AND parent_id IS NOT NULL) THEN
        RETURN NULL;
      END IF;
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id::text, OLD.room_id::text, ''),
        'identityId', COALESCE(NEW.identity_id, OLD.identity_id),
        'workspaceId', COALESCE(NEW.workspace_id, OLD.workspace_id),
        'removed', CASE
          WHEN TG_OP = 'DELETE' THEN true
          ELSE COALESCE(NEW.removed_at IS NOT NULL, false)
        END
      ) || COALESCE((
        SELECT jsonb_build_object(
          'parentRoomId', room.parent_id,
          'cornerParentId', CASE WHEN TG_OP <> 'UPDATE' OR NEW.removed_at IS DISTINCT FROM OLD.removed_at
            THEN room.parent_id END,
          'archived', room.archived_at IS NOT NULL,
          'openedBy', CASE WHEN room.parent_id IS NOT NULL THEN COALESCE(
            ${cornerOwnerSql('room.id')},
            room.created_by
          ) END
        )
        FROM rooms room WHERE room.id = COALESCE(NEW.room_id, OLD.room_id)
      ), '{}'::jsonb);
    WHEN 'corner_facts' THEN
      -- A lifecycle-only change is the cache mirror; corner_github_cache notifies it.
      -- This test goes with the mirror and the corner_facts.lifecycle column.
      IF TG_OP = 'UPDATE' AND NEW.lifecycle IS DISTINCT FROM OLD.lifecycle
        AND (NEW.locked,NEW.reviewer_agent_id) IS NOT DISTINCT FROM (OLD.locked,OLD.reviewer_agent_id) THEN
        RETURN NULL;
      END IF;
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.corner_id, OLD.corner_id),
        'cornerId', COALESCE(NEW.corner_id, OLD.corner_id),
        'closeRequested', COALESCE((SELECT archived_at IS NOT NULL FROM rooms
          WHERE id=COALESCE(NEW.corner_id,OLD.corner_id)),false),
        'cornerParentId', CASE WHEN ${rowChangedSql(CORNER_ROW_FACT_COLUMNS)}
          THEN (SELECT parent_id FROM rooms WHERE id = COALESCE(NEW.corner_id, OLD.corner_id)) END
      );
    WHEN 'corner_github_cache' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', NEW.corner_id,
        'cornerId', NEW.corner_id,
        'closeRequested', COALESCE((SELECT archived_at IS NOT NULL FROM rooms WHERE id=NEW.corner_id),false),
        'cornerParentId', CASE WHEN ${rowChangedSql(CORNER_ROW_CACHE_COLUMNS)}
          THEN (SELECT parent_id FROM rooms WHERE id = NEW.corner_id) END
      );
    WHEN 'corner_brief_revisions' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.corner_id, OLD.corner_id),
        'cornerTextChanged', CASE WHEN TG_OP='DELETE' THEN false ELSE
          NEW.revision=(SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=NEW.corner_id)
          AND CASE WHEN TG_OP='INSERT' THEN true ELSE NEW.objective IS DISTINCT FROM OLD.objective END END,
        'cornerParentId', (SELECT parent_id FROM rooms WHERE id=COALESCE(NEW.corner_id,OLD.corner_id))
      );
    WHEN ${PARENT_ONLY_SQL} THEN
      -- Equal payloads collapse an owed refresh into one transaction notification.
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', 'UPDATE',
        'roomId', COALESCE(NEW.corner_id, OLD.corner_id),
        'cornerParentId', (SELECT parent_id FROM rooms
          WHERE id = COALESCE(NEW.corner_id, OLD.corner_id))
      );
    WHEN 'permission_authority' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.principal_id, OLD.principal_id),
        'permissionId', COALESCE(NEW.permission_id, OLD.permission_id),
        'cornerParentId', CASE WHEN TG_OP <> 'UPDATE' OR NEW.status IS DISTINCT FROM OLD.status
          THEN (SELECT parent_id FROM rooms WHERE id = COALESCE(NEW.room_id, OLD.room_id)) END
      );
    WHEN 'agent_grants' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'grantId', COALESCE(NEW.id, OLD.id)
      );
    WHEN 'agent_schedules', 'agent_subscriptions' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'scheduleId', COALESCE(NEW.id, OLD.id),
        'cornerParentId', (SELECT parent_id FROM rooms WHERE id=COALESCE(NEW.room_id,OLD.room_id))
      );
    WHEN 'workspaces' THEN
      -- Only the header every rail, list and settings page paints.
      IF TG_OP = 'UPDATE' AND ROW(NEW.name,NEW.avatar) IS DISTINCT FROM ROW(OLD.name,OLD.avatar) THEN
        payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
          'roomId', '', 'workspaceId', NEW.id);
      END IF;
    WHEN 'identities' THEN
      -- The public identity (name, handle, picture, face) and the owner's push level.
      -- A push level change alone is the owner's own setting, so only they hear it.
      IF TG_OP = 'UPDATE' AND ROW(NEW.name,NEW.handle,NEW.avatar,NEW.face_id,NEW.push_level,NEW.speaking_speed)
          IS DISTINCT FROM ROW(OLD.name,OLD.handle,OLD.avatar,OLD.face_id,OLD.push_level,OLD.speaking_speed) THEN
        payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
          'roomId', '', 'identityId', NEW.id,
          'ownerOnly', ROW(NEW.name,NEW.handle,NEW.avatar,NEW.face_id)
            IS NOT DISTINCT FROM ROW(OLD.name,OLD.handle,OLD.avatar,OLD.face_id));
      END IF;
    WHEN 'push_devices' THEN
      payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '');
    WHEN 'workspace_join_notifications' THEN
      payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '');
    WHEN 'helper_release_notifications' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '',
        'releaseVersion', NEW.version, 'releaseSha', NEW.sha
      );
  END CASE;
  -- A section clear can touch hundreds of marks in one transaction. Equal
  -- room/reader payloads let PostgreSQL collapse them into one notification.
  IF TG_TABLE_NAME IN ('needs_you_marks', ${PARENT_ONLY_SQL}) THEN
    payload = payload || jsonb_build_object(
      'traceId', md5(txid_current()::text || payload::text),
      'databaseAt', floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
    );
  ELSE
    payload = payload || jsonb_build_object(
      'traceId', md5(random()::text || clock_timestamp()::text || txid_current()::text),
      'databaseAt', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
    );
  END IF;
  IF payload->>'roomId' IS NOT NULL THEN
    -- Workspace first, then Room and parent: the same lock order for every
    -- writer. Deleted Rooms retain their workspace in OLD.
    source_room := NULLIF(payload->>'roomId','');
    parent_room := NULLIF(payload->>'cornerParentId','');
    workspace := COALESCE(payload->>'workspaceId',
      (SELECT workspace_id::text FROM rooms WHERE id=source_room::uuid));
    IF TG_TABLE_NAME IN ('rooms','memberships','workspaces') THEN
      workspace := COALESCE(workspace,
        to_jsonb(NEW)->>'workspace_id',to_jsonb(OLD)->>'workspace_id');
      IF TG_TABLE_NAME='workspaces' THEN workspace := COALESCE(NEW.id,OLD.id)::text; END IF;
    END IF;
    PERFORM pg_notify('${POSTGRES_LIVE_CHANNEL}', payload::text);
  END IF;
  IF TG_TABLE_NAME='agent_commands' THEN
    IF COALESCE(NEW.avatar_job,OLD.avatar_job,false) THEN
      PERFORM pg_notify('${POSTGRES_LIVE_CHANNEL}', jsonb_build_object(
        'table','avatar_job','operation',TG_OP,'roomId','',
        'ownerId',(SELECT owner_id FROM agents WHERE agent_id=COALESCE(NEW.agent_id,OLD.agent_id)),
        'resourceId',COALESCE(NEW.agent_id,OLD.agent_id))::text);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The cache row is created and deleted with corner_facts, which notifies those.
DROP TRIGGER IF EXISTS beeline_notify_live_corner_github_cache ON corner_github_cache;
CREATE TRIGGER beeline_notify_live_corner_github_cache AFTER UPDATE ON corner_github_cache
  FOR EACH ROW EXECUTE FUNCTION beeline_notify_live();

-- Memory jobs no longer exist as work, so their rows no longer wake anyone.
DROP TRIGGER IF EXISTS beeline_notify_live_institutional_memory_jobs ON institutional_memory_jobs;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'messages', 'live_outputs', 'agent_turns', 'rooms', 'memberships', 'corner_person_state',
    'corner_facts', 'corner_brief_revisions', ${PARENT_ONLY_SQL},
    'permission_authority', 'room_read_marks', 'message_bookmarks',
    'needs_you_marks',
    'agent_grants', 'agent_schedules', 'agent_subscriptions', 'agent_commands',
    'github_installations', 'github_repositories',
    'workspace_connectors', 'workspace_connections', 'wallet_bindings', 'agents', 'usage_accounts', 'agent_avatars', 'free_agent_usage',
    'registry_mcp_oauth_attempts', 'push_devices',
    'workspace_join_notifications',
    'helper_release_notifications', 'workspaces', 'identities'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'beeline_notify_live_' || table_name AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
        'FOR EACH ROW EXECUTE FUNCTION beeline_notify_live()',
        'beeline_notify_live_' || table_name,
        table_name
      );
    END IF;
  END LOOP;
END;
$$;
`;
}


export interface PgNotification {
  channel: string;
  payload?: string;
}


export interface LivePgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (message: PgNotification) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
}


export type LivePgClientFactory = () => LivePgClient;


export interface LiveNotificationPayload {
  journalStreams?: string[];
  instanceId?:string;
  renewedAt?:number;
  table: string;
  operation: string;
  roomId: string;
  ownerId?: string;
  resourceId?: string;
  accountId?:string;
  usageOnly?:true;
  version?: string;
  squireReportChanged?: boolean;
  squireWorkChanged?: boolean;
  squireAddress?: string;
  messageId?: string;
  requestId?: string;
  turnStatus?: string;
  agentId?: string;
  identityId?: string;
  /** An identities change only its owner may hear: the push level alone. */
  ownerOnly?: boolean;
  workspaceId?: string;
  sourceRoomId?: string;
  needsYouCandidate?: boolean;
  turnId?: string;
  kind?: string;
  observedAt?: number;
  ownerEpoch?: string;
  expiresAt?: number;
  traceId?: string;
  databaseAt?: number;
  parentRoomId?: string;
  openedBy?: string;
  archived?: boolean;
  removed?: boolean;
  closeRequested?: boolean;
  /** Parent Room of a corner whose corner-list row inputs changed. */
  cornerParentId?: string;
  /** A current title/goal also changes the parent transcript's opening-card projection. */
  cornerTextChanged?: boolean;
  pending?: boolean;
  /** An agent_commands row left `claimed`. */
  released?: boolean;
  repositoryChanged?: boolean;
  installationId?: string;
  repositoryId?: string;
  jobId?: string;
  dueAt?: number;
  registryState?: string;
  registryConnectorId?: string;
  registryDueAt?: number;
  releaseVersion?: string;
  releaseSha?: string;
  /** Connection epoch an instance accepted for `agentId` (table `agent_connection`). */
  epoch?: number;
}
