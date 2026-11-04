import { X_SIGNUP_DELIVERY_TABLE, SERVER_LEASE_EVIDENCE_TABLE, AGENT_SIGN_IN_TABLE, decodeAgentSignInNotification, USAGE_REFRESH_TABLE, USAGE_REFRESH_RESULT_TABLE, decodeUsageRefreshResult, MCP_WEBHOOK_TABLE } from './postgres-live-notifications.js';
import { readHelperOverlayFrame } from '@beeline/api-contract/helper-overlay';
import { notifyCommandCompletion, recoverCommandCompletions } from './command-completion.js';
import { COMMAND_COMPLETION_CHANNEL, POSTGRES_LIVE_CHANNEL } from './postgres-live-notifications.js';
import { Client } from 'pg';
import type { UsageRefreshOutcome } from '@beeline/api-contract/daemon';
import type { AgentSignInStep } from './agent-sign-in.js';
import type { SqlDatabase } from './database.js';
import type { LiveEvent, LiveHub } from './live.js';

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

const PARENT_ONLY_TABLES: ReadonlySet<string> = new Set([
  'corner_owed', 'corner_follows', 'corner_merge_holds',
]);
const PARENT_ONLY_SQL = [...PARENT_ONLY_TABLES].map((table) => `'${table}'`).join(',');

/** Publish only committed state; callers pass their current transaction. */
type PublishedNotification = LiveNotificationPayload
  | (AgentSignInStep & Pick<LiveNotificationPayload, 'table' | 'operation' | 'roomId'>)
  | (LiveNotificationPayload & { outcome: UsageRefreshOutcome });

async function notifyLive(
  database: Pick<SqlDatabase, 'query'>,
  payload: PublishedNotification,
): Promise<void> {
  await database.query('SELECT pg_notify($1,$2)', [POSTGRES_LIVE_CHANNEL, JSON.stringify(payload)]);
}

export function notifyAgentCommand(database: Pick<SqlDatabase, 'query'>, roomId: string, agentId: string) {
  return notifyLive(database, { table: 'agent_commands', operation: 'UPDATE', roomId, agentId });
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
  const [{ cornerOwnerSql }, { askSql }, { DURABLE_LIVE_SCHEMA }, { SCHEDULED_WORK_ROW_SOURCE_SCHEMA },
    { CORNER_ROW_CACHE_COLUMNS, CORNER_ROW_FACT_COLUMNS, CORNER_ROW_MESSAGE_COLUMNS, CORNER_ROW_ROOM_COLUMNS, rowChangedSql }] = await Promise.all([
      import('./corner-worker.js'), import('./needs-you.js'), import('./durable-live.js'),
      import('./scheduled-work-row-source.js'), import('./corner-row-projection.js'),
    ]);
  return `
${DURABLE_LIVE_SCHEMA}
${SCHEDULED_WORK_ROW_SOURCE_SCHEMA}
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
    -- Draft text/presence is an overlay, restored by the existing snapshot.
    -- Durable Room state, including reactions and deletes, is ID-only here.
    IF TG_TABLE_NAME <> 'live_outputs' AND (source_room IS NOT NULL OR workspace IS NOT NULL) THEN
      -- Capture both sides of moves before taking any legacy Room lock.
      -- OLD retains the Workspace even after a Room has moved or been deleted.
      previous_room := COALESCE(to_jsonb(OLD)->>'room_id',
        CASE WHEN TG_TABLE_NAME='rooms' THEN to_jsonb(OLD)->>'id' END,
        to_jsonb(OLD)->>'corner_id');
      workspace_scopes := ARRAY[workspace,to_jsonb(NEW)->>'workspace_id',to_jsonb(OLD)->>'workspace_id'];
      IF previous_room IS NOT NULL AND TG_TABLE_NAME<>'rooms' THEN
        workspace_scopes := workspace_scopes || ARRAY(SELECT workspace_id::text FROM rooms WHERE id=previous_room::uuid);
      END IF;
      FOR workspace_target IN SELECT DISTINCT value FROM unnest(workspace_scopes) value
        WHERE value IS NOT NULL ORDER BY value LOOP
        -- The early canonical row source owns these two Workspace appends,
        -- before any legacy Room lock. Keep this notification's original
        -- Workspace hints and every Room/parent journal body below unchanged.
        IF TG_TABLE_NAME NOT IN('agent_schedules','agent_subscriptions') THEN
        PERFORM beeline_journal('workspace:' || workspace_target,jsonb_build_object(
          'type','invalidate','roomId','','reason','workspace-replay','sourceRoomId',source_room,
          'sourceTable',TG_TABLE_NAME,'operation',TG_OP,
          'messageId',payload->>'messageId','identityId',payload->>'identityId',
          'agentId',payload->>'agentId','parentRoomId',parent_room,
          'oldRoomId',previous_room,'newRoomId',source_room,
          'oldParentRoomId',CASE WHEN TG_TABLE_NAME='rooms' THEN to_jsonb(OLD)->>'parent_id' END,
          'newParentRoomId',CASE WHEN TG_TABLE_NAME='rooms' THEN to_jsonb(NEW)->>'parent_id' END,
          'sourceRemoved',TG_TABLE_NAME='rooms' AND TG_OP='UPDATE'
            AND to_jsonb(OLD)->>'workspace_id'=workspace_target
            AND to_jsonb(NEW)->>'workspace_id' IS DISTINCT FROM to_jsonb(OLD)->>'workspace_id',
          'needsYouCandidate',payload->'needsYouCandidate','workflowRunsChanged',payload->'workflowRunsChanged','removed',payload->'removed'));
        END IF;
        streams := array_append(streams,'workspace:' || workspace_target);
      END LOOP;
      IF source_room IS NOT NULL THEN
        body := jsonb_strip_nulls(jsonb_build_object(
          'type','invalidate','roomId',source_room,'reason','postgres:' || TG_TABLE_NAME,
          'messageId',payload->>'messageId','agentId',payload->>'agentId',
          'requestId',payload->>'requestId',
          'trace',jsonb_build_object('id',payload->>'traceId',
            'databaseAt',payload->'databaseAt','emittedAt',payload->'databaseAt'),
          'readerId',CASE WHEN TG_TABLE_NAME='room_read_marks' THEN payload->>'identityId' END));
        PERFORM beeline_journal('room:' || source_room,body);
        streams := array_append(streams,'room:' || source_room);
      END IF;
      IF previous_room IS NOT NULL AND previous_room IS DISTINCT FROM source_room THEN
        PERFORM beeline_journal('room:' || previous_room,jsonb_build_object(
          'type','invalidate','roomId',previous_room,'reason','postgres:'||TG_TABLE_NAME,
          'messageId',payload->>'messageId','operation',TG_OP));
        streams := array_append(streams,'room:'||previous_room);
      END IF;
      IF parent_room IS NOT NULL AND parent_room IS DISTINCT FROM source_room THEN
        PERFORM beeline_journal('room:' || parent_room,jsonb_build_object(
          'type','invalidate','roomId',parent_room,'reason','corner-status'));
        streams := array_append(streams,'room:' || parent_room);
      END IF;
    END IF;
    payload := payload || jsonb_build_object('journalStreams',streams);
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

interface PgNotification {
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

type LivePgClientFactory = () => LivePgClient;

interface LiveNotificationPayload {
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

function decodePayload(value: string | undefined): LiveNotificationPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.table !== 'string' ||
      typeof parsed.operation !== 'string' ||
      typeof parsed.roomId !== 'string'
    )
      return undefined;
    return {
      ...(Array.isArray(parsed.journalStreams)
        ? { journalStreams: parsed.journalStreams.filter((s): s is string => typeof s === 'string') } : {}),
      ...(typeof parsed.instanceId==='string' ? {instanceId:parsed.instanceId} : {}),
      ...(Number.isSafeInteger(parsed.renewedAt) ? {renewedAt:parsed.renewedAt as number} : {}),
      table: parsed.table,
      operation: parsed.operation,
      roomId: parsed.roomId,
      ...(typeof parsed.ownerId === 'string' ? { ownerId: parsed.ownerId } : {}),
      ...(typeof parsed.resourceId === 'string' ? { resourceId: parsed.resourceId } : {}),
      ...(typeof parsed.accountId==='string'&&/^[0-9]{1,20}$/.test(parsed.accountId)?{accountId:parsed.accountId}:{}),
      ...(parsed.usageOnly===true?{usageOnly:true as const}:{}),
      ...(parsed.squireReportChanged === true ? { squireReportChanged: true } : {}),
      ...(parsed.squireWorkChanged === true ? { squireWorkChanged: true } : {}),
      ...(typeof parsed.squireAddress === 'string' ? { squireAddress: parsed.squireAddress } : {}),
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      ...(typeof parsed.agentId === 'string' ? { agentId: parsed.agentId } : {}),
      ...(typeof parsed.identityId === 'string' ? { identityId: parsed.identityId } : {}),
      ...(parsed.ownerOnly === true ? { ownerOnly: true } : {}),
      ...(typeof parsed.workspaceId === 'string' ? { workspaceId: parsed.workspaceId } : {}),
      ...(typeof parsed.sourceRoomId === 'string' ? { sourceRoomId: parsed.sourceRoomId } : {}),
      ...(typeof parsed.needsYouCandidate === 'boolean'
        ? { needsYouCandidate: parsed.needsYouCandidate } : {}),
      ...(typeof parsed.messageId === 'string' ? { messageId: parsed.messageId } : {}),
      ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}),
      ...(typeof parsed.turnStatus === 'string' ? { turnStatus: parsed.turnStatus } : {}),
      ...(typeof parsed.turnId === 'string' ? { turnId: parsed.turnId } : {}),
      ...(typeof parsed.kind === 'string' ? { kind: parsed.kind } : {}),
      ...(typeof parsed.observedAt === 'number' ? { observedAt: parsed.observedAt } : {}),
      ...(typeof parsed.epoch === 'number' ? { epoch: parsed.epoch } : {}),
      ...(typeof parsed.ownerEpoch === 'string' ? { ownerEpoch: parsed.ownerEpoch } : {}),
      ...(typeof parsed.expiresAt === 'number' ? { expiresAt: parsed.expiresAt } : {}),
      ...(typeof parsed.traceId === 'string' ? { traceId: parsed.traceId } : {}),
      ...(typeof parsed.databaseAt === 'number' ? { databaseAt: parsed.databaseAt } : {}),
      ...(typeof parsed.parentRoomId === 'string' ? { parentRoomId: parsed.parentRoomId } : {}),
      ...(typeof parsed.openedBy === 'string' ? { openedBy: parsed.openedBy } : {}),
      ...(typeof parsed.archived === 'boolean' ? { archived: parsed.archived } : {}),
      ...(typeof parsed.removed === 'boolean' ? { removed: parsed.removed } : {}),
      ...(typeof parsed.closeRequested === 'boolean'
        ? { closeRequested: parsed.closeRequested }
        : {}),
      ...(typeof parsed.cornerParentId === 'string'
        ? { cornerParentId: parsed.cornerParentId }
        : {}),
      ...(parsed.cornerTextChanged === true ? { cornerTextChanged: true } : {}),
      ...(typeof parsed.pending === 'boolean' ? { pending: parsed.pending } : {}),
      ...(parsed.released === true ? { released: true } : {}),
      ...(typeof parsed.repositoryChanged === 'boolean'
        ? { repositoryChanged: parsed.repositoryChanged } : {}),
      ...(parsed.installationId !== undefined ? { installationId: String(parsed.installationId) } : {}),
      ...(parsed.repositoryId !== undefined ? { repositoryId: String(parsed.repositoryId) } : {}),
      ...(typeof parsed.jobId === 'string' ? { jobId: parsed.jobId } : {}),
      ...(typeof parsed.dueAt === 'number' ? { dueAt: parsed.dueAt } : {}),
      ...(typeof parsed.registryState === 'string' ? { registryState: parsed.registryState } : {}),
      ...(typeof parsed.registryConnectorId === 'string' ? { registryConnectorId: parsed.registryConnectorId } : {}),
      ...(typeof parsed.registryDueAt === 'number' ? { registryDueAt: parsed.registryDueAt } : {}),
      ...(typeof parsed.releaseVersion === 'string' ? { releaseVersion: parsed.releaseVersion } : {}),
      ...(typeof parsed.releaseSha === 'string' ? { releaseSha: parsed.releaseSha } : {}),
    };
  } catch {
    return undefined;
  }
}

/** One session-persistent LISTEN connection for one server machine. */
export class PostgresLiveListener {
  private pushWake?: () => void;
  private xSignupDeliveryWake?:()=>void;
  setXSignupDeliveryWake(wake:()=>void):void {this.xSignupDeliveryWake=wake;}
  private serverLeaseEvidence?: (instance:string,renewedAt:number,removed:boolean)=>void;
  setServerLeaseEvidence(observe:(instance:string,renewedAt:number,removed:boolean)=>void):void { this.serverLeaseEvidence=observe; }

  setPushWake(wake: () => void): void { this.pushWake = wake; }
  private owedWake?: (source: 'sentry' | 'owed') => void;
  setOwedWake(wake: (source: 'sentry' | 'owed') => void): void { this.owedWake = wake; }
  private mcpWebhookWake?: () => void;
  /** A committed AI-client tag; the wake sends its webhook POST at once. */
  setMcpWebhookWake(wake: () => void): void { this.mcpWebhookWake = wake; }
  private stopped = false;
  private running?: Promise<void>;
  private reconnectPending = false;
  private replacementAllowed = true;
  private resumeConnection?: () => void;
  private disconnectActive?: () => void;
  private stopRecovery?: () => void;
  private active?: LivePgClient;
  private connected = false;
  private readonly projectionQueue: Array<{ raw: string; queuedAt: number; key?: string }> = [];
  private activeProjections = 0;
  private readonly activeProjectionSince = new Map<number, number>();
  private nextProjectionTicket = 0;
  private droppedProjections = 0;
  private deliveredProjections = 0;
  private failedProjections = 0;
  private lastNotificationAt: number | null = null;
  private lastDeliveredAt: number | null = null;
  private lastDeliveryAgeMs: number | null = null;
  private maxDeliveryAgeMs = 0;
  private readonly deliveryAgeBuckets = [0, 0, 0, 0, 0, 0];
  private needsProjectionResync = false;
  private readonly registryDue = new Map<string, { connectorId: string; dueAt: number }>();
  private registryDueTimer?: NodeJS.Timeout;

  private scheduleRegistryDue(): void {
    if (this.registryDueTimer) clearTimeout(this.registryDueTimer);
    this.registryDueTimer = undefined;
    if (this.stopped || !this.registryDue.size) return;
    let dueAt = Number.POSITIVE_INFINITY;
    for (const attempt of this.registryDue.values()) dueAt = Math.min(dueAt, attempt.dueAt);
    this.registryDueTimer = setTimeout(() => {
      this.registryDueTimer = undefined;
      const now = Date.now();
      for (const [state, attempt] of this.registryDue) {
        if (attempt.dueAt > now) continue;
        this.registryDue.delete(state);
        void notifyConnectorHelper(this.database, attempt.connectorId).catch((error) =>
          console.error('[live-listener] registry expiry notification failed', error));
      }
      this.scheduleRegistryDue();
    }, Math.max(0, dueAt - Date.now()));
    this.registryDueTimer.unref?.();
  }

  private async restoreRegistryDue(): Promise<void> {
    const rows = await this.database.query<{
      state: string; connector_id: string; expires_at: Date;
    }>(`SELECT state,connector_id,expires_at FROM registry_mcp_oauth_attempts WHERE code IS NULL`);
    this.registryDue.clear();
    for (const row of rows.rows) {
      const dueAt = row.expires_at.getTime();
      if (dueAt <= Date.now()) await notifyConnectorHelper(this.database, row.connector_id);
      else this.registryDue.set(row.state, { connectorId: row.connector_id, dueAt });
    }
    this.scheduleRegistryDue();
  }

  constructor(
    private readonly database: SqlDatabase,
    private readonly live: LiveHub,
    private readonly clientFactory: LivePgClientFactory,
  ) {}

  projectionHealth() {
    const oldestActive = this.activeProjectionSince.size
      ? Math.min(...this.activeProjectionSince.values()) : undefined;
    return {
      connected: this.connected,
      active: this.activeProjections,
      queued: this.projectionQueue.length,
      oldestActiveAgeMs: oldestActive === undefined
        ? null : Math.max(0, Date.now() - oldestActive),
      oldestQueuedAgeMs: this.projectionQueue[0]
        ? Math.max(0, Date.now() - this.projectionQueue[0].queuedAt) : null,
      dropped: this.droppedProjections,
      delivered: this.deliveredProjections,
      failed: this.failedProjections,
      lastNotificationAt: this.lastNotificationAt,
      lastDeliveredAt: this.lastDeliveredAt,
      lastDeliveryAgeMs: this.lastDeliveryAgeMs,
      maxDeliveryAgeMs: this.maxDeliveryAgeMs,
      /** Cumulative receipt-to-projection ages <=10, 50, 100, 500, 2000 ms, then above. */
      deliveryAgeBuckets: [...this.deliveryAgeBuckets],
      resyncPending: this.needsProjectionResync,
    };
  }

  private enqueueProjection(raw: string | undefined): void {
    if (this.stopped || !raw) return;
    this.lastNotificationAt = Date.now();
    const payload = decodePayload(raw);
    if (!payload) return;
    // A committed cause proves traffic on this incarnation; an opened socket
    // alone never replenishes the one replacement allowance.
    this.replacementAllowed = true;
    if (payload.journalStreams?.length) this.live.journalChanged(payload.journalStreams);
    if (payload.table === 'router_source' || payload.table === 'router_authority') return;
    if(payload.table===X_SIGNUP_DELIVERY_TABLE){this.xSignupDeliveryWake?.();return;}
    if(payload.table===SERVER_LEASE_EVIDENCE_TABLE){
      if(payload.instanceId && payload.renewedAt!==undefined)this.serverLeaseEvidence?.(payload.instanceId,payload.renewedAt,payload.removed===true);
      return;
    }
    if (payload.table === 'sentry_wake_state') {
      this.owedWake?.('sentry');
      return;
    }
    if (payload.table === MCP_WEBHOOK_TABLE) {
      this.mcpWebhookWake?.();
      return;
    }
    const pushOnly = payload.table === 'push_devices' ||
      payload.table === 'workspace_join_notifications';
    if ((payload.table === 'messages' && payload.operation !== 'DELETE') ||
        pushOnly || payload.table === 'identities' ||
        (payload.table === 'agent_turns' && payload.operation === 'UPDATE'))
      this.pushWake?.();
    if (pushOnly) return;
    if (payload.table === USAGE_REFRESH_TABLE && payload.agentId) {
      this.live.publish({
        type: 'usage-refresh', roomId: '', agentId: payload.agentId,
        ...(payload.requestId ? { requestId: payload.requestId } : {}),
      });
      return;
    }
    if (payload.table === USAGE_REFRESH_RESULT_TABLE) {
      const event = decodeUsageRefreshResult(raw);
      if (event) this.live.publish(event);
      return;
    }
    if (payload.table === AGENT_SIGN_IN_TABLE) {
      // No database work: publish now, and never queue or log the payload.
      const event = decodeAgentSignInNotification(raw);
      if (event) this.live.publish(event);
      return;
    }
    if (payload.table === 'helper_release_notifications' &&
        payload.releaseVersion && payload.releaseSha) {
      this.live.publish({
        type: 'helper-release',
        version: payload.releaseVersion, sha: payload.releaseSha,
      });
      return;
    }
    // These notifications only ask a helper to refresh the latest state or
    // drain durable pending operations; the newest one supersedes earlier ones.
    const key = (payload.table === 'agent_config' || payload.table === 'connector_assignment') &&
        payload.agentId
      ? `${payload.table}:${payload.agentId}`
      : payload.table==='usage_accounts'&&payload.ownerId&&payload.accountId
        ? `usage-account:${payload.ownerId}:${payload.accountId}`
      : PARENT_ONLY_TABLES.has(payload.table) && payload.cornerParentId
        ? `corner-status:${payload.cornerParentId}`
      : (payload.table === 'github_installations' && payload.installationId) ||
          (payload.table === 'github_repositories' && payload.repositoryId)
        ? `${payload.table}:${payload.installationId ?? payload.repositoryId}`
        : undefined;
    if (key) {
      const queued = this.projectionQueue.find((item) => item.key === key);
      if (queued) { queued.raw = raw; return; }
    }
    if (this.projectionQueue.length >= 512) {
      this.droppedProjections++;
      this.needsProjectionResync = true;
      return;
    }
    this.projectionQueue.push({ raw, queuedAt: Date.now(), ...(key ? { key } : {}) });
    this.drainProjections();
  }

  private drainProjections(): void {
    while (!this.stopped && this.activeProjections < 2 && this.projectionQueue.length) {
      const next = this.projectionQueue.shift()!;
      this.activeProjections++;
      const ticket = this.nextProjectionTicket++;
      this.activeProjectionSince.set(ticket, next.queuedAt);
      void this.rebroadcast(next.raw).then(() => {
        const now = Date.now();
        const duration = Math.max(0, now - next.queuedAt);
        this.deliveredProjections++;
        this.lastDeliveredAt = now;
        this.lastDeliveryAgeMs = duration;
        this.maxDeliveryAgeMs = Math.max(this.maxDeliveryAgeMs, duration);
        const bucket = [10, 50, 100, 500, 2_000].findIndex((bound) => duration <= bound);
        this.deliveryAgeBuckets[bucket < 0 ? 5 : bucket]!++;
      }).catch((error) => {
        this.failedProjections++;
        console.error('[live-listener] notification failed', error);
      }).finally(() => {
        this.activeProjectionSince.delete(ticket);
        this.activeProjections--;
        if (this.projectionQueue.length) this.drainProjections();
        else if (!this.stopped && this.activeProjections === 0 && this.needsProjectionResync) {
          this.needsProjectionResync = false;
          this.live.resync();
        }
      });
    }
  }

  static forConnectionString(
    connectionString: string,
    database: SqlDatabase,
    live: LiveHub,
  ): PostgresLiveListener {
    return new PostgresLiveListener(
      database,
      live,
      () => new Client({ connectionString }) as unknown as LivePgClient,
    );
  }

  run(): Promise<void> {
    if (this.stopped) return this.running ?? Promise.resolve();
    if (!this.running) {
      this.stopRecovery = this.database.onRecovery?.(() => {
        if (this.stopped) return;
        this.replacementAllowed = true;
        if (!this.connected) this.requestConnection();
      });
      this.running = this.runConnections();
    }
    return this.running;
  }

  private requestConnection(): void {
    this.reconnectPending = true;
    this.resumeConnection?.();
  }

  private async runConnections(): Promise<void> {
    while (!this.stopped) {
      this.reconnectPending = false;
      let disconnect!: () => void;
      let released = false;
      const disconnected = new Promise<void>((resolve) => {
        disconnect = () => {
          if(released)return;released=true;
          if (this.connected && this.replacementAllowed && !this.stopped) {
            this.replacementAllowed = false;
            this.requestConnection();
          }
          this.connected=false;
          this.live.projectionUnavailable();
          resolve();
        };
      });
      this.disconnectActive = disconnect;
      const client = this.clientFactory();
      this.active = client;
      client.on('notification', (message) => {
        if (this.stopped || this.active !== client || released) return;
        if (message.channel === COMMAND_COMPLETION_CHANNEL) {
          if (message.payload) notifyCommandCompletion(message.payload);
          return;
        }
        if (message.channel !== POSTGRES_LIVE_CHANNEL) return;
        this.enqueueProjection(message.payload);
      });
      client.on('error', (error) => {
        console.error('[live-listener] connection failed', error.message);
        disconnect();
      });
      client.on('end', disconnect);
      try {
        await client.connect();
        if (this.stopped || this.active !== client) return;
        if (released) throw new Error('LISTEN connection ended during acquisition');
        await client.query(`LISTEN ${POSTGRES_LIVE_CHANNEL}`);
        if (this.stopped) return;
        if (released) throw new Error('LISTEN connection ended during acquisition');
        await client.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
        if (this.stopped) return;
        if (released) throw new Error('LISTEN connection ended during acquisition');
        recoverCommandCompletions();
        this.xSignupDeliveryWake?.();
        this.connected = true;
        console.log('[live-listener] connected');
        // A reconnect may have missed committed writes while LISTEN was down.
        this.pushWake?.();
        await this.restoreRegistryDue();
        if (this.stopped) return;
        if (released) throw new Error('LISTEN connection ended during acquisition');
        this.live.resync();
        await disconnected;
      } catch (error) {
        this.connected = false;
        disconnect();
        console.error(
          '[live-listener] connect failed',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        this.connected = false;
        if (this.active === client) this.active = undefined;
        this.disconnectActive = undefined;
        await client.end().catch(() => undefined);
      }
      if (!this.stopped && !this.reconnectPending) {
        await new Promise<void>(resolve => { this.resumeConnection = resolve; });
        this.resumeConnection = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopRecovery?.();
    this.disconnectActive?.();
    this.resumeConnection?.();
    this.projectionQueue.length = 0;
    if (this.registryDueTimer) clearTimeout(this.registryDueTimer);
    await this.active?.end().catch(() => undefined);
    await this.running;
  }

  private async rebroadcast(raw: string | undefined): Promise<void> {
    const payload = decodePayload(raw);
    if (!payload) return;
    if(payload.table==='usage_accounts'){
      if(!payload.ownerId||!payload.accountId)return;
      const affected=await this.database.query<{agent_id:string}>(`SELECT agent_id FROM agents
        WHERE owner_id=$1 AND usage_account_id=$2::bigint ORDER BY agent_id`,[payload.ownerId,payload.accountId]);
      for(const agent of affected.rows)this.live.publish({type:'resource-change',roomId:'',ownerId:payload.ownerId,
        resource:'agent',resourceId:agent.agent_id,usageOnly:true});
      return;
    }
    if (payload.ownerId && (payload.table === 'workspace_connectors' ||
      payload.table === 'workspace_connections' || payload.table === 'connector_discovery_cache' || payload.table === 'wallet_bindings' || payload.table === 'agents' ||
      payload.table === 'agent_avatars' || payload.table === 'avatar_job' || payload.table === 'free_agent_usage')) {
      this.live.publish({ type: 'resource-change', roomId: '', ownerId: payload.ownerId,
        resource: payload.table === 'workspace_connectors' ? 'install'
          : payload.table === 'workspace_connections' || payload.table === 'connector_discovery_cache' || payload.table === 'wallet_bindings' ? 'workbench' : 'agent',
        ...(payload.resourceId ? { resourceId: payload.resourceId } : {}),
        ...(payload.usageOnly?{usageOnly:true as const}:{}),
        ...(payload.version ? { version: payload.version } : {}) });
      if (payload.squireReportChanged)
        this.live.publish({ type: 'resource-change', roomId: '', ownerId: payload.ownerId,
          resource: 'workbench' });
      if (payload.squireWorkChanged && payload.squireAddress)
        this.live.publish({ type: 'resource-change', roomId: '', ownerId: payload.ownerId,
          resource: 'install', resourceId: payload.squireAddress });
      return;
    }
    if (payload.table === 'live_outputs' && payload.agentId && payload.turnId) {
      if (payload.operation === 'DELETE') {
        if (payload.kind === 'draft' || payload.kind === 'thought') {
          this.live.publish({
            type: 'retract',
            roomId: payload.roomId,
            agentId: payload.agentId,
            turnId: payload.turnId,
            kind: payload.kind,
          });
        }
        return;
      }
      if (payload.kind === 'presence') {
        const rows = await this.database.query<{
          room_id: string;
          body: Record<string, unknown>;
        }>(
          `SELECT membership.room_id,presence.body
           FROM room_access membership
           JOIN LATERAL(
             SELECT body FROM live_outputs
             WHERE agent_id=$1 AND kind='presence'
             ORDER BY updated_at DESC LIMIT 1
           ) presence ON true
           WHERE membership.identity_id=$1 AND membership.room_id IS NOT NULL
             AND membership.removed_at IS NULL`,
          [payload.agentId],
        );
        for (const row of rows.rows) {
          if (
            (row.body.status !== 'online' && row.body.status !== 'offline') ||
            typeof row.body.observedAt !== 'number'
          )
            continue;
          this.live.publish({
            type: 'presence',
            roomId: row.room_id,
            agentId: payload.agentId,
            status: row.body.status,
            observedAt: row.body.observedAt,
            ...(row.body.held === true ? { held: true } : {}),
          });
        }
        return;
      }
      const row = (
        await this.database.query<{ body: Record<string, unknown> }>(
          `SELECT body FROM live_outputs
           WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind=$4`,
          [payload.roomId, payload.agentId, payload.turnId, payload.kind],
        )
      ).rows[0];
      if (!row) return;
      if (payload.kind === 'draft' || payload.kind === 'thought') {
        if (typeof row.body.text !== 'string') return;
        const overlayV1=readHelperOverlayFrame(row.body.overlayV1);
        if(row.body.overlayV1!==undefined && (!overlayV1 || overlayV1.agentId!==payload.agentId ||
            overlayV1.roomId!==payload.roomId || overlayV1.turnId!==payload.turnId || overlayV1.kind!==payload.kind))return;
        if(overlayV1 && (overlayV1.type==='end'||overlayV1.type==='retract')){
          this.live.publish({type:'retract',roomId:payload.roomId,agentId:payload.agentId,turnId:payload.turnId,kind:payload.kind,overlayV1});
          return;
        }
        this.live.publish({
          type: payload.kind,
          roomId: payload.roomId,
          agentId: payload.agentId,
          turnId: payload.turnId,
          text: row.body.text,
          ...(overlayV1?{overlayV1}:{}),
          ...(typeof row.body.latestChunk === 'string'
            ? { latestChunk: row.body.latestChunk } : {}),
        });
        return;
      }
      return;
    }
    if (payload.table === 'agent_connection' && payload.agentId && payload.epoch !== undefined) {
      // Another instance accepted a newer helper connection for this agent.
      this.live.publish({
        type: 'agent-connection', roomId: '', agentId: payload.agentId, epoch: payload.epoch,
      });
      return;
    }
    if (payload.table === 'agent_config' && payload.agentId) {
      // A phone-side model/effort selection change. The synthetic payload is
      // written by PhoneService with a direct pg_notify inside the selection
      // transaction (the agents table carries no Room, so it has no trigger);
      // every daemon subscription of that Room filters on the target agent.
      this.live.publish({
        type: 'invalidate',
        roomId: payload.roomId,
        reason: 'agent-config',
        targetAgentId: payload.agentId,
      });
      return;
    }
    if (payload.table === 'connector_assignment' && payload.agentId) {
      // Connect / pending_ops: one agent-directed wake, never a catalog.
      this.live.publish({
        type: 'invalidate',
        roomId: payload.roomId,
        reason: 'connector-assignment',
        targetAgentId: payload.agentId,
      });
      return;
    }
    if (payload.table === 'registry_mcp_oauth_attempts') {
      if (payload.registryState) {
        if (payload.registryDueAt && payload.registryConnectorId &&
            payload.registryDueAt > Date.now())
          this.registryDue.set(payload.registryState, {
            connectorId: payload.registryConnectorId, dueAt: payload.registryDueAt });
        else {
          this.registryDue.delete(payload.registryState);
          if (payload.registryDueAt && payload.registryConnectorId)
            await notifyConnectorHelper(this.database, payload.registryConnectorId);
        }
        this.scheduleRegistryDue();
      }
      return;
    }
    if (PARENT_ONLY_TABLES.has(payload.table)) {
      if (payload.cornerParentId)
        this.live.publish({ type: 'invalidate', roomId: payload.cornerParentId,
          reason: 'corner-status' });
      // A new owed item may expire before the leader's next cycle.
      if (payload.table === 'corner_owed') this.owedWake?.('owed');
      return;
    }
    if (payload.table === 'github_installations' || payload.table === 'github_repositories') {
      const rooms = await this.database.query<{ id: string }>(
        payload.installationId
          ? `SELECT id FROM rooms WHERE github_installation_id=$1 AND parent_id IS NULL`
          : `SELECT id FROM rooms WHERE repository_key='github:' || $1 AND parent_id IS NULL`,
        [payload.installationId ?? payload.repositoryId],
      );
      for (const room of rooms.rows)
        this.live.publish({ type: 'invalidate', roomId: room.id,
          reason: 'postgres:rooms', repositoryChanged: true });
      return;
    }
    if (payload.table === 'workspaces' || payload.table === 'identities') {
      // ID-only: each phone socket reads the change once and only a viewer
      // who shares that Workspace, or a Workspace or Room with that person, hears it.
      if (payload.table === 'workspaces' && payload.workspaceId)
        this.live.publish({ type: 'invalidate', roomId: '',
          reason: 'postgres:workspaces', workspaceId: payload.workspaceId });
      if (payload.table === 'identities' && payload.identityId)
        this.live.publish({ type: 'invalidate', roomId: '',
          reason: 'postgres:identities', personId: payload.identityId,
          ...(payload.ownerOnly ? { readerId: payload.identityId } : {}) });
      return;
    }
    if (payload.table === 'message_bookmarks' && payload.identityId &&
        payload.workspaceId && payload.messageId) {
      this.live.publish({ type: 'invalidate', roomId: '',
        reason: 'postgres:message_bookmarks', readerId: payload.identityId,
        workspaceId: payload.workspaceId, messageId: payload.messageId,
        operation: payload.operation });
      return;
    }
    if (payload.table === 'needs_you_marks' && payload.identityId &&
        payload.sourceRoomId) {
      this.live.publish({ type: 'invalidate', roomId: '',
        reason: 'postgres:needs_you_marks', readerId: payload.identityId,
        sourceRoomId: payload.sourceRoomId });
      return;
    }
    const event: Extract<LiveEvent, { type: 'invalidate' }> = {
      type: 'invalidate',
      roomId: payload.roomId,
      reason: `postgres:${payload.table}`,
      operation: payload.operation,
      ...(payload.table === 'memberships' && !payload.roomId && payload.identityId
        ? { readerId: payload.identityId }
        : {}),
      ...(payload.table === 'memberships' && payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
      ...(payload.messageId ? { messageId: payload.messageId } : {}),
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
      ...(payload.turnStatus === 'working' || payload.turnStatus === 'complete' ||
        payload.turnStatus === 'failed' || payload.turnStatus === 'cancelled'
        ? { turnStatus: payload.turnStatus } : {}),
      ...(payload.needsYouCandidate ? { needsYouCandidate: true } : {}),
      ...(payload.table === 'agent_commands' ? { targetAgentId: payload.agentId } : {}),
      ...(payload.table === 'agent_commands' && payload.released ? { commandReleased: true } : {}),
      ...(payload.table === 'memberships' && payload.identityId
        ? { targetAgentId: payload.identityId }
        : {}),
      ...(payload.table === 'room_read_marks' && payload.identityId
        ? { readerId: payload.identityId }
        : {}),
      ...(payload.parentRoomId ? { parentRoomId: payload.parentRoomId } : {}),
      ...(payload.openedBy ? { openedBy: payload.openedBy } : {}),
      ...(payload.archived ? { archived: true } : {}),
      ...(payload.removed ? { removed: true } : {}),
      ...(payload.closeRequested ? { closeRequested: true } : {}),
      ...(payload.repositoryChanged ? { repositoryChanged: true } : {}),
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
      ...(payload.traceId && payload.databaseAt
        ? {
            trace: {
              id: payload.traceId,
              databaseAt: payload.databaseAt,
              emittedAt: Date.now(),
            },
          }
        : {}),
    };
    this.live.publish(event);
    // Navigation text also appears in the parent's historical opening-card projection.
    if (payload.cornerParentId && payload.cornerTextChanged) this.live.publish({
      type: 'invalidate', roomId: payload.cornerParentId, reason: 'corner-text',
    });
    // The parent corner list rereads from this id-only hint.
    if (payload.cornerParentId) {
      this.live.publish({
        type: 'invalidate',
        roomId: payload.cornerParentId,
        reason: payload.table === 'agent_schedules' || payload.table === 'agent_subscriptions'
          ? `postgres:${payload.table}` : 'corner-status',
      });
    }
  }
}
