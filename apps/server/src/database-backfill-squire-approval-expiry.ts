import { INSTITUTIONAL_HISTORY_MAX_AGE_DAYS, INSTITUTIONAL_MEMORY_KEYWORD_PATTERN, INSTITUTIONAL_MEMORY_KEYWORDS_MAX, INSTITUTIONAL_MEMORY_STOPWORDS, INSTITUTIONAL_RETIRED_STANDING_KEY } from '@beeline/api-contract/daemon';
import { SCHEDULE_RAN_VERB } from '@beeline/api-contract/scheduled-prompts';
import { PER_ITEM_EVENT_KINDS, uniqueAgentHandle } from '@beeline/api-contract/phone';
import { perItemMembershipSubscriptionCleanupSql } from './membership-join.js';
import { TERMINAL_PUSH_CLAIMS_SQL } from './push-claim-cleanup.js';
import { cornerOwedBackfillSql } from './corner-owed.js';
import { runMigrationStep } from './migration-steps.js';
import { SqlDatabase, QueryResult } from './database.js';
import { messageSearchDocumentSql } from './message-search-document-sql.js';



/** Give pre-expiry Squire cards a bounded life, retaining their message history. */
export async function backfillSquireApprovalExpiry(database: SqlDatabase): Promise<number> {
  const result = await database.query(
    `UPDATE messages approval SET card=approval.card || jsonb_build_object(
       'expiresAt',floor(extract(epoch FROM approval.created_at + interval '24 hours')*1000)::bigint,
       'status',CASE WHEN approval.created_at <= now()-interval '24 hours'
         THEN 'expired' ELSE COALESCE(approval.card->>'status','pending') END)
     WHERE approval.card_type='squire-approval'
       AND approval.deleted_at IS NULL
       AND approval.card->>'approvalId' IS NOT NULL
       AND approval.card->>'sourceRoomId' ~ '^[0-9a-f-]{36}$'
       AND approval.card->>'expiresAt' IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM messages decision
         WHERE decision.room_id=(approval.card->>'sourceRoomId')::uuid
           AND decision.card_type='squire-approval-decision'
           AND decision.card->>'approvalId'=approval.card->>'approvalId'
       )`,
  );
  return result.rowCount;
}


/** The first distinct words of a body that can serve as its keywords. */
export function keywordsFromBody(body: string): string[] {
  const words = body.toLocaleLowerCase('en-US').split(/[^a-z0-9_]+/);
  const keywords = [...new Set(words)].filter(
    (word) =>
      INSTITUTIONAL_MEMORY_KEYWORD_PATTERN.test(word) && !INSTITUTIONAL_MEMORY_STOPWORDS.has(word),
  );
  return keywords.length ? keywords.slice(0, INSTITUTIONAL_MEMORY_KEYWORDS_MAX) : ['preference'];
}


/**
 * The standing preference used to go into every prompt for its person. It is
 * gone, so each old row becomes an ordinary explicit profile fact under an
 * ordinary key, keeping its version chain, and loads only when a request
 * matches its keywords or meaning. The embed cycle fills its embedding.
 * Idempotent: an older server image in a rolling deploy may still write a
 * `standing` row, and the next boot converts it.
 */
export async function retireStandingPreferences(database: SqlDatabase): Promise<number> {
  // Every `standing` row of one person shares one destination key, so a
  // version chain stays under a single key even when that person already has
  // a `standing-preference` item. The embedding covered the old key, so it is
  // cleared and the embed cycle computes a fresh one.
  const renamed = await database.query(
    `WITH destination AS (
       SELECT old.workspace_id,old.kind,old.subject_identity_id,old.audience_kind,
         'standing-preference' || CASE WHEN EXISTS (
           SELECT 1 FROM institutional_memory_items taken
           WHERE taken.workspace_id=old.workspace_id AND taken.kind=old.kind
             AND taken.subject_identity_id IS NOT DISTINCT FROM old.subject_identity_id
             AND taken.audience_kind=old.audience_kind
             AND taken.canonical_key='standing-preference')
         THEN '-' || left(min(old.id::text),8)
         ELSE '' END AS canonical_key
       FROM institutional_memory_items old
       WHERE old.canonical_key=$1
       GROUP BY old.workspace_id,old.kind,old.subject_identity_id,old.audience_kind
     )
     UPDATE institutional_memory_items item
     SET canonical_key=destination.canonical_key,
         explicit_save=true,
         embedding=NULL,
         embedding_model=NULL,
         embedded_at=NULL
     FROM destination
     WHERE item.canonical_key=$1
       AND item.workspace_id=destination.workspace_id AND item.kind=destination.kind
       AND item.subject_identity_id IS NOT DISTINCT FROM destination.subject_identity_id
       AND item.audience_kind=destination.audience_kind`,
    [INSTITUTIONAL_RETIRED_STANDING_KEY],
  );
  const empty = await database.query<{ id: string; body: string }>(
    `SELECT id,body FROM institutional_memory_items
     WHERE canonical_key LIKE 'standing-preference%' AND keywords='{}'
       AND state='active' AND deleted_at IS NULL`,
  );
  for (const row of empty.rows) {
    await database.query(`UPDATE institutional_memory_items SET keywords=$2 WHERE id=$1`, [
      row.id,
      keywordsFromBody(row.body),
    ]);
  }
  if (renamed.rowCount) {
    console.log(`retireStandingPreferences: converted ${renamed.rowCount} standing row(s)`);
  }
  return renamed.rowCount ?? 0;
}


export const MESSAGE_SEARCH_BACKFILL_BATCH = 2_000;


/**
 * Fill exact and stemmed documents for rows written before either trigger version.
 *
 * Only rows `searchInstitutionalHistory` can ever return are filled: it matches
 * `presentation='message'` inside INSTITUTIONAL_HISTORY_MAX_AGE_DAYS, and a row
 * older than that window today can never re-enter it, so a document for one is
 * work with no reader. The release data stage keeps this work out of DDL
 * retries and commits each batch before starting the next. The partial index
 * makes a converged probe cheap even when older rows remain unfilled.
 */
export async function backfillMessageSearchDocuments(
  database: SqlDatabase,
  batchSize = MESSAGE_SEARCH_BACKFILL_BATCH,
  bounded = false,
): Promise<number> {
  let filled = 0;
  for (;;) {
    let updated: { rowCount: number } | undefined;
    await runMigrationStep('message search backfill batch', async () => {
      const run = (db: SqlDatabase) => db.query(
        `UPDATE messages SET search_document=${messageSearchDocumentSql('')},
                            search_stem_document=${messageSearchDocumentSql('', 'english')}
       WHERE id IN (
         SELECT id FROM (
           SELECT id,created_at FROM messages
           WHERE search_document IS NULL AND presentation='message'
             AND created_at>=now()-$1*interval '1 day'
           UNION
           SELECT id,created_at FROM messages
           WHERE search_stem_document IS NULL AND presentation='message'
             AND created_at>=now()-$1*interval '1 day'
         ) missing
         ORDER BY created_at DESC LIMIT $2)`,
        [INSTITUTIONAL_HISTORY_MAX_AGE_DAYS, batchSize],
      );
      updated = bounded
        ? await database.transaction(async (transaction) => {
            await transaction.query(`SET LOCAL statement_timeout='10000ms'`);
            await transaction.query(`SET LOCAL lock_timeout='500ms'`);
            return run(transaction);
          })
        : await run(database);
    });
    filled += updated!.rowCount;
    if (updated!.rowCount < batchSize) return filled;
  }
}


/**
 * A CONCURRENTLY build cancelled mid-flight — the release's own timeout is the
 * ordinary way — leaves an INVALID index behind, and `IF NOT EXISTS` would then
 * skip it forever while every reader silently seq-scans. Drop that carcass
 * first; a valid index is left alone.
 */
export async function createIndexConcurrently(
  database: SqlDatabase,
  name: string,
  create: string,
): Promise<void> {
  const existing = await database.query<{ valid: boolean }>(
    `SELECT indisvalid valid FROM pg_index
     WHERE indexrelid=to_regclass($1) AND to_regclass($1) IS NOT NULL`,
    [name],
  );
  const state = existing.rows[0];
  if (state?.valid) return;
  // These indexes also enforce write admission. A failed build must fail
  // the migration before its schema-ready marker can advance.
  if (state) await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
  await database.query(create);
}


/** Backfill machine_id on legacy workspace_connectors rows. */
export async function backfillConnectorMachineId(database: SqlDatabase): Promise<number> {
  const changed = await boundedMigrationUpdate(database, 'connector machine IDs',
    `UPDATE workspace_connectors c SET machine_id=COALESCE(
       (SELECT a.machine_id FROM agents a WHERE a.agent_id=c.helper_agent_id),
       c.helper_agent_id
     ) WHERE c.id IN (SELECT id FROM workspace_connectors
       WHERE machine_id IS NULL ORDER BY id LIMIT $1)`,
  );
  if (changed > 0)
    console.log(`backfillConnectorMachineId: set ${changed} connector machine_id(s)`);
  return changed;
}


export async function boundedMigrationUpdate(
  database: SqlDatabase,
  name: string,
  sql: string,
  values: unknown[] = [],
  batchSize = 200,
): Promise<number> {
  let changed = 0;
  for (;;) {
    let count = 0;
    await runMigrationStep(name, async () => {
      count = (await database.transaction(async (transaction) => {
        await transaction.query(`SET LOCAL statement_timeout='10000ms'`);
        await transaction.query(`SET LOCAL lock_timeout='500ms'`);
        return transaction.query(sql, [...values, batchSize]);
      })).rowCount;
    });
    changed += count;
    if (count < batchSize) return changed;
  }
}


/** Expire old deliveries without one long row lock. */
export async function compactWebhookDeliveries(database: SqlDatabase): Promise<void> {
  const expired = await boundedMigrationUpdate(database, 'expired webhook deliveries',
    `DELETE FROM github_webhook_deliveries delivery
     WHERE delivery.delivery_id IN (
       SELECT delivery_id FROM github_webhook_deliveries
       WHERE received_at<now()-interval '30 days'
       ORDER BY received_at,delivery_id LIMIT $1 FOR UPDATE SKIP LOCKED)`, [], 1000);
  if (expired) console.log(`compactWebhookDeliveries: expired ${expired}`);
}


export async function compactPushClaims(database: SqlDatabase): Promise<void> {
  const cleared = await boundedMigrationUpdate(database, 'terminal push claims',
    TERMINAL_PUSH_CLAIMS_SQL, [], 1000);
  if (cleared) console.log(`compactPushClaims: expired ${cleared} claim(s)`);
}


/**
 * Replaces legacy/random agent addresses with deterministic name-derived ones.
 * Each candidate is reserved in every Workspace the agent currently belongs
 * to, so two unrelated Workspaces may use the same address while duplicates
 * inside either roster receive deterministic numeric suffixes.
 */



/**
 * Institutional memory is on by default, so every Workspace is enrolled at the
 * `live` stage unless an operator explicitly turned it `off`/`paused`. Existing
 * staged rows migrate to `live`; a Workspace with no row gets one. Idempotent:
 * the explicit off switches survive, and re-running touches nothing else.
 */
export async function backfillInstitutionalMemoryRollout(database: SqlDatabase): Promise<number> {
  const advanced = await database.query(
    `UPDATE institutional_memory_workspace_rollouts
     SET stage='live',updated_at=now()
     WHERE stage IN ('shadow','pilot')`,
  );
  const enrolled = await database.query(
    `INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage)
     SELECT id,'live' FROM workspaces
     ON CONFLICT (workspace_id) DO NOTHING`,
  );
  const changed = advanced.rowCount + enrolled.rowCount;
  if (changed)
    console.log(
      `backfillInstitutionalMemoryRollout: advanced ${advanced.rowCount}, enrolled ${enrolled.rowCount} Workspace rollout(s)`,
    );
  return changed;
}


/**
 * Scheduled-prompt lines predate the `kind` beside their verb. They are the one
 * shape a live subscriber can already be waiting on, so they are stamped; older
 * join/corner/check lines get nothing, because no subscriber can want an event
 * that already happened. Idempotent through the `IS NULL` guard.
 */
export async function backfillSystemEventKinds(database: SqlDatabase): Promise<void> {
  await boundedMigrationUpdate(database, 'system event kinds',
    `UPDATE messages SET system_event = system_event || jsonb_build_object('kind','schedule-ran')
     WHERE id IN (SELECT id FROM messages WHERE system_event->>'verb'=$1
       AND system_event->>'kind' IS NULL ORDER BY id LIMIT $2)`,
    [SCHEDULE_RAN_VERB],
  );
}


/**
 * Strips every `PER_ITEM_EVENT_KINDS` entry out of `memberships.event_subscriptions`.
 *
 * A per-item kind answers one ask and already wakes its owner directly
 * (`wakes: [...]` at the call site); a Room-wide subscription to one, left
 * over from before `subscribe_events` refused them, would wake the subscriber
 * on every OTHER agent's item forever. `subscribers()` and the corner
 * membership copy both ignore these kinds regardless, so this is cleanup for
 * `list_event_subscriptions` and any future direct read of the column, not a
 * correctness fix on its own. Idempotent: the `?|` predicate selects nothing
 * once every row's array is clean.
 */
export async function backfillPerItemEventSubscriptions(database: SqlDatabase): Promise<number> {
  return boundedMigrationUpdate(database, 'per-item event subscriptions',
    perItemMembershipSubscriptionCleanupSql(),
    [PER_ITEM_EVENT_KINDS],
  );
}


/**
 * Older corners predate an explicit owner fact. The creating agent is authoritative
 * when present; imported/legacy corners fall back to their first agent-authored post.
 */
/**
 * Fill `corner_owed` from messages until the release that adds it is marked
 * current (schema 17), so corners already owing someone keep reading so.
 * Its triggers keep it current after that; a rerun before the marker only
 * re-adds rows that are still owed.
 */
export async function backfillCornerOwed(database: SqlDatabase): Promise<void> {
  const marked = await database.query<{ marked: boolean }>(
    `SELECT to_regclass('beeline_schema_state') IS NOT NULL marked`,
  );
  if (marked.rows[0]?.marked) {
    const current = await database.query<{ version: number }>(
      `SELECT version FROM beeline_schema_state`,
    );
    if ((current.rows[0]?.version ?? 0) >= 26) return;
  }
  await database.query(cornerOwedBackfillSql());
}


export async function measureDatabase(database: SqlDatabase): Promise<{
  tables: Array<{ name: string; bytes: number }>;
  totalBytes: number;
  fitsNeonFree: boolean;
}> {
  const result = await database.query<{ name: string; bytes: string }>(`
    SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);
  const tables = result.rows.map((row) => ({ name: row.name, bytes: Number(row.bytes) }));
  const totalBytes = tables.reduce((sum, row) => sum + row.bytes, 0);
  return { tables, totalBytes, fitsNeonFree: totalBytes < 500_000_000 };
}


export async function measureDatabaseBreakdown(database: SqlDatabase): Promise<{
  topTables: Array<{ name: string; bytes: number }>;
  eventTypes: Array<{ type: string; rows: number; logicalBytes: number }>;
  media: Array<{ type: string; objects: number; bytes: number }>;
}> {
  const total = await measureDatabase(database);
  const events = await database.query<{ type: string; rows: string; logical_bytes: string }>(`
    WITH message_types AS (
      SELECT CASE
        WHEN m.presentation='activity' THEN 'activity'
        WHEN m.durable_fact IS NOT NULL OR m.card_type IN ('daemon-fact','github-event','corner','target-branch') THEN 'facts'
        WHEN i.kind='human' AND m.presentation='message' THEN 'human-messages'
        WHEN i.kind='agent' AND m.presentation='message' THEN 'agent-messages'
        WHEN m.legacy_event->>'retired'='true' THEN 'retired-kinds'
        ELSE 'other-kept-events' END type, pg_column_size(m)::bigint bytes
      FROM messages m JOIN identities i ON i.id=m.author_id
    ), operational AS (
      SELECT 'receipts' type,pg_column_size(t)::bigint bytes FROM agent_turns t
      UNION ALL SELECT 'presence-adjacent',pg_column_size(l)::bigint FROM live_outputs l
    )
    SELECT type,count(*)::text rows,sum(bytes)::text logical_bytes FROM (SELECT message_types.* FROM message_types UNION ALL SELECT operational.* FROM operational) typed GROUP BY type ORDER BY sum(bytes) DESC,type`);
  const media = await database.query<{ type: string; objects: string; bytes: string }>(`
    WITH refs AS (
      SELECT DISTINCT (regexp_match(candidate.url,'/v1/media/([0-9a-f-]+)$'))[1] id
      FROM messages m CROSS JOIN LATERAL jsonb_array_elements(m.attachments) a
      CROSS JOIN LATERAL (VALUES(a->>'url'),(a->>'thumbnailUrl')) candidate(url)
      WHERE candidate.url ~ '/v1/media/[0-9a-f-]+$'
    ), classified AS (
      SELECT o.size::bigint bytes,
        CASE WHEN refs.id IS NOT NULL THEN 'referenced-by-kept-message'
          WHEN COALESCE(o.title,'') ~* '(canary|test|fixture|sample|probe)' THEN 'orphan-likely-canary-or-test'
          ELSE 'orphan-unreferenced' END type
      FROM objects o LEFT JOIN refs ON refs.id=o.id::text
    ) SELECT type,count(*)::text objects,sum(bytes)::text bytes FROM classified GROUP BY type ORDER BY sum(bytes) DESC,type`);
  const eventByType = new Map(
    events.rows.map((row) => [
      row.type,
      { type: row.type, rows: Number(row.rows), logicalBytes: Number(row.logical_bytes) },
    ]),
  );
  const mediaByType = new Map(
    media.rows.map((row) => [
      row.type,
      { type: row.type, objects: Number(row.objects), bytes: Number(row.bytes) },
    ]),
  );
  return {
    topTables: total.tables.sort((left, right) => right.bytes - left.bytes).slice(0, 10),
    eventTypes: [
      'human-messages',
      'agent-messages',
      'receipts',
      'activity',
      'facts',
      'presence-adjacent',
      'retired-kinds',
      'other-kept-events',
    ].map((type) => eventByType.get(type) ?? { type, rows: 0, logicalBytes: 0 }),
    media: [
      'referenced-by-kept-message',
      'orphan-unreferenced',
      'orphan-likely-canary-or-test',
    ].map((type) => mediaByType.get(type) ?? { type, objects: 0, bytes: 0 }),
  };
}
