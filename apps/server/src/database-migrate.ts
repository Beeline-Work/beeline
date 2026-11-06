import { OWNED_MODEL_CREDENTIAL_SCHEMA } from './owned-model-credential.js';
import { OWNED_MODEL_ATTEMPT_SCHEMA } from './owned-model-attempt.js';
import { SENTRY_WAKE_SOURCE_SCHEMA } from './sentry-wake-source.js';
import { CONNECTOR_OFFER_EXPIRY_SCHEMA } from './connector-offer-expiry.js';
import { PENDING_ATTACHMENT_SOURCE_SCHEMA } from './pending-attachment-source.js';
import { AGENT_SCHEDULE_SOURCE_SCHEMA } from './agent-schedule-source.js';
import { HELPER_ACTIVATION_SCHEMA } from './helper-activation-schema.js';
import { HELPER_USAGE_SCHEMA } from './helper-usage.js';
import { HELPER_OVERLAY_SCHEMA } from './helper-overlay.js';
import { BACKGROUND_DUE_SOURCE_SCHEMA } from './background-due-source.js';
import { MCP_MEMBER_STREAM_SCHEMA } from './rooms-mcp-stream.js';
import { X_SIGNUP_DELIVERY_SCHEMA } from './x-ads.js';
import { SERVER_LEASE_DEADLINE_SCHEMA } from './server-lease-deadlines.js';
import { commandCompletionSchema } from './command-completion.js';
import { ROUTER_COMMAND_SCHEMA } from './router-command-ledger.js';
import { backfillWelcomeVideoWorkflow } from './welcome-video-workflow.js';
import { AGENT_TURN_END_SCHEMA } from './agent-turn-end.js';
import { clearConnectedAppPlaceholders } from './migrations/connected-app-turns.js';
import { AGENT_CORNER_HOLDS_SCHEMA } from './migrations/agent-corner-holds.js';
import { MOBILE_MINIMUM_SCHEMA } from './mobile-minimum.js';
import { STARTER_ONBOARDING_SCHEMA } from './starter-onboarding-run.js';
import { NEXT_DAY_CHECKIN_SCHEMA } from './next-day-checkin.js';
import { ROOMS_MCP_SCHEMA } from './rooms-mcp-schema.js';
import { backfillMcpMemberRoomsAndAvatars, backfillMcpMembers } from './rooms-mcp-members.js';
import { seedPreregisteredMcpClients } from './rooms-mcp-preregistered.js';
import { backfillCornerHoldMessages, releaseArchivedCornerHolds } from './corner-holds.js';
import { OPERATOR_SYSTEM_DM_SCHEMA } from './operator-system-dm.js';
import { OPERATOR_FINANCES_SCHEMA } from './operator-finances.js';
import { backfillPushOutbox, PUSH_OUTBOX_SCHEMA } from './push-outbox.js';
import { LEGACY_STORAGE_SCHEMA } from './migrations/legacy-storage.js';
import { CORNER_PERSON_STATE_SCHEMA, migrateCornerPersonState } from './corner-person-state.js';
import { CORNER_MEMBERSHIPS_SCHEMA, removeCornerMemberships } from './migrations/corner-memberships.js';
import { deleteArchivedCornerWakeSources } from './migrations/archived-corner-wakes.js';
import { retireBotDirectMessages } from './migrations/one-system-thread.js';
import { FREE_AGENTS_SCHEMA, FREE_AGENT_CONNECT_GUIDE } from './free-agents.js';
import { backfillComputerObservations } from './system-line.js';
import { SUBSCRIPTION_WEBHOOKS_SCHEMA } from './subscription-webhooks.js';
import { AGENT_SUBSCRIPTIONS_SCHEMA, migrateMembershipSubscriptions } from './agent-subscriptions.js';
import { PROVIDER_WEBHOOKS_SCHEMA } from './provider-webhooks.js';
import { SENTRY_WAKE_SCHEMA } from './sentry-wake.js';
import { CORNER_MERGE_HOLDS_SCHEMA } from './migrations/corner-merge-holds.js';
import { hyphenateCornerNames } from './migrations/corner-names.js';
import { normalizeLegacyWorkflowRuns, reportAbandonedWorkflowEndings, saveUnsavedWorkflowRunStatus, workflowBackfillOnce } from './migrations/workflow-cleanup.js';
import { workflowRunIsLiveSql, workflowRunStatusUnsavedSql } from './workflow-run-saved-status.js';
import { AGENT_COMMAND_SCHEMA } from './agent-command.js';
import { GITHUB_STAR_PROMPT_SCHEMA } from './github-star-prompt.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { backfillCornerLifecycleRuns, deleteStoredCornerWorkflows } from './corner-lifecycle.js';
import { backfillFeedbackTriageWorkflow, backfillFeedbackSignalWalk, backfillWorkspaceWalkHistory } from './feedback-triage-workflow.js';
import { backfillWorkflowSkillDescriptions, closeStaleWorkflowGateChoices } from './workflow-runs.js';
import { upgradeGrantPolicy, withdrawSupersededGrantAsks } from './grant-policy-upgrade.js';
import { backfillRegistryApps } from './app-connections.js';
import { syncTopLevelSharedRoomRoles } from './membership-join.js';
import { postgresLiveSchema } from './postgres-live.js';
import { TURN_OWNERSHIP_SCHEMA } from './turn-ownership.js';
import { COMPUTER_EXPIRY_SCHEMA } from './computer-expiry-schema.js';
import { CHOICE_EXPIRY_SCHEMA } from './choice-expiry-schema.js';
import { askingMessageSql, cardExpiresAtSql, EXPIRING_CARD_TYPES } from './needs-you.js';
import { cancelArchivedCornerAssignments } from './corner-close.js';
import { cornerOwedSchemaSql } from './corner-owed.js';
import { cornerWaitingFunctionSql } from './corner-waiting-report.js';
import { CORNER_ATTENTION_SCHEMA } from './corner-attention.js';
import { backfillCornerFollows, cornerFollowsSchemaSql } from './corner-follow.js';
import { alreadyNoOp, alreadySatisfied, triggerAlreadyCurrent, runMigrationStep, splitMigrationStatements } from './migration-steps.js';
import { SqlDatabase, SCHEMA, MESSAGE_CURSOR_MS_SQL } from './database.js';
import { createIndexConcurrently, backfillMessageSearchDocuments, backfillSquireApprovalExpiry, compactWebhookDeliveries, compactPushClaims, backfillCornerOwed, backfillSystemEventKinds, backfillPerItemEventSubscriptions, backfillInstitutionalMemoryRollout, retireStandingPreferences, backfillAgentHandles, backfillConnectorMachineId } from './database-backfill-squire-approval-expiry.js';



export async function migrate(
  database: SqlDatabase,
  options: { deferData?: boolean } = {},
): Promise<void> {
  const ddl = async (name: string, sql: string) => runMigrationStep(name, async () => {
    const statement = sql.replace(/^(?:\s*--[^\n]*\n)*/, '').trim();
    const index = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\b/i.exec(statement);
    if (index) {
      await createIndexConcurrently(database, index[2]!, statement.replace(/\bINDEX\b/i, 'INDEX CONCURRENTLY'));
      return;
    }
    // Install CHECK/FK enforcement without scanning the hot table under the
    // ALTER lock. Validation uses PostgreSQL's weaker online lock separately.
    const constraint = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+CONSTRAINT\s+(\w+)\s+(?:CHECK|FOREIGN\s+KEY)\b/i.exec(statement);
    if (constraint && !/\bNOT\s+VALID\b/i.test(statement)) {
      await database.query(statement.replace(/;?\s*$/, ' NOT VALID;'));
      await database.query(`ALTER TABLE ${constraint[1]} VALIDATE CONSTRAINT ${constraint[2]}`);
      return;
    }
    await database.query(sql);
  });
  const ddlScript = async (name: string, sql: string) => {
    const statements = splitMigrationStatements(sql);
    for (let index = 0; index < statements.length; index++) {
      const statement = statements[index]!;
      if (await alreadySatisfied(database, statement) || await alreadyNoOp(database, statement)) continue;
      const next = statements[index + 1];
      if (next && await triggerAlreadyCurrent(database, statement, next)) { index++; continue; }
      await ddl(`${name} ${index + 1}/${statements.length}`, statement);
    }
  };
  await ddlScript('server schema', SCHEMA);
  await ddlScript('Rooms MCP OAuth', ROOMS_MCP_SCHEMA);
  await ddlScript('historical storage schema', LEGACY_STORAGE_SCHEMA);
  await runMigrationStep('webhook retention index', () => createIndexConcurrently(
    database, 'github_webhook_deliveries_received_idx',
    `CREATE INDEX CONCURRENTLY github_webhook_deliveries_received_idx
     ON github_webhook_deliveries(received_at)`,
  ));
  await runMigrationStep('terminal push claim expiry index', () => createIndexConcurrently(
    database, 'push_delivery_claims_terminal_idx',
    `CREATE INDEX CONCURRENTLY push_delivery_claims_terminal_idx
     ON push_delivery_claims(completed_at)
     WHERE status IN ('delivered','suppressed','failed','uncertain')`,
  ));
  await runMigrationStep('pending read-clear claim index', () => createIndexConcurrently(
    database, 'push_delivery_claims_read_clear_idx',
    `CREATE INDEX CONCURRENTLY push_delivery_claims_read_clear_idx
     ON push_delivery_claims(device_token,message_id)
     WHERE status='delivered' AND read_cleared_at IS NULL`,
  ));
  await ddl('wallet delegation',
    `ALTER TABLE wallet_bindings ADD COLUMN IF NOT EXISTS delegation_standing boolean NOT NULL DEFAULT false`,
  );
  await ddlScript('agent command schema', AGENT_COMMAND_SCHEMA);
  await ddlScript('turn ownership schema', TURN_OWNERSHIP_SCHEMA);
  await ddlScript('agent turn ending', AGENT_TURN_END_SCHEMA);
  // The previous serving/rollback image still owns its notification capture
  // triggers. Retire them together with their storage in a later contract release.
  await ddlScript('router command identity', ROUTER_COMMAND_SCHEMA);
  await ddlScript('retired turn recovery schema', `
    ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS startup_outcome text;
    DROP TRIGGER IF EXISTS defer_startup_wake ON agent_commands;
    DROP FUNCTION IF EXISTS defer_startup_wake();
  `);
  await ddlScript('free agents schema', FREE_AGENTS_SCHEMA);
  await ddlScript('owned model credentials', OWNED_MODEL_CREDENTIAL_SCHEMA);
  await ddlScript('owned model attempts', OWNED_MODEL_ATTEMPT_SCHEMA);
  await ddlScript('starter onboarding schema', STARTER_ONBOARDING_SCHEMA);
  await runMigrationStep('checkin human history index', () => createIndexConcurrently(
    database, 'messages_checkin_author_history',
    `CREATE INDEX CONCURRENTLY messages_checkin_author_history ON messages(author_id,created_at,id)
     WHERE presentation='message' AND system_event IS NULL`,
  ));
  await ddlScript('next day checkin schema', NEXT_DAY_CHECKIN_SCHEMA);
  await runMigrationStep('room pending command index', () => createIndexConcurrently(
    database, 'agent_commands_room_pending_status',
    `CREATE INDEX CONCURRENTLY agent_commands_room_pending_status
     ON agent_commands(room_id,agent_id,created_at,id)
     WHERE state='pending' AND action='input'
       AND reason IN ('human_tag','direct_message')`,
  ));
  await ddlScript('agent subscriptions', AGENT_SUBSCRIPTIONS_SCHEMA);
  await ddlScript('subscription webhook calls', SUBSCRIPTION_WEBHOOKS_SCHEMA);
  await ddlScript('provider webhooks', PROVIDER_WEBHOOKS_SCHEMA);
  await ddlScript('sentry wakes', SENTRY_WAKE_SCHEMA);
  await ddlScript('operator System DMs', OPERATOR_SYSTEM_DM_SCHEMA);
  await ddlScript('operator finances snapshots', OPERATOR_FINANCES_SCHEMA);
  await runMigrationStep('operator model cost history index', () => createIndexConcurrently(
    database, 'free_agent_events_model_cost_at',
    `CREATE INDEX CONCURRENTLY free_agent_events_model_cost_at ON free_agent_events(at)
     WHERE kind='model_usage'`,
  ));
  await ddlScript('github star prompt schema', GITHUB_STAR_PROMPT_SCHEMA);
  await ddlScript('mobile store minimum schema', MOBILE_MINIMUM_SCHEMA);
  // Bounded operator history reads use date-leading indexes rather than
  // scanning the message/turn ledgers once for every plotted day.
  await runMigrationStep('operator message history index', () => createIndexConcurrently(
    database, 'messages_operator_history_idx',
    `CREATE INDEX CONCURRENTLY messages_operator_history_idx
     ON messages(created_at,author_id) WHERE presentation='message' AND deleted_at IS NULL`,
  ));
  // Membership attention refreshes ask for this person's last answer in each
  // candidate Room. A date-leading index re-scans history for every item when
  // a newcomer has no answers.
  await runMigrationStep('corner answer lookup index', () => createIndexConcurrently(
    database, 'messages_room_author_answer_idx',
    `CREATE INDEX CONCURRENTLY messages_room_author_answer_idx
     ON messages(room_id,author_id,created_at DESC)
     WHERE presentation='message' AND deleted_at IS NULL`,
  ));
  await runMigrationStep('operator turn history index', () => createIndexConcurrently(
    database, 'agent_turns_operator_history_idx',
    `CREATE INDEX CONCURRENTLY agent_turns_operator_history_idx ON agent_turns(created_at) INCLUDE(status)`,
  ));
  await runMigrationStep('operator invited join history index', () => createIndexConcurrently(
    database, 'memberships_operator_invited_history_idx',
    `CREATE INDEX CONCURRENTLY memberships_operator_invited_history_idx
     ON memberships(joined_at,invited_by) WHERE room_id IS NULL AND invited_by IS NOT NULL`,
  ));
  await runMigrationStep('operator invite creation index', () => createIndexConcurrently(
    database, 'invites_operator_created_idx',
    `CREATE INDEX CONCURRENTLY invites_operator_created_idx
     ON invites(created_at,created_by) WHERE created_at IS NOT NULL`,
  ));
  await runMigrationStep('operator pairing code creation index', () => createIndexConcurrently(
    database, 'agent_pairing_codes_operator_created_idx',
    `CREATE INDEX CONCURRENTLY agent_pairing_codes_operator_created_idx
     ON agent_pairing_codes(created_at,created_by) WHERE created_at IS NOT NULL`,
  ));
  await runMigrationStep('operator turn token index', () => createIndexConcurrently(
    database, 'agent_turns_operator_tokens_idx',
    `CREATE INDEX CONCURRENTLY agent_turns_operator_tokens_idx
     ON agent_turns(created_at,agent_id) INCLUDE (input_tokens,output_tokens)`,
  ));
  await runMigrationStep('operator repository link index', () => createIndexConcurrently(
    database, 'repository_link_successes_operator_linked_idx',
    `CREATE INDEX CONCURRENTLY repository_link_successes_operator_linked_idx
     ON repository_link_successes(first_linked_at,identity_id)`,
  ));
  await runMigrationStep('operator repository card index', () => createIndexConcurrently(
    database, 'messages_repository_onboarding_idx',
    `CREATE INDEX CONCURRENTLY messages_repository_onboarding_idx
     ON messages(created_at) WHERE card_type='repository-onboarding' AND deleted_at IS NULL`,
  ));
  await runMigrationStep('operator unrevoked daemon token index', () => createIndexConcurrently(
    database, 'daemon_tokens_unrevoked_created_idx',
    `CREATE INDEX CONCURRENTLY daemon_tokens_unrevoked_created_idx
     ON daemon_tokens(agent_id,created_at) WHERE revoked_at IS NULL`,
  ));
  await runMigrationStep('message cursor index', () => createIndexConcurrently(
    database, 'messages_room_cursor_idx',
    `CREATE INDEX CONCURRENTLY messages_room_cursor_idx ON messages (room_id,
     (${MESSAGE_CURSOR_MS_SQL}), id)`,
  ));
  await runMigrationStep('live activity index', () => createIndexConcurrently(
    database, 'messages_live_activity_idx',
    `CREATE INDEX CONCURRENTLY messages_live_activity_idx
     ON messages(room_id,author_id,created_at DESC,id DESC)
     WHERE presentation='activity' AND durable_fact IS NULL`,
  ));
  await runMigrationStep('unread cursor index', () => createIndexConcurrently(
    database, 'messages_unread_cursor_idx',
    `CREATE INDEX CONCURRENTLY messages_unread_cursor_idx
     ON messages(room_id,created_at,id) INCLUDE(author_id)
     WHERE presentation<>'activity' AND card_type IS DISTINCT FROM 'grant-decision'
       AND card_type IS DISTINCT FROM 'connector-offer-decision'`,
  ));
  // Without this the drained backfill's first probe is a full heap read of the
  // busiest table on EVERY release, including every release that has nothing
  // left to fill. It is not empty once the backfill converges and is not meant
  // to be: it keeps one entry per conversational row the trigger never saw,
  // which is every pre-window row the backfill deliberately skips below. The
  // drain reads newest-first and stops at the window edge, so those entries are
  // never visited — they are exactly what makes a converged probe free.
  await runMigrationStep('search backfill index', () => createIndexConcurrently(
    database,
    'messages_search_document_backfill_idx',
    `CREATE INDEX CONCURRENTLY messages_search_document_backfill_idx
     ON messages(created_at DESC)
     WHERE search_document IS NULL AND presentation='message'`,
  ));
  await runMigrationStep('search document index', () => createIndexConcurrently(
    database,
    'messages_search_document_idx',
    `CREATE INDEX CONCURRENTLY messages_search_document_idx
     ON messages USING GIN(search_document)
     WHERE deleted_at IS NULL AND presentation='message'`,
  ));
  await runMigrationStep('search stem backfill index', () => createIndexConcurrently(
    database,
    'messages_search_stem_document_backfill_idx',
    `CREATE INDEX CONCURRENTLY messages_search_stem_document_backfill_idx
     ON messages(created_at DESC)
     WHERE search_stem_document IS NULL AND presentation='message'`,
  ));
  await runMigrationStep('search stem document index', () => createIndexConcurrently(
    database,
    'messages_search_stem_document_idx',
    `CREATE INDEX CONCURRENTLY messages_search_stem_document_idx
     ON messages USING GIN(search_stem_document)
     WHERE deleted_at IS NULL AND presentation='message'`,
  ));
  // Embedding-cycle scan: cheap once the backfill converges, for the same
  // reason as the search backfill index above (a filled row never re-enters
  // this partial index).
  await runMigrationStep('institutional memory embedding backfill index', () =>
    createIndexConcurrently(
      database,
      'institutional_memory_items_embedding_backfill_idx',
      `CREATE INDEX CONCURRENTLY institutional_memory_items_embedding_backfill_idx
       ON institutional_memory_items(updated_at ASC)
       WHERE state='active' AND deleted_at IS NULL AND embedding IS NULL`,
    ));
  // Exact distance scans stay inside one Workspace's small active set.
  await runMigrationStep('workspace skill embedding backfill index', () =>
    createIndexConcurrently(
      database,
      'workspace_skills_embedding_backfill_idx',
      `CREATE INDEX CONCURRENTLY workspace_skills_embedding_backfill_idx
       ON workspace_skills(updated_at ASC)
       WHERE state='active' AND embedding IS NULL`,
    ));
  // A corner's run state is its newest handoff card (corner-run.ts).
  await runMigrationStep('corner run card index', () => createIndexConcurrently(
    database, 'messages_corner_run_card_idx',
    `CREATE INDEX CONCURRENTLY messages_corner_run_card_idx
     ON messages (room_id, ((card->>'seq')::int) DESC) WHERE card_type='corner-workflow-handoff'`,
  ));
  // A corner's worker and owner are its assignment commands (corner-worker.ts).
  await runMigrationStep('corner assignment index', () => createIndexConcurrently(
    database, 'agent_commands_corner_assignment_idx',
    `CREATE INDEX CONCURRENTLY agent_commands_corner_assignment_idx
     ON agent_commands (room_id, inbox_sequence) WHERE reason IN ('corner_objective','human_tag')`,
  ));
  await createIndexConcurrently(
    database, 'messages_corner_fact_idx',
    `CREATE INDEX CONCURRENTLY messages_corner_fact_idx
     ON messages ((card->>'cornerId')) WHERE card_type='daemon-fact'`,
  );
  // Machine connection changes find their one open notice without scanning
  // transcript history. messages is busy, so this index builds concurrently.
  await runMigrationStep('machine offline notice index', () => createIndexConcurrently(
    database, 'messages_machine_offline_open_idx',
    `CREATE INDEX CONCURRENTLY messages_machine_offline_open_idx
     ON messages((card->>'machineId'),(card->>'ownerId'))
     WHERE card_type='machine-offline' AND card->>'status'='open'`,
  ));
  // Reviewer recovery reads one successful sign-in without scanning transcript
  // history on each reconciliation. Build outside the busy messages transaction.
  await runMigrationStep('agent sign-in recovery index', () => createIndexConcurrently(
    database, 'messages_agent_sign_in_success_idx',
    `CREATE INDEX CONCURRENTLY messages_agent_sign_in_success_idx
     ON messages((card->>'agentId'),created_at DESC,id DESC)
     WHERE card_type='agent-sign-in' AND card->>'status'='signed-in'`,
  ));
  // The Needs-you tray finds undecided grant cards without reading transcripts.
  await runMigrationStep('grant request index', () => createIndexConcurrently(
    database, 'messages_grant_request_idx',
    `CREATE INDEX CONCURRENTLY messages_grant_request_idx
     ON messages(room_id,created_at DESC) WHERE card_type='grant-request'`,
  ));
  // Without this, deleting a message with replies makes Postgres sequentially
  // scan the whole messages table for the FK check on reply_to_message_id,
  // which is what stalled DELETE FROM workspaces past the app pool's
  // statement_timeout (reported as the delete dialog hanging forever).
  await runMigrationStep('reply-to index', () => createIndexConcurrently(
    database, 'messages_reply_to_idx',
    `CREATE INDEX CONCURRENTLY messages_reply_to_idx
     ON messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL`,
  ));
  // Every live-run check reads the start card's saved status through this index.
  await runMigrationStep('workflow run live index', () => createIndexConcurrently(
    database, 'messages_workflow_run_live_idx',
    `CREATE INDEX CONCURRENTLY messages_workflow_run_live_idx
     ON messages(room_id) WHERE card_type='workflow-handoff' AND ${workflowRunIsLiveSql('card')}`,
  ));
  // The phone finds each persisted start card, then the latest handoff for
  // that run. Both indexes are built outside the schema transaction because
  // messages is a busy table.
  await runMigrationStep('workflow run start index', () => createIndexConcurrently(
    database, 'messages_workflow_run_start_idx',
    `CREATE INDEX CONCURRENTLY messages_workflow_run_start_idx
     ON messages(room_id,created_at DESC,id DESC)
     WHERE card_type='workflow-handoff' AND id=card->>'runId'`,
  ));
  await runMigrationStep('workflow run handoff index', () => createIndexConcurrently(
    database, 'messages_workflow_handoff_run_seq_idx',
    `CREATE INDEX CONCURRENTLY messages_workflow_handoff_run_seq_idx
     ON messages(room_id,(card->>'runId'),((card->>'seq')::int) DESC NULLS LAST)
     WHERE card_type='workflow-handoff' AND card->>'runId' IS NOT NULL`,
  ));
  // Empty once every start card has its saved status, so each release's check is free.
  await runMigrationStep('workflow run status backfill index', () => createIndexConcurrently(
    database, 'messages_workflow_run_status_backfill_idx',
    `CREATE INDEX CONCURRENTLY messages_workflow_run_status_backfill_idx
     ON messages(id) WHERE card_type='workflow-handoff' AND ${workflowRunStatusUnsavedSql('card', 'id')}`,
  ));
  // The Task Tray reads sign-in and Trusty Squire approval cards at any age
  // (they leave only when decided or expired), so it reads them through these.
  await runMigrationStep('needs-you approval index', () => createIndexConcurrently(
    database, 'messages_needs_you_approval_idx',
    `CREATE INDEX CONCURRENTLY messages_needs_you_approval_idx
     ON messages(room_id)
     WHERE card_type IN ('agent-sign-in','app-sign-in','squire-approval') AND deleted_at IS NULL`,
  ));
  // Index the three deadlines read by DeadlineExpiry.
  await runMigrationStep('needs-you mark expiry index', () => createIndexConcurrently(
    database, 'needs_you_marks_open_first_seen_idx',
    `CREATE INDEX CONCURRENTLY needs_you_marks_open_first_seen_idx
     ON needs_you_marks(first_seen_at) WHERE cleared_at IS NULL`,
  ));
  await runMigrationStep('needs-you card expiry index', () => createIndexConcurrently(
    database, 'messages_needs_you_expiry_idx',
    `CREATE INDEX CONCURRENTLY messages_needs_you_expiry_idx
     ON messages(${cardExpiresAtSql()})
     WHERE ${EXPIRING_CARD_TYPES} AND deleted_at IS NULL`,
  ));
  // The v2 predicate includes actionable commander reports. Build it before
  // retiring the old question-only index, so deployed databases keep indexed reads.
  await runMigrationStep('needs-you actionable lookback index', () => createIndexConcurrently(
    database, 'messages_needs_you_actionable_idx',
    `CREATE INDEX CONCURRENTLY messages_needs_you_actionable_idx
     ON messages(created_at) WHERE ${askingMessageSql()}`,
  ));
  await runMigrationStep('retire needs-you question-only index', async () => {
    await database.query('DROP INDEX CONCURRENTLY IF EXISTS messages_needs_you_question_idx');
  });
  await runMigrationStep('squire decision index', () => createIndexConcurrently(
    database, 'messages_squire_decision_idx',
    `CREATE INDEX CONCURRENTLY messages_squire_decision_idx
     ON messages(room_id,(card->>'approvalId')) WHERE card_type='squire-approval-decision'`,
  ));
  await ddlScript('corner merge holds', CORNER_MERGE_HOLDS_SCHEMA);
  await ddlScript('agent corner holds', AGENT_CORNER_HOLDS_SCHEMA);
  await runMigrationStep('corner forwarded item index', () => createIndexConcurrently(
    database, 'messages_source_room_idx',
    `CREATE INDEX CONCURRENTLY messages_source_room_idx
     ON messages ((card->>'sourceRoomId')) WHERE card->>'sourceRoomId' IS NOT NULL`,
  ));
  await runMigrationStep('corner report message index', () => createIndexConcurrently(
    database, 'messages_report_request_idx',
    `CREATE INDEX CONCURRENTLY messages_report_request_idx
     ON messages (request_id) WHERE request_id IS NOT NULL`,
  ));
  await runMigrationStep('corner report origin index', () => createIndexConcurrently(
    database, 'agent_commands_report_origin_idx',
    `CREATE INDEX CONCURRENTLY agent_commands_report_origin_idx ON agent_commands
     ((CASE WHEN private_payload->>'originCornerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN (private_payload->>'originCornerId')::uuid ELSE room_id END))`,
  ));
  await ddlScript('corner person state', CORNER_PERSON_STATE_SCHEMA);
  await ddlScript('corner membership guard', CORNER_MEMBERSHIPS_SCHEMA);
  await runMigrationStep('corner human report return index', () => createIndexConcurrently(
    database, 'corner_human_reports_return',
    `CREATE INDEX CONCURRENTLY corner_human_reports_return ON messages(room_id,created_at DESC,id DESC)
     WHERE card->>'reportToId' IS NOT NULL`,
  ));
  await runMigrationStep('corner human report worker index', () => createIndexConcurrently(
    database, 'corner_human_reports_worker',
    `CREATE INDEX CONCURRENTLY corner_human_reports_worker ON messages(author_id,created_at DESC,id DESC)
     WHERE card->>'reportToId' IS NOT NULL`,
  ));
  await ddlScript('corner owed schema', cornerOwedSchemaSql());
  await ddlScript('corner explicit wait function', cornerWaitingFunctionSql());
  await ddlScript('corner attention schema', CORNER_ATTENTION_SCHEMA);
  // Idle reads use bounded ordered probes, including a corner with a long
  // execution/transcript history. Build outside busy writer transactions.
  await runMigrationStep('corner idle turn history index', () => createIndexConcurrently(
    database, 'agent_turns_idle_latest_idx',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_turns_idle_latest_idx
     ON agent_turns(room_id,ended_at DESC NULLS LAST,created_at DESC) INCLUDE(agent_id,status)
     WHERE COALESCE(generation_id,'') NOT LIKE 'pending:%'`,
  ));
  await runMigrationStep('corner working turn index', () => createIndexConcurrently(
    database, 'agent_turns_working_room_idx',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_turns_working_room_idx
     ON agent_turns(room_id,agent_id,request_id)
     WHERE status='working' AND COALESCE(generation_id,'') NOT LIKE 'pending:%'`,
  ));
  await runMigrationStep('corner human input history index', () => createIndexConcurrently(
    database, 'messages_idle_human_history_idx',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_idle_human_history_idx
     ON messages(room_id,author_id,created_at DESC)
     WHERE presentation='message' AND system_event IS NULL`,
  ));
  await runMigrationStep('corner private report card index', () => createIndexConcurrently(
    database, 'messages_private_report_card_idx',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_private_report_card_idx
     ON messages(id) WHERE card_type='agent-command' AND card->>'kind'='report'`,
  ));
  await runMigrationStep('corner human report origin history index', () => createIndexConcurrently(
    database, 'messages_human_report_origin_idx',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_human_report_origin_idx
     ON messages((card->>'sourceRoomId'),author_id,created_at DESC,id DESC)
     WHERE card->>'reportToId' IS NOT NULL`,
  ));
  await runMigrationStep('corner legacy human report history index', () => createIndexConcurrently(
    database, 'messages_human_report_legacy_idx',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_human_report_legacy_idx
     ON messages(room_id,author_id,created_at DESC,id DESC)
     WHERE card->>'reportToId' IS NOT NULL AND card->>'sourceRoomId' IS NULL`,
  ));
  await ddlScript('corner follows schema', cornerFollowsSchemaSql());
  await ddlScript('live notification schema', (await postgresLiveSchema()));
  await ddlScript('sentry eligibility source', SENTRY_WAKE_SOURCE_SCHEMA);
  await ddlScript('agent schedule due source', AGENT_SCHEDULE_SOURCE_SCHEMA);
  await ddlScript('pending attachment due source', PENDING_ATTACHMENT_SOURCE_SCHEMA);
  await ddlScript('computer expiry source', COMPUTER_EXPIRY_SCHEMA);
  await ddlScript('choice expiry source', CHOICE_EXPIRY_SCHEMA);
  await ddlScript('connector offer expiry source', CONNECTOR_OFFER_EXPIRY_SCHEMA);
  await ddlScript('server lease deadlines', SERVER_LEASE_DEADLINE_SCHEMA);
  await ddlScript('X signup delivery deadlines', X_SIGNUP_DELIVERY_SCHEMA);
  await ddlScript('command completion notifications', commandCompletionSchema());
  await ddlScript('MCP member stream', MCP_MEMBER_STREAM_SCHEMA);
  await ddlScript('Helper overlay demand', HELPER_OVERLAY_SCHEMA);
  await ddlScript('Helper usage ownership', HELPER_USAGE_SCHEMA);
  await ddlScript('Helper command activation', HELPER_ACTIVATION_SCHEMA);
  await ddlScript('push outbox', PUSH_OUTBOX_SCHEMA);
  await ddlScript('Background obligation sources', BACKGROUND_DUE_SOURCE_SCHEMA);
  // Retired Tray clock and background storage remains through the serving and
  // rollback overlap. A later release owns its contract, after its readers drain.
  if (!options.deferData) await migrateData(database);
}


/** Idempotent data work runs after both schema owners have expanded. Each step
 * commits separately, so retrying a release resumes completed work. */
export async function migrateData(database: SqlDatabase): Promise<void> {
  const dataStep = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    let result!: T;
    await runMigrationStep(name, async () => {
      result = await run();
    });
    return result;
  };
  await dataStep('archived corner holds', () => releaseArchivedCornerHolds(database));
  await dataStep('corner hold messages', () => backfillCornerHoldMessages(database));
  await dataStep('push outbox cutover', () => workflowBackfillOnce(
    database, 'push-outbox-v1', backfillPushOutbox));
  await dataStep('free agent connection guide', () =>
    workflowBackfillOnce(database, 'free-agent-connect-guide-v1', async db => {
      await db.query(`UPDATE agents agent SET soul=jsonb_set(agent.soul,'{instructions}',
        to_jsonb((agent.soul->>'instructions') || E'\\n\\n' || $1::text)),updated_at=now()
        FROM free_agents free WHERE agent.agent_id=free.agent_id
        AND jsonb_typeof(agent.soul->'instructions')='string'
        AND strpos(agent.soul->>'instructions',$1)=0`, [FREE_AGENT_CONNECT_GUIDE]);
    }));
  await dataStep('durable phone sessions', () =>
    workflowBackfillOnce(database, 'durable-phone-sessions-v1', async db => {
      await db.query("UPDATE phone_sessions SET expires_at='9999-12-31T23:59:59Z'");
    }));
  await dataStep('one system thread', () =>
    workflowBackfillOnce(database, 'one-system-thread-v1', retireBotDirectMessages));
  await dataStep('browser observations', () =>
    workflowBackfillOnce(database, 'computer-observations-v1', backfillComputerObservations));
  const searchDocuments = await backfillMessageSearchDocuments(database, 200, true);
  await dataStep('Squire approval expiry backfill', () => backfillSquireApprovalExpiry(database));
  await dataStep('webhook payload and retention', () =>
    workflowBackfillOnce(database, 'webhook-retention-v1', compactWebhookDeliveries));
  await dataStep('archived corner assignments', () =>
    workflowBackfillOnce(database, 'archived-corner-assignments-v1', cancelArchivedCornerAssignments));
  await dataStep('archived corner wakes', () =>
    workflowBackfillOnce(database, 'archived-corner-wakes-v1', deleteArchivedCornerWakeSources));
  await dataStep('connected app dispatch placeholders', () =>
    workflowBackfillOnce(database, 'connected-app-placeholders-v1', clearConnectedAppPlaceholders));
  await dataStep('terminal push claims', () =>
    workflowBackfillOnce(database, 'terminal-push-claims-v1', compactPushClaims));
  if (searchDocuments)
    console.log(`backfillMessageSearchDocuments: filled ${searchDocuments} message row(s)`);
  await dataStep('corner owed backfill', () => backfillCornerOwed(database));
  await dataStep('continuous corner names', () =>
    workflowBackfillOnce(database, 'corner-names-continuous-v1', hyphenateCornerNames));
  await dataStep('corner follows backfill', () =>
    workflowBackfillOnce(database, 'corner-follows-v1', backfillCornerFollows));
  await dataStep('corner person state migration', () => migrateCornerPersonState(database));
  await dataStep('single subscription store', () => migrateMembershipSubscriptions(database));
  await dataStep('remove corner memberships', () => removeCornerMemberships(database));
  await dataStep('rooms MCP preregistered clients', () => seedPreregisteredMcpClients(database));
  const mcpMembers = await dataStep('rooms MCP members', () => backfillMcpMembers(database));
  if (mcpMembers) console.log(`backfillMcpMembers: created ${mcpMembers} member(s)`);
  await dataStep('rooms MCP member public Rooms and logos', () =>
    workflowBackfillOnce(database, 'rooms-mcp-member-public-rooms-v1', backfillMcpMemberRoomsAndAvatars));
  await dataStep('rooms MCP app default pictures', () =>
    workflowBackfillOnce(database, 'rooms-mcp-app-default-pictures-v2', backfillMcpMemberRoomsAndAvatars));
  // ChatGPT moves from Dots to the OpenAI mark; Cursor and apps without a logo get the bot face.
  await dataStep('rooms MCP app logo pictures', () =>
    workflowBackfillOnce(database, 'rooms-mcp-app-default-pictures-v3', backfillMcpMemberRoomsAndAvatars));
  await dataStep('stored corner workflows', () => deleteStoredCornerWorkflows(database));
  await dataStep('corner lifecycle runs', () => backfillCornerLifecycleRuns(database));
  await dataStep('feedback triage workflow', () =>
    workflowBackfillOnce(database, 'feedback-triage-prompt-cases-v1', backfillFeedbackTriageWorkflow));
  await dataStep('feedback triage latest counts', () =>
    workflowBackfillOnce(database, 'feedback-triage-latest-count-v1', backfillFeedbackTriageWorkflow));
  await dataStep('welcome video workflow', () =>
    workflowBackfillOnce(database, 'welcome-video-v2', backfillWelcomeVideoWorkflow));
  await dataStep('feedback signal walk', () =>
    workflowBackfillOnce(database, 'feedback-signal-walk-v1', backfillFeedbackSignalWalk));
  await dataStep('workspace walk history', () =>
    workflowBackfillOnce(database, 'workspace-walk-history-v1', backfillWorkspaceWalkHistory));
  await dataStep('workflow skill summary/does', () =>
    workflowBackfillOnce(database, 'workflow-descriptions-v1', backfillWorkflowSkillDescriptions));
  await dataStep('repair workflow step descriptions', () =>
    workflowBackfillOnce(database, 'workflow-descriptions-v2', backfillWorkflowSkillDescriptions));
  await dataStep('stale workflow gate choices', () =>
    workflowBackfillOnce(database, 'stale-workflow-gates-v1', closeStaleWorkflowGateChoices));
  await dataStep('workflow run storage', () =>
    workflowBackfillOnce(database, 'workflow-storage-v1', normalizeLegacyWorkflowRuns));
  await dataStep('workflow run status', () => saveUnsavedWorkflowRunStatus(database));
  await dataStep('abandoned workflow endings', () =>
    workflowBackfillOnce(database, 'abandoned-workflow-endings-v1', reportAbandonedWorkflowEndings));
  // A timer lost after any release stalls its run; re-arm missing ones every boot.
  const syncedRoomRoles = await dataStep('top-level Room roles', () =>
    syncTopLevelSharedRoomRoles(database));
  console.log(`syncTopLevelSharedRoomRoles: updated ${syncedRoomRoles} stale Room role(s)`);
  await dataStep('system event kinds', () => backfillSystemEventKinds(database));
  const strippedSubscriptions = await dataStep('per-item event subscriptions', () =>
    backfillPerItemEventSubscriptions(database));
  if (strippedSubscriptions)
    console.log(
      `backfillPerItemEventSubscriptions: stripped per-item kinds from ${strippedSubscriptions} membership row(s)`,
    );
  await dataStep('system identity avatar', () => database.query(
    `UPDATE identities SET avatar='/v1/connectors/logo/system.svg',updated_at=now()
     WHERE id=$1 AND avatar IS DISTINCT FROM '/v1/connectors/logo/system.svg'`,
    [SYSTEM_IDENTITY_ID],
  ));
  // The shared Welcome Workspace is no longer reseeded at boot; a release-
  // owned step retires it (welcome-retirement.ts, run from index.ts).
  await dataStep('institutional rollout', () => backfillInstitutionalMemoryRollout(database));
  await dataStep('institutional memory lifecycle', async () => {
    await retireStandingPreferences(database);
    await database.query(`WITH RECURSIVE explicit_chain AS (
        SELECT id FROM institutional_memory_items WHERE created_by_command_id IS NOT NULL
        UNION
        SELECT newer.id FROM institutional_memory_items newer
        JOIN explicit_chain older ON newer.supersedes_id=older.id
      )
      UPDATE institutional_memory_items SET explicit_save=true
      WHERE id IN (SELECT id FROM explicit_chain) AND explicit_save=false`);
    // The old curator marked items stale after 30 unused days. Those rows only
    // aged out, so they come back under the new rule (agent saves expire after
    // 90 unused days, explicit saves never)
    // instead of being blanked. A row that was superseded, whose key has a
    // current row, or whose source was deleted is really gone.
    await database.query(`WITH aged AS (
        SELECT DISTINCT ON (item.workspace_id,item.kind,COALESCE(item.subject_identity_id,''),
                            item.canonical_key,item.audience_kind) item.id
        FROM institutional_memory_items item
        WHERE item.state IN ('stale','archived') AND item.deleted_at IS NULL AND item.body<>''
          AND NOT EXISTS (SELECT 1 FROM institutional_memory_items newer
            WHERE newer.supersedes_id=item.id)
          AND NOT EXISTS (SELECT 1 FROM institutional_memory_items current
            WHERE current.state='active' AND current.workspace_id=item.workspace_id
              AND current.kind=item.kind
              AND COALESCE(current.subject_identity_id,'')=COALESCE(item.subject_identity_id,'')
              AND current.canonical_key=item.canonical_key
              AND current.audience_kind=item.audience_kind)
          AND NOT EXISTS (SELECT 1 FROM institutional_memory_item_sources source
            JOIN messages message ON message.id=source.message_id
            WHERE source.item_id=item.id AND message.deleted_at IS NOT NULL)
        ORDER BY item.workspace_id,item.kind,COALESCE(item.subject_identity_id,''),
                 item.canonical_key,item.audience_kind,item.updated_at DESC,item.id
      )
      UPDATE institutional_memory_items item SET state='active'
      FROM aged WHERE item.id=aged.id`);
    await database.query(`UPDATE institutional_memory_items
      SET body='',deleted_at=COALESCE(deleted_at,now()),state='stale'
      WHERE state<>'active' AND (body<>'' OR deleted_at IS NULL OR state='archived')`);
    await database.query(`ALTER TABLE institutional_memory_items
      DROP CONSTRAINT IF EXISTS institutional_memory_items_state_check`);
    await database.query(`ALTER TABLE institutional_memory_items
      ADD CONSTRAINT institutional_memory_items_state_check CHECK (state IN ('active','stale','archived')) NOT VALID`);
    await database.query(`ALTER TABLE institutional_memory_items VALIDATE CONSTRAINT institutional_memory_items_state_check`);
    await database.query(`UPDATE workspace_skills SET state='stale'
      WHERE state='archived'`);
    await database.query(`ALTER TABLE workspace_skills
      DROP CONSTRAINT IF EXISTS workspace_skills_state_check`);
    await database.query(`ALTER TABLE workspace_skills
      ADD CONSTRAINT workspace_skills_state_check CHECK (state IN ('active','stale','archived')) NOT VALID`);
    await database.query(`ALTER TABLE workspace_skills VALIDATE CONSTRAINT workspace_skills_state_check`);
    await database.query(`UPDATE institutional_memory_jobs
      SET status='dead',error='curator model jobs removed',updated_at=now()
      WHERE trigger_kind='curator' AND status IN ('pending','retry','claimed')`);
  });
  await backfillAgentHandles(database);
  await dataStep('connector machine IDs', () => backfillConnectorMachineId(database));
  await dataStep('registry apps', () => backfillRegistryApps(database));
  await dataStep('grant policy', () => upgradeGrantPolicy(database));
  const withdrawn = await dataStep('superseded grant asks', () =>
    withdrawSupersededGrantAsks(database));
  if (withdrawn) console.log(`withdrawSupersededGrantAsks: withdrew ${withdrawn} pending ask(s)`);
}
