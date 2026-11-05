import '../../apps/server/scripts/test-event-loop.js';
import { readFile } from "node:fs/promises";
import { priorReleaseCornerListSql } from "../../apps/server/src/fixtures/sentry-22-load-corners.js";
import { EventEmitter } from "node:events";
import { INSTITUTIONAL_HISTORY_MAX_AGE_DAYS } from "@beeline/api-contract/daemon";
import { DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID } from "@beeline/api-contract/phone";
import { DatabaseTransactionStartError, backfillAgentHandles, backfillMessageSearchDocuments, MESSAGE_SEARCH_DOCUMENT_MAX_BYTES, backfillInstitutionalMemoryRollout, backfillPerItemEventSubscriptions, MESSAGE_CURSOR_MS_SQL, APP_POOL_WAIT_TIMEOUT_MS, APP_STATEMENT_TIMEOUT_MS, ENRICHMENT_POOL_WAIT_TIMEOUT_MS, ENRICHMENT_STATEMENT_TIMEOUT_MS, REQUIRED_SCHEMA_VERSION, REQUIRED_ROUTER_SCHEMA_VERSION, HEALTH_POOL_WAIT_TIMEOUT_MS, MIGRATION_LOCK_TIMEOUT_MS, MIGRATION_STATEMENT_TIMEOUT_MS, isTransientDatabaseConnectionError } from "../../apps/server/src/database.js";
import { requireRoomSlug, reserveRoomName } from "../../apps/server/src/room-names.js";
import { BackgroundJobRunner, MediaExpiryLoop, PushDeliveryLoop } from "../../apps/server/src/background.js";
import { repairDeadlineFamilies, registerBackgroundDeadlineFamilies, subscribeBackgroundFamilies, BackgroundRecordDeadlines } from "../../apps/server/src/background-deadlines.js";
import { NextDayCheckin } from "../../apps/server/src/next-day-checkin.js";
import { FreeAgentService, freeAgentConfigFromEnv } from "../../apps/server/src/free-agents.js";
import type { FreeAgentMachines } from "../../apps/server/src/fly-machines.js";
import { notifyCommandCompletion } from "../../apps/server/src/command-completion.js";
import { backgroundDatabaseCut, backgroundNextDelay } from "../../apps/server/src/background-deadline-clock.js";
import { groupBPostgresDatabase } from "../../apps/server/src/test-fixtures/test-support-router-group-b-postgres.js";
import { PhoneService } from "../../apps/server/src/phone-service.js";
import { INSTITUTIONAL_MEMORY_ON } from "../../apps/server/src/institutional-memory-shadow.js";
import { LIVE_REPLAY_BYTE_LIMIT, LIVE_REPLAY_LIMIT } from "../../apps/server/src/durable-live.js";
import type { HelperOverlayFrame } from "@beeline/api-contract/helper-overlay";
import { HELPER_OVERLAY_SCHEMA, HelperOverlayViewer, applyHelperOverlay, fenceHelperOverlayEnqueue, subscribeHelperOverlayDemand } from "../../apps/server/src/helper-overlay.js";
import { type LiveEvent } from "../../apps/server/src/live.js";
import { postgresLiveSchema, PostgresLiveListener } from "../../apps/server/src/postgres-live.js";
import { HelperOverlayOwner } from "../../apps/body/src/helper-overlay.js";
import { insertCornerFacts } from "../../apps/server/src/test-support.js";
import type { GitHubAppClient, GitHubOAuthClient } from "@beeline/auth/github";
import { GitHubOperations } from "../../apps/server/src/github-operations.js";
import { systemLine } from "../../apps/server/src/system-line.js";
import { TokenAuth } from "../../apps/server/src/auth.js";
import { flushSentryWakes, runSentryWakeDeadline } from "../../apps/server/src/sentry-wake.js";
import { generateKeypair, nip98AuthHeader } from "@beeline/nostr";
import { createBeelineServer, type ServerOptions } from "../../apps/server/src/server.js";
import { alreadyNoOp, alreadySatisfied, normalizeDefault, lockedTables, noOpCheck, logLockHolders, normalizeTriggerDefinition, runMigrationStep, satisfiedCheck, splitMigrationStatements, triggerAlreadyCurrent, triggerPair } from "../../apps/server/src/migration-steps.js";
import { type QueryResultRow } from "pg";
import { OwnedModelCredentials, OWNED_MODEL_UNKNOWN_GENERATION_MESSAGE } from "../../apps/server/src/owned-model-credential.js";
import { MODEL_KEY } from "../../apps/server/src/test-fixtures/owned-model.js";
import { ROUTER_AUTHORITY_LOCK } from "../../apps/server/src/router-authority-lock.js";
import { sealSecrets, tokenHash } from "../../apps/server/src/free-agents.js";
import { retireAgentFromWorkspace } from "../../apps/server/src/agent-retirement.js";
import { lockDaemonCredentialLifetime } from "../../apps/server/src/daemon-credential-lifetime.js";
import { MODEL_OWNER, MODEL_WORKSPACE } from "../../apps/server/src/test-fixtures/owned-model.js";
import { readFileSync } from "node:fs";
import { PendingAttachmentCleanupLoop } from "../../apps/server/src/pending-attachment-cleanup.js";
import { DISPLAY_DEADLINE_KEY } from "../../apps/server/src/deadline-expiry-source.js";
import { SENTRY_TRIAGE_ROOM, sentryEligibilityKey } from "../../apps/server/src/sentry-wake-source.js";
import { PENDING_ATTACHMENT_DUE_KEY } from "../../apps/server/src/pending-attachment-source.js";
import { AGENT_SCHEDULE_DUE_KEY } from "../../apps/server/src/agent-schedule-source.js";
import { COMMAND_COMPLETION_CHANNEL, subscribeCommandCompletion } from "../../apps/server/src/command-completion.js";
import { DeadlineExpiry } from "../../apps/server/src/deadline-expiry.js";
import { announceAgentLifecycle, claimAgentConnection, ConnectionPresence } from "../../apps/server/src/connection-presence.js";
import { notifyAgentConfigChange, notifyConnectorAssignment, POSTGRES_LIVE_CHANNEL, type LivePgClient } from "../../apps/server/src/postgres-live.js";
import { seedCornerOpening, assignCornerWorker, recordCornerRun } from "../../apps/server/src/test-support.js";
import { MCP_WEBHOOK_TABLE } from "../../apps/server/src/rooms-mcp-members.js";
import { cornerCommissionerSql } from "../../apps/server/src/corner-opening.js";
import { backfillPushOutbox } from "../../apps/server/src/push-outbox.js";
import * as sentry from "../../apps/server/src/sentry.js";
import { Client } from "pg";
import { AuthStore, type BindTicket } from "../../apps/auth/src/store.js";
import { waitForAuthTicket } from "../../apps/auth/src/completion-wait.js";
import { type CommandCompletionKey } from "../../apps/server/src/command-completion.js";
import { createServer, request as httpRequest, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { ROOMS_MCP_SCHEMA } from "../../apps/server/src/rooms-mcp-schema.js";
import { RoomsMcpOAuth } from "../../apps/server/src/rooms-mcp-oauth.js";
import type { RouterSnapshot } from "@beeline/api-contract/router-protocol";
import { routerSourcePlan } from "../../apps/server/src/router-source-plan.js";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { TrayChoiceClockOwner } from "../../apps/server/src/tray-choice-clock-owner.js";
import { TRAY_CLOCK_OWNER_SCHEMA } from "../../apps/server/src/tray-clock-owner.js";
import { TRAY_CLOCK_SOURCE_SCHEMA } from "../../apps/server/src/tray-clock-source.js";
import { CHOICE_CARD_TYPE } from "@beeline/api-contract/phone";
import { skipRoomChoice } from "../../apps/server/src/room-choice.js";
import { dispatchTrayDecisionCommand } from "../../apps/server/src/tray-decision-command.js";
import { TRAY_MUTABLE_SOURCE_SCHEMA } from "../../apps/server/src/tray-mutable-source.js";
import { workflowRunLockKey } from "../../apps/server/src/workflow-runs.js";
import { BackgroundLeader } from "../../apps/server/src/background-leader.js";
import { BackgroundWork } from "../../apps/server/src/background-work.js";
import { type PoolClient } from "pg";
import { type SqlDatabase } from "../../apps/server/src/database.js";
import { BackgroundOwnership, BACKGROUND_OWNERSHIP_SCHEMA, BACKGROUND_LEADER_LOCK_KEY, BackgroundOwnershipLost, type BackgroundEpoch, type BackgroundEffectRequest } from "../../apps/server/src/background-ownership.js";
import type { CommandActivationInput } from "@beeline/api-contract/helper-activation";
import { HELPER_ACTIVATION_SCHEMA } from "../../apps/server/src/helper-activation-schema.js";
import { captureCommandActivation, fenceCommandActivationEnqueue, type ActivationReader } from "../../apps/server/src/helper-activation.js";
import { TURN_OWNERSHIP_SCHEMA } from "../../apps/server/src/turn-ownership.js";
import { CommandActivationContext } from "../../apps/body/src/helper-activation-context.js";
import { createHash } from "node:crypto";
import type { AgentUsage } from "@beeline/api-contract/daemon";
import { canonicalUsageAccountSnapshot } from "@beeline/api-contract/helper-usage";
import { DURABLE_LIVE_SCHEMA } from "../../apps/server/src/durable-live.js";
import { HELPER_USAGE_SCHEMA, fenceAgentUsageCellEnqueue, publishUsageAccount, readAgentUsageCell } from "../../apps/server/src/helper-usage.js";
import { ROUTER_PROJECTION_SCHEMA } from "../../apps/server/src/router-projection-schema.js";
import { OwnedModelAttempts } from "../../apps/server/src/owned-model-attempt.js";
import { parkOwnedModelTerminal } from "../../apps/server/src/owned-model-parking.js";
import { MODEL, MODEL_AGENT, MODEL_CLAIM, MODEL_ROOM, MODEL_SOURCE, seedOwnedModelFixture } from "../../apps/server/src/test-fixtures/owned-model.js";
import { MEDIA_AUTHORITY_SCHEMA } from "../../apps/server/src/media-authority-schema.js";
import { readMediaMetadata, fenceMediaMetadataEnqueue } from "../../apps/server/src/phone-media.js";
import { subscribeAuthorityFences, currentAuthorityFence } from "../../apps/server/src/router-authority-fences.js";
import { readRouterAuthority } from "../../apps/server/src/router-projections.js";
import { LiveHub } from "../../apps/server/src/live.js";
import { vi } from "vitest";
import { RouterCommandLedger, ROUTER_COMMAND_SCHEMA, CommandDigestConflict } from "../../apps/server/src/router-command-ledger.js";
import { DaemonService } from "../../apps/server/src/daemon-service.js";
import { lockCornerLifecycle } from "../../apps/server/src/corner-lifecycle.js";
import { cancelCornerAgentCommands } from "../../apps/server/src/corner-close.js";
import { authorizeCommandOutput } from "../../apps/server/src/agent-command.js";
import { commandOwnerLiveSql } from "../../apps/server/src/turn-ownership.js";
import { VoiceAudioMeter, VoiceBudgetStore } from "../../apps/server/src/voice-budget.js";
import { describe } from 'vitest';
import { PgliteDatabase } from "../../apps/server/src/test-support.js";
import { migratedDatabase } from "../../apps/server/src/test-support.js";
import { cornerImplementerSql as oldWorker, cornerOwnerSql as oldOwner } from "../../apps/server/src/fixtures/rollout-0707-corner-worker.js";
import { cornerImplementerSql, cornerOwnerSql } from "../../apps/server/src/corner-worker.js";
import { starPromptReplySql } from "../../apps/server/src/github-star-prompt.js";
import { createAgentCommand, claimAgentCommand } from "../../apps/server/src/agent-command.js";
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  assertSchemaCurrent, markSchemaCurrent, migrate, migrateData, postgresPoolConfig, PostgresDatabase,
  type ClosableDatabase, type DatabaseFailureKind,
} from '../../apps/server/src/database.js';

vi.setConfig({ fakeTimers: { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] } });

const serverDatabaseUrl = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (!serverDatabaseUrl || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(serverDatabaseUrl).hostname))
  throw new Error('The server-db seam requires isolated loopback PostgreSQL');
const fixtureUrl = new URL(serverDatabaseUrl);
const name = `beeline_seam_${randomUUID().replaceAll('-', '')}`;
fixtureUrl.pathname = '/' + name;
const admin = new Pool({ connectionString: serverDatabaseUrl, max: 1 });
const observer = new Pool({ connectionString: fixtureUrl.href, max: 1 });
let pool: Pool;
let database: PostgresDatabase;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${name}`);
  const bootstrap = new PostgresDatabase(fixtureUrl.href, 2, { mode: 'migration' });
  try {
    await migrate(bootstrap);
    // The release owner stamps readiness after schema and data steps complete.
    await markSchemaCurrent(bootstrap);
  } finally { await bootstrap.close(); }
  await observer.query('CREATE TABLE seam_effects(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text)');
});
beforeEach(async () => {
  await observer.query('TRUNCATE seam_effects');
  pool = new Pool(postgresPoolConfig(fixtureUrl.href, 2));
  database = new PostgresDatabase('', 2, { pool });
});
afterEach(async () => { await database?.close(); });
afterAll(async () => {
  await observer.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
});

// Lose the reply after PostgreSQL commits the real effect. There is no unique
// constraint or in-memory effect counter that could conceal a replay.
async function lostReply(kind: DatabaseFailureKind, boundary: 'INSERT' | 'COMMIT') {
  await observer.query('TRUNCATE seam_effects');
  const failure = Object.assign(new Error('injected driver failure'), { code: kind === 'unknown' ? 'XX000' : kind });
  const connect = pool.connect.bind(pool);
  let lost = false;
  let acquisitions = 0;
  pool.connect = (async () => {
    acquisitions++;
    const client = await connect();
    const query = client.query.bind(client);
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (!lost && (boundary === 'COMMIT' ? sql === 'COMMIT' : sql.startsWith('INSERT'))) {
        lost = true;
        throw failure;
      }
      return result;
    }) as typeof client.query;
    return client;
  }) as typeof pool.connect;
  const insert = 'INSERT INTO seam_effects(value) VALUES($1) RETURNING id';
  const work = boundary === 'COMMIT'
    ? database.transaction(tx => tx.query(insert, ['committed']))
    : database.query(insert, ['committed']);
  await expect(work).rejects.toBe(failure);
  expect(lost).toBe(true);
  expect(acquisitions).toBe(1);
  expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'committed' }]);
}

type MigrationEntry = keyof Pick<typeof import('../../apps/server/src/database.js'),
  'migrate' | 'migrateData' | 'markSchemaCurrent' | 'assertSchemaCurrent'>;
const cases = {
  query: async () => {
    expect((await database.query('SELECT $1::text value', ['received'])).rows).toEqual([{ value: 'received' }]);
    await lostReply('08006', 'INSERT');
  },
  transaction: async () => {
    await database.transaction(async tx => { await tx.query("INSERT INTO seam_effects(value) VALUES('committed')"); });
    const failure = new Error('rollback');
    await expect(database.transaction(async tx => {
      await tx.query("INSERT INTO seam_effects(value) VALUES('rolled back')");
      throw failure;
    })).rejects.toBe(failure);
    expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'committed' }]);
    await lostReply('08006', 'COMMIT');
  },
  connectDedicated: async () => {
    for (const mode of ['app', 'enrichment', 'diagnostics', 'long-running', 'migration'] as const) {
      const configured = new PostgresDatabase(fixtureUrl.href, 2, { mode });
      try {
        const first = await configured.connectDedicated();
        try {
          const second = await configured.connectDedicated();
          try {
            expect((await first.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
            expect((await second.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
          } finally { second.release(); }
        } finally { first.release(); }
        expect((await configured.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
      } finally { await configured.close(); }
    }
  },
  backgroundWork: async () => {
    database.backgroundWork.run(async () => { await database.query("INSERT INTO seam_effects(value) VALUES('detached')"); });
    await database.backgroundWork.drain();
    expect(database.backgroundWork.isEmpty).toBe(true);
    expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'detached' }]);
  },
  close: async () => {
    database.backgroundWork.run(async () => { await database.query("INSERT INTO seam_effects(value) VALUES('before close')"); });
    await database.close();
    expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'before close' }]);
    await expect(database.query('SELECT 1')).rejects.toThrow();
  },
  poolCounts: async () => {
    await database.query('SELECT 1');
    expect(database.poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
  },
  poolTelemetry: async () => {
    await database.query('SELECT 1');
    expect(database.poolTelemetry()).toMatchObject({ checkouts: 1, checkoutFailures: 0, deadlocks: 0 });
  },
  oldestActiveQueryAgeMs: async () => {
    const pending = database.query('SELECT 1');
    expect(await database.oldestActiveQueryAgeMs()).toBeTypeOf('number');
    await pending;
    expect(await database.oldestActiveQueryAgeMs()).toBeNull();
  },
  queryProfiles: async () => {
    await database.query('SELECT 1');
    expect(database.queryProfiles()).toMatchObject({ top: [{ calls: 1, errors: 0 }], overflow: 0 });
  },
  queryWindow: async () => {
    await database.query('SELECT 1');
    expect(database.queryWindow()).toMatchObject({ queryCount: 1, checkoutCount: 1 });
  },
  oldestActiveTransactionAgeMs: async () => {
    await database.transaction(async tx => {
      expect(database.oldestActiveTransactionAgeMs()).toBeTypeOf('number');
      await tx.query('SELECT 1');
    });
    expect(database.oldestActiveTransactionAgeMs()).toBeNull();
  },
  transactionDeadlineCount: async () => {
    await database.transaction(tx => tx.query('SELECT 1'));
    expect(database.transactionDeadlineCount()).toBe(0);
  },
  onRecovery: async () => {
    let recoveries = 0;
    const remove = database.onRecovery(() => { recoveries++; });
    await lostReply('08006', 'INSERT');
    expect(recoveries).toBe(0);
    await database.query('SELECT 1');
    await database.query('SELECT 1');
    expect(recoveries).toBe(1);
    remove();
  },
  migrate: async () => {
    const id = 'c'.repeat(64);
    await database.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Seam person')", [id]);
    try {
      await migrate(database);
      await assertSchemaCurrent(database);
      expect((await database.query('SELECT name FROM identities WHERE id=$1', [id])).rows).toEqual([{ name: 'Seam person' }]);
    } finally { await database.query('DELETE FROM identities WHERE id=$1', [id]); }
  },
  migrateData: async () => {
    await migrateData(database);
    await migrateData(database);
    await assertSchemaCurrent(database);
  },
  markSchemaCurrent: async () => {
    await database.query('DELETE FROM beeline_schema_state');
    await markSchemaCurrent(database);
    await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
  },
  assertSchemaCurrent: async () => {
    await database.query('UPDATE beeline_schema_state SET version=0');
    try { await expect(assertSchemaCurrent(database)).rejects.toThrow('schema'); }
    finally { await markSchemaCurrent(database); }
  },
  '57P01': () => lostReply('57P01', 'INSERT'),
  '57P03': () => lostReply('57P03', 'INSERT'),
  '53300': () => lostReply('53300', 'INSERT'),
  '08006': () => lostReply('08006', 'INSERT'),
  '08003': () => lostReply('08003', 'INSERT'),
  '08000': () => lostReply('08000', 'INSERT'),
  ETIMEDOUT: () => lostReply('ETIMEDOUT', 'INSERT'),
  EAI_AGAIN: () => lostReply('EAI_AGAIN', 'INSERT'),
  '40P01': () => lostReply('40P01', 'INSERT'),
  '55P03': () => lostReply('55P03', 'INSERT'),
  '57014': () => lostReply('57014', 'INSERT'),
  unknown: () => lostReply('unknown', 'INSERT'),
} satisfies Record<keyof ClosableDatabase | MigrationEntry | DatabaseFailureKind, () => Promise<void>>;

it.each(Object.entries(cases))('%s', async (_member, run) => { await run(); });


describe("database-background-work", () => {
  it('finishes a deferred observer across successive queries before closing its database', async () => {
    const database = new PgliteDatabase();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const firstQuery = new Promise<void>(resolve => { started = resolve; });
    const values: number[] = [];
    database.backgroundWork.run(async () => {
      values.push(Number((await database.query('SELECT 1 AS value')).rows[0]!.value));
      started();
      await held;
      values.push(Number((await database.query('SELECT 2 AS value')).rows[0]!.value));
    });
    await firstQuery;
    let closed = false;
    const closing = database.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(values).toEqual([1, 2]);
    expect(closed).toBe(true);
  });
});


describe("rollout-overlap", () => {
  let db: PgliteDatabase;
  afterEach(async () => { await db?.close(); });
  const H = 'a'.repeat(64), A = 'b'.repeat(64);
  const W = '11111111-1111-4111-8111-111111111111', R = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';
  async function fixture() {
    db = await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Worker')`, [H,A]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A,H]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Rollout proof')`, [W]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Parent',$3)`, [R,W,H]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`, [C,W,R,A]);
    await db.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`, [C]);
  }
  
  it('rollout-0707: the exact released expressions survive both schema overlap directions and repeated migrations', async () => {
    // Sentry 466aa2408b8c47348aac9a16b97f527a, release 3fe0d1b17,
    // 2026-11-03 07:08:34 UTC: waiting_fact.owner_agent_id does not exist.
    await fixture();
    for (const alias of ['waiting_fact','fact','owner_fact']) {
      const query = `SELECT ${oldWorker(alias, 'corner')} worker,${oldOwner('corner.id')} owner
        FROM rooms corner JOIN corner_facts ${alias} ON ${alias}.corner_id=corner.id WHERE corner.id=$1`;
      expect((await db.query(query, [C])).rows[0]).toMatchObject({ worker: A });
    }
    await db.query(`UPDATE corner_facts SET owner_agent_id=$1 WHERE corner_id=$2`, [A,C]);
    await migrate(db);
    await migrate(db);
    expect((await db.query(`SELECT owner_agent_id FROM corner_facts WHERE corner_id=$1`, [C])).rows[0]).toEqual({ owner_agent_id: A });
    expect((await db.query(`SELECT ${cornerImplementerSql('fact','corner')} worker,${cornerOwnerSql('corner.id')} owner
      FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id WHERE corner.id=$1`, [C])).rows[0]).toMatchObject({ worker: A });
    // Also repair installations where the preceding release already dropped it.
    await db.query(`ALTER TABLE corner_facts DROP COLUMN owner_agent_id`);
    await migrate(db);
    await expect(db.query(`SELECT ${oldOwner('corner.id')} owner FROM rooms corner WHERE id=$1`, [C])).resolves.toMatchObject({ rowCount: 1 });
  }, 60_000);
  
  it('SERVER-27: a released reply upsert and the candidate upsert both commit through overlap and repair', async () => {
    // Sentry db04a711c86948d18b913312503ad871, 2026-11-02 21:21:58 UTC.
    await fixture();
    const source = 'e'.repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'A person asks')`, [source,R,H]);
    // Exact 75e48e93346e starPromptReplySql output. Keep the retired write frozen.
    const oldReply = `WITH command AS (SELECT $1::text root_source_message_id)
      INSERT INTO github_star_prompts AS prompt(identity_id,replies,reached_milestone)
       SELECT source.author_id,1,
         CASE WHEN 1=ANY(ARRAY[3,30,300]) THEN 1 ELSE 0 END
       FROM command command
       JOIN messages source ON source.id=command.root_source_message_id
       JOIN identities person ON person.id=source.author_id
         AND person.kind='human' AND NOT person.hidden_from_roster
       LIMIT 1
       ON CONFLICT(identity_id) DO UPDATE SET
         replies=prompt.replies+1,
         reached_milestone=CASE WHEN prompt.replies+1=ANY(ARRAY[3,30,300])
           THEN prompt.replies+1 ELSE prompt.reached_milestone END,
         updated_at=now()`;
    await db.query(oldReply, [source]);
    await db.query(`WITH command AS (SELECT $1::text root_source_message_id) ${starPromptReplySql('command')}`, [source]);
    await db.query(oldReply, [source]);
    await migrate(db);
    expect((await db.query(`SELECT replies,reached_milestone FROM github_star_prompts WHERE identity_id=$1`, [H])).rows[0])
      .toEqual({ replies: 3, reached_milestone: 3 });
    await db.query(`ALTER TABLE github_star_prompts DROP COLUMN reached_milestone`);
    await migrate(db);
    await db.query(oldReply, [source]);
    expect((await db.query(`SELECT replies FROM github_star_prompts WHERE identity_id=$1`, [H])).rows[0]).toEqual({ replies: 4 });
  }, 60_000);
});


describe("completed-command-turns", () => {
  it('stuck-turn-1: release migration closes orphan turns once and preserves a live claimed successor', async () => {
    const database = new PgliteDatabase();
    const human = 'a'.repeat(64),
      agent = 'b'.repeat(64);
    const workspace = '11111111-1111-4111-8111-111111111111',
      room = '22222222-2222-4222-8222-222222222222';
    try {
      await migrate(database, { deferData: true });
      await database.query(
        `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Ruby')`,
        [human, agent],
      );
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')`, [
        room,
        workspace,
      ]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
        [workspace, human, agent, room],
      );
      const orphanIds: string[] = [];
      for (let index = 0; index < 6; index++) {
        const request = String(index).repeat(64);
        await database.query(
          `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@ruby work')`,
          [request, room, human],
        );
        const command = await createAgentCommand(database, {
          roomId: room,
          agentId: agent,
          sourceMessageId: request,
          reason: 'human_tag',
        });
        await claimAgentCommand(database, room, agent, command!.id, `old-${index}`);
        await database.query(
          `UPDATE agent_commands SET state='complete',completed_at=now()-interval '2 days' WHERE id=$1`,
          [command!.id],
        );
        await database.query(
          `UPDATE agent_turns SET created_at=now()-interval '2 days',generation_id='retired-generation' WHERE request_id=$1`,
          [request],
        );
        if (index < 5) orphanIds.push(request);
        else {
          const source = 'f'.repeat(64);
          await database.query(
            `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'resume')`,
            [source, room, human],
          );
          const successor = await createAgentCommand(database, {
            roomId: room,
            agentId: agent,
            sourceMessageId: source,
            reason: 'resume',
            action: 'resume',
            turnRequestId: request,
          });
          await claimAgentCommand(database, room, agent, successor!.id, 'live-successor');
        }
      }
      await migrateData(database);
      expect(
        (
          await database.query(
            `SELECT status,failure_reason FROM agent_turns WHERE request_id=ANY($1::text[])`,
            [orphanIds],
          )
        ).rows,
      ).toEqual(
        Array.from({ length: 5 }, () => ({
          status: 'failed',
          failure_reason: 'the command completed without a terminal turn receipt',
        })),
      );
      expect(
        (
          await database.query(`SELECT status,generation_id FROM agent_turns WHERE request_id=$1`, [
            '5'.repeat(64),
          ])
        ).rows,
      ).toEqual([{ status: 'working', generation_id: 'live-successor' }]);
      // The release marker prevents a later release from running this repair again.
      await database.query(
        `UPDATE agent_commands SET state='complete' WHERE generation_id='live-successor'`,
      );
      await migrateData(database);
      expect(
        (await database.query(`SELECT status FROM agent_turns WHERE request_id=$1`, ['5'.repeat(64)]))
          .rows,
      ).toEqual([{ status: 'working' }]);
    } finally {
      await database.close();
    }
  });
});


describe("corner-names", () => {
  const WORKSPACE = '00000000-0000-4000-8000-000000000001';
  const ROOM = '00000000-0000-4000-8000-000000000010';
  const OTHER_ROOM = '00000000-0000-4000-8000-000000000020';
  const corner = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
  const AUTHOR = 'a'.repeat(64);
  
  let database: PgliteDatabase;
  
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database, { deferData: true });
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`, [
      AUTHOR,
    ]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name) VALUES($2,$1,'beeline'),($3,$1,'other')`,
      [WORKSPACE, ROOM, OTHER_ROOM],
    );
    const rows: [string, string, string, string, string?][] = [
      [corner(1), ROOM, 'fix-ledger', '2026-09-01'],
      [corner(2), ROOM, 'Fix ledger', '2026-09-02'],
      [corner(3), ROOM, 'fix  ledger drift and more words', '2026-09-03'],
      [corner(4), ROOM, 'fix ledger', '2026-09-04'],
      [corner(5), OTHER_ROOM, 'fix ledger', '2026-09-05'],
      [corner(6), ROOM, '   ', '2026-09-06'],
      // An archived name stays taken, and an archived spaced name is renamed too.
      [corner(7), ROOM, 'ship-it', '2026-09-07', '2026-09-08'],
      [corner(8), ROOM, 'ship it', '2026-09-09'],
      [corner(9), ROOM, 'old idea here', '2026-09-10', '2026-09-11'],
    ];
    for (const [id, parent, name, at, archivedAt] of rows) {
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,name,created_at,archived_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [id, WORKSPACE, parent, name, at, archivedAt ?? null],
      );
    }
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,card_type,card) VALUES
         ('m1',$1,$2,'','daemon-fact',jsonb_build_object('cornerId',$3::text,'name','Fix ledger')),
         ('m2',$1,$2,'','daemon-fact',jsonb_build_object('cornerId',$3::text,'objective','x'))`,
      [ROOM, AUTHOR, corner(2)],
    );
  });
  
  afterEach(async () => {
    await database.close();
  });
  
  async function names() {
    const result = await database.query<{ id: string; name: string }>(
      `SELECT id,name FROM rooms WHERE parent_id IS NOT NULL ORDER BY id`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.id, row.name]));
  }
  
  it('hyphenates spaced corner names once, with deterministic suffixes per Room', async () => {
    await migrateData(database);
    expect(await names()).toEqual({
      [corner(1)]: 'fix-ledger',
      [corner(2)]: 'Fix-ledger-2',
      [corner(3)]: 'fix-ledger-drift',
      [corner(4)]: 'fix-ledger-3',
      [corner(5)]: 'fix-ledger',
      [corner(6)]: 'corner-00000000',
      [corner(7)]: 'ship-it',
      [corner(8)]: 'ship-it-2',
      [corner(9)]: 'old-idea-here',
    });
    const cards = await database.query<{ id: string; card: Record<string, unknown> }>(
      `SELECT id,card FROM messages ORDER BY id`,
    );
    expect(cards.rows.map((row) => row.card.name)).toEqual(['Fix-ledger-2', undefined]);
  
    await database.query(`UPDATE rooms SET name='spaced again' WHERE id=$1`, [corner(1)]);
    await migrateData(database);
    expect((await names())[corner(1)]).toBe('spaced again');
    console.log('Demonstrated corner-names backfill:', JSON.stringify(await names()));
  });
});


describe("background-leader.postgres", () => {
  const url=serverDatabaseUrl;
  if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Leadership proof requires isolated loopback PostgreSQL');
  function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
  describe.skipIf(!url)('real PostgreSQL blocking leader ownership',()=>{
    it('transfers the existing lock to a waiting peer and cancels another waiter without timed probes',async()=>{
      const pools=[0,1,2].map(()=>new Pool({connectionString:url,max:1,statement_timeout:2000,options:'-c lock_timeout=500ms'}));
      const waiting=[deferred(),deferred(),deferred()],entered=[deferred(),deferred(),deferred()],cycles=[0,0,0],statements:string[][]=[[],[],[]];
      const leaders=pools.map((pool,i)=>new BackgroundLeader({connectDedicated:async()=>{
        const client=await pool.connect();
        const query=client.query.bind(client);
        client.query=((sql:string,values?:unknown[])=>{
          statements[i]!.push(sql);const result=query(sql,values);
          if(sql.includes('pg_advisory_lock'))waiting[i]!.resolve();return result;
        }) as typeof client.query;
        return client;
      }},async initial=>{expect(initial).toBe(true);cycles[i]++;entered[i]!.resolve();return Infinity;}));
      try{
        void leaders[0]!.run();await entered[0]!.promise;
        void leaders[1]!.run();void leaders[2]!.run();
        // The third actual lock query is submitted while the first owner
        // holds it. Shutdown must cancel this blocked wait immediately.
        await waiting[2]!.promise;
        await leaders[2]!.stop();expect(cycles[2]).toBe(0);
        await leaders[0]!.stop();await entered[1]!.promise;
        expect(cycles).toEqual([1,1,0]);
        expect(statements[0]).toEqual(['SET statement_timeout=0; SET lock_timeout=0','SELECT pg_advisory_lock($1)']);
        expect(statements[1]).toEqual(statements[0]);
        await leaders[1]!.stop();
      }finally{
        await Promise.all(leaders.map(leader=>leader.stop()));await Promise.all(pools.map(pool=>pool.end()));
      }
    });
    it('shares the unchanged lock with a polling old-server owner during a rolling deploy', async () => {
      const oldPool = new Pool({ connectionString: url, max: 1 });
      const newPool = new Pool({ connectionString: url, max: 1 });
      const old = await oldPool.connect();
      const waiting = deferred();
      const entered = deferred();
      const leader = new BackgroundLeader({ connectDedicated: async () => {
        const client = await newPool.connect();
        const query = client.query.bind(client);
        client.query = ((sql: string, values?: unknown[]) => {
          const result = query(sql, values);
          if (sql.includes('pg_advisory_lock')) waiting.resolve();
          return result;
        }) as typeof client.query;
        return client;
      } }, async () => { entered.resolve(); return Infinity; });
      try {
        const key = 0x0bee11;
        expect((await old.query('SELECT pg_try_advisory_lock($1) locked', [key])).rows[0].locked).toBe(true);
        void leader.run();
        await waiting.promise;
        await old.query('SELECT pg_advisory_unlock($1)', [key]);
        await entered.promise;
        expect((await old.query('SELECT pg_try_advisory_lock($1) locked', [key])).rows[0].locked).toBe(false);
        await leader.stop();
        // Pool release destroys the socket synchronously; PostgreSQL may process
        // EOF after another connection's next query. Wait on the same real lock.
        await old.query("SET lock_timeout='2s'");
        await old.query('SELECT pg_advisory_lock($1)', [key]);
        expect((await old.query('SELECT pg_try_advisory_lock($1) locked', [key])).rows[0].locked).toBe(true);
      } finally {
        await leader.stop();
        old.release(true);
        await Promise.all([oldPool.end(), newPool.end()]);
      }
    });
  
    it('ends admission for the rest of a repair cycle when its physical backend is lost', async () => {
      const pool = new Pool({ connectionString: url, max: 1 });
      const admin = new Pool({ connectionString: url, max: 1 });
      const entered = deferred(), finish = deferred(), lost = deferred(), drained = deferred();
      const work = new BackgroundWork(() => 0, () => {});
      const calls: string[] = [];
      let backend = 0;
      let attempts = 0;
      work.addDeadline('held-provider', async () => {
        calls.push('held-provider'); entered.resolve(); await finish.promise;
      });
      work.addDeadline('later-repair', async () => { calls.push('later-repair'); });
      const leader = new BackgroundLeader({ connectDedicated: async () => {
        // Refuse the one incident replacement: loss cannot become a test-only
        // success path that runs the abandoned old owner's pending families.
        if (++attempts > 1) throw new Error('Synthetic replacement unavailable');
        const client = await pool.connect();
        backend = (await client.query('SELECT pg_backend_pid() id')).rows[0].id;
        return client;
      } }, async (initial, signal) => {
        const delay = await work.run(initial, signal); drained.resolve(); return delay;
      }, { acquired: async () => {}, lost: () => { lost.resolve(); } });
      try {
        void leader.run(); await entered.promise;
        await admin.query('SELECT pg_terminate_backend($1)', [backend]);
        await lost.promise;
        finish.resolve(); await drained.promise;
        expect(calls).toEqual(['held-provider']);
        // A separately acquired epoch still gets its one initial family pass.
        expect(await work.run(true, new AbortController().signal)).toBe(Infinity);
        expect(calls).toEqual(['held-provider', 'held-provider', 'later-repair']);
      } finally {
        finish.resolve(); await leader.stop(); await Promise.all([pool.end(), admin.end()]);
      }
    });
  
  });
});


describe("background-ownership.postgres", () => {
  const url=serverDatabaseUrl;
  if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))
    throw new Error('Background ownership proofs require isolated loopback PostgreSQL');
  const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
  const intent:BackgroundEffectRequest<'push.deliver'>={job:'push.deliver',effectId:'synthetic-delivery',sourceClaimId:'source',
    sourceClaimVersion:'v1',provider:'fcm',canonicalRequest:'{"message":"synthetic"}'};
  async function fixture(){
    const schema=`background_epoch_${randomUUID().replaceAll('-','')}`;
    const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public -c lock_timeout=100ms`,max:2};
    const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
    const locks=new Pool({connectionString:url,max:2,statement_timeout:0,options:'-c lock_timeout=0'});
    await first.query(`CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz NOT NULL);
      INSERT INTO live_server_instances VALUES('first',clock_timestamp()),('second',clock_timestamp());${BACKGROUND_OWNERSHIP_SCHEMA}`);
    const scopes:Array<{owner:BackgroundOwnership;epoch:BackgroundEpoch}>=[];const held=new Set<PoolClient>();
    const acquire=async()=>{const client=await locks.connect();held.add(client);await client.query('SELECT pg_advisory_lock($1)',[BACKGROUND_LEADER_LOCK_KEY]);return client;};
    const drop=(client:PoolClient)=>{if(held.delete(client))client.release(true);};
    return {first,second,acquire,drop,scopes,close:async()=>{
      for(const {owner,epoch}of scopes)owner.revoke(epoch);
      for(const client of held)client.release(true);held.clear();
      await Promise.all([first.close(),second.close(),locks.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }};
  }
  
  describe.skipIf(!url)('F16 private final epoch fences, real PostgreSQL',()=>{
    it('binds the actual backend start identity and rejects a shared-only advisory lock',async()=>{
      const f=await fixture();
      try{
        const lock=await f.acquire(),core=new BackgroundOwnership(f.first,'first'),epoch=await core.claim(lock);f.scopes.push({owner:core,epoch});
        expect((await f.first.query(`SELECT beeline_background_backend_holds(lock_backend_pid,lock_backend_start) exact,
          beeline_background_backend_holds(lock_backend_pid,lock_backend_start+interval '1 microsecond') reused
          FROM background_leader_owners`)).rows).toEqual([{exact:true,reused:false}]);
        await lock.query('SELECT pg_advisory_unlock($1)',[BACKGROUND_LEADER_LOCK_KEY]);
        await lock.query('SELECT pg_advisory_lock_shared($1)',[BACKGROUND_LEADER_LOCK_KEY]);
        await expect(new BackgroundOwnership(f.first,'first').claim(lock)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
        expect((await f.first.query(`SELECT beeline_background_backend_holds(lock_backend_pid,lock_backend_start) exact FROM background_leader_owners`)).rows).toEqual([{exact:false}]);
      }finally{await f.close();}
    });
    it('blocks an old delayed effect after lock transfer even when its local connection-loss signal was withheld',async()=>{
      const f=await fixture();
      try{
        const lockA=await f.acquire(),first=new BackgroundOwnership(f.first,'first');
        const epochA=await first.claim(lockA);f.scopes.push({owner:first,epoch:epochA});
        const prepared=await first.prepareEffect(epochA,intent);expect(prepared.kind).toBe('new');if(prepared.kind!=='new')return;
        f.drop(lockA); // Deliberately do not tell the old private epoch about loss.
        const lockB=await f.acquire(),second=new BackgroundOwnership(f.second,'second');
        const epochB=await second.claim(lockB);f.scopes.push({owner:second,epoch:epochB});
        expect(epochA.signal.aborted).toBe(false);let sends=0;
        await expect(first.enqueue(epochA,prepared.attempt,()=>{sends++;return undefined;})).rejects.toBeInstanceOf(BackgroundOwnershipLost);
        expect(sends).toBe(0);expect(epochA.signal.aborted).toBe(true);
        expect((await f.second.query('SELECT state FROM background_effect_attempts')).rows).toEqual([{state:'unknown'}]);
      }finally{await f.close();}
    });
  
    it('holds the exact owner row through synchronous enqueue while takeover blocks, without awaiting provider completion',async()=>{
      const f=await fixture(),reached=deferred(),release=deferred(),provider=deferred();let pause=false,reads=0;
      const wrap=(database:SqlDatabase):SqlDatabase=>({
        query:async(sql,values)=>{const result=await database.query(sql,values);
          if(pause&&sql.includes('FROM background_leader_owners owner JOIN')&&++reads===2){reached.resolve();await release.promise;}return result;},
        transaction:work=>database.transaction(tx=>work(wrap(tx))),
      });
      try{
        const lockA=await f.acquire(),first=new BackgroundOwnership(wrap(f.first),'first');
        const epochA=await first.claim(lockA);f.scopes.push({owner:first,epoch:epochA});
        const prepared=await first.prepareEffect(epochA,intent);if(prepared.kind!=='new')throw new Error('Expected fresh attempt');
        pause=true;let sends=0;let completion:Promise<void>|undefined;
        const dispatch=first.enqueue(epochA,prepared.attempt,()=>{sends++;completion=provider.promise;return undefined;});
        await reached.promise;expect(sends).toBe(1);f.drop(lockA);
        const lockB=await f.acquire(),second=new BackgroundOwnership(f.second,'second');
        await expect(second.claim(lockB)).rejects.toMatchObject({code:'55P03'});
        release.resolve();expect((await dispatch).state).toBe('unknown');expect(completion).toBe(provider.promise);
        const epochB=await second.claim(lockB);f.scopes.push({owner:second,epoch:epochB});
        expect(BigInt(epochB.generation)).toBeGreaterThan(BigInt(epochA.generation));
        provider.resolve();await completion;
        expect((await first.recordOutcome(prepared.attempt,'succeeded','verified synthetic provider receipt')).state).toBe('succeeded');
        await expect(first.enqueue(epochA,prepared.attempt,()=>{sends++;return undefined;})).rejects.toBeInstanceOf(BackgroundOwnershipLost);
        expect(sends).toBe(1);
      }finally{release.resolve();provider.resolve();await f.close();}
    });
  
    it('retains UNKNOWN across final commit-ack loss and offers no duplicate dispatch after restart/takeover',async()=>{
      const f=await fixture();let loseAck=false;
      const observed:SqlDatabase={query:(sql,values)=>f.first.query(sql,values),transaction:async work=>{
        const value=await f.first.transaction(work);if(loseAck){loseAck=false;throw new Error('lost final fence acknowledgment');}return value;
      }};
      try{
        const lockA=await f.acquire(),first=new BackgroundOwnership(observed,'first');
        const epochA=await first.claim(lockA);f.scopes.push({owner:first,epoch:epochA});
        const prepared=await first.prepareEffect(epochA,intent);if(prepared.kind!=='new')throw new Error('Expected fresh attempt');
        loseAck=true;let sends=0;
        await expect(first.enqueue(epochA,prepared.attempt,()=>{sends++;return undefined;})).rejects.toThrow('lost final fence');
        expect(sends).toBe(1);expect((await f.second.query('SELECT state FROM background_effect_attempts')).rows).toEqual([{state:'unknown'}]);
        f.drop(lockA);const lockB=await f.acquire(),second=new BackgroundOwnership(f.second,'second');
        const epochB=await second.claim(lockB);f.scopes.push({owner:second,epoch:epochB});
        const duplicate=await second.prepareEffect(epochB,intent);expect(duplicate.kind).toBe('existing');
        if(duplicate.kind==='existing')expect(duplicate.receipt.state).toBe('unknown');expect(sends).toBe(1);
      }finally{await f.close();}
    });
  });
});


describe("helper-activation.postgres", () => {
  const url=serverDatabaseUrl;
  if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Activation proofs require isolated loopback PostgreSQL');
  const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};};
  const agent='a'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
  const input:CommandActivationInput={agentId:agent,workspaceId:workspace,roomId:room,commandId:'claimed-command',generationId:'generation',source:{connectionId:'connection',epoch:1}};
  describe.skipIf(!url)('actual PostgreSQL coherent activation and authority contention',()=>{
    it('keeps one RR database cut and waits behind a real source revocation before final enqueue',async()=>{
      const schema='activation_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
      const config={connectionString:url,options:`-c search_path=${schema},public`,max:3};
      const left=new PostgresDatabase('',3,{pool:new Pool(config)}),right=new PostgresDatabase('',3,{pool:new Pool(config)});
      const cutRead=deferred(),resumeCut=deferred(),revokeHeld=deferred(),commitRevoke=deferred(),fenceEntered=deferred();
      let capturing:Promise<unknown>|undefined,revoking:Promise<unknown>|undefined,fencing:Promise<unknown>|undefined;
      try{
        await left.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY,visibility text);
          CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text,fast_mode boolean NOT NULL DEFAULT false);
          CREATE TABLE identities(id text PRIMARY KEY,name text);
          CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
          CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
          CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,released_at timestamptz,instance_id text);
          CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);
          CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,generation_id text,state text,lease_expires_at timestamptz);
          CREATE TABLE agent_grants(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,agent_id text,app_id uuid,status text);
          CREATE TABLE workspace_apps(id uuid PRIMARY KEY,workspace_id uuid,owner_identity_id text);
          CREATE TABLE workspace_connectors(id uuid PRIMARY KEY,workspace_id uuid,owner_identity_id text);
          CREATE TABLE corner_facts(corner_id uuid);CREATE TABLE corner_brief_revisions(corner_id uuid);
          CREATE TABLE corner_merge_holds(corner_id uuid);CREATE TABLE corner_merge_approvals(corner_id uuid);CREATE TABLE free_agents(agent_id text);`);
        await left.query(TURN_OWNERSHIP_SCHEMA);
        await left.query(HELPER_ACTIVATION_SCHEMA);
        await left.query(`INSERT INTO workspaces VALUES($1,'private')`,[workspace]);
        await left.query('INSERT INTO agents(agent_id) VALUES($1)',[agent]);
        await left.query('INSERT INTO rooms(id,workspace_id) VALUES($1,$2)',[room,workspace]);
        await left.query(`INSERT INTO memberships VALUES($1,NULL,$2,'member',NULL),($1,$3,$2,'member',NULL)`,[workspace,agent,room]);
        await left.query(`INSERT INTO agent_connections(agent_id,connection_id,epoch,released_at) VALUES($1,'connection',1,NULL)`,[agent]);
        await left.query(`INSERT INTO agent_commands(id,room_id,agent_id,generation_id,state,lease_expires_at) VALUES($1,$2,$3,'generation','claimed',now()+interval '1 day')`,[input.commandId,room,agent]);
        await left.query(`INSERT INTO agent_grants(id,workspace_id,room_id,agent_id,status) VALUES('33333333-3333-4333-8333-333333333333',$1,$2,$3,'approved')`,[workspace,room,agent]);
        const read:ActivationReader=async db=>{
          const fast=(await db.query<{fast_mode:boolean}>('SELECT fast_mode FROM agents WHERE agent_id=$1',[agent])).rows[0]!.fast_mode;
          return {configuration:{fastMode:fast,commands:[],yoloMode:false,isReviewer:false},roster:{members:[]},grants:{grants:[]},repository:{resolution:'none'}};
        };
        const captured=captureCommandActivation(left,input,async(db,command,corner)=>{
          const before=await read(db,command,corner);cutRead.resolve();await resumeCut.promise;
          const after=await read(db,command,corner);expect(after.configuration.fastMode).toBe(before.configuration.fastMode);return after;
        });capturing=captured;await cutRead.promise;
        await right.query('UPDATE agents SET fast_mode=true WHERE agent_id=$1',[agent]);resumeCut.resolve();
        const oldCut=await captured;expect(oldCut.configuration.fastMode).toBe(false);
        const delivered:unknown[]=[];expect(await fenceCommandActivationEnqueue(left,oldCut,value=>{delivered.push(value);})).toBe(false);expect(delivered).toEqual([]);
        const current=await captureCommandActivation(left,input,read);expect(current.configuration.fastMode).toBe(true);
        const scope={origin:'http://127.0.0.1',generation:1,source:input.source};
        let setupReads=0;
        const context=new CommandActivationContext({scope:()=>scope,selected:()=>true,read:async request=>{
          setupReads++;return captureCommandActivation(left,request,read);
        }});
        const held=await Promise.all(Array.from({length:100},()=>context.read(input)));
        expect(setupReads).toBe(1);expect(held.every(value=>value===held[0])).toBe(true);
        revoking=right.transaction(async db=>{await db.query(`UPDATE agent_grants SET status='revoked'`);revokeHeld.resolve();await commitRevoke.promise;});
        await revokeHeld.promise;
        const observed:SqlDatabase={query:(sql,values)=>left.query(sql,values),transaction:work=>left.transaction(db=>work({
          transaction:nested=>db.transaction(nested),query:(sql,values)=>{
            const pending=db.query(sql,values);if(sql.includes('FROM helper_activation_authority')&&sql.includes('FOR SHARE'))fenceEntered.resolve();return pending;
          },
        }))};
        fencing=fenceCommandActivationEnqueue(observed,current,value=>{delivered.push(value);});
        await fenceEntered.promise;expect(delivered).toEqual([]);commitRevoke.resolve();await revoking;expect(await fencing).toBe(false);expect(delivered).toEqual([]);
        // A cached setup value is context, never current effect authority.
        expect(await context.read(input)).toBe(held[0]);expect(setupReads).toBe(1);
        expect(await fenceCommandActivationEnqueue(left,held[0]!,value=>{delivered.push(value);})).toBe(false);
        expect(delivered).toEqual([]);
        const newest=await captureCommandActivation(left,input,read);
        await right.query(`UPDATE agent_commands SET generation_id='replacement' WHERE id=$1`,[input.commandId]);
        await expect(fenceCommandActivationEnqueue(left,newest,value=>{delivered.push(value);})).rejects.toThrow('command ownership changed');expect(delivered).toEqual([]);
      }finally{
        resumeCut.resolve();commitRevoke.resolve();await Promise.allSettled([capturing,revoking,fencing].filter((value):value is Promise<unknown>=>value!==undefined));
        await Promise.all([left.close(),right.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
      }
    },20000);
  });
});


describe("helper-usage.postgres", () => {
  const url=serverDatabaseUrl;
  if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Usage proofs require isolated loopback PostgreSQL');
  const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};};
  const owner='a'.repeat(64),other='b'.repeat(64),first='c'.repeat(64),second='d'.repeat(64);
  describe.skipIf(!url)('usage real PostgreSQL publication and final owner contention',()=>{
    it('shares one account revision under competing publishers and blocks private enqueue behind real owner reassignment',async()=>{
      const schema='usage_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
      const config={connectionString:url,options:`-c search_path=${schema},public`,max:3};
      const left=new PostgresDatabase('',3,{pool:new Pool(config)}),right=new PostgresDatabase('',3,{pool:new Pool(config)});
      const inserted=deferred(),allowCommit=deferred(),contending=deferred(),ownerHeld=deferred(),allowOwnerCommit=deferred(),fenceEntered=deferred();
      let original:Promise<unknown>|undefined,competing:Promise<unknown>|undefined,reassign:Promise<unknown>|undefined,fencing:Promise<void>|undefined;
      let firstWrittenAt:unknown;
      try{
        await left.query(`CREATE TABLE identities(id text PRIMARY KEY,name text,hidden_from_roster boolean NOT NULL DEFAULT false);
          CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text,usage_snapshot jsonb,usage_account_id bigint,machine_name text,updated_at timestamptz NOT NULL DEFAULT now());
          CREATE TABLE usage_accounts(id bigserial PRIMARY KEY,owner_id text NOT NULL,provider text NOT NULL,account_key text NOT NULL,usage jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,provider,account_key));
          CREATE INDEX agents_usage_account ON agents(usage_account_id);
          CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,released_at timestamptz);
          CREATE TABLE free_agents(agent_id text,owner_id text,removed_at timestamptz);
          CREATE TABLE free_agent_usage(owner_id text,day date,tokens bigint);
          CREATE TABLE free_agent_budget(day date,usd numeric);
          CREATE TABLE free_agent_events(agent_id text,kind text,at timestamptz);`);
        await left.query(DURABLE_LIVE_SCHEMA);await left.query(HELPER_USAGE_SCHEMA);
        await left.query(`INSERT INTO identities(id,name) VALUES($1,'First'),($2,'Second')`,[first,second]);
        await left.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)',[first,second,owner]);
        await left.query(`INSERT INTO agent_connections VALUES($1,'first-source',1,NULL),($2,'second-source',1,NULL)`,[first,second]);
        const usage:AgentUsage={updatedAt:Date.now()/1000-1,windows:[{rateLimitType:'five_hour',status:'allowed',utilization:0.4,updatedAt:Date.now()/1000-1}],
          read:{status:'fresh',at:Date.now()/1000-1},account:{provider:'claude',key:'id:'+'e'.repeat(32)}};
        const revision=createHash('sha256').update(canonicalUsageAccountSnapshot(usage,owner)).digest('hex');
        const firstDb:SqlDatabase={query:(sql,values)=>left.query(sql,values),transaction:work=>left.transaction(tx=>work({
          transaction:nested=>tx.transaction(nested),query:async(sql,values)=>{
            const result=await tx.query(sql,values);
            if(sql.includes('INSERT INTO usage_accounts(')){
              firstWrittenAt=(await tx.query('SELECT updated_at FROM usage_accounts')).rows[0]?.updated_at;
              inserted.resolve();await allowCommit.promise;
            }
            return result;
          },
        }))};
        const secondDb:SqlDatabase={query:(sql,values)=>right.query(sql,values),transaction:work=>right.transaction(tx=>work({
          transaction:nested=>tx.transaction(nested),query:(sql,values)=>{
            const pending=tx.query(sql,values);if(sql.includes('SELECT pg_advisory_xact_lock('))contending.resolve();return pending;
          },
        }))};
        original=publishUsageAccount(firstDb,first,{ownerId:owner,usage,revision,source:{connectionId:'first-source',epoch:1}});
        await inserted.promise;
        competing=publishUsageAccount(secondDb,second,{ownerId:owner,usage,revision,source:{connectionId:'second-source',epoch:1}});
        await contending.promise;
        expect((await right.query('SELECT count(*)::integer count FROM usage_accounts')).rows).toEqual([{count:0}]);
        allowCommit.resolve();const results=await Promise.all([original,competing]);expect(results[0]).toEqual(results[1]);
        const accounts=(await left.query('SELECT id::text,updated_at,source_revision FROM usage_accounts')).rows;
        expect(accounts).toHaveLength(1);expect(accounts[0]?.source_revision).toBe(revision);expect(accounts[0]?.updated_at).toEqual(firstWrittenAt);
        expect((await left.query('SELECT usage_account_id::text account FROM agents ORDER BY agent_id')).rows).toEqual([{account:accounts[0]!.id},{account:accounts[0]!.id}]);
        const prepared=await readAgentUsageCell(left,second,owner);expect(prepared.allowed).toBe(true);
        reassign=right.transaction(async tx=>{
          await tx.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1',[second,other]);ownerHeld.resolve();await allowOwnerCommit.promise;
        });
        await ownerHeld.promise;
        const observedFence:SqlDatabase={query:(sql,values)=>left.query(sql,values),transaction:work=>left.transaction(tx=>work({
          transaction:nested=>tx.transaction(nested),query:(sql,values)=>{
            const pending=tx.query(sql,values);if(sql.includes('SELECT owner_id FROM agents')&&sql.includes('FOR SHARE'))fenceEntered.resolve();return pending;
          },
        }))};
        const delivered:unknown[]=[];fencing=fenceAgentUsageCellEnqueue(observedFence,owner,prepared,cell=>{delivered.push(cell);});
        await fenceEntered.promise;expect(delivered).toEqual([]);allowOwnerCommit.resolve();await reassign;await fencing;
        expect(delivered).toEqual([expect.objectContaining({v:1,agentId:second,ownerId:owner,allowed:false})]);expect(delivered[0]).not.toHaveProperty('usage');
        expect(await readAgentUsageCell(left,second,other)).toMatchObject({allowed:true,usage:null});
        await expect(publishUsageAccount(left,second,{ownerId:owner,usage,revision,source:{connectionId:'second-source',epoch:1}})).rejects.toThrow('owner changed');
      }finally{
        allowCommit.resolve();allowOwnerCommit.resolve();await Promise.allSettled([original,competing,reassign,fencing].filter((value):value is Promise<unknown>=>value!==undefined));
        await Promise.all([left.close(),right.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
      }
    },20000);
  });
});


describe("owned-model-parking.postgres", () => {
  const url = serverDatabaseUrl;
  if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Model parking proof requires isolated loopback PostgreSQL');
  function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
  const ONE = '11111111-1111-4111-8111-111111111111';
  async function fixture() {
    const schema = 'model_park_' + randomUUID().replaceAll('-', ''), admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public -c statement_timeout=8000`, max: 2 };
    const left = new PostgresDatabase('', 2, { pool: new Pool(config) }), right = new PostgresDatabase('', 2, { pool: new Pool(config) });
    try {
      await left.query(`CREATE TABLE identities(id text PRIMARY KEY,kind text,name text);
        CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text);
        CREATE TABLE workspaces(id uuid PRIMARY KEY,name text);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,name text,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
        CREATE TABLE free_agents(agent_id text PRIMARY KEY,workspace_id uuid,owner_id text,sealed_keys text,
          model_token_hash text,state text,model text,removed_at timestamptz);
        CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);
        CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,instance_id text,released_at timestamptz);
        CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,action text,reason text,
          root_command_id text,root_source_message_id text,agent_depth integer,state text,generation_id text,claimed_at timestamptz,
          lease_expires_at timestamptz,created_at timestamptz DEFAULT now());
        CREATE TABLE agent_turns(room_id uuid,request_id text,agent_id text,status text,generation_id text);
        CREATE TABLE live_outputs(room_id uuid,agent_id text,turn_id text,kind text,body jsonb);`);
      await left.query(DURABLE_LIVE_SCHEMA); await left.query(ROUTER_PROJECTION_SCHEMA); await left.query(TURN_OWNERSHIP_SCHEMA);
      const seeded = await seedOwnedModelFixture(left);
      return { ...seeded, left, right, admin, close: async () => { await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
    } catch (error) { await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); throw error; }
  }
  describe.skipIf(!url)('real PostgreSQL causal model owner end', () => {
    it('serializes an admitted owner end against a competing old-code generation claim and prevents final provider entry', async () => {
      const f = await fixture(), admitted = deferred<void>(), release = deferred<void>(), writerPid = deferred<number>();
      let park: Promise<unknown> | undefined, claim: Promise<unknown> | undefined;
      try {
        const attempts = new OwnedModelAttempts(f.left, f.credentials);
        const reserved = await attempts.reserve(f.actor, ONE, { model: MODEL, messages: [] }, async () => ({
          reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 }, payload: { model: MODEL, messages: [], max_tokens: 8 },
        }));
        await f.left.query(`INSERT INTO agent_turns VALUES($1,'synthetic-request',$2,'working',$3)`, [MODEL_ROOM, MODEL_AGENT, MODEL_CLAIM.generationId]);
        park = f.left.transaction(async tx => {
          await parkOwnedModelTerminal(tx, { roomId: MODEL_ROOM, agentId: MODEL_AGENT, requestId: 'synthetic-request', generationId: MODEL_CLAIM.generationId,
            status: 'failed', modelOwnerEnd: { requestId: ONE } }, MODEL_AGENT, MODEL_SOURCE);
          admitted.resolve(); await release.promise;
        });
        await admitted.promise;
        claim = f.right.transaction(async tx => {
          writerPid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
          await tx.query(`UPDATE agent_commands SET generation_id='late-old-code-generation' WHERE id=$1`, [MODEL_CLAIM.commandId]);
        });
        void claim.catch(() => {});
        const pid = await writerPid.promise;
        let waiting = false;
        // Synchronize only against the actual admitted row-lock contention.
        for (let count = 0; count < 200; count++) {
          waiting = (await f.admin.query<{ waiting: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 waiting', [pid])).rows[0]!.waiting;
          if (waiting) break; await new Promise(done => setTimeout(done, 5));
        }
        expect(waiting).toBe(true); release.resolve(); await park;
        await expect(claim).rejects.toThrow('owner has ended');
        let entries = 0;
        await expect(attempts.handoff(reserved.permit!, async () => { entries++; return 'must not enter'; })).rejects.toThrow('authority is unavailable');
        expect(entries).toBe(0);
        expect((await f.right.query('SELECT state,generation_id FROM agent_commands')).rows).toEqual([{ state: 'claimed', generation_id: MODEL_CLAIM.generationId }]);
        expect((await f.right.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
        expect((await f.right.query('SELECT * FROM agent_turns')).rowCount).toBe(0);
      } finally { release.resolve(); await Promise.allSettled([park, claim].filter((value): value is Promise<unknown> => value !== undefined)); await f.close(); }
    }, 20_000);
  });
});


describe("phone-media.postgres", () => {
  const postgresUrl=serverDatabaseUrl;
  if(postgresUrl && !['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))throw new Error('media proofs require isolated loopback PostgreSQL');
  const OBJECT='33333333-3333-4333-8333-333333333333',VIEWER='synthetic-owner';
  function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
  
  describe.skipIf(!postgresUrl)('P6 media metadata current-authority enqueue fence',()=>{
    it.each(['expiry','reference','owner'] as const)('serializes %s revocation with the actual synchronous enqueue',async(kind)=>{
      const schema=`media_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:postgresUrl,max:1});
      await admin.query(`CREATE SCHEMA ${schema}`);
      const config={connectionString:postgresUrl,options:`-c search_path=${schema},public`,max:2};
      const db=new PostgresDatabase('',2,{pool:new Pool(config)}),revoker=new PostgresDatabase('',2,{pool:new Pool(config)});
      const reached=deferred(),release=deferred();let pending:Promise<void>|undefined,enqueued=0;
      const revoke=async(tx:SqlDatabase)=>{
        if(kind==='expiry')await tx.query(`INSERT INTO object_expirations(id) VALUES($1)`,[OBJECT]);
        else if(kind==='reference')await tx.query(`UPDATE messages SET attachments='[]'::jsonb WHERE id='reference'`);
        else await tx.query(`UPDATE objects SET owner_id='new-owner' WHERE id=$1`,[OBJECT]);
      };
      try{
        await db.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
          CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
          CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
          CREATE VIEW room_access AS SELECT * FROM memberships;
          CREATE TABLE objects(id uuid PRIMARY KEY,owner_id text,key text,sha256 text,size bigint,mime text,state text,expires_at timestamptz);
          CREATE TABLE object_expirations(id uuid PRIMARY KEY);
          CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,attachments jsonb,deleted_at timestamptz);`);
        await db.query(DURABLE_LIVE_SCHEMA);await db.query(ROUTER_PROJECTION_SCHEMA);await db.query(MEDIA_AUTHORITY_SCHEMA);
        await db.query(`INSERT INTO objects VALUES($1,$2,'immutable/key',$3,10,'image/webp','ready','2099-01-01')`,[OBJECT,VIEWER,'a'.repeat(64)]);
        await db.query(`INSERT INTO messages(id,attachments) VALUES('reference',$1::jsonb)`,[JSON.stringify([{url:`/v1/media/${OBJECT}`}])]);
        const metadata=await readMediaMetadata(db,OBJECT,VIEWER);
        const observed:SqlDatabase={query:(sql,args)=>db.query(sql,args),transaction:work=>db.transaction(tx=>work({
          transaction:nested=>tx.transaction(nested),query:async(sql,args)=>{const result=await tx.query(sql,args);
            if(sql.includes('pg_advisory_xact_lock_shared')){reached.resolve();await release.promise;}return result;},
        }))};
        pending=fenceMediaMetadataEnqueue(observed,OBJECT,VIEWER,metadata.authority,()=>{enqueued++;return undefined;});await reached.promise;
        await expect(revoker.transaction(async tx=>{await tx.query("SET LOCAL lock_timeout='100ms'");await revoke(tx);})).rejects.toMatchObject({code:'55P03'});
        expect(enqueued).toBe(0);release.resolve();await pending;expect(enqueued).toBe(1);
        await revoker.transaction(revoke);
        await expect(fenceMediaMetadataEnqueue(db,OBJECT,VIEWER,metadata.authority,()=>{enqueued++;return undefined;})).rejects.toMatchObject({status:kind==='reference'?409:404});
        expect(enqueued).toBe(1);
      }finally{
        release.resolve();await pending?.catch(()=>{});await Promise.all([db.close(),revoker.close()]);
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
      }
    });
  });
});


describe("router-authority-fences.postgres", () => {
  const postgresUrl=serverDatabaseUrl;
  if(postgresUrl&&!['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))throw new Error('authority proofs require isolated loopback PostgreSQL');
  const WORKSPACE='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222',VIEWER='synthetic-reader';
  function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
  describe.skipIf(!postgresUrl)('P6 independent authority control final enqueue',()=>{
    it('serializes a content-free denial against regrant and never advances a data cursor',async()=>{
      const schema=`authority_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:postgresUrl,max:1});
      await admin.query(`CREATE SCHEMA ${schema}`);
      const config={connectionString:postgresUrl,options:`-c search_path=${schema},public`,max:2};
      const database=new PostgresDatabase('',2,{pool:new Pool(config)}),writer=new PostgresDatabase('',2,{pool:new Pool(config)});
      const reached=deferred(),releaseFence=deferred(),sent=deferred();let release:(()=>void)|undefined;const frames:Record<string,any>[]=[];
      try{
        await database.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
          CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
          CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);`);
        await database.query(DURABLE_LIVE_SCHEMA);await database.query(ROUTER_PROJECTION_SCHEMA);
        await database.query(`INSERT INTO workspaces VALUES($1)`,[WORKSPACE]);
        await database.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[ROOM,WORKSPACE]);
        await database.query(`INSERT INTO memberships VALUES($1,NULL,$2,'member',NULL),($1,$3,$2,'member',NULL)`,[WORKSPACE,VIEWER,ROOM]);
        const observed:SqlDatabase={query:(sql,args)=>database.query(sql,args),transaction:work=>database.transaction(tx=>work({
          transaction:nested=>tx.transaction(nested),query:async(sql,args)=>{const result=await tx.query(sql,args);
            if(sql.includes('pg_advisory_xact_lock_shared')){reached.resolve();await releaseFence.promise;}return result;},
        }))};
        const live=new LiveHub();release=await subscribeAuthorityFences(observed,live,VIEWER,frame=>{frames.push(frame);if(frame.mode==='advance')sent.resolve();return undefined;},reason=>{throw new Error(reason);});
        await writer.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
        live.journalChanged([`authority:${VIEWER}`]);await reached.promise;
        await expect(writer.transaction(async tx=>{await tx.query("SET LOCAL lock_timeout='100ms'");
          await tx.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
        })).rejects.toMatchObject({code:'55P03'});
        expect(frames).toHaveLength(0);releaseFence.resolve();await sent.promise;
        expect(frames).toHaveLength(2);expect(frames[0]).toMatchObject({kind:'authority-fence',scope:ROOM,authorityScope:`room:${ROOM}`,mode:'deny'});
        expect(frames[1]).toMatchObject({mode:'advance',authorityScope:`reader:${VIEWER}:workspace:${WORKSPACE}:visibility`});
        for(const frame of frames){expect(frame).not.toHaveProperty('cut');expect(frame).not.toHaveProperty('to');}
        await writer.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
        const granted=await readRouterAuthority(database,{family:'room-head',workspaceId:WORKSPACE,roomId:ROOM},VIEWER);
        expect(BigInt(granted.scopes.find(item=>item.authorityScope===`room:${ROOM}`)!.epoch)).toBeGreaterThan(BigInt(frames[0]!.authority.scopes[0].epoch));
        expect(await currentAuthorityFence(database,VIEWER,ROOM,`room:${ROOM}`)).toBeUndefined();
      }finally{
        releaseFence.resolve();release?.();await Promise.all([database.close(),writer.close()]);
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
      }
    });
  });
});


describe("router-command.postgres", () => {
  const postgresUrl = serverDatabaseUrl;
  if (postgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(postgresUrl).hostname))
    throw new Error('command proofs require isolated loopback PostgreSQL');
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  /** PGlite serializes transactions; this optional proof exercises two real
   * PostgreSQL pools competing on the same uncommitted unique identity. */
  describe.skipIf(!postgresUrl)('P7 real PostgreSQL competing server instances', () => {
    it('commits one effect under concurrent replay and rejects a conflicting digest', async () => {
      const schema = `command_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: postgresUrl, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const config = { connectionString: postgresUrl, options: `-c search_path=${schema},public`, max: 2 };
      const firstDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
      const secondDb = new PostgresDatabase('', 2, { pool: new Pool(config) });
      try {
        await firstDb.query(ROUTER_COMMAND_SCHEMA);
        await firstDb.query('CREATE TABLE effects(id text PRIMARY KEY)');
        const reached = deferred(), release = deferred(), competing = deferred();
        const observed: SqlDatabase = {
          query: (sql, values) => secondDb.query(sql, values),
          transaction: work => secondDb.transaction(tx => work({
            transaction: nested => tx.transaction(nested),
            query: (sql, values) => {
              const pending = tx.query(sql, values);
              if (sql.includes('INSERT INTO router_commands')) competing.resolve();
              return pending;
            },
          })),
        };
        const first = new RouterCommandLedger(firstDb), second = new RouterCommandLedger(observed);
        const key = { principal: 'reader', operation: 'create', commandId: 'same-intent' };
        const firstEffect = vi.fn(async (tx: SqlDatabase) => {
          await tx.query("INSERT INTO effects VALUES('one')");
          reached.resolve(); await release.promise;
          return { effectId: 'one' };
        });
        const secondEffect = vi.fn(async () => ({ effectId: 'unexpected' }));
        const original = first.atomic(key, { target: 'one' }, firstEffect);
        await reached.promise;
        const replay = second.atomic(key, { target: 'one' }, secondEffect);
        await competing.promise;
        release.resolve();
        const receipts = await Promise.all([original, replay]);
        expect(receipts[0]).toEqual(receipts[1]);
        expect(secondEffect).not.toHaveBeenCalled();
        expect((await secondDb.query('SELECT * FROM effects')).rows).toEqual([{ id: 'one' }]);
        await expect(second.atomic(key, { target: 'different' }, secondEffect)).rejects.toBeInstanceOf(CommandDigestConflict);
        expect(secondEffect).not.toHaveBeenCalled();
      } finally {
        await Promise.all([firstDb.close(), secondDb.close()]);
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });
  });
});


describe("turn-ownership-authority.postgres", () => {
  const url=serverDatabaseUrl;
  if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))
    throw new Error('Turn authority proofs require isolated loopback PostgreSQL');
  const room='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';
  const source={connectionId:'registered-source',epoch:1};
  function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
  async function blocked(admin:Pool,pid:number){
    // Fixture synchronization against one admitted, nonempty row-lock obligation.
    for(let attempt=0;attempt<200;attempt++){
      if((await admin.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0]!.blocked)return;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    throw new Error('Expected current authority writer to wait behind final enqueue');
  }
  describe.skipIf(!url)('real PostgreSQL owned control current authority',()=>{
    it('fences actual effects and control enqueue against current revocation, replacement and lease expiry',async()=>{
      const schema='turn_authority_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
      await admin.query(`CREATE SCHEMA ${schema}`);
      const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
      const reader=new PostgresDatabase('',2,{pool:new Pool(config)}),writer=new PostgresDatabase('',2,{pool:new Pool(config)});
      let gate:ReturnType<typeof deferred<void>>|undefined,entered:ReturnType<typeof deferred<void>>|undefined;
      let pause:'before-authority'|'before-effect'|'after-command'|undefined;
      let lifecyclePid:ReturnType<typeof deferred<number>>|undefined;
      let authorityPid:ReturnType<typeof deferred<number>>|undefined;
      const archiveAllowed=deferred<void>();
      const closeRollbackAllowed=deferred<void>();
      let pending:Promise<unknown>|undefined,competing:Promise<unknown>|undefined,error:unknown;
      const frames:string[]=[];
      try{
        await reader.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
          CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz,
            reviewer_agent_id text,reviewer_fallback_ids text[] DEFAULT ARRAY[]::text[]);
          CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
          CREATE VIEW room_access AS
            SELECT member.* FROM memberships member WHERE member.room_id IS NULL OR EXISTS(
              SELECT 1 FROM rooms surface WHERE surface.id=member.room_id AND surface.parent_id IS NULL)
            UNION ALL SELECT corner.workspace_id,corner.id,parent.identity_id,parent.role,parent.removed_at
              FROM rooms corner JOIN memberships parent ON parent.room_id=corner.parent_id
              WHERE corner.parent_id IS NOT NULL AND corner.archived_at IS NULL;
          CREATE TABLE identities(id text PRIMARY KEY,name text);
          CREATE TABLE corner_facts(corner_id uuid PRIMARY KEY,reviewer_agent_id text);
          CREATE TABLE voice_orders(source_message_id text,agent_id text);
          CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,source_message_id text,
            action text,state text,generation_id text,lease_expires_at timestamptz,private_payload jsonb,created_at timestamptz DEFAULT now());
          CREATE TABLE agent_turns(room_id uuid,request_id text,agent_id text,generation_id text,status text,created_at timestamptz DEFAULT now());
          CREATE TABLE agents(agent_id text PRIMARY KEY,selected_model text);
          CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,presentation text,request_id text,
            activity jsonb,agent_model text,created_at timestamptz DEFAULT now());
          CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,instance_id text,released_at timestamptz);
          CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);`);
        await reader.query(DURABLE_LIVE_SCHEMA);await reader.query(ROUTER_PROJECTION_SCHEMA);await reader.query(TURN_OWNERSHIP_SCHEMA);
        await reader.query(`INSERT INTO workspaces VALUES($1);`,[workspace]);
        await reader.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[room,workspace]);
        await reader.query(`INSERT INTO memberships VALUES($1,NULL,'agent','member',NULL),($1,$2,'agent','member',NULL)`,[workspace,room]);
        await reader.query(`INSERT INTO live_server_instances VALUES('owner-server',clock_timestamp());
          INSERT INTO agent_connections VALUES('agent','registered-source',1,'owner-server',NULL);`);
        await reader.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,state,generation_id,turn_owner_connection_id,turn_owner_epoch)
          VALUES('command',$1,'agent','request','input','claimed','generation','registered-source',1)`,[room]);
        await reader.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,generation_id,status)
          VALUES($1,'request','agent','generation','working')`,[room]);
        const wrap=(tx:SqlDatabase):SqlDatabase=>({
          transaction:nested=>tx.transaction(inner=>nested(wrap(inner))),query:async(sql,args)=>{
            if(lifecyclePid&&sql.includes('pg_advisory_xact_lock(hashtext($1))')){
              lifecyclePid.resolve(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
            }
            if(authorityPid&&sql.includes('pg_advisory_xact_lock_shared'))
              authorityPid.resolve(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
            if(gate&&((pause==='before-authority'&&sql.includes('pg_advisory_xact_lock_shared'))||
                (pause==='before-effect'&&sql.includes('INSERT INTO messages(')))){
              pause=undefined;entered!.resolve();await gate.promise;
            }
            const result=await tx.query(sql,args);
            if(pause==='after-command'&&sql.includes('SELECT command.id FROM agent_commands command')&&gate){
              pause=undefined;entered!.resolve();await gate.promise;
            }
            return result;
          },
        });
        const observed:SqlDatabase={query:(sql,args)=>reader.query(sql,args),transaction:work=>reader.transaction(tx=>work(wrap(tx)))};
        const daemon=new DaemonService(observed,new LiveHub()),input={roomId:room,commandId:'command',generationId:'generation'};
        const effect={roomId:room,requestId:'request',generationId:'generation',activity:[]};
        // Revoke after execute's initial access read, before its real transaction
        // authority fence. The actual production activity writer must do no DML.
        gate=deferred<void>();entered=deferred<void>();pause='before-authority';
        pending=daemon.execute('postAgentActivity',effect,'agent');
        void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
        await writer.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id='agent'`,[room]);
        gate.resolve();await expect(pending).rejects.toThrow();gate=undefined;
        expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(0);
        await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id='agent'`,[room]);
        // Revoke after each control's initial access read too, before its claim
        // or stop-ack transaction can acquire source rows or modify commands.
        for(const operation of ['claimAgentCommand','acknowledgeAgentCommand'] as const){
          gate=deferred<void>();entered=deferred<void>();pause='before-authority';error=undefined;
          pending=daemon.execute(operation,input,'agent',source);
          void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
          await writer.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id='agent'`,[room]);
          gate.resolve();await expect(pending).rejects.toThrow();gate=undefined;
          expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(0);
          await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id='agent'`,[room]);
        }
  
        gate=deferred<void>();entered=deferred<void>();pause='before-effect';error=undefined;
        pending=daemon.execute('postAgentActivity',effect,'agent');
        void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
        const effectPid=deferred<number>();
        competing=writer.transaction(async tx=>{
          effectPid.resolve(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
          await tx.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id='agent'`,[room]);
        });
        await blocked(admin,await effectPid.promise);
        expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(0);
        gate.resolve();await pending;await competing;gate=undefined;
        expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(1);
        await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id='agent'`,[room]);
  
        const progressBeforeExpiry=(await reader.query('SELECT xmin::text version,created_at::text FROM agent_turns')).rows;
        gate=deferred<void>();entered=deferred<void>();pause='before-effect';error=undefined;
        pending=daemon.execute('postAgentActivity',effect,'agent');
        void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
        await writer.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds' WHERE instance_id='owner-server'`);
        gate.resolve();await expect(pending).rejects.toThrow('authority expired before commit');gate=undefined;
        expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(1);
        expect((await reader.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);
        expect((await reader.query('SELECT xmin::text version,created_at::text FROM agent_turns')).rows).toEqual(progressBeforeExpiry);
        await writer.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp() WHERE instance_id='owner-server'`);
        await writer.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id IS NULL AND identity_id='agent'`);
        await expect(daemon.execute('postAgentActivity',effect,'agent')).rejects.toThrow();
        expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(1);
        await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id IS NULL AND identity_id='agent'`);
  
        gate=deferred<void>();entered=deferred<void>();
        pause='after-command';error=undefined;
        pending=daemon.fenceOwnedTurnReply('agent',source,input,()=>frames.push('admitted-before-revoke'),true);
        void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
        const pid=deferred<number>();
        competing=writer.transaction(async tx=>{
          pid.resolve(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
          await tx.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id='agent'`,[room]);
        });
        await blocked(admin,await pid.promise);expect(frames).toEqual([]);
        gate.resolve();await pending;await competing;gate=undefined;
        expect(frames).toEqual(['admitted-before-revoke']);
        await expect(daemon.fenceOwnedTurnReply('agent',source,input,()=>frames.push('must-not-send-revoked'),true)).rejects.toThrow();
        expect(frames).toHaveLength(1); // The aggregate lease is still fresh.
  
        await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id='agent'`,[room]);
        gate=deferred<void>();entered=deferred<void>();error=undefined;
        pause='after-command';
        pending=daemon.fenceOwnedTurnReply('agent',source,input,()=>frames.push('must-not-send-expired'),true);
        void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
        await writer.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds' WHERE instance_id='owner-server'`);
        gate.resolve();await expect(pending).rejects.toThrow('source changed');gate=undefined;expect(frames).toHaveLength(1);
  
        await writer.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp() WHERE instance_id='owner-server'`);
        gate=deferred<void>();entered=deferred<void>();error=undefined;
        pause='after-command';
        pending=daemon.fenceOwnedTurnReply('agent',source,input,()=>frames.push('admitted-before-replacement'),true);
        void pending.catch(reason=>{error=reason;entered!.resolve();});await entered.promise;if(error)throw error;
        const replacementPid=deferred<number>();
        competing=writer.transaction(async tx=>{
          replacementPid.resolve(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
          await tx.query(`UPDATE agent_connections SET connection_id='replacement',epoch=2 WHERE agent_id='agent'`);
        });
        await blocked(admin,await replacementPid.promise);expect(frames).toHaveLength(1);
        gate.resolve();await pending;await competing;gate=undefined;
        await expect(daemon.fenceOwnedTurnReply('agent',source,input,()=>frames.push('must-not-send-old-owner'),true)).rejects.toThrow('source changed');
        expect(frames).toEqual(['admitted-before-revoke','admitted-before-replacement']);
  
        // The account/close writer's real ordering is lifecycle -> command/Room
        // authority. Start an actual failed-corner receipt while that writer
        // holds lifecycle, then let its real Room archival trigger run. Taking
        // shared authority before waiting for lifecycle creates a deadlock here.
        const parent='33333333-3333-4333-8333-333333333333';
        await writer.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[parent,workspace]);
        await writer.query(`INSERT INTO memberships VALUES($1,$2,'agent','member',NULL)`,[workspace,parent]);
        await writer.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`,[room,parent]);
        await writer.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,state,generation_id,turn_owner_connection_id,turn_owner_epoch)
          VALUES('lifecycle-command',$1,'agent','lifecycle-request','input','claimed','lifecycle-generation','replacement',2)`,[room]);
        const lifecycleHeld=deferred<void>();lifecyclePid=deferred<number>();
        competing=writer.transaction(async tx=>{
          await lockCornerLifecycle(tx,room);lifecycleHeld.resolve();await archiveAllowed.promise;
          await tx.query(`UPDATE rooms SET archived_at=clock_timestamp() WHERE id=$1`,[room]);
        });
        void competing.catch(()=>lifecycleHeld.resolve());await lifecycleHeld.promise;
        pending=daemon.execute('postAgentTurnReceipt',{agentId:'agent',roomId:room,requestId:'lifecycle-request',
          generationId:'lifecycle-generation',status:'failed',reason:'Synthetic harness failure'},'agent',{connectionId:'replacement',epoch:2});
        let receiptError:unknown;
        void pending.catch(reason=>{receiptError=reason;lifecyclePid!.resolve(0);});
        const receiptPid=await lifecyclePid.promise;if(receiptError)throw receiptError;expect(receiptPid).toBeGreaterThan(0);
        await blocked(admin,receiptPid);archiveAllowed.resolve();await competing;
        await expect(pending).rejects.toThrow('access denied');
        expect((await reader.query('SELECT * FROM messages')).rowCount).toBe(1);
        expect((await reader.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);
  
        await writer.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`,[room]);
        lifecyclePid=undefined;
        const commandHeld=deferred<void>(),closeRollback=new Error('Synthetic close rollback');
        let closeError:unknown;
        // Enter the actual common cancellation boundary and retain its first
        // nonempty command lock. Roll back deliberately after the real archival
        // trigger, before cancellation's later stop-delivery business work.
        competing=writer.transaction(async tx=>{
          await lockCornerLifecycle(tx,room);
          await cancelCornerAgentCommands({transaction:nested=>tx.transaction(nested),query:async(sql,args)=>{
            const result=await tx.query(sql,args);
            if(sql.includes('SELECT * FROM agent_commands')&&sql.includes('FOR UPDATE')){
              expect(result.rowCount).toBeGreaterThan(0);commandHeld.resolve();await closeRollbackAllowed.promise;
              await tx.query(`UPDATE rooms SET archived_at=clock_timestamp() WHERE id=$1`,[room]);
              throw closeRollback;
            }
            return result;
          }},room);
        });
        const closed=competing.catch(reason=>{closeError=reason;commandHeld.resolve();});await commandHeld.promise;if(closeError)throw closeError;
        authorityPid=deferred<number>();
        pending=daemon.fenceOwnedTurnReply('agent',{connectionId:'replacement',epoch:2},
          {roomId:room,commandId:'lifecycle-command',generationId:'lifecycle-generation'},()=>frames.push('current-after-close-rollback'),true);
        void pending.catch(()=>authorityPid!.resolve(0));
        const enqueuePid=await authorityPid.promise;expect(enqueuePid).toBeGreaterThan(0);await blocked(admin,enqueuePid);
        expect((await admin.query<{wait_event:string}>('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[enqueuePid])).rows[0]!.wait_event).toBe('advisory');
        expect(frames).toHaveLength(2);closeRollbackAllowed.resolve();await closed;expect(closeError).toBe(closeRollback);
        await pending;expect(frames).toEqual(['admitted-before-revoke','admitted-before-replacement','current-after-close-rollback']);
      }finally{
        gate?.resolve();archiveAllowed.resolve();closeRollbackAllowed.resolve();await Promise.allSettled([pending,competing].filter((work):work is Promise<unknown>=>work!==undefined));
        await Promise.all([reader.close(),writer.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
      }
    },20_000);
  });
});


describe("turn-ownership.postgres", () => {
  const url = serverDatabaseUrl;
  if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Turn ownership proofs require isolated loopback PostgreSQL');
  const room = '11111111-1111-4111-8111-111111111111';
  const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
  async function blocked(admin: Pool, pid: number): Promise<void> {
    // Test synchronization against one known nonempty lock obligation only.
    // This is not a runtime retry or discovery owner.
    for (let i = 0; i < 200; i += 1) {
      if ((await admin.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0]!.blocked) return;
      await new Promise(done => setTimeout(done, 5));
    }
    throw new Error('Expected competing PostgreSQL connection to wait on its exact source row');
  }
  
  describe.skipIf(!url)('real PostgreSQL execution ownership contention', () => {
    it('serializes replacement with an admitted writer, survives rollback, and keeps generation bindings across requeue', async () => {
      const schema = 'turn_owner_' + randomUUID().replaceAll('-', '');
      const admin = new Pool({ connectionString: url, max: 1 }); await admin.query(`CREATE SCHEMA ${schema}`);
      const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
      const left = new PostgresDatabase('', 2, { pool: new Pool(config) });
      const right = new PostgresDatabase('', 2, { pool: new Pool(config) });
      const entered = deferred<void>(), releaseWriter = deferred<void>(), replacementEntered = deferred<void>(), rollBack = deferred<void>(), waitingPid = deferred<number>();
      const expiryEntered = deferred<void>(), releaseExpired = deferred<void>();
      let writer: Promise<unknown> | undefined, replacement: Promise<unknown> | undefined;
      let temporary: Promise<unknown> | undefined, afterRollback: Promise<unknown> | undefined;
      let writerError: unknown;
      let overdue: Promise<unknown> | undefined, overdueError: unknown;
      try {
        await left.query(`CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,
            action text,state text,generation_id text,lease_expires_at timestamptz,created_at timestamptz DEFAULT now());
          CREATE TABLE agent_turns(room_id uuid,request_id text,agent_id text,status text,generation_id text,created_at timestamptz DEFAULT now());
          CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,instance_id text,released_at timestamptz);
          CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);
          CREATE TABLE ownership_effects(id text PRIMARY KEY,epoch bigint);`);
        await left.query(TURN_OWNERSHIP_SCHEMA);
        await left.query(`INSERT INTO live_server_instances VALUES('old-server',clock_timestamp()),('new-server',clock_timestamp());
          INSERT INTO agent_connections VALUES('agent','old-connection',1,'old-server',NULL);`);
        await left.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,state,generation_id,
            turn_owner_connection_id,turn_owner_epoch) VALUES('command',$1,'agent','request','input','claimed','generation','old-connection',1)`, [room]);
        await left.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id) VALUES($1,'request','agent','working','generation')`, [room]);
  
        writer = left.transaction(async db => {
          await authorizeCommandOutput(db, room, 'agent', 'request', 'generation');
          await authorizeCommandOutput(db, room, 'agent', 'request', 'generation');
          expect(Number((await db.query<{ count: string }>('SELECT count(*)::text count FROM turn_owned_effect_fences')).rows[0]!.count)).toBe(1);
          entered.resolve(); await releaseWriter.promise;
          await db.query(`INSERT INTO ownership_effects VALUES('admitted-old-effect',1)`);
        });
        void writer.catch(error => { writerError = error; entered.resolve(); });
        await entered.promise;
        // Surface an early authorization error immediately rather than leaving
        // an unresolved fixture barrier until the suite deadline.
        if (writerError) throw writerError;
        let replaced = false;
        replacement = right.transaction(async db => {
          const pid = Number((await db.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid);
          waitingPid.resolve(pid);
          await db.query(`UPDATE agent_connections SET connection_id='new-connection',epoch=2,instance_id='new-server' WHERE agent_id='agent'`);
          replaced = true;
        });
        await blocked(admin, await waitingPid.promise); expect(replaced).toBe(false);
        releaseWriter.resolve(); await writer; await replacement;
        expect((await left.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);
        expect((await left.query(`SELECT id FROM ownership_effects`)).rows).toEqual([{ id: 'admitted-old-effect' }]);
        await expect(left.transaction(db => authorizeCommandOutput(db, room, 'agent', 'request', 'generation')))
          .rejects.toThrow('command output authority rejected');
  
        await left.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='command'`);
        await expect(right.query(`UPDATE agent_commands SET state='claimed',generation_id='generation',
          turn_owner_connection_id='new-connection',turn_owner_epoch=2 WHERE id='command'`)).rejects.toThrow('generation owner changed');
        await right.transaction(async db => {
          await db.query(`UPDATE agent_commands SET state='claimed',generation_id='new-generation',turn_owner_connection_id='new-connection',turn_owner_epoch=2 WHERE id='command'`);
          await db.query(`UPDATE agent_turns SET generation_id='new-generation'`);
        });
        const before = (await left.query(`SELECT command.xmin::text command_version,turn.xmin::text turn_version,
          command.created_at::text command_created,turn.created_at::text turn_created FROM agent_commands command CROSS JOIN agent_turns turn`)).rows;
        await right.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp() WHERE instance_id='new-server'`);
        expect((await left.query(`SELECT command.xmin::text command_version,turn.xmin::text turn_version,
          command.created_at::text command_created,turn.created_at::text turn_created FROM agent_commands command CROSS JOIN agent_turns turn`)).rows).toEqual(before);
  
        temporary = right.transaction(async db => {
          await db.query(`UPDATE agent_connections SET connection_id='uncommitted-replacement',epoch=3 WHERE agent_id='agent'`);
          replacementEntered.resolve(); await rollBack.promise; throw new Error('synthetic rollback');
        });
        const rolledBack = temporary.catch(error => { expect(error.message).toBe('synthetic rollback'); });
        await replacementEntered.promise;
        const leftPid = deferred<number>();
        afterRollback = left.transaction(async db => {
          leftPid.resolve(Number((await db.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
          await authorizeCommandOutput(db, room, 'agent', 'request', 'new-generation');
          await db.query(`INSERT INTO ownership_effects VALUES('same-owner-after-rollback',2)`);
        });
        await blocked(admin, await leftPid.promise);
        rollBack.resolve(); await rolledBack; await afterRollback;
        expect((await left.query(`SELECT id FROM ownership_effects ORDER BY id`)).rows).toEqual([
          { id: 'admitted-old-effect' }, { id: 'same-owner-after-rollback' },
        ]);
        expect((await left.query<{ live: boolean }>(`SELECT ${commandOwnerLiveSql('command')} live FROM agent_commands command`)).rows[0]!.live).toBe(true);
        overdue = left.transaction(async db => {
          await authorizeCommandOutput(db, room, 'agent', 'request', 'new-generation');
          expiryEntered.resolve(); await releaseExpired.promise;
          await db.query(`INSERT INTO ownership_effects VALUES('must-rollback-after-expiry',2)`);
        });
        void overdue.catch(error => { overdueError = error; expiryEntered.resolve(); });
        await expiryEntered.promise; if (overdueError) throw overdueError;
        await right.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds' WHERE instance_id='new-server'`);
        releaseExpired.resolve();
        await expect(overdue).rejects.toThrow('authority expired before commit');
        expect((await left.query(`SELECT id FROM ownership_effects WHERE id='must-rollback-after-expiry'`)).rowCount).toBe(0);
        expect((await left.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);
        await expect(left.transaction(db => authorizeCommandOutput(db, room, 'agent', 'request', 'new-generation')))
          .rejects.toThrow('command output authority rejected');
      } finally {
        releaseWriter.resolve(); rollBack.resolve(); releaseExpired.resolve();
        await Promise.allSettled([writer, replacement, temporary, afterRollback, overdue].filter((work): work is Promise<unknown> => work !== undefined));
        await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
      }
    }, 20_000);
  });
});


describe("voice-budget.postgres", () => {
  const url=serverDatabaseUrl;
  if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))
    throw new Error('Voice ownership proofs require isolated loopback PostgreSQL');
  const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
  
  describe.skipIf(!url)('F17 voice durable admission and final owner fence, real PostgreSQL',()=>{
    it('retains charged admission, denies a prior takeover and holds the exact owner row through synchronous enqueue',async()=>{
      const schema=`voice_meter_${randomUUID().replaceAll('-','')}`;
      const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
      const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
      const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
      const now=Date.now(),entered=deferred(),release=deferred();let pause=false;
      const wrap=(database:SqlDatabase):SqlDatabase=>({
        transaction:work=>database.transaction(tx=>work(wrap(tx))),
        query:async(sql,values)=>{const result=await database.query(sql,values);
          if(pause&&sql.includes('ended_at IS NULL FOR SHARE')){pause=false;entered.resolve();await release.promise;}return result;},
      });
      try{
        await first.query(`CREATE TABLE rooms(id text PRIMARY KEY,workspace_id text);
          CREATE TABLE voice_calls(id text PRIMARY KEY,room_id text,runtime_owner text,runtime_until timestamptz,ended_at timestamptz);
          CREATE TABLE voice_workspace_usage(workspace_id text,call_id text,day_start bigint,audio int8multirange DEFAULT '{}',PRIMARY KEY(workspace_id,call_id,day_start));
          INSERT INTO rooms VALUES('room','workspace');
          INSERT INTO voice_calls VALUES('call','room','owner',clock_timestamp()+interval '1 minute',NULL);`);
        const budget=new VoiceBudgetStore(wrap(first),10_000,()=>now),replacement=new VoiceBudgetStore(second,10_000,()=>now);
        await budget.record('call','owner','workspace',[[now-20,now]]);
        await second.query("UPDATE voice_calls SET runtime_owner='successor' WHERE id='call'");
        let enqueues=0;expect(await budget.fence('call','owner',()=>{enqueues++;})).toBe(false);
        expect(enqueues).toBe(0);expect((await replacement.read('workspace')).remainingMs).toBe(9980);
        await second.query("UPDATE voice_calls SET runtime_owner='owner' WHERE id='call'");
        pause=true;const guarded=budget.fence('call','owner',()=>{enqueues++;});await entered.promise;
        await expect(second.transaction(async tx=>{
          await tx.query("SET LOCAL lock_timeout='100ms'");
          await tx.query("UPDATE voice_calls SET runtime_owner='successor' WHERE id='call'");
        })).rejects.toMatchObject({code:'55P03'});
        expect(enqueues).toBe(0);release.resolve();expect(await guarded).toBe(true);expect(enqueues).toBe(1);
        await second.query("UPDATE voice_calls SET runtime_owner='successor' WHERE id='call'");
        expect(await budget.fence('call','owner',()=>{enqueues++;})).toBe(false);expect(enqueues).toBe(1);
        expect((await replacement.read('workspace')).remainingMs).toBe(9980);
      }finally{release.resolve();await Promise.all([first.close(),second.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
    });
  
    it('survives a crash boundary after durable commit but before acknowledgment without unbilled forwarding or a duplicate charge',async()=>{
      const schema=`voice_crash_${randomUUID().replaceAll('-','')}`;
      const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
      const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
      const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
      const now=Date.now(),committed=deferred(),ack=deferred();let meter:VoiceAudioMeter|undefined;
      try{
        await first.query(`CREATE TABLE rooms(id text PRIMARY KEY,workspace_id text);
          CREATE TABLE voice_calls(id text PRIMARY KEY,room_id text,runtime_owner text,runtime_until timestamptz,ended_at timestamptz);
          CREATE TABLE voice_workspace_usage(workspace_id text,call_id text,day_start bigint,audio int8multirange DEFAULT '{}',PRIMARY KEY(workspace_id,call_id,day_start));
          INSERT INTO rooms VALUES('room','workspace');
          INSERT INTO voice_calls VALUES('call','room','owner',clock_timestamp()+interval '1 minute',NULL);`);
        const store=new VoiceBudgetStore(first,10_000,()=>now),restored=new VoiceBudgetStore(second,10_000,()=>now);
        const record=store.record.bind(store);store.record=async(...args)=>{const result=await record(...args);committed.resolve();await ack.promise;return result;};
        let sent=0;meter=new VoiceAudioMeter(store,'call','owner','workspace',await store.read('workspace'),()=>{},()=>{},()=>now);
        meter.capture(new Int16Array(320),now,()=>{sent++;});const flush=meter.flush();await committed.promise;
        expect((await restored.read('workspace')).remainingMs).toBe(9980);expect(sent).toBe(0);
        const closed=meter.close();ack.resolve();await Promise.all([flush,closed]);expect(sent).toBe(0);
        await restored.record('call','owner','workspace',[[now-20,now]]);
        expect((await restored.read('workspace')).remainingMs).toBe(9980);
      }finally{ack.resolve();await meter?.close();await Promise.all([first.close(),second.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
    });
  });
});


describe("database", () => {
  it('indexes delivered claims still awaiting a read-clear push', async () => {
    const database = await migratedDatabase();
    try {
      const index = await database.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname='push_delivery_claims_read_clear_idx'`,
      );
      expect(index.rows[0]?.indexdef).toContain('(device_token, message_id)');
      expect(index.rows[0]?.indexdef).toContain("status = 'delivered'");
      expect(index.rows[0]?.indexdef).toContain('read_cleared_at IS NULL');
    } finally {
      await database.close();
    }
  });
  
  it('upgrades the question-only needs-you index to include commander reports', async () => {
    const database = await migratedDatabase();
    try {
      await database.query('DROP INDEX messages_needs_you_actionable_idx');
      await database.query(`CREATE INDEX messages_needs_you_question_idx ON messages(created_at)
        WHERE presentation='message' AND deleted_at IS NULL AND text LIKE '%?'`);
      await migrate(database);
      const indexes = (await database.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname,indexdef FROM pg_indexes WHERE indexname LIKE 'messages_needs_you_%'`,
      )).rows;
      expect(indexes.some(index => index.indexname === 'messages_needs_you_question_idx')).toBe(false);
      expect(indexes.find(index => index.indexname === 'messages_needs_you_actionable_idx')?.indexdef)
        .toContain('blocked|needs-decision|failed');
    } finally {
      await database.close();
    }
  });
  
  function result<Row>(rows: Row[]) {
    return { rows, rowCount: rows.length };
  }
  
  const TERMINATED = () => new Error('Connection terminated unexpectedly');
  
  it('retires old Google consent and connector rows without leaving active grants', async () => {
    const database = new PgliteDatabase();
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const connector = '33333333-3333-4333-8333-333333333333';
    const app = '44444444-4444-4444-8444-444444444444';
    const grant = '55555555-5555-4555-8555-555555555555';
    const human = 'a'.repeat(64);
    const agent = 'b'.repeat(64);
    try {
      await migrate(database);
      await database.query(`INSERT INTO identities(id,kind,name)
        VALUES($1,'human','Owner'),($2,'agent','Helper')`, [human, agent]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name)
        VALUES($1,$2,$3,'Tools')`, [room, workspace, human]);
      await database.query(`INSERT INTO workspace_connectors(id,workspace_id,
        owner_identity_id,connector_type,helper_agent_id,status)
        VALUES($1,$2,$3,'google-calendar',$4,'connected')`, [connector, workspace, human, agent]);
      await database.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,
        app_key,display_name,transport,route,connector_id)
        VALUES($1,$2,$3,'calendar','Calendar','registry-mcp','workbench',$4)`,
        [app, workspace, human, connector]);
      await database.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,
        reason,requested_by,room_id,status,app_id)
        VALUES($1,$2,$3,'mcp','app:calendar','legacy',$4,$5,'approved',$6)`,
        [grant, agent, workspace, human, room, app]);
      await database.query(`CREATE TABLE google_oauth_accounts (id text)`);
      await database.query(`CREATE TABLE google_oauth_grants (id text)`);
      await database.query(`CREATE TABLE google_oauth_attempts (id text)`);
      await database.query(`INSERT INTO google_oauth_accounts(id) VALUES('legacy-account')`);
      await database.query(`INSERT INTO google_oauth_grants(id) VALUES('legacy-grant')`);
      await database.query(`INSERT INTO google_oauth_attempts(id) VALUES('legacy-attempt')`);
      await migrate(database);
      expect((await database.query<{ state: string; connector_id: string | null }>(
        `SELECT state,connector_id FROM workspace_apps WHERE id=$1`, [app])).rows)
        .toEqual([{ state: 'disconnected', connector_id: null }]);
      expect((await database.query<{ status: string }>(
        `SELECT status FROM agent_grants WHERE id=$1`, [grant])).rows)
        .toEqual([{ status: 'revoked' }]);
      expect((await database.query(`SELECT 1 FROM workspace_connectors WHERE id=$1`,
        [connector])).rowCount).toBe(0);
      expect((await database.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE
        schemaname='public' AND tablename LIKE 'google_oauth_%' ORDER BY tablename`)).rows)
        .toEqual([{ tablename: 'google_oauth_grants' }]);
      expect((await database.query(`SELECT 1 FROM google_oauth_grants`)).rowCount).toBe(1);
    } finally {
      await database.close();
    }
  });
  
  it('turns every legacy Workspace ban into a plain removal before dropping the ban table', async () => {
    const database = new PgliteDatabase();
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const owner = 'a'.repeat(64);
    const banned = 'b'.repeat(64);
    const kept = 'c'.repeat(64);
    try {
      await migrate(database);
      await database.query(`INSERT INTO identities(id,kind,name)
        VALUES($1,'human','Owner'),($2,'human','Banned'),($3,'human','Kept')`, [owner, banned, kept]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name)
        VALUES($1,$2,$3,'Tools')`, [room, workspace, owner]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
          ($1,$5,$3,'member'),($1,$5,$4,'member')`, [workspace, owner, banned, kept, room]);
      // A legacy ban whose memberships are still live: the drop must not restore
      // (or leave live) anyone the ban table was holding out.
      await database.query(`CREATE TABLE workspace_bans (workspace_id uuid NOT NULL,
        identity_id text NOT NULL, banned_by text, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(workspace_id, identity_id))`);
      await database.query(`INSERT INTO workspace_bans(workspace_id,identity_id,banned_by)
        VALUES($1,$2,$3)`, [workspace, banned, owner]);
      await migrate(database);
      const live = await database.query<{ identity_id: string; room_id: string | null }>(
        `SELECT identity_id,room_id FROM memberships WHERE workspace_id=$1 AND removed_at IS NULL
         ORDER BY identity_id,room_id NULLS FIRST`,
        [workspace],
      );
      expect(live.rows).toEqual([
        { identity_id: owner, room_id: null },
        { identity_id: kept, room_id: null },
        { identity_id: kept, room_id: room },
      ]);
      expect((await database.query(`SELECT to_regclass('workspace_bans') IS NULL gone`)).rows)
        .toEqual([{ gone: true }]);
    } finally {
      await database.close();
    }
  });
  
  it('excludes existing accounts while new identities inherit welcome eligibility', async () => {
    const database = new PgliteDatabase();
    try {
      const oldId = 'a'.repeat(64);
      const newId = 'b'.repeat(64);
      await database.query(`CREATE TABLE identities (
        id text PRIMARY KEY, kind text NOT NULL, name text NOT NULL, handle text,
        avatar text, hidden_from_roster boolean NOT NULL DEFAULT false,
        push_level text NOT NULL DEFAULT 'mine', github_subject text UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Old')`, [oldId]);
      await migrate(database);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','New')`, [newId]);
      const rows = await database.query<{ id: string; welcome_cards_due: boolean | null }>(
        `SELECT id,welcome_cards_due FROM identities WHERE id=ANY($1::text[]) ORDER BY id`,
        [[oldId, newId]],
      );
      expect(rows.rows).toEqual([
        { id: oldId, welcome_cards_due: null },
        { id: newId, welcome_cards_due: true },
      ]);
    } finally {
      await database.close();
    }
  });
  
  describe('Room slugs', () => {
    it('requires a bounded lowercase slug for new names', () => {
      expect(requireRoomSlug('room-name-2')).toBe('room-name-2');
      for (const value of ['Room Name', 'room--name', '-room', 'room-', '', 'room\n', 'room\r', 'room\u00a0name', 'room\u2003name'])
        expect(() => requireRoomSlug(value)).toThrow(/invalid Room name/);
    });
  
    it('refuses a name another top-level Room in the Workspace already uses', async () => {
      const db = await migratedDatabase();
      const workspace = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      const otherWorkspace = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaab';
      const room = 'bbbbbbbb-bbbb-4bbb-bbbb-000000000001';
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Slug test'),($2,'Other')`, [
        workspace,
        otherWorkspace,
      ]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Road-Map')`, [
        room,
        workspace,
      ]);
  
      await expect(reserveRoomName(db, workspace, 'road-map')).rejects.toThrow(/conflict/);
      await expect(reserveRoomName(db, workspace, 'Road-Map')).rejects.toThrow(/conflict/);
      // A rename may keep the Room's own name.
      await expect(reserveRoomName(db, workspace, 'road-map', room)).resolves.toBeUndefined();
      // The same name is free in another Workspace.
      await expect(reserveRoomName(db, otherWorkspace, 'road-map')).resolves.toBeUndefined();
    });
  });
  
  function stubClient() {
    const client = new EventEmitter() as EventEmitter & {
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    };
    client.query = vi.fn().mockResolvedValue(result([]));
    client.release = vi.fn();
    return client;
  }
  
  function poolHandingOut(clients: unknown[]) {
    const connect = vi.fn();
    clients.forEach((client) => connect.mockResolvedValueOnce(client));
    return { query: vi.fn(), on: vi.fn(), connect, end: vi.fn() } as unknown as Pool;
  }
  
  function poolWithQuery(query: ReturnType<typeof vi.fn>): Pool {
    const connect = vi.fn(async () => {
      const client = stubClient();
      client.query = query;
      return client;
    });
    return { query: vi.fn(), on: vi.fn(), connect, end: vi.fn() } as unknown as Pool;
  }
  
  describe('pool checkout telemetry', () => {
    it('separates queued checkout time from checked-out query time and releases on failure', async () => {
      const client = stubClient();
      let grant!: (client: typeof client) => void;
      const checkout = new Promise<typeof client>((resolve) => { grant = resolve; });
      const pool = {
        connect: vi.fn().mockReturnValueOnce(checkout).mockResolvedValue(client),
        waitingCount: 1,
        on: vi.fn(), end: vi.fn(),
      } as unknown as Pool;
      const database = new PostgresDatabase('', 1, { pool });
      const first = database.query('SELECT 1');
      await new Promise((resolve) => setTimeout(resolve, 20));
      grant(client);
      await first;
      const afterFirst = database.poolTelemetry();
      expect(afterFirst.checkouts).toBe(1);
      expect(afterFirst.waitMs).toBeGreaterThanOrEqual(15);
      expect(afterFirst.waitBuckets.reduce((sum, count) => sum + count, 0)).toBe(1);
      expect(database.queryWindow()).toMatchObject({
        queryCount: 1, checkoutCount: 1, waiterP95: 1,
      });
      expect(database.queryWindow().waitP95Ms).toBeGreaterThanOrEqual(15);
      expect(client.release).toHaveBeenCalledOnce();
  
      client.query.mockRejectedValueOnce(Object.assign(new Error('statement timeout'), { code: '57014' }));
      await expect(database.query('BROKEN')).rejects.toThrow('statement timeout');
      const afterFailure = database.poolTelemetry();
      expect(afterFailure.checkouts).toBe(2);
      expect(afterFailure.statementTimeouts).toBe(1);
      expect(afterFailure.activeMs).toBeGreaterThanOrEqual(afterFirst.activeMs);
      expect(client.release).toHaveBeenCalledTimes(2);
    });
  
    it('counts failed checkout attempts independently of successful checkouts', async () => {
      const pool = {
        connect: vi.fn().mockRejectedValue(new Error('pool exhausted')),
        on: vi.fn(), end: vi.fn(),
      } as unknown as Pool;
      const database = new PostgresDatabase('', 1, { pool });
      await expect(database.query('SELECT 1')).rejects.toThrow('pool exhausted');
      expect(database.poolTelemetry()).toMatchObject({ checkouts: 0, checkoutFailures: 1 });
    });
  });
  
  describe('a terminated checked-out connection never wedges the pool', () => {
    it('destroys a transaction connection after its total deadline and refuses late queries', async () => {
      const client = stubClient();
      const database = new PostgresDatabase('', 1, {
        pool: poolHandingOut([client]), transactionDeadlineMs: 50,
      });
      let releaseWork: (() => void) | undefined;
      const work = new Promise<void>((resolve) => { releaseWork = resolve; });
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const stalled = database.transaction(async (transaction) => {
        markStarted!();
        await work;
        await transaction.query('SELECT should_not_run');
      });
      const rejection = expect(stalled).rejects.toThrow(/transaction deadline exceeded/);
      await started;
      expect(database.oldestActiveTransactionAgeMs()).not.toBe(null);
      await rejection;
      expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ code: '57014' }));
      expect(database.transactionDeadlineCount()).toBe(1);
      expect(database.oldestActiveTransactionAgeMs()).toBe(null);
      releaseWork!();
      await Promise.resolve();
      expect(client.query).not.toHaveBeenCalledWith('SELECT should_not_run');
    });
  
    it('clears a stalled query age when a transaction deadline destroys its client', async () => {
      const client = stubClient();
      client.query.mockImplementation((sql: string) =>
        sql === 'SELECT hanging' ? new Promise(() => {}) : Promise.resolve(result([])),
      );
      const database = new PostgresDatabase('', 1, {
        pool: poolHandingOut([client]), transactionDeadlineMs: 20,
      });
      await expect(database.transaction((transaction) => transaction.query('SELECT hanging')))
        .rejects.toThrow(/transaction deadline exceeded/);
      expect(await database.oldestActiveQueryAgeMs()).toBe(null);
      expect(database.oldestActiveTransactionAgeMs()).toBe(null);
      expect(client.release).toHaveBeenCalledOnce();
    });
    it('frees a checked-out transaction client that errors while no query is pending, and the pool recovers', async () => {
      const dying = stubClient();
      dying.query
        .mockResolvedValueOnce(result([])) // BEGIN
        .mockRejectedValue(TERMINATED()); // COMMIT (and ROLLBACK) on the dead socket
      const healthy = stubClient();
      const database = new PostgresDatabase('', 5, { pool: poolHandingOut([dying, healthy]) });
  
      let releaseWork: (() => void) | undefined;
      const work = new Promise<void>((resolve) => {
        releaseWork = resolve;
      }).then(() => 'first work');
      const first = database.transaction(() => work);
      await vi.waitFor(() => expect(dying.query).toHaveBeenCalledWith('BEGIN'));
  
      // The socket dies while the transaction body is doing non-database work:
      // nothing in the app is awaiting this client, so nothing else will free it.
      dying.emit('error', TERMINATED());
      expect(dying.release).toHaveBeenCalledWith(expect.any(Error));
  
      releaseWork!();
      await expect(first).rejects.toThrow(/Connection terminated/);
      // The app's own finally must not double-release the reclaimed client.
      expect(dying.release).toHaveBeenCalledTimes(1);
  
      // The freed slot hands out a fresh client: the pool recovered.
      await expect(database.transaction(() => 'second work')).resolves.toBe('second work');
      expect(healthy.query).toHaveBeenCalledWith('BEGIN');
    });
  
    it('releases and recovers when a pool query hits a terminated connection', async () => {
      const pool = poolWithQuery(vi
          .fn()
          .mockRejectedValueOnce(TERMINATED())
          .mockResolvedValueOnce(result([{ answer: 2 }])));
      const database = new PostgresDatabase('', 5, { pool });
  
      await expect(database.query('SELECT 2')).rejects.toThrow(/Connection terminated/);
      expect(pool.connect).toHaveBeenCalledOnce();
      await expect(database.query<{ answer: number }>('SELECT 2')).resolves.toEqual(
        result([{ answer: 2 }]),
      );
      expect(database.queryProfiles().top).toMatchObject([{ calls: 2, errors: 1 }]);
      expect(pool.connect).toHaveBeenCalledTimes(2);
    });
  
    it('announces recovery once after a failed pool read succeeds later', async () => {
      const pool = poolWithQuery(vi.fn()
          .mockRejectedValueOnce(TERMINATED())
          .mockResolvedValue(result([{ answer: 2 }])));
      const database = new PostgresDatabase('', 2, { pool });
      const recovered = vi.fn();
      const release = database.onRecovery(recovered);
  
      await expect(database.query('SELECT 1')).rejects.toThrow(/Connection terminated/);
      expect(recovered).not.toHaveBeenCalled();
      await expect(database.query('SELECT 2')).resolves.toEqual(result([{ answer: 2 }]));
      expect(recovered).toHaveBeenCalledOnce();
      await database.query('SELECT 3');
      expect(recovered).toHaveBeenCalledOnce();
      release();
    });
  
    it('bounds every pool acquisition and keeps half-open connections from hanging silently', () => {
      expect(postgresPoolConfig('postgres://app', 1, 'long-running')).toMatchObject({
        connectionTimeoutMillis: APP_POOL_WAIT_TIMEOUT_MS,
        keepAlive: true,
      });
      expect(postgresPoolConfig('postgres://app', 1, 'diagnostics')).toMatchObject({
        connectionTimeoutMillis: HEALTH_POOL_WAIT_TIMEOUT_MS,
        keepAlive: true,
      });
      expect(postgresPoolConfig('postgres://app', 1, 'migration')).toMatchObject({
        application_name: 'beeline_migration',
        options: `-c jit=off -c lock_timeout=${MIGRATION_LOCK_TIMEOUT_MS}ms -c statement_timeout=${MIGRATION_STATEMENT_TIMEOUT_MS}ms`,
      });
    });
  
    it('retries server startup and connection saturation responses', () => {
      expect(isTransientDatabaseConnectionError({ code: '57P03' })).toBe(true);
      expect(isTransientDatabaseConnectionError({ code: '53300' })).toBe(true);
    });
  });
  
  describe('message search vectors', () => {
    it('keeps release schema and resumable data work separate without losing historical search', async () => {
      const database = await migratedDatabase();
      try {
        const workspace = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
        const room = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
        const author = 'a'.repeat(64);
        await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`, [author]);
        await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'History')`, [workspace]);
        await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
        await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('legacy-search',$1,$2,'historical phrase')`, [room, author]);
        await database.query(`UPDATE messages SET search_document=NULL WHERE id='legacy-search'`);
        await migrate(database, { deferData: true });
        expect((await database.query(`SELECT search_document FROM messages WHERE id='legacy-search'`)).rows[0]).toEqual({ search_document: null });
        await migrateData(database);
        expect((await database.query<{ matched: boolean }>(
          `SELECT search_document @@ websearch_to_tsquery('simple','historical phrase') matched
           FROM messages WHERE id='legacy-search'`,
        )).rows[0]?.matched).toBe(true);
        // Upgrade a database whose exact documents are already fully populated.
        await database.query(`ALTER TABLE messages DROP COLUMN search_stem_document`);
        await migrate(database, { deferData: true });
        expect((await database.query(`SELECT search_stem_document FROM messages WHERE id='legacy-search'`)).rows[0])
          .toEqual({ search_stem_document: null });
        await migrateData(database);
        expect((await database.query<{ matched: boolean }>(
          `SELECT search_stem_document @@ plainto_tsquery('english','historical phrases') matched
           FROM messages WHERE id='legacy-search'`,
        )).rows[0]?.matched).toBe(true);
        expect(await backfillMessageSearchDocuments(database, 10)).toBe(0);
      } finally {
        await database.close();
      }
    });
    it('maintains new writes by trigger and fills history in bounded batches', async () => {
      const database = await migratedDatabase();
      const workspace = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
      const room = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`, [
        'a'.repeat(64),
      ]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Search')`, [workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text)
         SELECT 'search-'||lpad(series::text,3,'0'),$1,$2,'release marker '||series
         FROM generate_series(1,25) series`,
        [room, 'a'.repeat(64)],
      );
  
      const searchable = async () =>
        Number(
          (
            await database.query<{ count: string }>(
              `SELECT count(*)::text count FROM messages
               WHERE search_document @@ websearch_to_tsquery('simple','release marker')`,
            )
          ).rows[0]?.count ?? 0,
        );
      // The trigger indexed every insert without a table rewrite.
      expect(await searchable()).toBe(25);
  
      // A row older than the search window can never be returned by a search, so
      // the release does not pay to vectorize it. This is the whole reason the
      // backfill is not a full rewrite of the busiest table behind the gate.
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         VALUES('ancient',$1,$2,'release marker ancient',
                now()-($3+30)*interval '1 day')`,
        [room, 'a'.repeat(64), INSTITUTIONAL_HISTORY_MAX_AGE_DAYS],
      );
  
      // Rows written before the column existed carry no vector until the backfill.
      await database.query(`UPDATE messages SET search_document=NULL`);
      expect(await searchable()).toBe(0);
      expect(await backfillMessageSearchDocuments(database, 10)).toBe(25);
      expect(await searchable()).toBe(25);
      expect(
        (
          await database.query<{ document: string | null }>(
            `SELECT search_document::text document FROM messages WHERE id='ancient'`,
          )
        ).rows[0]?.document,
      ).toBe(null);
  
      // A converged table's single probe must not read the heap. The index is NOT
      // empty — every out-of-window row above is still in it — so what makes the
      // probe free is the newest-first range scan stopping at the window edge.
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         SELECT 'ancient-'||lpad(series::text,4,'0'),$1,$2,'ancient message '||series,
                now()-($3+series)*interval '1 day'
         FROM generate_series(1,500) series`,
        [room, 'a'.repeat(64), INSTITUTIONAL_HISTORY_MAX_AGE_DAYS],
      );
      await database.query(`UPDATE messages SET search_document=NULL WHERE id LIKE 'ancient-%'`);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text)
         SELECT 'bulk-'||lpad(series::text,5,'0'),$1,$2,'bulk message '||series
         FROM generate_series(1,3000) series`,
        [room, 'a'.repeat(64)],
      );
      await database.query(`ANALYZE messages`);
      const probePlan = JSON.stringify(
        (
          await database.query<Record<string, unknown>>(
            `EXPLAIN (FORMAT JSON)
             SELECT id FROM messages
             WHERE search_document IS NULL AND presentation='message'
               AND created_at>=now()-${INSTITUTIONAL_HISTORY_MAX_AGE_DAYS}*interval '1 day'
             ORDER BY created_at DESC LIMIT 2000`,
          )
        ).rows[0]?.['QUERY PLAN'],
      );
      expect(probePlan).toContain('messages_search_document_backfill_idx');
      expect(probePlan).not.toContain('"Node Type":"Seq Scan"');
      const stemProbePlan = JSON.stringify((await database.query(
        `EXPLAIN (FORMAT JSON) SELECT id FROM messages
         WHERE search_stem_document IS NULL AND presentation='message'
           AND created_at>=now()-${INSTITUTIONAL_HISTORY_MAX_AGE_DAYS}*interval '1 day'
         ORDER BY created_at DESC LIMIT 2000`,
      )).rows[0]?.['QUERY PLAN']);
      expect(stemProbePlan).toContain('messages_search_stem_document_backfill_idx');
      expect(stemProbePlan).not.toContain('"Node Type":"Seq Scan"');
      const stemSearchPlan = JSON.stringify((await database.query(
        `EXPLAIN (FORMAT JSON) SELECT id FROM messages
         WHERE search_stem_document @@ plainto_tsquery('english','releases markers')
           AND deleted_at IS NULL AND presentation='message'`,
      )).rows[0]?.['QUERY PLAN']);
      expect(stemSearchPlan).toContain('messages_search_stem_document_idx');
  
      // A filled table costs one query, not a window walk on every release.
      let queries = 0;
      const counted: SqlDatabase = {
        query: (sql, values) => {
          queries += 1;
          return database.query(sql, values);
        },
        transaction: (work) => database.transaction(work),
      };
      expect(await backfillMessageSearchDocuments(counted, 10)).toBe(0);
      expect(queries).toBe(1);
      // Those 500 entries are still in the index and still unfilled: the converged
      // probe cost one query anyway, which is the whole point of skipping them.
      expect(
        Number(
          (
            await database.query<{ count: string }>(
              `SELECT count(*)::text count FROM messages
               WHERE search_document IS NULL AND presentation='message'`,
            )
          ).rows[0]?.count ?? 0,
        ),
      ).toBe(501);
  
      await database.query(`UPDATE messages SET text='unrelated wording' WHERE id='search-001'`);
      expect(await searchable()).toBe(24);
      expect((await database.query<{ matched: boolean }>(
        `SELECT search_stem_document @@ plainto_tsquery('english','releases markers') matched
         FROM messages WHERE id='search-001'`,
      )).rows[0]?.matched).toBe(false);
      await database.query(`UPDATE messages SET presentation='system' WHERE id='search-002'`);
      expect((await database.query(
        `SELECT search_document::text exact,search_stem_document::text stem
         FROM messages WHERE id='search-002'`,
      )).rows[0]).toEqual({ exact: '', stem: '' });
      database.close();
    });
  
    it('writes an empty vector rather than failing on an oversized or non-chat row', async () => {
      const database = await migratedDatabase();
      const workspace = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';
      const room = 'ffffffff-ffff-4fff-ffff-ffffffffffff';
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`, [
        'a'.repeat(64),
      ]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Search')`, [workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
  
      // Distinct short tokens are the worst case: to_tsvector's output runs about
      // 3x its input, so an unbounded call raises past Postgres's hard
      // 1,048,575-byte vector limit and the INSERT itself fails.
      const tokens: string[] = [];
      for (let index = 0, bytes = 0; bytes < 1_200_000; index += 1) {
        const token = `marker${index.toString(36)}`;
        tokens.push(token);
        bytes += token.length + 1;
      }
      const oversized = tokens.join(' ');
      expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(MESSAGE_SEARCH_DOCUMENT_MAX_BYTES);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES('oversized',$1,$2,$3)`,
        [room, 'a'.repeat(64), oversized],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation)
         VALUES('a-system-line',$1,$2,'release marker system note','system')`,
        [room, 'a'.repeat(64)],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES('ordinary',$1,$2,'release marker')`,
        [room, 'a'.repeat(64)],
      );
  
      const vectors = new Map(
        (
          await database.query<{ id: string; document: string }>(
            `SELECT id,search_document::text document FROM messages ORDER BY id`,
          )
        ).rows.map((row) => [row.id, row.document]),
      );
      expect(vectors.get('oversized')).toBe('');
      expect(vectors.get('a-system-line')).toBe('');
      expect(vectors.get('ordinary')).not.toBe('');
      const stems = new Map((await database.query<{ id: string; document: string }>(
        `SELECT id,search_stem_document::text document FROM messages`,
      )).rows.map((row) => [row.id, row.document]));
      expect(stems.get('oversized')).toBe('');
      expect(stems.get('a-system-line')).toBe('');
      expect(stems.get('ordinary')).not.toBe('');
  
      // Empty is not NULL, so the drained backfill still converges over them.
      expect(await backfillMessageSearchDocuments(database, 10)).toBe(0);
      expect(
        (
          await database.query<{ id: string }>(
            `SELECT id FROM messages
             WHERE search_document @@ websearch_to_tsquery('simple','release marker')`,
          )
        ).rows.map((row) => row.id),
      ).toEqual(['ordinary']);
      database.close();
    });
  });
  
  describe('institutional cascades', () => {
    it('keeps a consolidated fact when an unrelated Room is deleted', async () => {
      const database = await migratedDatabase();
      const workspace = '11110000-0000-4000-8000-000000000002';
      const jobRoom = '22220000-0000-4000-8000-000000000002';
      const factRoom = '22220000-0000-4000-8000-000000000003';
      const human = 'b'.repeat(64);
      const job = '33330000-0000-4000-8000-000000000002';
      const item = '55550000-0000-4000-8000-000000000002';
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
        human,
      ]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Shared')`, [workspace]);
      await database.query(
        `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Job room'),($2,$3,'Fact room')`,
        [jobRoom, factRoom, workspace],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES
           ('job-room-source',$1,$3,'A source.'),('fact-room-source',$2,$3,'Another source.')`,
        [jobRoom, factRoom, human],
      );
      // The curator queues the workspace-facts partition against whichever Room
      // its first candidate came from, but consolidates a fact that lives in another.
      await database.query(
        `INSERT INTO institutional_memory_jobs
         (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
          requester_identity_id,source_audience_kind,idempotency_key)
         VALUES($1,$2,'curator','live',$3,'job-room-source',$4,'workspace_candidate','cross-room')`,
        [job, workspace, jobRoom, human],
      );
      await database.query(
        `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,
          audience_kind,confidence,version,created_by_job_id)
         VALUES($1,$2,'workspace_fact','cross-room-key','A consolidated fact.',$3,
                'fact-room-source','workspace',0.9,2,$4)`,
        [item, workspace, factRoom, job],
      );
  
      await database.query(`DELETE FROM rooms WHERE id=$1`, [jobRoom]);
  
      // The fact survives its own Room's untouched lifetime; only the provenance
      // pointer to the deleted job is forgotten.
      expect(
        (
          await database.query<{ id: string; state: string; created_by_job_id: string | null }>(
            `SELECT id,state,created_by_job_id FROM institutional_memory_items WHERE id=$1`,
            [item],
          )
        ).rows[0],
      ).toMatchObject({ id: item, state: 'active', created_by_job_id: null });
  
      // Deleting the fact's own Room still removes it.
      await database.query(`DELETE FROM rooms WHERE id=$1`, [factRoom]);
      expect((await database.query(`SELECT 1 FROM institutional_memory_items`)).rowCount).toBe(0);
      database.close();
    });
  
    it('lets a Workspace delete carry every institutional row with it', async () => {
      const database = await migratedDatabase();
      const workspace = '11110000-0000-4000-8000-000000000001';
      const room = '22220000-0000-4000-8000-000000000001';
      const human = 'a'.repeat(64);
      const job = '33330000-0000-4000-8000-000000000001';
      const skill = '44440000-0000-4000-8000-000000000001';
      const item = '55550000-0000-4000-8000-000000000001';
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
        human,
      ]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Doomed')`, [workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES('cascade-source',$1,$2,'A source.')`,
        [room, human],
      );
      await database.query(
        `INSERT INTO institutional_memory_jobs
         (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
          requester_identity_id,source_audience_kind,idempotency_key)
         VALUES($1,$2,'merge_review','live',$3,'cascade-source',$4,'workspace_candidate','cascade')`,
        [job, workspace, room, human],
      );
      // A memory item and a skill version both reference that job.
      await database.query(
        `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,
          audience_kind,confidence,version,created_by_job_id)
         VALUES($1,$2,'workspace_fact','cascade-key','A fact.',$3,'cascade-source',
                'workspace',0.9,1,$4)`,
        [item, workspace, room, job],
      );
      await database.query(
        `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit)
         VALUES($1,$2,'cascade-procedure','A procedure','active',1,1,$3,'owner/repo',$4)`,
        [skill, workspace, room, 'a'.repeat(40)],
      );
      await database.query(
        `INSERT INTO workspace_skill_versions
         (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
          repository,target_commit,extractor_version,model)
         VALUES($1,1,'Body.',$2,$3,ARRAY['cascade-source']::text[],'owner/repo',$4,'test','test')`,
        [skill, 'b'.repeat(64), job, 'a'.repeat(40)],
      );
  
      await expect(
        database.query(`DELETE FROM workspaces WHERE id=$1`, [workspace]),
      ).resolves.toBeDefined();
      expect((await database.query(`SELECT 1 FROM workspace_skill_versions`)).rowCount).toBe(0);
      expect((await database.query(`SELECT 1 FROM institutional_memory_items`)).rowCount).toBe(0);
      expect((await database.query(`SELECT 1 FROM institutional_memory_jobs`)).rowCount).toBe(0);
      database.close();
    });
  });
  
  describe('cascade-path foreign keys stay indexed', () => {
    it('never lets a FK into messages, rooms, or workspaces lack a supporting index', async () => {
      const database = await migratedDatabase();
      // A workspace delete cascades through rooms and messages; an FK column
      // pointing at one of those three tables with no leading-column index
      // forces Postgres to sequentially scan the whole child table for the FK
      // check or cascade. That is exactly what stalled DELETE FROM workspaces
      // past the app pool's statement_timeout for the Beeline Welcome
      // Workspace (agent_commands.source_message_id/result_message_id and
      // messages.reply_to_message_id, found by reproducing the incident).
      const unindexed = await database.query<{ child_table: string; fk_columns: string[] }>(
        `WITH fk AS (
           SELECT con.conname, con.conrelid, con.confrelid::regclass::text AS parent, con.conkey
           FROM pg_constraint con
           WHERE con.contype = 'f'
             AND con.confrelid::regclass::text IN ('messages', 'rooms', 'workspaces')
         )
         SELECT fk.conrelid::regclass::text AS child_table,
                array_agg(att.attname ORDER BY k.ord) AS fk_columns
         FROM fk
         JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute att ON att.attrelid = fk.conrelid AND att.attnum = k.attnum
         WHERE NOT EXISTS (
           SELECT 1 FROM pg_index idx
           WHERE idx.indrelid = fk.conrelid
             AND (idx.indkey::smallint[])[0:array_length(fk.conkey,1)-1] = fk.conkey::smallint[]
         )
         GROUP BY fk.conrelid`,
      );
      expect(unindexed.rows).toEqual([]);
      database.close();
    });
  });
  
  describe('release-owned schema readiness', () => {
    it('rejects the previous schema marker until the push outbox migration is released', async () => {
      const query = vi.fn().mockResolvedValue(result([{ version: REQUIRED_SCHEMA_VERSION - 1 }]));
      await expect(assertSchemaCurrent({ query, transaction: vi.fn() })).rejects.toThrow(
        new RegExp(`expected schema version ${REQUIRED_SCHEMA_VERSION}, found ${REQUIRED_SCHEMA_VERSION - 1}`),
      );
    });
  
    it('returns unavailable boot evidence once without treating it as a schema mismatch', async () => {
      const failure = new Error('timeout exceeded when trying to connect');
      const query = vi.fn().mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(result([{ version: REQUIRED_SCHEMA_VERSION, router_version: REQUIRED_ROUTER_SCHEMA_VERSION }]));
      await expect(assertSchemaCurrent({ query, transaction: vi.fn() })).rejects.toBe(failure);
      expect(query).toHaveBeenCalledOnce();
      await expect(assertSchemaCurrent({ query, transaction: vi.fn() })).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(2);
    });
  
    it('fails boot clearly until the release migration writes its final marker', async () => {
      const database = new PgliteDatabase();
      await expect(assertSchemaCurrent(database)).rejects.toThrow(
        /database schema is not ready.*release migration step/,
      );
      await migrate(database);
      await expect(assertSchemaCurrent(database)).rejects.toThrow(/release migration step/);
      await markSchemaCurrent(database);
      await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
      database.close();
    });
  });
  
  describe('PostgresDatabase one-attempt ownership', () => {
    it('bounds app and enrichment statements and pool checkout waits', () => {
      expect(postgresPoolConfig('postgres://app', 7)).toMatchObject({
        max: 7,
        statement_timeout: APP_STATEMENT_TIMEOUT_MS,
        connectionTimeoutMillis: APP_POOL_WAIT_TIMEOUT_MS,
        application_name: 'beeline_app',
      });
      expect(postgresPoolConfig('postgres://app', 2, 'enrichment')).toMatchObject({
        max: 2,
        statement_timeout: ENRICHMENT_STATEMENT_TIMEOUT_MS,
        connectionTimeoutMillis: ENRICHMENT_POOL_WAIT_TIMEOUT_MS,
        application_name: 'beeline_enrichment',
      });
      expect(postgresPoolConfig('postgres://owner', 1, 'long-running')).toMatchObject({
        statement_timeout: 2_000, options: '-c jit=off -c lock_timeout=500ms',
      });
    });
  
    it('never repeats an autocommitted write after its reply is lost', async () => {
      const failure = new Error('Connection terminated unexpectedly');
      let effects = 0;
      const query = vi.fn(async () => {
        effects++;
        if (effects === 1) throw failure;
        return result([{ id: effects }]);
      });
      const pool = poolWithQuery(query);
      const database = new PostgresDatabase('', 5, { pool });
      await expect(database.query('INSERT INTO effects DEFAULT VALUES RETURNING id')).rejects.toBe(failure);
      expect(query).toHaveBeenCalledOnce();
      expect(effects).toBe(1);
    });
  
    it('returns query failure and admits another attempt only on a separate call', async () => {
      const failure = new Error('Connection terminated unexpectedly');
      const query = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(result([{ answer: 1 }]));
      const pool = poolWithQuery(query);
      const database = new PostgresDatabase('', 5, { pool });
      await expect(database.query('SELECT 1')).rejects.toBe(failure);
      expect(query).toHaveBeenCalledOnce();
      await expect(database.query('SELECT 1')).resolves.toEqual(result([{ answer: 1 }]));
      expect(query).toHaveBeenCalledTimes(2);
      expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  
    it.each(['EAI_AGAIN', '53300', 'ENOTFOUND', 'EAI_NONAME', 'EAI_FAIL'])(
      'parks checkout failure %s for an idle day without another attempt', async (code) => {
        vi.useFakeTimers();
        try {
          const error = Object.assign(new Error(`database unavailable: ${code}`), { code });
          expect(isTransientDatabaseConnectionError(error)).toBe(['EAI_AGAIN', '53300'].includes(code));
          const pool = { on: vi.fn(), connect: vi.fn().mockRejectedValue(error), end: vi.fn() } as unknown as Pool;
          const database = new PostgresDatabase('', 5, { pool });
          await expect(database.query('SELECT 1')).rejects.toBe(error);
          await vi.advanceTimersByTimeAsync(86_400_000);
          expect(pool.connect).toHaveBeenCalledOnce();
          expect(vi.getTimerCount()).toBe(0);
          expect(database.poolTelemetry()).toMatchObject({ checkouts: 0, checkoutFailures: 1 });
        } finally { vi.useRealTimers(); }
      },
    );
  
    it('keeps temporary DNS classification code-based', () => {
      expect(isTransientDatabaseConnectionError({ code: 'EAI_AGAIN' })).toBe(true);
      expect(isTransientDatabaseConnectionError(new Error('getaddrinfo EAI_AGAIN database.example.invalid'))).toBe(false);
    });
  
    it('does not retry non-connection errors', async () => {
      const failure = Object.assign(new Error('duplicate key'), { code: '23505' });
      const query = vi.fn().mockRejectedValue(failure);
      const database = new PostgresDatabase('', 5, { pool: poolWithQuery(query) });
      await expect(database.query('SELECT 1')).rejects.toBe(failure);
      expect(query).toHaveBeenCalledOnce();
    });
  
    it.each(['checkout', 'begin'])('returns transaction %s failure without running or retrying work', async (stage) => {
      const failure = Object.assign(new Error('connection unavailable'), { code: '08006' });
      const query = vi.fn().mockResolvedValue(result([]));
      const pool = poolWithQuery(query);
      if (stage === 'checkout') vi.mocked(pool.connect).mockRejectedValueOnce(failure);
      else query.mockRejectedValueOnce(failure);
      const database = new PostgresDatabase('', 5, { pool });
      const work = vi.fn().mockResolvedValue('complete');
      await expect(database.transaction(work)).rejects.toMatchObject({ name: 'DatabaseTransactionStartError', cause: failure });
      expect(pool.connect).toHaveBeenCalledOnce();
      expect(work).not.toHaveBeenCalled();
      expect(query.mock.calls).toEqual(stage === 'checkout' ? [] : [['BEGIN']]);
      const recovered = vi.fn();
      database.onRecovery(recovered);
      await expect(database.transaction(work)).resolves.toBe('complete');
      expect(work).toHaveBeenCalledOnce();
      expect(recovered).toHaveBeenCalledOnce();
    });
  
    it('does not replay a transaction callback or a lost COMMIT', async () => {
      const failure = new Error('Connection terminated unexpectedly');
      const query = vi.fn(async (sql: string) => {
        if (sql === 'COMMIT') throw failure;
        return result([]);
      });
      const pool = poolWithQuery(query);
      const database = new PostgresDatabase('', 5, { pool });
      const work = vi.fn(async (db: SqlDatabase) => { await db.query('INSERT INTO effects DEFAULT VALUES'); });
      await expect(database.transaction(work)).rejects.toBe(failure);
      expect(pool.connect).toHaveBeenCalledOnce();
      expect(work).toHaveBeenCalledOnce();
      expect(query.mock.calls).toEqual([['BEGIN'], ['INSERT INTO effects DEFAULT VALUES'], ['COMMIT'], ['ROLLBACK']]);
      expect(failure).not.toBeInstanceOf(DatabaseTransactionStartError);
    });
  
    it('makes one dedicated checkout attempt and reports recovery only after admitted database work', async () => {
      const failure = new Error('Connection terminated unexpectedly');
      const query = vi.fn().mockResolvedValue(result([{ answer: 1 }]));
      const pool = poolWithQuery(query);
      vi.mocked(pool.connect).mockRejectedValueOnce(failure);
      const database = new PostgresDatabase('', 5, { pool });
      const recovered = vi.fn();
      const unsubscribe = database.onRecovery(recovered);
      await expect(database.connectDedicated()).rejects.toBe(failure);
      expect(pool.connect).toHaveBeenCalledOnce();
      expect(recovered).not.toHaveBeenCalled();
      await database.query('SELECT 1');
      expect(recovered).toHaveBeenCalledOnce();
      unsubscribe();
    });
  
    it('handles an error emitted by a dedicated client', async () => {
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn(),
        release: vi.fn(),
      });
      const pool = {
        query: vi.fn(),
        on: vi.fn(),
        connect: vi.fn().mockResolvedValue(client),
        end: vi.fn(),
      } as unknown as Pool;
      const database = new PostgresDatabase('', 5, { pool });
      const error = new Error('Connection terminated unexpectedly');
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  
      const dedicated = await database.connectDedicated();
  
      expect(client.listenerCount('error')).toBe(1);
      expect(() => dedicated.emit('error', error)).not.toThrow();
      expect(errorLog).toHaveBeenCalledWith('dedicated postgres client error', error);
      dedicated.release();
      expect(client.listenerCount('error')).toBe(0);
      const reused = await database.connectDedicated();
      expect(reused.listenerCount('error')).toBe(1);
      reused.release();
      expect(client.listenerCount('error')).toBe(0);
    });
  });
  
  describe('the message cursor index', () => {
    const AUTHOR = 'a'.repeat(64);
    const WORKSPACE = '11111111-1111-4111-8111-111111111111';
    const ROOM = '22222222-2222-4222-8222-222222222222';
    let database: PgliteDatabase;
  
    beforeEach(async () => {
      database = await migratedDatabase();
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`, [
        AUTHOR,
      ]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
      await database.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,
        [ROOM, WORKSPACE, AUTHOR],
      );
    });
  
    afterEach(() => database.close());
  
    it('uses the expression index for the seeded inbox query plan', async () => {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         SELECT lpad(value::text,64,'0'),$1,$2,'message',
                '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 millisecond'
         FROM generate_series(1,10000) value`,
        [ROOM, AUTHOR],
      );
      await database.query(`ANALYZE messages`);
  
      const explained = await database.query<Record<'QUERY PLAN', unknown>>(
        `EXPLAIN (FORMAT JSON)
         SELECT id,${MESSAGE_CURSOR_MS_SQL} cursor_ms FROM messages
         WHERE room_id=$1 AND (${MESSAGE_CURSOR_MS_SQL},id)>($2::bigint,$3)
         ORDER BY cursor_ms,id LIMIT 101`,
        [ROOM, Date.parse('2026-01-01T00:00:05Z'), '0'.repeat(64)],
      );
      const plan = JSON.stringify(explained.rows[0]?.['QUERY PLAN']);
      expect(plan).toContain('messages_room_cursor_idx');
      expect(plan).not.toMatch(/"Node Type":"Seq Scan"[^}]*"Relation Name":"messages"/);
    });
  
    it('keeps same-millisecond order and cursor round-trips tied to the message id', async () => {
      const lowerId = '1'.repeat(64);
      const higherId = '2'.repeat(64);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
         ($1,$3,$4,'later microsecond','2026-09-06T12:00:00.000900Z'),
         ($2,$3,$4,'earlier microsecond','2026-09-06T12:00:00.000100Z')`,
        [lowerId, higherId, ROOM, AUTHOR],
      );
  
      const first = await database.query<{ id: string; cursor_ms: number | string }>(
        `SELECT id,${MESSAGE_CURSOR_MS_SQL} cursor_ms FROM messages
         WHERE room_id=$1 ORDER BY cursor_ms,id LIMIT 1`,
        [ROOM],
      );
      expect(first.rows).toEqual([{ id: lowerId, cursor_ms: 1_788_696_000_000 }]);
      const cursor = first.rows[0]!;
      const after = await database.query<{ id: string }>(
        `SELECT id FROM messages WHERE room_id=$1
         AND (${MESSAGE_CURSOR_MS_SQL},id)>($2::bigint,$3)
         ORDER BY ${MESSAGE_CURSOR_MS_SQL},id`,
        [ROOM, cursor.cursor_ms, cursor.id],
      );
      expect(after.rows).toEqual([{ id: higherId }]);
    });
  
    it('matches the persisted cursor expression across time-zone edge cases', async () => {
      const timestamps = [
        '1965-03-14T07:00:00.123456Z',
        '2026-03-08T06:59:59.999999Z',
        '2026-03-08T07:00:00.000001Z',
        '2026-11-01T05:59:59.999999Z',
        '2026-11-01T06:00:00.000001Z',
        '2200-01-01T00:00:00.654321Z',
      ];
      const result = await database.query<{ old_cursor: string; indexed_cursor: string }>(
        `SELECT floor(extract(epoch FROM created_at)*1000)::bigint old_cursor,
                ${MESSAGE_CURSOR_MS_SQL} indexed_cursor
         FROM unnest($1::timestamptz[]) created_at`,
        [timestamps],
      );
  
      expect(result.rows.every((row) => row.old_cursor === row.indexed_cursor)).toBe(true);
    });
  });
  
  describe('the membership inviter migration', () => {
    const OWNER = 'a'.repeat(64);
    const MEMBER = 'b'.repeat(64);
    const WORKSPACE = '11111111-1111-4111-8111-111111111111';
    let database: PgliteDatabase;
  
    beforeEach(async () => {
      database = await migratedDatabase();
    });
  
    afterEach(() => database.close());
  
    it('upgrades legacy inviter references so deleting an inviter preserves the member', async () => {
      await database.query(`ALTER TABLE memberships DROP CONSTRAINT memberships_invited_by_fkey`);
      await database.query(
        `ALTER TABLE memberships ADD CONSTRAINT memberships_invited_by_fkey
         FOREIGN KEY (invited_by) REFERENCES identities(id)`,
      );
      await database.query(
        `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Member')`,
        [OWNER, MEMBER],
      );
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
         VALUES($1,NULL,$2,'member',$3)`,
        [WORKSPACE, MEMBER, OWNER],
      );
  
      await migrate(database);
      await database.query(`DELETE FROM identities WHERE id=$1`, [OWNER]);
  
      expect(
        (
          await database.query<{ invited_by: string | null }>(
            `SELECT invited_by FROM memberships WHERE workspace_id=$1 AND identity_id=$2`,
            [WORKSPACE, MEMBER],
          )
        ).rows,
      ).toEqual([{ invited_by: null }]);
    });
  });
  
  describe('the three-level push migration', () => {
    const OWNER = 'a'.repeat(64);
    let database: PgliteDatabase;
    beforeEach(async () => {
      database = await migratedDatabase();
    });
    afterEach(() => database.close());
  
    it('preserves Full activity across repeated migrations', async () => {
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
        OWNER,
      ]);
      // Simulate a stored preference before repeating the migration.
      await database.query(`ALTER TABLE identities DROP CONSTRAINT identities_push_level_check`);
      await database.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [OWNER]);
      // Repeated migration must preserve the chosen sensitivity.
      await migrate(database);
      expect(
        (
          await database.query<{ push_level: string }>(
            `SELECT push_level FROM identities WHERE id=$1`,
            [OWNER],
          )
        ).rows[0]?.push_level,
      ).toBe('full');
      await database.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [OWNER]);
    });
  });
  
  describe('the yolo default migration', () => {
    const OWNER = 'a'.repeat(64);
    const ON_AGENT = '1'.repeat(64);
    const OFF_AGENT = '2'.repeat(64);
    const FRESH_AGENT = '4'.repeat(64);
    let database: PgliteDatabase;
    beforeEach(async () => {
      database = await migratedDatabase();
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
        OWNER,
      ]);
    });
    afterEach(() => database.close());
  
    it('keeps an owner\'s explicit yolo off across a release migration', async () => {
      await database.query(
        `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Off'),($2,'agent','On')`,
        [OFF_AGENT, ON_AGENT],
      );
      await database.query(
        `INSERT INTO agents(agent_id,owner_id,yolo_mode) VALUES($1,$3,false),($2,$3,true)`,
        [OFF_AGENT, ON_AGENT, OWNER],
      );
      await migrate(database);
      const rows = await database.query<{ agent_id: string; yolo_mode: boolean }>(
        `SELECT agent_id,yolo_mode FROM agents ORDER BY agent_id`,
      );
      expect(rows.rows).toEqual([
        { agent_id: ON_AGENT, yolo_mode: true },
        { agent_id: OFF_AGENT, yolo_mode: false },
      ]);
    });
  
    it('defaults a newly created agent to yolo on', async () => {
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Fresh')`, [
        FRESH_AGENT,
      ]);
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [
        FRESH_AGENT,
        OWNER,
      ]);
      const rows = await database.query<{ yolo_mode: boolean }>(
        `SELECT yolo_mode FROM agents WHERE agent_id=$1`,
        [FRESH_AGENT],
      );
      expect(rows.rows).toEqual([{ yolo_mode: true }]);
    });
  });
  
  describe('the institutional memory rollout migration', () => {
    const STAGED = '10000000-0000-4000-8000-000000000011';
    const PAUSED = '10000000-0000-4000-8000-000000000012';
    const OFF = '10000000-0000-4000-8000-000000000013';
    const PLAIN = '10000000-0000-4000-8000-000000000014';
    let database: PgliteDatabase;
    beforeEach(async () => {
      database = await migratedDatabase();
    });
    afterEach(() => database.close());
  
    it('enrolls every Workspace live, advances staged rows, and keeps the off switches', async () => {
      await database.query(
        `INSERT INTO workspaces(id,name) VALUES($1,'Staged'),($2,'Paused'),($3,'Off'),($4,'Plain')`,
        [STAGED, PAUSED, OFF, PLAIN],
      );
      await database.query(
        `INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES
           ($1,'shadow'),($2,'paused'),($3,'off')`,
        [STAGED, PAUSED, OFF],
      );
  
      // One staged row advances to live and one Workspace with no row is enrolled.
      await expect(backfillInstitutionalMemoryRollout(database)).resolves.toBe(2);
      const stages = await database.query<{ workspace_id: string; stage: string }>(
        `SELECT workspace_id,stage FROM institutional_memory_workspace_rollouts
         WHERE workspace_id=ANY($1::uuid[]) ORDER BY workspace_id`,
        [[STAGED, PAUSED, OFF, PLAIN]],
      );
      expect(new Map(stages.rows.map((row) => [row.workspace_id, row.stage]))).toEqual(
        new Map([
          [STAGED, 'live'],
          [PAUSED, 'paused'],
          [OFF, 'off'],
          [PLAIN, 'live'],
        ]),
      );
  
      // A second run has nothing left to do.
      await expect(backfillInstitutionalMemoryRollout(database)).resolves.toBe(0);
    });
  
    it('defaults a newly inserted rollout row to live', async () => {
      const NEW = '10000000-0000-4000-8000-000000000015';
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'New')`, [NEW]);
      await database.query(
        `INSERT INTO institutional_memory_workspace_rollouts(workspace_id) VALUES($1)`,
        [NEW],
      );
      const stage = await database.query<{ stage: string }>(
        `SELECT stage FROM institutional_memory_workspace_rollouts WHERE workspace_id=$1`,
        [NEW],
      );
      expect(stage.rows[0]?.stage).toBe('live');
    });
  });
  
  it('keeps the previous server image able to read and write through migration and rollback', async () => {
    const database = new PgliteDatabase();
    const workspace = '10000000-0000-4000-8000-000000000021';
    const room = '20000000-0000-4000-8000-000000000021';
    const item = '30000000-0000-4000-8000-000000000021';
    const skill = '40000000-0000-4000-8000-000000000021';
    const human = 'a'.repeat(64);
    try {
      await migrate(database);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [human]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Memory')`, [workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Shared')`, [room, workspace]);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('old-source',$1,$2,'Fact')`, [room, human]);
      await database.query(`INSERT INTO institutional_memory_workspace_rollouts(workspace_id) VALUES($1)`, [workspace]);
      await database.query(`INSERT INTO institutional_memory_items
        (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,
         audience_kind,confidence,version)
        VALUES($1,$2,'workspace_fact','old-key','Fact',$3,'old-source','workspace',0.9,1)`,
        [item, workspace, room]);
      await database.query(`INSERT INTO workspace_skills
        (id,workspace_id,slug,description,current_version,revision,source_room_id,repository,target_commit)
        VALUES($1,$2,'old-skill','A saved skill',1,1,$3,'','')`, [skill, workspace, room]);
  
      for (let image = 0; image < 2; image += 1) {
        await migrateData(database);
        // These are the previous image's lifecycle columns and state writes.
        const settings = await database.query<{ stale_after_days: number; archive_after_days: number; retention_days: number }>(
          `SELECT stale_after_days,archive_after_days,retention_days
           FROM institutional_memory_workspace_rollouts WHERE workspace_id=$1`, [workspace]);
        expect(settings.rows[0]).toEqual({ stale_after_days: 30, archive_after_days: 90, retention_days: 365 });
        await database.query(`UPDATE institutional_memory_items SET state='archived' WHERE id=$1`, [item]);
        await database.query(`UPDATE workspace_skills SET state='archived' WHERE id=$1`, [skill]);
      }
    } finally {
      await database.close();
    }
  });
  
  describe('the agent handle migration', () => {
    let database: PgliteDatabase;
    beforeEach(async () => {
      database = await migratedDatabase();
    });
    afterEach(() => database.close());
  
    it('replaces unrelated and duplicate legacy handles with unique name-derived addresses', async () => {
      const human = 'a'.repeat(64);
      const goosy = 'b'.repeat(64);
      const lumen = 'c'.repeat(64);
      const secondLumen = 'd'.repeat(64);
      await database.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Alice','alice'),
         ($2,'agent','Goosy','nora'),
         ($3,'agent','Lumen','una'),
         ($4,'agent','Lumen','nora')`,
        [human, goosy, lumen, secondLumen],
      );
      const workspace = '11111111-1111-4111-8111-111111111111';
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Tubing Crew')`, [workspace]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
         ($1,NULL,$4,'member'),($1,NULL,$5,'member')`,
        [workspace, human, goosy, lumen, secondLumen],
      );
  
      await expect(backfillAgentHandles(database)).resolves.toBe(3);
      const rows = await database.query<{ name: string; handle: string }>(
        `SELECT name,handle FROM identities WHERE kind='agent' ORDER BY id`,
      );
      expect(rows.rows).toEqual([
        { name: 'Goosy', handle: 'goosy' },
        { name: 'Lumen', handle: 'lumen' },
        { name: 'Lumen', handle: 'lumen_2' },
      ]);
      await expect(backfillAgentHandles(database)).resolves.toBe(0);
    });
  
    it('allocates across every Workspace the agent belongs to', async () => {
      const human = 'e'.repeat(64);
      const agent = 'f'.repeat(64);
      const otherWorkspace = '22222222-2222-4222-8222-222222222222';
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline Welcome')`, [
        DEFAULT_WORKSPACE_ID,
      ]);
      await database.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Lumen','lumen'),($2,'agent','Lumen','nora')`,
        [human, agent],
      );
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Elsewhere')`, [
        otherWorkspace,
      ]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'member'),($3,NULL,$4,'member'),($1,NULL,$4,'member')`,
        [DEFAULT_WORKSPACE_ID, agent, otherWorkspace, human],
      );
  
      await migrate(database);
  
      expect(
        (await database.query(`SELECT handle FROM identities WHERE id=$1`, [agent])).rows,
      ).toEqual([{ handle: 'lumen_2' }]);
    });
  });
  
  describe('the per-item event subscription migration', () => {
    const AGENT_A = 'a'.repeat(64);
    const AGENT_B = 'b'.repeat(64);
    const WORKSPACE = '11111111-1111-4111-8111-111111111111';
    const ROOM = '22222222-2222-4222-8222-222222222222';
  
    it('strips exactly the per-item kinds, idempotently, and leaves Room-level kinds alone', async () => {
      const database = await migratedDatabase();
      await database.query(
        `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee'),($2,'agent','Owl')`,
        [AGENT_A, AGENT_B],
      );
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        ROOM,
        WORKSPACE,
      ]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions) VALUES
         ($1,$2,$3,'member','["joined","grant-decided","choice-answered"]'::jsonb),
         ($1,$2,$4,'member','["merged"]'::jsonb)`,
        [WORKSPACE, ROOM, AGENT_A, AGENT_B],
      );
      await expect(backfillPerItemEventSubscriptions(database)).resolves.toBe(1);
      const rows = await database.query<{ identity_id: string; event_subscriptions: string[] }>(
        `SELECT identity_id,event_subscriptions FROM memberships WHERE room_id=$1 ORDER BY identity_id`,
        [ROOM],
      );
      expect(rows.rows).toEqual([
        { identity_id: AGENT_A, event_subscriptions: ['joined'] },
        { identity_id: AGENT_B, event_subscriptions: ['merged'] },
      ]);
      await expect(backfillPerItemEventSubscriptions(database)).resolves.toBe(0);
      await database.close();
    });
  });
  
  describe('the top-level shared Room role migration', () => {
    it('repairs shared Room roles inherited by corners and preserves DM authority', async () => {
      const database = await migratedDatabase();
      const workspace = '41111111-1111-4111-8111-111111111111';
      const room = '42222222-2222-4222-8222-222222222222';
      const corner = '43333333-3333-4333-8333-333333333333';
      const dm = '44444444-4444-4444-8444-444444444444';
      const member = 'd'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Admin')`, [
        member,
      ]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [workspace]);
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,name,direct_participants) VALUES
         ($1,$4,NULL,'Room',NULL),($2,$4,$1,'Corner',NULL),($3,$4,NULL,'DM',$5::jsonb)`,
        [room, corner, dm, workspace, JSON.stringify([member])],
      );
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'admin'),($1,$3,$2,'member'),($1,$4,$2,'owner')`,
        [workspace, member, room, dm],
      );
  
      await migrate(database);
  
      const roles = await database.query<{ room_id: string | null; role: string }>(
        `SELECT room_id,role FROM room_access WHERE workspace_id=$1 AND identity_id=$2
         ORDER BY room_id NULLS FIRST`,
        [workspace, member],
      );
      expect(roles.rows).toEqual([
        { room_id: null, role: 'admin' },
        { room_id: room, role: 'admin' },
        { room_id: corner, role: 'admin' },
        { room_id: dm, role: 'owner' },
      ]);
      database.close();
    });
  });
  
  describe('the workspace_connectors machine_id migration ordering', () => {
    let database: PgliteDatabase;
  
    beforeEach(async () => {
      database = await migratedDatabase();
    });
  
    afterEach(() => database.close());
  
    it('adds machine_id before the unique index when the table already exists without it', async () => {
      // Simulate the pre-migration production shape: a workspace_connectors
      // table that already exists WITHOUT the machine_id column. This is what
      // happens when migrate() runs against a database created by an older
      // release: the CREATE TABLE IF NOT EXISTS is a no-op.
      await database.query(`DROP TABLE IF EXISTS connection_receipts CASCADE`);
      await database.query(`DROP TABLE IF EXISTS workspace_connections CASCADE`);
      await database.query(`DROP TABLE IF EXISTS workspace_connectors CASCADE`);
  
      // Recreate the old schema: same columns but no machine_id / sign_in / etc.
      await database.query(`
        CREATE TABLE workspace_connectors (
          id uuid PRIMARY KEY,
          workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          owner_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
          connector_type text NOT NULL,
          helper_agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
          status text NOT NULL DEFAULT 'installing'
            CHECK (status IN ('installing','connected','error','disconnected')),
          status_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
          status_error text,
          pending_ops jsonb NOT NULL DEFAULT '[]'::jsonb,
          connected_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      // Recreate the old unique index that the migration will replace
      await database.query(`
        CREATE UNIQUE INDEX workspace_connectors_owner_unique
          ON workspace_connectors(workspace_id, owner_identity_id, connector_type)
      `);
  
      // This must NOT throw: after the fix, ADD COLUMN IF NOT EXISTS machine_id
      // runs before the unique index that references it.
      await expect(migrate(database)).resolves.toBeUndefined();
  
      // Verify machine_id column exists
      const columns = await database.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='workspace_connectors' AND column_name='machine_id'`,
      );
      expect(columns.rows.length).toBe(1);
  
      // Verify the unique index on machine_id exists
      const indexes = await database.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename='workspace_connectors'
           AND indexname='workspace_connectors_fixed_machine_unique'`,
      );
      expect(indexes.rows.length).toBe(1);
    });
  
    it('keeps the connector uniqueness index in place across releases', async () => {
      const database = await migratedDatabase();
      try {
        const oid = async () =>
          (
            await database.query<{ oid: number }>(
              `SELECT c.oid FROM pg_class c WHERE c.relname='workspace_connectors_fixed_machine_unique'`,
            )
          ).rows[0]?.oid;
        const first = await oid();
        expect(first).toBeDefined();
        // A re-run must not drop and rebuild it: while it is gone
        // `pairConnector`'s ON CONFLICT has no arbiter index to infer.
        await migrate(database);
        expect(await oid()).toBe(first);
      } finally {
        database.close();
      }
    });
  });
  
  describe('the agent_grants kind vocabulary migration', () => {
    let database: PgliteDatabase;
  
    beforeEach(async () => {
      database = await migratedDatabase();
    });
  
    afterEach(() => database.close());
  
    it('widens the agent_grants kind check so an upgraded database accepts an mcp route', async () => {
      // The pre-migration production shape: agent_grants already exists, so the
      // CREATE TABLE IF NOT EXISTS is a no-op and the old CHECK survives.
      await database.query(
        `ALTER TABLE agent_grants DROP CONSTRAINT IF EXISTS agent_grants_kind_check`,
      );
      await database.query(`ALTER TABLE agent_grants ADD CONSTRAINT agent_grants_kind_check
          CHECK (kind IN ('path','host','secret','device','budget','command'))`);
      const owner = 'a'.repeat(64);
      const agent = 'b'.repeat(64);
      await database.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [owner, agent],
      );
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline Welcome')`, [
        DEFAULT_WORKSPACE_ID,
      ]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'welcome')`, [
        WELCOME_ROOM_ID,
        DEFAULT_WORKSPACE_ID,
      ]);
      const storeRoute = (kind: string) =>
        database.query(
          `INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status)
             VALUES(gen_random_uuid(),$3,$1,$5,$2,'squire','route it',$4,'pending')`,
          [DEFAULT_WORKSPACE_ID, kind, agent, owner, WELCOME_ROOM_ID],
        );
  
      await expect(storeRoute('mcp')).rejects.toThrow();
  
      await migrate(database);
  
      await expect(storeRoute('mcp')).resolves.toBeDefined();
      // Widening the vocabulary is not removing it: an unknown kind is still refused.
      await expect(storeRoute('nonsense')).rejects.toThrow();
      expect((await database.query<{ kind: string }>(`SELECT kind FROM agent_grants`)).rows).toEqual([
        { kind: 'mcp' },
      ]);
    });
  });
  
  describe('retired app storage — SENTRY-22', () => {
    const parent = '10000000-0000-4000-8000-000000000001';
    const corner = '10000000-0000-4000-8000-000000000002';
    const installation = '10000000-0000-4000-8000-000000000003';
    const instance = '10000000-0000-4000-8000-000000000004';
    const viewer = 'a'.repeat(64);
  
    async function seedCorner(database: SqlDatabase) {
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Rollout')`, [DEFAULT_WORKSPACE_ID]);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader')`, [viewer]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Rollout Room')`,
        [parent, DEFAULT_WORKSPACE_ID]);
      await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Visible corner')`,
        [corner, DEFAULT_WORKSPACE_ID, parent]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [DEFAULT_WORKSPACE_ID, viewer, parent]);
    }
  
    async function readPriorRelease(database: SqlDatabase) {
      const result = await database.query<{ corner_rows: Array<{ id: string; app_manifest: unknown }> }>(
        priorReleaseCornerListSql(), [parent, viewer]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].corner_rows.map(row => row.id)).toEqual([corner]);
      return result.rows[0].corner_rows[0];
    }
  
    it('lets the prior release list corners after retirement, including repair of already dropped tables', async () => {
      const database = await migratedDatabase();
      try {
        await seedCorner(database);
        // Model a database where #3221 already ran; repairing only future upgrades is insufficient.
        await database.query(`DROP TABLE IF EXISTS corner_apps;
          DROP TABLE IF EXISTS corner_app_bindings;
          DROP TABLE IF EXISTS corner_app_installations;`);
        await expect(readPriorRelease(database)).rejects.toThrow('corner_app_bindings');
        await migrate(database);
        expect((await readPriorRelease(database)).app_manifest).toBeNull();
        await migrate(database);
        await readPriorRelease(database);
      } finally {
        await database.close();
      }
    });
  
    it('keeps existing retired rows and rollback writes across repeated migrations', async () => {
      const database = await migratedDatabase();
      try {
        await seedCorner(database);
        await database.query(await readFile("apps/server/src/fixtures/sentry-22-app-schema.sql", 'utf8'));
        await database.query(`INSERT INTO corner_app_installations(id,workspace_id,installed_by,manifest)
          VALUES($1,$2,$3,'{"name":"Legacy"}')`, [installation, DEFAULT_WORKSPACE_ID, viewer]);
        await database.query(`INSERT INTO corner_app_bindings(corner_id,installation_id,instance_id,bound_by)
          VALUES($1,$2,$3,$4)`, [corner, installation, instance, viewer]);
        await database.query(`INSERT INTO corner_apps(corner_id,slug,author_agent_id,definition)
          VALUES($1,'legacy',$2,'{"command":"legacy"}')`, [corner, viewer]);
        await migrate(database);
        await migrate(database);
        expect((await readPriorRelease(database)).app_manifest).toEqual({ name: 'Legacy' });
        expect((await database.query(`SELECT definition FROM corner_apps WHERE corner_id=$1`, [corner])).rows)
          .toEqual([{ definition: { command: 'legacy' } }]);
        // Previous images can still write if rolled back. New images expose no app surfaces.
        await database.query(`UPDATE corner_app_installations SET manifest='{"name":"Rollback"}' WHERE id=$1`, [installation]);
        expect((await readPriorRelease(database)).app_manifest).toEqual({ name: 'Rollback' });
      } finally {
        await database.close();
      }
    });
  });
});


describe("background-deadlines.postgres", () => {
  const url=serverDatabaseUrl;
  describe.skipIf(!url)('P12 actual background deadline composition, real PostgreSQL',()=>{
    let fixture:Awaited<ReturnType<typeof groupBPostgresDatabase>>,release:()=>Promise<void>;
    beforeAll(async()=>{fixture=await groupBPostgresDatabase(url!);release=await fixture.listenToCompletions();},60000);
    afterAll(async()=>{await release?.();await fixture?.close();});
  
    it('does zero idle-day SQL/provider work; a committed calendar/retention source runs only its family and takeover initializes once',async()=>{
      const statements:string[]=[],observe=(db:SqlDatabase):SqlDatabase=>({
        query:(sql,values)=>{statements.push(sql);return db.query(sql,values);},
        transaction:run=>db.transaction(tx=>run(observe(tx))),
      });
      const db=observe(fixture.database),provider=vi.fn(async()=>{throw new Error('Empty proof must never call a provider');});
      const machine={create:provider,find:provider,start:provider,suspend:provider,stop:provider,destroy:provider,state:provider,waitFor:provider} as unknown as FreeAgentMachines;
      const free=new FreeAgentService(db,freeAgentConfigFromEnv({BEELINE_FREE_AGENT_SEAL_KEY:'synthetic',FLY_FREE_AGENT_IMAGE:'synthetic'},'http://127.0.0.1')!,machine,provider);
      const checkin=new NextDayCheckin(db,'http://127.0.0.1',provider),push=new PushDeliveryLoop(db,undefined);
      let now=0;const work=new BackgroundWork(()=>now,()=>{}),runner=new BackgroundJobRunner();
      const live=new LiveHub();
      const families=[...repairDeadlineFamilies(db,{live,phone:new PhoneService(db,'http://127.0.0.1'),
        mediaExpiry:new MediaExpiryLoop(db),institutionalMemory:INSTITUTIONAL_MEMORY_ON,
        voiceDeadlines:new BackgroundRecordDeadlines('voice-call-recovery',work,()=>{},()=>now)}),
        {name:'next-day-checkin',run:()=>checkin.runOnce(),next:(cut?:string)=>checkin.nextDelayMs(cut)},
        {name:'push',run:async()=>{await push.runOnce();},next:(cut?:string)=>push.nextDelayMs(cut)},
        {name:'free-agents',run:async()=>{await free.sweep();},next:(cut?:string)=>free.nextDelayMs(cut)},
      ];
      const runs:string[]=[],wakes:string[]=[];
      registerBackgroundDeadlineFamilies(work,families,(name,run)=>{runs.push(name);return runner.run(name,run);},db);
      const stop=subscribeBackgroundFamilies(fixture.database,live,families.map(family=>family.name),name=>{wakes.push(name);work.wake(name);});
      try{
        expect(await work.run(true)).toBe(Infinity);expect(statements.length).toBeGreaterThan(20);
        statements.length=0;runs.length=0;
        now=86_400_000;expect(await work.run(false)).toBe(Infinity);
        expect(statements).toEqual([]);expect(runs).toEqual([]);expect(provider).not.toHaveBeenCalled();
        const human='a'.repeat(64);await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic')`,[human]);
        await fixture.database.query(`INSERT INTO next_day_checkin_candidates(identity_id,first_at,due_at) VALUES($1,clock_timestamp(),clock_timestamp()+interval '3 days')`,[human]);
        await vi.waitFor(()=>expect(wakes).toEqual(['next-day-checkin']));
        expect(await work.run(false)).toBeGreaterThan(0);expect(runs).toEqual(['next-day-checkin']);expect(provider).not.toHaveBeenCalled();
        runs.length=0;wakes.length=0;
        await fixture.database.query(`INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,'11111111-1111-4111-8111-111111111111',clock_timestamp()-interval '1 second')`,['c'.repeat(64),human]);
        await vi.waitFor(()=>expect(wakes).toEqual(['retention:phone_access_tokens']));
        await work.run(false);expect(runs).toEqual(['retention:phone_access_tokens']);
        expect((await fixture.database.query(`SELECT token_hash FROM phone_access_tokens WHERE token_hash=$1`,['c'.repeat(64)])).rows).toEqual([]);
        // Drain only the actual committed deletion hint before measuring idle.
        await vi.waitFor(()=>expect(wakes).toHaveLength(2));await work.run(false);
        runs.length=0;statements.length=0;now+=86_400_000;await work.run(false);
        expect(statements).toEqual([]);expect(runs).toEqual([]);
        await work.run(true);expect(runs).toEqual(families.map(family=>family.name));expect(provider).not.toHaveBeenCalled();
      }finally{stop();}
    });
  
    it('retains a deadline that becomes due between the business scan and minimum query, while parking an older failed record',async()=>{
      const db=fixture.database,cut=await backgroundDatabaseCut(db);
      expect(await backgroundNextDelay(db,`SELECT clock_timestamp() due_at`,cut)).toBe(0);
      expect(await backgroundNextDelay(db,`SELECT $1::timestamptz-interval '1 microsecond' due_at`,cut)).toBeUndefined();
    });
  
    it('moves known voice expiry without recovery reads and fences a baseline against concurrent source evidence',async()=>{
      let now=0;const work=new BackgroundWork(()=>now,()=>{}),wake=vi.fn(),owner=new BackgroundRecordDeadlines('voice-call-recovery',work,wake,()=>now);
      const run=vi.fn(async()=>{});work.addDeadline('voice-call-recovery',async()=>{owner.consume();await run();return owner.next();});
      const stop=owner.subscribe();
      const evidence=(due:number,ended=false)=>notifyCommandCompletion({principal:'background-record',operation:'voice-call-recovery',commandId:JSON.stringify(['call',due,ended])});
      try{
        await work.run(true);run.mockClear();
        for(let tick=1;tick<=120;tick++){
          now=tick*5000;evidence(now+15000);expect(await work.run(false)).toBe(15000);
        }
        expect(run).not.toHaveBeenCalled();
        let finish!:(rows:{id:string;due:number}[])=>void;
        const capturing=owner.capture(()=>new Promise(resolve=>{finish=resolve;}));
        evidence(now+20000);finish([{id:'call',due:now+1000}]);await capturing;
        expect(owner.next()).toBe(20000);
        now+=20000;await work.run(false);expect(run).toHaveBeenCalledOnce();
        evidence(now+15000,true);expect(owner.next()).toBeUndefined();
      }finally{stop();}
    });
  
    it('consumes actual PostgreSQL voice lease/terminal notifications without admitting recovery reads on renewal',async()=>{
      const db=fixture.database,human='b'.repeat(64),workspace='22222222-2222-4222-8222-222222222222',room='33333333-3333-4333-8333-333333333333',call='44444444-4444-4444-8444-444444444444';
      await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Voice owner')`,[human]);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic')`,[workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic')`,[room,workspace]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('voice-source',$1,$2,'Synthetic call')`,[room,human]);
      const now=Date.now(),work=new BackgroundWork(()=>now,()=>{}),wake=vi.fn(),run=vi.fn(async()=>{});
      const deadlines=new BackgroundRecordDeadlines('voice-call-recovery',work,wake,()=>now),stop=deadlines.subscribe();
      work.addDeadline('voice-call-recovery',async()=>{await run();return deadlines.next();});await work.run(true);run.mockClear();
      try{
        await db.query(`INSERT INTO voice_calls(id,room_id,message_id,runtime_owner,runtime_until) VALUES($1,$2,'voice-source','synthetic-owner',clock_timestamp()+interval '15 seconds')`,[call,room]);
        await vi.waitFor(()=>expect(wake).toHaveBeenCalledOnce());
        for(let renewal=1;renewal<=20;renewal++){
          await db.query(`UPDATE voice_calls SET runtime_until=clock_timestamp()+interval '15 seconds' WHERE id=$1`,[call]);
          await vi.waitFor(()=>expect(wake).toHaveBeenCalledTimes(renewal+1));
          expect(await work.run(false)).toBeGreaterThan(0);
        }
        expect(run).not.toHaveBeenCalled();
        const due=deadlines.next();
        await expect(db.transaction(async tx=>{await tx.query(`UPDATE voice_calls SET ended_at=clock_timestamp() WHERE id=$1`,[call]);throw new Error('rollback');})).rejects.toThrow('rollback');
        expect(deadlines.next()).toBe(due);expect(wake).toHaveBeenCalledTimes(21);
        await db.query(`UPDATE voice_calls SET ended_at=clock_timestamp() WHERE id=$1`,[call]);await vi.waitFor(()=>expect(wake).toHaveBeenCalledTimes(22));
        expect(deadlines.next()).toBeUndefined();expect(run).not.toHaveBeenCalled();
      }finally{stop();}
    });
  
    it('uses an actual free-agent idle record once and never manufactures a failed-stop retry deadline',async()=>{
      const db=fixture.database,agent='d'.repeat(64),human='b'.repeat(64),workspace='22222222-2222-4222-8222-222222222222';
      await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Synthetic idle agent')`,[agent]);
      await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,human]);
      await db.query(`INSERT INTO free_agents(agent_id,owner_id,workspace_id,state,fly_machine_id,sealed_keys,last_activity_at,wake_requested_at)
        VALUES($1,$2,$3,'running','synthetic-machine','unused',clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '10 minutes')`,[agent,human,workspace]);
      const refused=vi.fn(async()=>{throw new Error('Synthetic stop result unknown');});
      const unexpected=vi.fn(async()=>{throw new Error('Unexpected provider action');});
      const machines={create:unexpected,find:unexpected,start:unexpected,suspend:unexpected,stop:refused,destroy:unexpected,state:unexpected,waitFor:unexpected} as unknown as FreeAgentMachines;
      const free=new FreeAgentService(db,freeAgentConfigFromEnv({BEELINE_FREE_AGENT_SEAL_KEY:'synthetic',FLY_FREE_AGENT_IMAGE:'synthetic'},'http://127.0.0.1')!,machines,unexpected,()=>{});
      expect(await free.sweep()).toBe(1);expect(refused).toHaveBeenCalledOnce();
      const due=await free.nextDelayMs();expect(due).toBeGreaterThan(29*86_400_000);
      expect(await free.sweep()).toBe(0);expect(refused).toHaveBeenCalledOnce();expect(unexpected).not.toHaveBeenCalled();
    });
  });
});


describe("durable-live.postgres", () => {
  const postgresUrl=serverDatabaseUrl;
  if(postgresUrl && !['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))throw new Error('journal proofs require isolated loopback PostgreSQL');
  
  describe.skipIf(!postgresUrl)('P5 journal retention generic-plan work bound',()=>{
    it('selects victims through both composite ranges and never scans retained history',async()=>{
      const schema=`journal_${randomUUID().replaceAll('-','')}`,pool=new Pool({connectionString:postgresUrl,max:1});
      try{
        await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`SET search_path TO ${schema},public`);
        await pool.query(DURABLE_LIVE_SCHEMA);
        await pool.query(`INSERT INTO live_streams(id,sequence,byte_total) VALUES('workspace:synthetic',6,6000),('room:synthetic',6,6000)`);
        await pool.query(`INSERT INTO live_journal(stream_id,sequence,event,byte_start)
          SELECT stream,n,jsonb_build_object('type','invalidate','roomId','','reason','synthetic'),n*1000
          FROM unnest(ARRAY['workspace:synthetic','room:synthetic']) stream CROSS JOIN generate_series(1,6)n`);
        await pool.query('ANALYZE live_journal');await pool.query('SET plan_cache_mode=force_generic_plan');
        const config=(await pool.query(`SELECT proconfig FROM pg_proc WHERE oid='beeline_journal(text,jsonb)'::regprocedure`)).rows[0].proconfig;
        expect(config).toContain('enable_seqscan=off');
        // Reproduce the production function's private planner configuration.
        await pool.query('SET enable_seqscan=off');
        // Explain the actual production function's DELETE, not a remembered
        // duplicate. Generic plans are the path used after repeated appends.
        const body=(await pool.query<{body:string}>(`SELECT pg_get_functiondef('beeline_journal(text,jsonb)'::regprocedure) body`)).rows[0]!.body;
        const deletion=body.match(/WITH count_victim AS MATERIALIZED[\s\S]*?;/)![0]
          .replace(/\bstream\b/g,'$1').replace(/\bposition\b/g,'$2').replace(/\btotal\b/g,'$3').replace(/\bbytes\b/g,'$4');
        await pool.query(`PREPARE prune(text,bigint,bigint,integer) AS ${deletion}`);
        const nodes:any[]=[];const visit=(node:any)=>{nodes.push(node);for(const child of node.Plans??[])visit(child);};
        const cold=(await pool.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE prune('workspace:synthetic',6,6000,1000)`)).rows[0]['QUERY PLAN'][0];
        visit(cold.Plan);expect(nodes.some(n=>n['Node Type']==='Seq Scan')).toBe(false);nodes.length=0;
        // Grow the relation inside one transaction without refreshing statistics;
        // the cold generic plan must remain bounded throughout the source write.
        await pool.query('BEGIN');
        await pool.query(`INSERT INTO live_journal(stream_id,sequence,event,byte_start)
          SELECT stream,n,'{}'::jsonb,n*1000 FROM unnest(ARRAY['workspace:synthetic','room:synthetic']) stream
          CROSS JOIN generate_series(7,1025)n`);
        const root=(await pool.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE prune('workspace:synthetic',1025,1025000,1000)`)).rows[0]['QUERY PLAN'][0];
        visit(root.Plan);
        expect(nodes.some(n=>n['Node Type']==='Seq Scan')).toBe(false);
        expect(nodes.some(n=>n['Index Name']==='live_journal_pkey')).toBe(true);
        expect(nodes.some(n=>n['Index Name']==='live_journal_byte_start_idx')).toBe(true);
        expect((await pool.query(`SELECT min(sequence)::int oldest,count(*)::int n FROM live_journal WHERE stream_id='workspace:synthetic'`)).rows[0]).toEqual({oldest:2,n:1024});
        await pool.query('COMMIT');
      }finally{await pool.query('ROLLBACK');await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
    });
    it('matches an independent bounded trailing-history model across count limits, byte gaps and oversized entries',async()=>{
      const schema=`journal_model_${randomUUID().replaceAll('-','')}`,pool=new Pool({connectionString:postgresUrl,max:1});
      try{
        await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`SET search_path TO ${schema},public`);await pool.query(DURABLE_LIVE_SCHEMA);
        const sizes=[40,200000,LIVE_REPLAY_BYTE_LIMIT+1],bodies=sizes.map(n=>JSON.stringify({type:'invalidate',roomId:'',reason:'synthetic',padding:'x'.repeat(n)}));
        const bytes=await Promise.all(bodies.map(body=>pool.query<{n:number}>('SELECT octet_length($1::jsonb::text)::int n',[body]).then(result=>result.rows[0]!.n)));
        const sequence=[...Array(1050).fill(0),...Array(70).fill(1),2,...Array(5).fill(0)] as number[];
        const model:Array<{sequence:number;bytes:number}>=[];let retainedBytes=0;
        await pool.query('BEGIN');
        for(let index=0;index<sequence.length;index++){
          const kind=sequence[index]!;
          await pool.query(`SELECT beeline_journal('workspace:synthetic',$1::jsonb)`,[bodies[kind]]);
          model.push({sequence:index+1,bytes:bytes[kind]!});retainedBytes+=bytes[kind]!;
          while(model.length>LIVE_REPLAY_LIMIT || retainedBytes>LIVE_REPLAY_BYTE_LIMIT)retainedBytes-=model.shift()!.bytes;
          if(index%50===0 || kind===2 || index===sequence.length-1){
            const rows=(await pool.query<{sequence:string}>(`SELECT sequence::text FROM live_journal WHERE stream_id='workspace:synthetic' ORDER BY live_journal.sequence`)).rows;
            expect(rows.map(row=>Number(row.sequence))).toEqual(model.map(row=>row.sequence));
          }
        }
        await pool.query('COMMIT');
      }finally{await pool.query('ROLLBACK');await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
    });
  
  });
});


describe("helper-overlay.postgres", () => {
  const url=serverDatabaseUrl;
  if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Overlay proofs require isolated loopback PostgreSQL');
  const room='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';
  const frame=(value:Partial<HelperOverlayFrame>={}):HelperOverlayFrame=>({v:1,agentId:'agent',roomId:room,commandId:'command',turnId:'turn',turnGeneration:'generation',runGeneration:0,
    kind:'draft',type:'baseline',revision:1,offset:0,text:'🌍',viewingRevision:1,...value});
  const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};};
  describe.skipIf(!url)('overlay real PostgreSQL remote listener and viewer fences',()=>{
    it.each(['wire','helper'] as const)('P12 %s: relays committed UTF8 generations across pools, replaces a missed revision, and fences zero viewers and terminal resurrection',async mode=>{
      const schema='overlay_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
      const config={connectionString:url,options:`-c search_path=${schema},public`,max:3};
      const writer=new PostgresDatabase('',3,{pool:new Pool(config)}),reader=new PostgresDatabase('',3,{pool:new Pool(config)});
      const listenerUrl=new URL(url!);listenerUrl.searchParams.set('options',`-c search_path=${schema},public`);
      const live=new LiveHub(),listener=PostgresLiveListener.forConnectionString(listenerUrl.toString(),reader,live);
      let listening:Promise<void>|undefined,stopDemand:(()=>void)|undefined,stopLive:(()=>void)|undefined,helper:HelperOverlayOwner|undefined;
      const ready=deferred(),stopReady=live.subscribeResync(ready.resolve);
      const frames:LiveEvent[]=[],waits=new Map<number,()=>void>(),demandWaits=new Map<number,()=>void>();
      const waitFrame=(revision:number)=>new Promise<void>(resolve=>{waits.set(revision,resolve);});
      const waitDemand=(revision:number)=>new Promise<void>(resolve=>{demandWaits.set(revision,resolve);});
      const viewer=new HelperOverlayViewer(event=>{void forward(event);});
      const forward=async(event:LiveEvent)=>fenceHelperOverlayEnqueue(reader,event,()=>{
        if(!viewer.canDeliver(event))return;const normalized=viewer.normalize(event);frames.push(normalized);viewer.delivered(normalized);
        const revision=(normalized as {overlayV1?:{revision:number}}).overlayV1?.revision;if(revision)waits.get(revision)?.();
      },'reader');
      try{
        await writer.query(`CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,archived_at timestamptz);
          CREATE TABLE room_access(room_id uuid,identity_id text,removed_at timestamptz);
          CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
          CREATE TABLE room_push_views(room_id uuid,identity_id text,session_id text,instance_id text,expires_at timestamptz);
          CREATE TABLE live_server_instances(instance_id text,renewed_at timestamptz);
          CREATE TABLE agent_connections(agent_id text,connection_id text,epoch bigint,released_at timestamptz,instance_id text);
          CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,action text,generation_id text,state text,created_at timestamptz DEFAULT now(),lease_expires_at timestamptz);
          CREATE TABLE agent_turns(room_id uuid,agent_id text,request_id text,generation_id text,status text);
          CREATE TABLE live_outputs(room_id uuid,agent_id text,turn_id text,kind text,body jsonb,updated_at timestamptz DEFAULT now(),PRIMARY KEY(room_id,agent_id,turn_id,kind));
          CREATE TABLE corner_github_cache(corner_id uuid PRIMARY KEY);
          CREATE TABLE registry_mcp_oauth_attempts(state text,connector_id text,expires_at timestamptz,code text);`);
        // Install the production journal+capture function, and its real source
        // trigger on the one table this isolated fixture exercises.
        await writer.query((await postgresLiveSchema()).split('-- Memory jobs')[0]!);
        await writer.query(`CREATE TRIGGER beeline_notify_live_live_outputs AFTER INSERT OR UPDATE OR DELETE ON live_outputs FOR EACH ROW EXECUTE FUNCTION beeline_notify_live()`);
        await writer.query(TURN_OWNERSHIP_SCHEMA);
      await writer.query(HELPER_OVERLAY_SCHEMA);
        await writer.query(`INSERT INTO rooms VALUES($1,$2,NULL)`,[room,workspace]);
        await writer.query(`INSERT INTO room_access VALUES($1,'agent',NULL),($1,'reader',NULL)`,[room]);
        await writer.query(`INSERT INTO memberships VALUES($1,NULL,'agent','member',NULL),($1,NULL,'reader','member',NULL)`,[workspace]);
        if(mode==='wire')await writer.query(`INSERT INTO room_push_views VALUES($1,'reader','phone-on-reader-instance',NULL,NULL)`,[room]);
        await writer.query(`INSERT INTO live_server_instances VALUES('owner-server',clock_timestamp());
        INSERT INTO agent_connections VALUES('agent','connection',1,NULL,'owner-server');
          INSERT INTO agent_turns VALUES('${room}','agent','turn','generation','working');
          INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,generation_id,state) VALUES('command','${room}','agent','turn','input','generation','claimed');`);
        listening=listener.run();await ready.promise;
        stopLive=live.subscribe(room,event=>{if(viewer.accept(event))void forward(event);});
        if(mode==='helper'){
          const uploaded:HelperOverlayFrame[]=[];
          const initial=deferred();
          helper=new HelperOverlayOwner({agentId:'agent',roomId:room,commandId:'command',turnId:'turn',turnGeneration:'generation',kind:'draft'}, {
            enabled:()=>true,
            subscribe:(_room,receive)=>subscribeHelperOverlayDemand(reader,room,demand=>{receive(demand);initial.resolve();}),
            send:async value=>{uploaded.push(value);const result=await applyHelperOverlay(writer,'agent',{connectionId:'connection',epoch:1},value);expect(result.ack.accepted).toBe(true);return result.ack;},
          });
          await initial.promise;
          for(let i=0;i<1000;i++)helper.update(`hidden 🌍 ${i}`);
          expect(uploaded).toEqual([]);
          expect((await writer.query('SELECT * FROM live_outputs')).rows).toEqual([]);
          viewer.enter(room);viewer.commit(room,1);
          const baseline=waitFrame(1);
          await writer.query(`INSERT INTO room_push_views VALUES($1,'reader','phone-on-other-server',NULL,NULL)`,[room]);await baseline;
          expect(uploaded).toHaveLength(1);expect(uploaded[0]).toMatchObject({type:'baseline',text:'hidden 🌍 999'});
          let text='hidden 🌍 999';
          for(let i=0;i<100;i++){
            const next=waitFrame(i+2);text+='é🌍';helper.update(text);await next;
          }
          expect(uploaded.filter(value=>value.type==='baseline')).toHaveLength(1);
          expect(uploaded.slice(1).every(value=>value.type==='append'&&value.text==='é🌍')).toBe(true);
          // Text carried by all uploads is exactly final UTF8 length, rather
          // than N growing snapshots. Framing has a fixed per-append bound.
          expect(uploaded.reduce((bytes,value)=>bytes+Buffer.byteLength(value.text),0)).toBe(Buffer.byteLength(text));
          expect(frames.at(-1)).toMatchObject({text});
          const reset=waitFrame(102);helper.beginRun();await reset;
          const restarted=waitFrame(103);helper.update('new 🌍');await restarted;
          expect(uploaded[101]).toMatchObject({type:'baseline',runGeneration:1,text:''});
          const ended=waitFrame(104);await helper.close();await ended;
          expect(frames.at(-1)).toMatchObject({type:'retract',overlayV1:{runGeneration:1,revision:104}});
          const before=uploaded.length;helper.update('late terminal');expect(uploaded).toHaveLength(before);
          expect((await writer.query('SELECT count(*)::int count FROM live_journal')).rows).toEqual([{count:0}]);
          return;
        }
        viewer.enter(room);viewer.commit(room,1);
        const demand1=waitDemand(1);stopDemand=subscribeHelperOverlayDemand(reader,room,demand=>{demandWaits.get(demand.viewingRevision)?.();});await demand1;
        const owner={connectionId:'connection',epoch:1};
        const first=waitFrame(1);expect((await applyHelperOverlay(writer,'agent',owner,frame())).ack).toEqual({accepted:true,revision:1});await first;
        const second=waitFrame(2);await applyHelperOverlay(writer,'agent',owner,frame({type:'append',revision:2,offset:4,text:'é'}));await second;
        expect(frames.at(-1)).toMatchObject({text:'🌍é',overlayV1:{type:'append',offset:4,revision:2}});
        const fourth=waitFrame(4);
        await writer.transaction(async tx=>{
          await applyHelperOverlay(tx,'agent',owner,frame({type:'append',revision:3,offset:6,text:'!'}));
          await applyHelperOverlay(tx,'agent',owner,frame({type:'append',revision:4,offset:7,text:'?'}));
        });await fourth;
        expect(frames.at(-1)).toMatchObject({text:'🌍é!?',overlayV1:{type:'replace',offset:0,revision:4}});
        expect((await writer.query('SELECT count(*)::integer count FROM live_journal')).rows).toEqual([{count:0}]);
        const off=waitDemand(2);await writer.query('DELETE FROM room_push_views');await off;viewer.leave(room);
        expect((await applyHelperOverlay(writer,'agent',owner,frame({type:'append',revision:5,offset:8,text:'hidden'}))).ack).toEqual({accepted:false,reason:'unviewed'});
        const on=waitDemand(3);await writer.query(`INSERT INTO room_push_views VALUES($1,'reader','new-view',NULL,NULL)`,[room]);await on;
        viewer.enter(room);viewer.commit(room,3);
        const baseline=waitFrame(5);await applyHelperOverlay(writer,'agent',owner,frame({revision:5,runGeneration:1,text:'fresh run',viewingRevision:3}));await baseline;
        const ended=waitFrame(6);await applyHelperOverlay(writer,'agent',owner,frame({type:'end',revision:6,runGeneration:1,text:'',viewingRevision:3}));await ended;
        expect(frames.at(-1)).toMatchObject({type:'retract',overlayV1:{revision:6,runGeneration:1}});
        expect((await applyHelperOverlay(writer,'agent',owner,frame({revision:7,runGeneration:0,text:'late baseline',viewingRevision:3}))).ack).toEqual({accepted:false,reason:'stale'});
        await writer.query(`UPDATE agent_commands SET state='complete';UPDATE agent_turns SET status='complete'`);
        const before=frames.length;await forward(frames[0]!);expect(frames).toHaveLength(before);
      }finally{
        await helper?.close();
        stopReady();stopDemand?.();stopLive?.();await listener.stop();await listening;
        await Promise.all([writer.close(),reader.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
      }
    },20000);
  });
});


describe("incident-deadlocks", () => {
  const url = serverDatabaseUrl;
  if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
    throw new Error('incident proofs require isolated loopback PostgreSQL');
  const H = 'a'.repeat(64), A = 'b'.repeat(64), B = 'c'.repeat(64), F = 'd'.repeat(64);
  const W = '11111111-1111-4111-8111-111111111111';
  const R = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';
  const headSha = '1'.repeat(40);
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  
  // Two real transactions form a deterministic cycle around the production
  // lifecycle lock. PostgreSQL, not an injected JS exception, chooses the victim.
  // The second transaction models an older writer that acquired its lock first.
  function contention(db: SqlDatabase) {
    const entered = deferred(), contenderLocked = deferred();
    let attempts = 0;
    const errors: string[] = [];
    const statements: string[][] = [];
    const victim: SqlDatabase = {
      query: db.query.bind(db),
      transaction: async work => {
        const attempt = ++attempts;
        const seen: string[] = []; statements.push(seen);
        try {
          return await db.transaction(async tx => {
            await tx.query(`SET LOCAL deadlock_timeout='10ms'`);
            const wrapped: SqlDatabase = {
              query: async (sql, values) => {
                seen.push(sql);
                return tx.query(sql, values);
              },
              transaction: async nested => nested(wrapped),
            };
            const result = await work(wrapped);
            if (attempt === 1) {
              entered.resolve();
              await contenderLocked.promise;
              await tx.query(`SELECT pg_advisory_xact_lock(1695,37)`);
            }
            return result;
          });
        } catch (error) {
          errors.push((error as { code: string }).code);
          throw error;
        }
      },
    };
    const other: SqlDatabase = {
      query: db.query.bind(db),
      transaction: work => db.transaction(async tx => {
        await tx.query(`SET LOCAL deadlock_timeout='5s'`);
        await tx.query(`SELECT pg_advisory_xact_lock(1695,37)`);
        contenderLocked.resolve();
        return work(tx);
      }),
    };
    return { victim, other, entered: entered.promise, errors, statements, attempts: () => attempts };
  }
  
  describe.skipIf(!url)('production incident deadlocks on real PostgreSQL', () => {
    let db: PostgresDatabase, admin: Pool, databaseName: string;
    beforeAll(async () => {
      databaseName = `incident_${randomUUID().replaceAll('-', '')}`;
      admin = new Pool({ connectionString: url });
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const isolated = new URL(url!); isolated.pathname = `/${databaseName}`;
      db = new PostgresDatabase(isolated.toString(), 8, { mode: 'migration' });
      await migrate(db);
    }, 60_000);
    afterAll(async () => {
      await db?.close();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
        await admin.end();
      }
    });
    beforeEach(async () => {
      await db.query(`DELETE FROM workspaces WHERE id=$1`, [W]);
      await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
        ($1,'human','Owner','owner'),($2,'agent','Worker','worker'),
        ($3,'agent','Reviewer','reviewer'),($4,'agent','Fallback','fallback')
        ON CONFLICT(id) DO NOTHING`, [H,A,B,F]);
      await db.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES
        ($1,$4,NULL),($2,$4,'opus-4-5'),($3,$4,'opus-4-5') ON CONFLICT(agent_id) DO NOTHING`, [A,B,F,H]);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Incident proof')`, [W]);
      await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
        VALUES(77,$1,'42','owner','User','selected','active') ON CONFLICT DO NOTHING`, [H]);
      await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
        VALUES(101,77,'owner/widgets','main') ON CONFLICT DO NOTHING`);
      await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,repository_remote,
        repository_resolution,github_installation_id) VALUES($1,$2,$3,'Parent','owner/widgets',
        'https://github.com/owner/widgets.git','repository',77)`, [R,W,H]);
      await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Incident')`, [C,W,R,A]);
      await insertCornerFacts(db, { cornerId: C, ownerAgentId: A, lifecycle: JSON.stringify({checks:'passing',
        pr:{number:1,headSha,url:'https://github.com/owner/widgets/pull/1',mergeability:'clean'}}), workflowState: 'implement' });
      for (const who of [H,A,B,F]) for (const room of [null,R])
        await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [W,room,who]);
    });
  
    it('SERVER-26/1A: one blocked command cannot consume the phone and webhook connections', async () => {
      // Real events: 5bb487e9f3c748f08d428fe653981658 (receipt deadline),
      // 4ad2aae26c47425298fcfb3d2a4b5bb8 (phone auth checkout),
      // 70aec06b59b34e22b735171fcf55e500 (GitHub webhook checkout).
      // Fly logs show command-row waits before the checkout failures.
      const isolated = new URL(url!); isolated.pathname = `/${databaseName}`;
      const appDb = new PostgresDatabase('', 2, { pool: new Pool({ connectionString: isolated.toString(), max: 2,
        connectionTimeoutMillis: 50, statement_timeout: 2000 }), transactionDeadlineMs: 1000 });
      const source = 'e'.repeat(64);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Work')`, [source,R,H]);
      const command = await createAgentCommand(db, { roomId: R, agentId: A, sourceMessageId: source, reason: 'human_tag' });
      const setup = new DaemonService(db, new LiveHub());
      await setup.execute('claimAgentCommand', { roomId: R, commandId: command!.id, generationId: 'rollout-proof' }, A);
      await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
        VALUES('github','rollout-proof',$1,'https://github.com','beeline','owner') ON CONFLICT DO NOTHING`, [H]);
      const auth = new TokenAuth(appDb, async () => ({ subject: 'rollout-proof', login: 'owner', name: 'Owner' }));
      const token = (await auth.exchangeGitHubOidc('fixture')).accessToken;
      const locked = deferred(), release = deferred(), entered = deferred();
      const blocker = db.transaction(async tx => {
        await tx.query(`SELECT id FROM agent_commands WHERE id=$1 FOR UPDATE`, [command!.id]);
        locked.resolve(); await release.promise;
      });
      await locked.promise;
      let writers = 0;
      const watched: SqlDatabase = {
        query: appDb.query.bind(appDb),
        transaction: work => appDb.transaction(tx => {
          const wrapped: SqlDatabase = { query: async (sql, values) => {
            if (/FROM agent_commands command/.test(sql) && /FOR UPDATE OF command/.test(sql)) { writers++; entered.resolve(); }
            return tx.query(sql, values);
          }, transaction: nested => nested(wrapped) };
          return work(wrapped);
        }),
      };
      const daemon = new DaemonService(watched, new LiveHub());
      const turn = { roomId: R, requestId: command!.turn_request_id, generationId: 'rollout-proof', agentId: A };
      const requests = Array.from({ length: 8 }, (_, n) => n % 2
        ? daemon.execute('postAgentTurnReceipt', { ...turn, status: 'working', heartbeat: true }, A)
        : daemon.execute('postAgentActivity', { ...turn, activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }] }, A));
      // Observe all promises immediately, including on the failing pre-fix path.
      const settled = Promise.allSettled(requests);
      try {
        await entered.promise;
        expect(await auth.authenticatePhoneSession(token)).toMatchObject({ identityId: H });
        const app = {
          installationToken: async () => ({ token: 'fixture' }),
          readCommitCheckRollup: async () => ({ state: 'passed', total: 1, failing: [], checks: [{ name: 'lint', status: 'passed' }] }),
          readPullRequest: async () => ({ number: 1, headSha, mergeability: 'clean' }),
        } as unknown as GitHubAppClient;
        const github = new GitHubOperations(appDb, {} as GitHubOAuthClient, app, 'secret');
        await github.processWebhook('check_run', { action: 'completed', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
          check_run: { name: 'lint', status: 'completed', conclusion: 'success', head_sha: headSha,
            check_suite: { head_branch: 'feature/corner-333333333333', head_sha: headSha } } });
        expect(writers).toBe(1);
      } finally {
        release.resolve(); await blocker;
        const results = await settled;
        await appDb.close();
        expect(results.map(result => result.status)).toEqual(Array(8).fill('fulfilled'));
        expect(appDb.transactionDeadlineCount()).toBe(0);
      }
    }, 20_000);
  
    it('SERVER-24: receipt writers wait before starting their transaction deadline', async () => {
      // Event 5bb487e9f3c748f08d428fe653981658 was postAgentTurnReceipt.
      // Each writer is short enough individually; waiting behind the preceding
      // writer must not consume the next writer's transaction deadline.
      const isolated = new URL(url!); isolated.pathname = `/${databaseName}`;
      const appDb = new PostgresDatabase('', 4, { pool: new Pool({ connectionString: isolated.toString(), max: 4,
        connectionTimeoutMillis: 2000, statement_timeout: 2000 }), transactionDeadlineMs: 1000 });
      const source = 'e'.repeat(64);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Work')`, [source,R,H]);
      const command = await createAgentCommand(db, { roomId: R, agentId: A, sourceMessageId: source, reason: 'human_tag' });
      await new DaemonService(db, new LiveHub()).execute('claimAgentCommand',
        { roomId: R, commandId: command!.id, generationId: 'deadline-proof' }, A);
      const watched: SqlDatabase = { query: appDb.query.bind(appDb), transaction: work => appDb.transaction(tx => {
        const wrapped: SqlDatabase = { query: async (sql, values) => {
          const result = await tx.query(sql, values);
          if (/FROM agent_commands command/.test(sql) && /FOR UPDATE OF command/.test(sql))
            await new Promise(resolve => setTimeout(resolve, 650));
          return result;
        }, transaction: nested => nested(wrapped) };
        return work(wrapped);
      }) };
      const daemon = new DaemonService(watched, new LiveHub());
      try {
        const results = await Promise.allSettled(Array.from({ length: 4 }, () => daemon.execute('postAgentTurnReceipt', {
          roomId: R, requestId: command!.turn_request_id, generationId: 'deadline-proof', agentId: A,
          status: 'working', heartbeat: true,
        }, A)));
        const errors = results.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []);
        expect(errors).toEqual([]);
        expect(appDb.transactionDeadlineCount()).toBe(0);
      } finally { await appDb.close(); }
    });
  
    it.each(['dispatch','singleton','insert'])('SERVER-25: a busy %s leaves the Sentry batch pending and delivers it once after release', async kind => {
      const triage = 'a914716f-cd6c-4663-b42a-6e1044dc2bb9';
      await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Triage',$4)`, [triage,W,R,A]);
      await db.query(`DELETE FROM sentry_wake_issues`);
      await db.query(`UPDATE sentry_wake_state SET last_wake_at=NULL`);
      await db.query(`INSERT INTO sentry_wake_issues(issue_id,event_type,title,level,culprit,permalink,first_seen,last_seen,event_count,delivery_hash)
        VALUES('7825612495','issue.created','canceling statement due to lock timeout','error','createAgentCommand',
          'https://beeline-bt.sentry.io/issues/7825612495/',now(),now(),1,'534f2fb1712b472fb6d3210b4b4aac0c')`);
      const locked = deferred(), release = deferred();
      if (kind === 'insert') await db.query(`CREATE FUNCTION sentry_insert_contention() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.reason='subscribed_event' THEN PERFORM pg_advisory_xact_lock(739125); END IF; RETURN NEW; END $$;
        CREATE TRIGGER sentry_insert_contention BEFORE INSERT ON agent_commands FOR EACH ROW EXECUTE FUNCTION sentry_insert_contention()`);
      const blocker = db.transaction(async tx => {
        if (kind === 'dispatch') await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`commander-wakes:${triage}:${A}`]);
        else if (kind === 'singleton') await tx.query(`SELECT singleton FROM sentry_wake_state WHERE singleton FOR UPDATE`);
        else await tx.query(`SELECT pg_advisory_xact_lock(739125)`);
        locked.resolve(); await release.promise;
      });
      await locked.promise;
      const bounded: SqlDatabase = { query: db.query.bind(db), transaction: work => db.transaction(async tx => {
        await tx.query(`SET LOCAL lock_timeout='30ms'`); return work(tx);
      }) };
      try {
        await expect(runSentryWakeDeadline(bounded,A)).resolves.toBeUndefined();
        expect((await db.query(`SELECT pending FROM sentry_wake_issues`)).rows).toEqual([{ pending: true }]);
      } finally { release.resolve(); await blocker; }
      await flushSentryWakes(bounded,A);
      await flushSentryWakes(bounded,A);
      if (kind === 'insert') await db.query(`DROP TRIGGER sentry_insert_contention ON agent_commands; DROP FUNCTION sentry_insert_contention()`);
      expect((await db.query(`SELECT pending FROM sentry_wake_issues`)).rows).toEqual([{ pending: false }]);
      expect((await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND reason='subscribed_event'`, [triage])).rowCount).toBe(1);
    });
  
    it('R-BRIEF-DEADLOCK: brief revision returns a real deadlock and a separate action can recover', async () => {
      const source = 'e'.repeat(64);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Clarify the brief')`, [source,R,H]);
      const command = await createAgentCommand(db,{roomId:R,agentId:A,sourceMessageId:source,reason:'human_tag'});
      const daemon = new DaemonService(db,new LiveHub());
      await daemon.execute('claimAgentCommand',{roomId:R,commandId:command!.id,generationId:'brief-proof'},A);
      const turn = {roomId:R,requestId:command!.turn_request_id,generationId:'brief-proof'};
      await daemon.execute('reviseCornerBrief',{...turn,cornerId:C,expectedRevision:0,
        brief:{spec:'Build the widget',change:'Record scope'}},A);
      const race = contention(db);
      const watched = new DaemonService(race.victim,new LiveHub());
      const revision = watched.execute('reviseCornerBrief',{...turn,cornerId:C,expectedRevision:1,
        brief:{spec:'Build the clarified widget',change:'Clarify scope'}},A);
      await race.entered;
      const [failed, contender] = await Promise.allSettled([revision,race.other.transaction(tx => lockCornerLifecycle(tx,C))]);
      expect(failed.status).toBe('rejected');
      if (failed.status === 'rejected') expect(failed.reason).toMatchObject({code:'40P01'});
      expect(contender.status).toBe('fulfilled');
      expect(race.errors).toEqual(['40P01']);
      expect(race.attempts()).toBe(1);
      expect((await db.query(`SELECT 1 FROM corner_brief_revisions WHERE corner_id=$1`,[C])).rowCount).toBe(1);
      expect((await daemon.execute('getCornerRestoreState',{cornerId:C},A)).brief?.spec).toBe('Build the widget');
      const result = await watched.execute('reviseCornerBrief',{...turn,cornerId:C,expectedRevision:1,
        brief:{spec:'Build the clarified widget',change:'Clarify scope'}},A);
      expect(race.attempts()).toBe(2);
      expect(result.revision).toBe(2);
      expect((await daemon.execute('getCornerRestoreState',{cornerId:C},A)).brief?.spec).toBe('Build the clarified widget');
      expect((await db.query(`SELECT 1 FROM corner_brief_revisions WHERE corner_id=$1`,[C])).rowCount).toBe(2);
      expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%Revision 2%'`,[C])).rowCount).toBe(1);
    });
  
    it('BEELINE-SERVER-1W: concurrent refreshes return a deadlock and a later event preserves one rollup', async () => {
      const race = contention(db);
      const app = {
        installationToken: async () => ({token:'fixture'}),
        readCommitCheckRollup: vi.fn(async () => ({state:'failed',total:1,failing:['lint'],checks:[{name:'lint',status:'failed'}]})),
        readPullRequest: async () => ({number:1,headSha,mergeability:'clean'}),
      } as unknown as GitHubAppClient;
      const payload = {action:'completed',installation:{id:77},repository:{full_name:'owner/widgets'},
        check_run:{name:'lint',status:'completed',conclusion:'failure',head_sha:headSha,
          check_suite:{head_branch:'feature/corner-333333333333',head_sha:headSha}}};
      const first = new GitHubOperations(race.victim, {} as GitHubOAuthClient, app, 'secret');
      const second = new GitHubOperations(race.other, {} as GitHubOAuthClient, app, 'secret');
      const refresh = first.processWebhook('check_run', payload);
      await race.entered;
      const [failed, contender] = await Promise.allSettled([refresh, second.processWebhook('check_run', payload)]);
      expect(failed.status).toBe('rejected');
      if (failed.status === 'rejected') expect(failed.reason).toMatchObject({code:'40P01'});
      expect(contender.status).toBe('fulfilled');
      expect(race.errors).toEqual(['40P01']);
      expect(race.attempts()).toBe(1);
      expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(2);
      // Another delivered event is a separate admission, not deadlock replay.
      await first.processWebhook('check_run', payload);
      expect(race.attempts()).toBeGreaterThanOrEqual(2);
      expect(race.attempts()).toBeLessThanOrEqual(3);
      for (const seen of race.statements.slice(0,2)) {
        const lock = seen.findIndex(sql => sql.includes('pg_advisory_xact_lock'));
        const fact = seen.findIndex(sql => sql.includes('SELECT lifecycle FROM corner_github_cache WHERE corner_id=$1 FOR UPDATE'));
        expect(lock).toBeGreaterThanOrEqual(0);
        expect(fact).toBeGreaterThan(lock);
      }
      expect((await db.query(`SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`, [C])).rows[0]?.checks).toBe('failing');
      expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND system_event->>'kind'='check-failed'`, [C])).rowCount).toBe(1);
      expect((await db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='corner_check'`, [C])).rowCount).toBe(1);
      expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(3);
    });
  
  });
});


describe("legacy-daemon-migration", () => {
  const owner = 'a'.repeat(64),
    workspace = '11111111-1111-4111-8111-111111111111';
  let database: PgliteDatabase,
    auth: TokenAuth,
    server: ReturnType<typeof createBeelineServer>,
    origin: string;
  const key = generateKeypair();
  beforeEach(async () => {
    database = await migratedDatabase();
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Legacy')`,
      [owner, key.publicKey],
    );
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,access_policy) VALUES($1,$2,'{"type":"creator"}')`,
      [key.publicKey, owner],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Fixture')`, [workspace]);
    await database.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`,
      [workspace, owner, key.publicKey],
    );
    auth = new TokenAuth(database, async () => {
      throw new Error('unused');
    });
    const live = new LiveHub();
    const options: ServerOptions = {
      database,
      auth,
      phone: new PhoneService(database, 'http://fixture'),
      daemon: new DaemonService(database, live),
      live,
      mediaMaximumBytes: 1024,
      legacyMigrationOrigin: '',
    };
    server = createBeelineServer(options);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    options.legacyMigrationOrigin = origin;
  });
  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await database.close();
  });
  function request(
    identity = key,
    payload = { workspaceId: workspace, pairedBy: owner },
    authorization?: string,
  ) {
    const url = `${origin}/v1/auth/daemon/migrate-legacy`;
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization:
          authorization ?? nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST'),
      },
      body: JSON.stringify(payload),
    });
  }
  it('redelivers the same migration credential after a lost exchange reply, without minting twice or reviving revocation', async () => {
    const exchange = await (await request()).json();
    const redeem = () =>
      fetch(`${origin}/v1/auth/daemon/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exchangeToken: exchange.exchangeToken }),
      });
    const issued = await (await redeem()).json();
    const replay = await redeem();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(issued);
    await database.query("UPDATE daemon_token_exchanges SET expires_at=now()-interval '1 day'");
    const delayed = await redeem();
    expect(delayed.status).toBe(200);
    expect(await delayed.json()).toEqual(issued);
    expect(
      (await database.query('SELECT count(*)::int AS count FROM daemon_tokens')).rows[0]?.count,
    ).toBe(1);
    await database.query('UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1', [
      key.publicKey,
    ]);
    expect((await redeem()).status).toBe(401);
  });
  it('migrates an authorized legacy identity once without changing its identity or permissions', async () => {
    const first = await request();
    expect(first.status).toBe(200);
    const exchange = await first.json();
    expect(exchange.agentId).toBe(key.publicKey);
    const activated = await auth.exchangeDaemonToken(exchange.exchangeToken);
    expect(activated?.agentId).toBe(key.publicKey);
    expect(await auth.authenticateDaemon(activated!.daemonToken)).toBe(key.publicKey);
    expect((await request()).status).toBe(403);
    expect(
      (
        await database.query<{ access_policy: unknown }>(
          `SELECT access_policy FROM agents WHERE agent_id=$1`,
          [key.publicKey],
        )
      ).rows[0]?.access_policy,
    ).toEqual({ type: 'creator' });
  });
  it('recovers a lost migration reply with a fresh proof and invalidates its prior unused exchange', async () => {
    const first = await (await request()).json();
    const second = await (await request()).json();
    expect(second.exchangeToken).not.toBe(first.exchangeToken);
    expect(await auth.exchangeDaemonToken(first.exchangeToken)).toBeNull();
    expect(await auth.exchangeDaemonToken(second.exchangeToken)).not.toBeNull();
  });
  it('allows a currently authorized relay record even when an earlier cutover minted an active credential', async () => {
    await auth.exchangeDaemonToken((await auth.createDaemonExchange(key.publicKey)).exchangeToken);
    const migration = await request();
    expect(migration.status).toBe(200);
    const exchange = await migration.json();
    expect(await auth.exchangeDaemonToken(exchange.exchangeToken)).not.toBeNull();
    expect((await request()).status).toBe(403);
  });
  it('does not mint a daemon token when removal wins between migration and exchange', async () => {
    const exchange = await (await request()).json();
    await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [
      key.publicKey,
    ]);
    expect(await auth.exchangeDaemonToken(exchange.exchangeToken)).toBeNull();
    expect(
      (await database.query(`SELECT 1 FROM daemon_tokens WHERE agent_id=$1`, [key.publicKey]))
        .rowCount,
    ).toBe(0);
  });
  it('refuses replay, the wrong request binding, unknown keys, removed membership and revoked monolith access', async () => {
    const url = `${origin}/v1/auth/daemon/migrate-legacy`;
    const proof = nip98AuthHeader(key.secretKey, key.publicKey, url, 'POST');
    expect((await request(key, undefined, proof)).status).toBe(200);
    expect((await request(key, undefined, proof)).status).toBe(403);
    expect((await request(generateKeypair())).status).toBe(403);
    expect(
      (
        await request(
          key,
          undefined,
          nip98AuthHeader(key.secretKey, key.publicKey, `${origin}/wrong`, 'POST'),
        )
      ).status,
    ).toBe(401);
    await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [
      key.publicKey,
    ]);
    expect((await request()).status).toBe(403);
    await database.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1`, [
      key.publicKey,
    ]);
    const token = await auth.exchangeDaemonToken(
      (await auth.createDaemonExchange(key.publicKey)).exchangeToken,
    );
    await database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1`, [
      key.publicKey,
    ]);
    expect(token).not.toBeNull();
    expect((await request()).status).toBe(403);
  });
});


describe("migration-steps", () => {
  const postgresUrl = serverDatabaseUrl;
  if (postgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(postgresUrl).hostname))
    throw new Error('migration lock proofs require an isolated loopback PostgreSQL');
  
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  
  describe('release-owned migration steps', () => {
    it.each(['40P01', '55P03', '57014', '42601'])('returns %s once and stays idle until another release command', async code => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failure = Object.assign(new Error(code), { code });
      const run = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
      const prior = vi.fn(async () => {});
      await runMigrationStep('prior', prior);
      await expect(runMigrationStep('contended', run)).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(run).toHaveBeenCalledOnce();
      expect(prior).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      // A new explicit release invocation owns this attempt.
      await runMigrationStep('contended', run);
      expect(run).toHaveBeenCalledTimes(2);
      expect(prior).toHaveBeenCalledOnce();
      expect(MIGRATION_LOCK_TIMEOUT_MS).toBe(1_000);
    });
  
    it.skipIf(!postgresUrl)('a real contended DDL step resumes only on an explicit invocation after lock release', async () => {
      const schema = `release_proof_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: postgresUrl, max: 1 });
      const reader = await admin.connect();
      const migration = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
        connectionString: postgresUrl, max: 1,
        options: `-c search_path=${schema} -c lock_timeout=30ms`,
      }) });
      try {
        await reader.query(`CREATE SCHEMA ${schema}`);
        await reader.query(`CREATE TABLE ${schema}.messages (id int)`);
        await reader.query(`BEGIN; SELECT * FROM ${schema}.messages`);
        const run = vi.fn(async () => { await migration.query('ALTER TABLE messages ADD COLUMN delivered boolean'); });
        await expect(runMigrationStep('reader contention', run)).rejects.toMatchObject({ code: '55P03' });
        expect(run).toHaveBeenCalledOnce();
        await reader.query('COMMIT');
        const columns = async () => (await reader.query(`SELECT column_name FROM information_schema.columns
          WHERE table_schema=$1 AND table_name='messages'`, [schema])).rows;
        expect(await columns()).not.toContainEqual({ column_name: 'delivered' });
        await runMigrationStep('reader contention', run);
        expect(run).toHaveBeenCalledTimes(2);
        expect(await columns()).toContainEqual({ column_name: 'delivered' });
      } finally {
        await reader.query('ROLLBACK');
        await migration.close();
        await reader.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        reader.release();
        await admin.end();
      }
    });
  
    it.skipIf(!postgresUrl)('R-MIGRATION-DATA stops each contended backfill and resumes only on a new release invocation', async () => {
      const schema = `backfill_proof_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: postgresUrl, max: 1 });
      const holder = await admin.connect();
      const database = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
        connectionString: postgresUrl, max: 1,
        options: `-c search_path=${schema},public -c lock_timeout=30ms`,
      }) });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await holder.query(`CREATE SCHEMA ${schema}`);
        await migrate(database);
        // Lock acquisition happens only when the targeted step starts, so earlier
        // completed steps remain outside the contended step.
        const steps = [
          { name: 'archived corner holds', table: 'corner_merge_holds',
            matches: (sql: string, _values: unknown[]) => sql.startsWith('SELECT 1 FROM corner_merge_holds hold JOIN rooms corner'),
            run: () => migrateData(database) },
          { name: 'corner hold messages', table: 'corner_merge_holds',
            matches: (sql: string, _values: unknown[]) => sql.includes('SELECT hold.corner_id,hold.id,COALESCE'),
            run: () => migrateData(database) },
          { name: 'welcome video workflow', table: 'workflow_backfills',
            matches: (sql: string, values: unknown[]) => sql.startsWith('SELECT name FROM workflow_backfills') && values[0] === 'welcome-video-v1',
            run: () => migrateData(database) },
          { name: 'agent handle candidates', table: 'identities',
            matches: (sql: string, _values: unknown[]) => sql.startsWith('SELECT id,created_at FROM identities'),
            run: () => backfillAgentHandles(database) },
        ];
        for (const step of steps) {
          let calls = 0;
          const query = database.query.bind(database);
          const querySpy = vi.spyOn(database, 'query').mockImplementation(async (sql, values = []) => {
            if (step.matches(sql, values) && ++calls === 1)
              await holder.query(`BEGIN; LOCK TABLE ${schema}.${step.table} IN ACCESS EXCLUSIVE MODE`);
            return query(sql, values);
          });
          try {
            await expect(step.run()).rejects.toMatchObject({ code: '55P03' });
            expect(calls, step.name).toBe(1);
            // A full data migration resumes from its entry point, so release
            // the lock before the next explicit invocation can reach this step.
            await holder.query('COMMIT');
            await step.run();
            expect(calls, step.name).toBe(2);
          } finally {
            querySpy.mockRestore();
            await holder.query('ROLLBACK');
          }
          // Failure leaves no aborted transaction or stranded pool slot.
          await expect(database.query('SELECT 1')).resolves.toMatchObject({ rowCount: 1 });
        }
      } finally {
        vi.restoreAllMocks();
        await holder.query('ROLLBACK');
        await database.close();
        await holder.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        holder.release();
        await admin.end();
      }
    }, 60_000);
  
    it('keeps semicolons inside quoted strings, comments, and trigger bodies', () => {
      const script = `-- first; comment
  CREATE TABLE sample (value text DEFAULT 'a;b');
  /* second; comment */
  CREATE FUNCTION sample_fn() RETURNS trigger AS $body$
  BEGIN NEW.value := 'c;d'; RETURN NEW; END;
  $body$ LANGUAGE plpgsql;
  CREATE TRIGGER sample_trigger BEFORE INSERT ON sample
  FOR EACH ROW EXECUTE FUNCTION sample_fn();`;
      const statements = splitMigrationStatements(script);
      expect(statements).toHaveLength(3);
      expect(statements[0]).toContain("DEFAULT 'a;b'");
      expect(statements[1]).toContain("RETURN NEW; END;");
      expect(statements[2]).toContain('CREATE TRIGGER');
    });
  
  });
  
  describe('lock holder diagnostic', () => {
    afterEach(() => vi.restoreAllMocks());
  
    const lockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const holder = {
      relation: 'identities', mode: 'RowExclusiveLock', granted: true, pid: 4242, state: 'idle in transaction',
      wait_event_type: 'Client', wait_event: 'ClientRead', xact_start: '2026-10-19 19:22:01+00',
      query_start: '2026-10-19 19:22:02+00', application_name: 'beeline_long_running',
      query: 'UPDATE identities SET name=$1 WHERE id=$2',
    };
  
    function fakeDatabase(fail = false) {
      const queries: { sql: string; values?: unknown[] }[] = [];
      const database = {
        async query(sql: string, values?: unknown[]) {
          queries.push({ sql, values });
          if (fail && sql.includes('pg_locks')) throw new Error('permission denied for pg_locks');
          return { rows: sql.includes('pg_locks') ? [holder] : [] };
        },
        async transaction<T>(work: (db: typeof database) => Promise<T>) { return work(database); },
      };
      return { database, queries };
    }
  
    it('names the tables a migration statement locks', () => {
      expect(lockedTables('ALTER TABLE identities ADD COLUMN IF NOT EXISTS hidden_from_roster boolean')).toEqual(['identities']);
      expect(lockedTables('DO $x$ BEGIN LOCK TABLE identities IN SHARE ROW EXCLUSIVE MODE; END $x$')).toContain('identities');
    });
  
    it('logs the sessions holding the blocked table on every lock timeout', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { database, queries } = fakeDatabase();
      const sql = 'ALTER TABLE identities ADD COLUMN IF NOT EXISTS hidden_from_roster boolean';
      await expect(runMigrationStep('server schema 3/567', async () => { throw lockTimeout(); }, {
        onLockTimeout: () => logLockHolders(database, 'server schema 3/567', sql),
      })).rejects.toMatchObject({ code: '55P03' });
      const diagnostics = queries.filter((query) => query.sql.includes('pg_locks'));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.values).toEqual([['identities']]);
      expect(queries.some((query) => /SET LOCAL statement_timeout/.test(query.sql))).toBe(true);
      const logged = warn.mock.calls.filter(([message]) => message === '[migration] lock holder').map(([, row]) => row);
      expect(logged).toHaveLength(1);
      expect(Object.keys(logged[0] as object)).toEqual(expect.arrayContaining([
        'pid', 'state', 'wait_event', 'xact_start', 'query_start', 'application_name', 'query',
      ]));
    });
  
    it('keeps the original lock timeout when the diagnostic fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { database } = fakeDatabase(true);
      await expect(runMigrationStep('schema', async () => { throw lockTimeout(); }, {
        onLockTimeout: () => logLockHolders(database, 'schema', 'ALTER TABLE identities ADD COLUMN x int'),
      })).rejects.toThrow('canceling statement due to lock timeout');
      expect(warn).toHaveBeenCalledWith('[migration] schema lock holder diagnostic failed: permission denied for pg_locks');
    });
  
    it.skipIf(!postgresUrl)('names the second session that holds the table in real PostgreSQL', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const schema = `lock_proof_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: postgresUrl, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`CREATE TABLE ${schema}.lock_proof (id int)`);
      const holder = new Pool({ connectionString: postgresUrl, max: 1, application_name: 'lock_proof_holder' });
      const held = await holder.connect();
      const database = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
        connectionString: postgresUrl, max: 1, options: `-c search_path=${schema} -c lock_timeout=200ms`,
      }) });
      try {
        await held.query(`BEGIN; SELECT count(*) FROM ${schema}.lock_proof`);
        const holderPid = (await held.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
        const sql = 'ALTER TABLE lock_proof ADD COLUMN IF NOT EXISTS hidden boolean';
        await expect(runMigrationStep('proof 1/1', async () => { await database.query(sql); }, {
            onLockTimeout: () => logLockHolders(database, 'proof 1/1', sql),
        })).rejects.toMatchObject({ code: '55P03' });
        const logged = warn.mock.calls.filter(([message]) => message === '[migration] lock holder').map(([, row]) => row);
        expect(logged).toContainEqual(expect.objectContaining({
          relation: 'lock_proof', granted: true, pid: holderPid, application_name: 'lock_proof_holder',
          state: 'idle in transaction', query: 'SELECT pg_backend_pid() pid',
        }));
      } finally {
        await held.query('ROLLBACK');
        held.release();
        await holder.end();
        await database.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });
  });
  
  describe('already-satisfied idempotent DDL', () => {
    it('reads back only plain IF NOT EXISTS creates', () => {
      expect(satisfiedCheck('ALTER TABLE identities ADD COLUMN IF NOT EXISTS hidden_from_roster boolean NOT NULL DEFAULT false;'))
        .toEqual({ relation: 'identities', columns: ['hidden_from_roster'] });
      expect(satisfiedCheck(`-- note\nALTER TABLE t ADD COLUMN IF NOT EXISTS a text DEFAULT 'x,y', ADD COLUMN IF NOT EXISTS b numeric(10,2)`))
        .toEqual({ relation: 't', columns: ['a', 'b'] });
      expect(satisfiedCheck('CREATE TABLE IF NOT EXISTS rooms (id uuid PRIMARY KEY)')).toEqual({ relation: 'rooms', columns: [] });
      expect(satisfiedCheck('CREATE UNIQUE INDEX IF NOT EXISTS rooms_slug ON rooms(slug)')).toEqual({ relation: 'rooms_slug', columns: [] });
      expect(satisfiedCheck('CREATE INDEX CONCURRENTLY IF NOT EXISTS rooms_slug ON rooms(slug)')).toBeNull();
      expect(satisfiedCheck('ALTER TABLE t ADD COLUMN IF NOT EXISTS a text, DROP COLUMN b')).toBeNull();
      expect(satisfiedCheck('ALTER TABLE t ADD COLUMN a text')).toBeNull();
      expect(satisfiedCheck('ALTER TABLE t ALTER COLUMN a SET NOT NULL')).toBeNull();
      expect(satisfiedCheck('UPDATE t SET a = 1')).toBeNull();
    });
  
    it('skips only when every named object exists, without touching the table', async () => {
      const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
        rows: [{ relation: true, columns: (values?.[1] as string[]).filter(c => c !== 'missing').length }],
      }));
      await expect(alreadySatisfied({ query }, 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text')).resolves.toBe(true);
      await expect(alreadySatisfied({ query }, 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text, ADD COLUMN IF NOT EXISTS missing text')).resolves.toBe(false);
      await expect(alreadySatisfied({ query }, 'ALTER TABLE t DROP COLUMN IF EXISTS a')).resolves.toBe(false);
      expect(query).toHaveBeenCalledTimes(2);
      expect(String(query.mock.calls[0]![0])).not.toMatch(/\bLOCK\b|\bALTER\b/i);
    });
  });
  
  describe('already-current trigger pairs', () => {
    const drop = 'DROP TRIGGER IF EXISTS next_day_first_message ON messages;';
    const create = 'CREATE TRIGGER next_day_first_message AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION note_checkin_first_message();';
    const installed = 'CREATE TRIGGER next_day_first_message AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION note_checkin_first_message()';
  
    it('pairs only a drop and create of the same trigger on the same table', () => {
      expect(triggerPair(drop, create)).toEqual(['next_day_first_message', 'messages']);
      expect(triggerPair(drop, create.replace('ON messages', 'ON rooms'))).toBeNull();
      expect(triggerPair(drop, 'CREATE TRIGGER other AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION f()')).toBeNull();
      expect(triggerPair('DROP TRIGGER next_day_first_message ON messages', create)).toBeNull();
      expect(normalizeTriggerDefinition(installed)).toBe(normalizeTriggerDefinition(create));
    });
  
    it('skips only when the installed definition is identical', async () => {
      const query = vi.fn(async () => ({ rows: [{ definition: installed }] }));
      await expect(triggerAlreadyCurrent({ query }, drop, create)).resolves.toBe(true);
      await expect(triggerAlreadyCurrent({ query }, drop, create.replace('AFTER INSERT', 'AFTER INSERT OR UPDATE'))).resolves.toBe(false);
      const absent = vi.fn(async () => ({ rows: [] }));
      await expect(triggerAlreadyCurrent({ query: absent }, drop, create)).resolves.toBe(false);
      await expect(triggerAlreadyCurrent({ query }, 'UPDATE t SET a=1', create)).resolves.toBe(false);
    });
  });
  
  describe('already-done drops and nullability', () => {
    it('reads back only drops and NOT NULL changes', () => {
      expect(noOpCheck('-- why\nALTER TABLE messages DROP COLUMN IF EXISTS mention_ids;'))
        .toEqual({ kind: 'alter', relation: 'messages', clauses: [{ kind: 'drop-column', name: 'mention_ids' }] });
      expect(noOpCheck('ALTER TABLE t DROP CONSTRAINT IF EXISTS c, ALTER COLUMN a DROP NOT NULL')).toEqual({
        kind: 'alter', relation: 't',
        clauses: [{ kind: 'drop-constraint', name: 'c' }, { kind: 'not-null', name: 'a', notNull: false }],
      });
      expect(noOpCheck('DROP TABLE IF EXISTS old_rows')).toEqual({ kind: 'drop-relation', relation: 'old_rows' });
      expect(noOpCheck('ALTER TABLE t DROP CONSTRAINT IF EXISTS c, ADD CONSTRAINT c CHECK (a > 0)')).toBeNull();
      expect(noOpCheck('ALTER TABLE t ALTER COLUMN a SET DEFAULT now()')).toEqual({
        kind: 'alter', relation: 't', clauses: [{ kind: 'default', name: 'a', expr: 'now()' }],
      });
      expect(noOpCheck('ALTER TABLE t DROP COLUMN a')).toBeNull();
    });
  
    it('skips only when there is nothing left to drop or change', async () => {
      const catalog = (present: boolean, attribute: Record<string, unknown>[], constraint: Record<string, unknown>[] = []) =>
        vi.fn(async (sql: string) => ({
          rows: sql.includes('to_regclass($1) IS NOT NULL AS present') ? [{ present }]
            : sql.includes('pg_constraint') ? constraint : sql.includes('pg_trigger') ? attribute : attribute,
        }));
      await expect(alreadyNoOp({ query: catalog(true, []) }, 'ALTER TABLE messages DROP COLUMN IF EXISTS mention_ids')).resolves.toBe(true);
      await expect(alreadyNoOp({ query: catalog(true, [{ attnotnull: false }]) }, 'ALTER TABLE messages DROP COLUMN IF EXISTS mention_ids')).resolves.toBe(false);
      await expect(alreadyNoOp({ query: catalog(true, [{ attnotnull: false }]) }, 'ALTER TABLE t ALTER COLUMN a DROP NOT NULL')).resolves.toBe(true);
      await expect(alreadyNoOp({ query: catalog(true, [{ attnotnull: true }]) }, 'ALTER TABLE t ALTER COLUMN a DROP NOT NULL')).resolves.toBe(false);
      await expect(alreadyNoOp({ query: catalog(true, [], [{ one: 1 }]) }, 'ALTER TABLE t DROP CONSTRAINT IF EXISTS c')).resolves.toBe(false);
      await expect(alreadyNoOp({ query: catalog(false, []) }, 'DROP TABLE IF EXISTS old_rows')).resolves.toBe(true);
      await expect(alreadyNoOp({ query: catalog(true, []) }, 'DROP TABLE IF EXISTS old_rows')).resolves.toBe(false);
      await expect(alreadyNoOp({ query: catalog(false, []) }, 'ALTER TABLE t DROP COLUMN IF EXISTS a')).resolves.toBe(false);
      await expect(alreadyNoOp({ query: catalog(true, []) }, 'DROP TRIGGER IF EXISTS x ON messages')).resolves.toBe(true);
      await expect(alreadyNoOp({ query: catalog(true, [{ one: 1 }]) }, 'DROP TRIGGER IF EXISTS x ON messages')).resolves.toBe(false);
    });
  });
  
  describe('already-current column defaults', () => {
    it('normalizes', () => {
      expect(normalizeDefault("'public'::text")).toBe(normalizeDefault("'public'"));
      expect(normalizeDefault('now()')).toBe(normalizeDefault('now()'));
      expect(normalizeDefault("'{\"type\": \"everyone\"}'::jsonb")).toBe(normalizeDefault(`'{"type":"everyone"}'::jsonb`));
      expect(normalizeDefault("'live'::text")).not.toBe(normalizeDefault("'public'"));
    });
    it('skips only identical defaults', async () => {
      const sql = "ALTER TABLE rooms ALTER COLUMN visibility SET DEFAULT 'public';";
      expect(noOpCheck(sql)).toEqual({ kind:'alter', relation:'rooms', clauses:[{kind:'default',name:'visibility',expr:"'public'"}] });
      const q = (expr: string|null) => vi.fn(async (s: string) => ({ rows: s.includes('present') ? [{present:true}] : expr===null ? [] : [{expr}] }));
      await expect(alreadyNoOp({ query: q("'public'::text") }, sql)).resolves.toBe(true);
      await expect(alreadyNoOp({ query: q("'private'::text") }, sql)).resolves.toBe(false);
      await expect(alreadyNoOp({ query: q(null) }, sql)).resolves.toBe(false);
    });
  });
});


describe("owned-model.postgres", () => {
  const url = serverDatabaseUrl;
  if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Owned model proofs require isolated loopback PostgreSQL');
  const ONE = '11111111-1111-4111-8111-111111111111', TWO = '22222222-2222-4222-8222-222222222222';
  function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
  async function blocked(admin: Pool, pid: number): Promise<void> {
    // Fixture synchronization against an already admitted, exact lock obligation.
    for (let index = 0; index < 200; index++) {
      if ((await admin.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0]!.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Expected exact model/source writer to wait behind admitted work');
  }
  function observe(database: SqlDatabase, after: (sql: string, tx: SqlDatabase) => Promise<void>): SqlDatabase {
    return {
      query: (sql, values) => database.query(sql, values),
      transaction: work => database.transaction(tx => work({
        query: async <Row extends QueryResultRow>(sql: string, values?: unknown[]) => {
          const result = await tx.query<Row>(sql, values); await after(sql, tx); return result;
        }, transaction: nested => tx.transaction(nested),
      })),
    };
  }
  async function fixture() {
    const schema = 'owned_model_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: url, max: 1 }); await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public -c statement_timeout=8000`, max: 2 };
    const left = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const right = new PostgresDatabase('', 2, { pool: new Pool(config) });
    try {
      await left.query(`CREATE TABLE identities(id text PRIMARY KEY,kind text,name text);
        CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text);
        CREATE TABLE workspaces(id uuid PRIMARY KEY,name text);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,name text,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
        CREATE TABLE free_agents(agent_id text PRIMARY KEY,workspace_id uuid,owner_id text,sealed_keys text,
          model_token_hash text,state text,model text,removed_at timestamptz);
        CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);
        CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,instance_id text,released_at timestamptz);
        CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,action text,reason text,
          root_command_id text,root_source_message_id text,agent_depth integer,state text,generation_id text,claimed_at timestamptz,
          lease_expires_at timestamptz,created_at timestamptz DEFAULT now());
        CREATE TABLE agent_turns(room_id uuid,request_id text,agent_id text,status text,generation_id text);`);
      // Install actual authority writer triggers and actual owned source/commit
      // predicates, rather than a fake lock in the proof's membership adapter.
      await left.query(DURABLE_LIVE_SCHEMA); await left.query(ROUTER_PROJECTION_SCHEMA); await left.query(TURN_OWNERSHIP_SCHEMA);
      const seeded = await seedOwnedModelFixture(left);
      return { ...seeded, left, right, admin, close: async () => {
        await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
      } };
    } catch (error) {
      await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); throw error;
    }
  }
  const payload = (text = 'synthetic private history') => ({ model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: text }] });
  const reserve = async (tx: SqlDatabase) => {
    await tx.query(`INSERT INTO owned_model_test_accounting(id,amount) VALUES($1,16)`, [randomUUID()]);
    return { reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 }, payload: payload() };
  };
  
  describe.skipIf(!url)('real PostgreSQL owned model primitive contention', () => {
    it('serializes competing admissions across pools and gives only the actual committed reservation a one-use permit', async () => {
      const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), pid = deferred<number>();
      let first: ReturnType<OwnedModelAttempts['reserve']> | undefined, second: ReturnType<OwnedModelAttempts['reserve']> | undefined;
      let early: unknown;
      try {
        const owner = new OwnedModelAttempts(f.left, f.credentials);
        const otherKeys = new OwnedModelCredentials({ currentVersion: 'test-v1', key: () => MODEL_KEY }, () => MODEL, () => 900_000);
        const otherActor = await otherKeys.authenticate(f.right, f.issued.token);
        const other = new OwnedModelAttempts(f.right, otherKeys);
        // Resolve PID before the actual blocking global-budget lock, which is
        // acquired before owner lock by both real admissions.
        const competing = new OwnedModelAttempts({ query: (sql, args) => f.right.query(sql, args), transaction: work => f.right.transaction(async tx => {
          pid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid)); return work(tx);
        }) }, otherKeys);
        const winningHook = vi.fn(async (tx: SqlDatabase) => { const value = await reserve(tx); entered.resolve(); await release.promise; return value; });
        first = owner.reserve(f.actor, ONE, payload(), winningHook);
        void first.catch(error => { early = error; entered.resolve(); }); await entered.promise; if (early) throw early;
        const losingHook = vi.fn(reserve); second = competing.reserve(otherActor, ONE, payload(), losingHook);
        await blocked(f.admin, await pid.promise); expect(losingHook).not.toHaveBeenCalled();
        release.resolve(); const admitted = await first, replayed = await second;
        expect(replayed).toEqual({ receipt: admitted.receipt }); expect(winningHook).toHaveBeenCalledOnce(); expect(losingHook).not.toHaveBeenCalled();
        expect((await f.right.query('SELECT * FROM owned_model_test_accounting')).rowCount).toBe(1);
        expect((await f.right.query('SELECT * FROM owned_model_attempts')).rowCount).toBe(1);
        const start = vi.fn(async () => 'synthetic result'); await owner.handoff(admitted.permit!, start);
        await expect(other.handoff(admitted.permit!, start)).rejects.toThrow('UNKNOWN'); expect(start).toHaveBeenCalledOnce();
      } finally { release.resolve(); await Promise.allSettled([first, second].filter((work): work is NonNullable<typeof work> => work !== undefined)); await f.close(); }
    }, 20_000);
  
    it.each(['membership', 'source', 'rotation'] as const)('serializes actual %s change through final synchronous handoff, without awaiting provider completion', async change => {
      const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), pid = deferred<number>(), provider = deferred<string>();
      let pause = false, early: unknown, handoff: ReturnType<OwnedModelAttempts['handoff']> | undefined, writer: Promise<unknown> | undefined;
      try {
        const owner = new OwnedModelAttempts(observe(f.left, async sql => {
          if (pause && sql.includes('FROM owned_model_attempts') && sql.includes('FOR SHARE NOWAIT')) { pause = false; entered.resolve(); await release.promise; }
        }), f.credentials);
        const first = await owner.reserve(f.actor, ONE, payload(), reserve);
        const next = await owner.reserve(f.actor, TWO, payload('synthetic next tool history'), async tx => ({ ...(await reserve(tx)), payload: payload('synthetic next tool history') }));
        const start = vi.fn(() => provider.promise); pause = true;
        handoff = owner.handoff(first.permit!, start); void handoff.catch(error => { early = error; entered.resolve(); });
        await entered.promise; if (early) throw early;
        let written = false;
        writer = f.right.transaction(async tx => {
          pid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
          if (change === 'membership') await tx.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1', [MODEL_ROOM]);
          if (change === 'source') await tx.query(`UPDATE agent_connections SET connection_id='replacement',epoch=2 WHERE agent_id=$1`, [MODEL_AGENT]);
          if (change === 'rotation') await tx.query('UPDATE free_agents SET model_token_hash=$2 WHERE agent_id=$1', [MODEL_AGENT, 'e'.repeat(64)]);
          written = true;
        });
        await blocked(f.admin, await pid.promise); expect(written).toBe(false); expect(start).not.toHaveBeenCalled();
        release.resolve(); expect((await handoff).state).toBe('started'); await writer;
        expect(start).toHaveBeenCalledOnce(); expect(written).toBe(true); // provider Promise remains unresolved
        await expect(owner.handoff(next.permit!, start)).rejects.toThrow(); expect(start).toHaveBeenCalledOnce();
        expect((await f.right.query(`SELECT state FROM owned_model_attempts`)).rows).toEqual([{ state: 'unknown' }, { state: 'unknown' }]);
      } finally {
        release.resolve(); provider.resolve('synthetic completion');
        await Promise.allSettled([handoff, writer].filter((work): work is NonNullable<typeof work> => work !== undefined)); await f.close();
      }
    }, 20_000);
  
    it('rechecks actual lease expiry after queue/source admission and refuses entry while retaining the committed UNKNOWN reservation', async () => {
      const f = await fixture(), entered = deferred<void>(), release = deferred<void>(); let pause = false, early: unknown;
      let handoff: ReturnType<OwnedModelAttempts['handoff']> | undefined;
      try {
        const owner = new OwnedModelAttempts(observe(f.left, async sql => {
          if (pause && sql.includes('FROM owned_model_attempts') && sql.includes('FOR SHARE NOWAIT')) { pause = false; entered.resolve(); await release.promise; }
        }), f.credentials);
        const admitted = await owner.reserve(f.actor, ONE, payload(), reserve), start = vi.fn(async () => 'must not enter'); pause = true;
        handoff = owner.handoff(admitted.permit!, start); void handoff.catch(error => { early = error; entered.resolve(); });
        await entered.promise; if (early) throw early;
        await f.right.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds'`);
        release.resolve(); await expect(handoff).rejects.toThrow('authority'); expect(start).not.toHaveBeenCalled();
        expect((await f.right.query('SELECT state,evidence FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown', evidence: null }]);
        expect((await f.right.query('SELECT * FROM owned_model_test_accounting')).rowCount).toBe(1);
        await expect(owner.handoff(admitted.permit!, start)).rejects.toThrow('UNKNOWN');
      } finally { release.resolve(); await Promise.allSettled(handoff ? [handoff] : []); await f.close(); }
    }, 20_000);
  
    it('refuses a reverse-order free-agent writer promptly instead of deadlocking or retrying provider entry', async () => {
      const f = await fixture(), rowHeld = deferred<void>(), authorityHeld = deferred<void>(), requestAuthority = deferred<void>();
      const releaseHandoff = deferred<void>(), pid = deferred<number>(); let pause = false, early: unknown;
      let writer: Promise<unknown> | undefined, handoff: ReturnType<OwnedModelAttempts['handoff']> | undefined;
      try {
        const owner = new OwnedModelAttempts(observe(f.left, async sql => {
          if (pause && sql.includes('pg_advisory_xact_lock_shared')) { pause = false; authorityHeld.resolve(); await releaseHandoff.promise; }
        }), f.credentials);
        const admitted = await owner.reserve(f.actor, ONE, payload(), reserve), start = vi.fn(async () => 'must not enter');
        writer = f.right.transaction(async tx => {
          await tx.query('SELECT agent_id FROM free_agents WHERE agent_id=$1 FOR UPDATE', [MODEL_AGENT]);
          pid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
          rowHeld.resolve(); await requestAuthority.promise;
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
        });
        void writer.catch(error => { early = error; rowHeld.resolve(); }); await rowHeld.promise; if (early) throw early;
        pause = true; handoff = owner.handoff(admitted.permit!, start);
        void handoff.catch(error => { early = error; authorityHeld.resolve(); }); await authorityHeld.promise; if (early) throw early;
        requestAuthority.resolve(); await blocked(f.admin, await pid.promise); releaseHandoff.resolve();
        await expect(handoff).rejects.toMatchObject({ code: '55P03' }); await writer;
        expect(start).not.toHaveBeenCalled(); await expect(owner.handoff(admitted.permit!, start)).rejects.toThrow('UNKNOWN');
        expect((await f.right.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
      } finally {
        requestAuthority.resolve(); releaseHandoff.resolve();
        await Promise.allSettled([writer, handoff].filter((work): work is NonNullable<typeof work> => work !== undefined)); await f.close();
      }
    }, 20_000);
  
    it('accounts for the complete final DB response delay instead of handing off with an expired observed lifetime', async () => {
      const f = await fixture(); let delay = false, delayed = false;
      try {
        const owner = new OwnedModelAttempts(observe(f.left, async (sql, tx) => {
          if (delay && sql.startsWith('SELECT command.agent_id')) {
            delay = false; delayed = true; await tx.query('SELECT pg_sleep(1.2)');
          }
        }), f.credentials);
        const admitted = await owner.reserve(f.actor, ONE, payload(), reserve), start = vi.fn(async () => 'must not enter');
        await f.right.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '89 seconds'`); delay = true;
        await expect(owner.handoff(admitted.permit!, start)).rejects.toThrow(); expect(delayed).toBe(true); expect(start).not.toHaveBeenCalled();
        expect((await f.right.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
      } finally { await f.close(); }
    }, 20_000);
  
    it('refuses behind the actual bootstrap token-rotation row owner without retrying or blocking its legacy credential completion', async () => {
      const f = await fixture(), held = deferred<void>(), release = deferred<void>(); let early: unknown;
      let bootstrap: ReturnType<FreeAgentService['bootstrap']> | undefined;
      try {
        await f.left.query(`ALTER TABLE agents ADD COLUMN soul jsonb;
          ALTER TABLE free_agents ADD COLUMN bootstrap_hash text,ADD COLUMN updated_at timestamptz;
          CREATE TABLE free_agent_events(id bigserial PRIMARY KEY,agent_id text,kind text,detail jsonb);`);
        const key = 'synthetic-sealing-key', bootstrapToken = 'bfb_synthetic';
        await f.left.query('UPDATE free_agents SET sealed_keys=$1,bootstrap_hash=$2', [sealSecrets(key, { agent: 'synthetic-agent-key', body: 'synthetic-body-key' }), tokenHash(bootstrapToken)]);
        const owner = new OwnedModelAttempts(f.left, f.credentials), admitted = await owner.reserve(f.actor, ONE, payload(), reserve);
        const noMachine = vi.fn(async () => { throw new Error('No lifecycle effect is authorized by this fixture'); });
        const machines: FreeAgentMachines = { create: noMachine, find: noMachine, start: noMachine, suspend: noMachine, stop: noMachine, destroy: noMachine, state: noMachine, waitFor: noMachine };
        const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENT_SEAL_KEY: key, FLY_FREE_AGENT_IMAGE: 'synthetic-image' }, 'https://synthetic.invalid')!;
        const service = new FreeAgentService(observe(f.right, async sql => {
          if (sql.includes('FOR UPDATE OF f')) { held.resolve(); await release.promise; }
        }), config, machines, async (agent, tx) => {
          await lockDaemonCredentialLifetime(tx, agent); return { exchangeToken: 'synthetic-exchange' };
        });
        bootstrap = service.bootstrap(bootstrapToken); void bootstrap.catch(error => { early = error; held.resolve(); });
        await held.promise; if (early) throw early;
        const start = vi.fn(async () => 'must not enter'); await expect(owner.handoff(admitted.permit!, start)).rejects.toMatchObject({ code: '55P03' });
        release.resolve(); expect((await bootstrap)?.daemonExchangeToken).toBe('synthetic-exchange');
        expect(start).not.toHaveBeenCalled(); expect(noMachine).not.toHaveBeenCalled();
        await expect(f.credentials.authenticate(f.left, f.issued.token)).rejects.toThrow('authority');
        expect((await f.left.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
      } finally { release.resolve(); await Promise.allSettled(bootstrap ? [bootstrap] : []); await f.close(); }
    }, 20_000);
  
    it('releases final authority on NOWAIT refusal so actual retirement can finish its reverse-order membership write', async () => {
      const f = await fixture(), rowHeld = deferred<void>(), authorityHeld = deferred<void>(), releaseRetire = deferred<void>(), releaseHandoff = deferred<void>();
      const pid = deferred<number>(); let early: unknown, pause = false;
      let retirement: Promise<unknown> | undefined, handoff: ReturnType<OwnedModelAttempts['handoff']> | undefined;
      try {
        await f.left.query(`ALTER TABLE free_agents ADD COLUMN bootstrap_hash text,ADD COLUMN wake_requested_at timestamptz,ADD COLUMN updated_at timestamptz;
          ALTER TABLE identities ADD COLUMN hidden_from_roster boolean,ADD COLUMN updated_at timestamptz;
          ALTER TABLE agents ADD COLUMN usage_snapshot jsonb,ADD COLUMN usage_account_id text,ADD COLUMN soul jsonb,
            ADD COLUMN chosen_voices jsonb,ADD COLUMN selected_model text,ADD COLUMN selected_effort text,ADD COLUMN model_catalog jsonb,
            ADD COLUMN model_unavailable jsonb,ADD COLUMN commands jsonb,ADD COLUMN schedule_ids jsonb,ADD COLUMN squire_report jsonb,
            ADD COLUMN squire_work jsonb,ADD COLUMN yolo_mode boolean,ADD COLUMN yolo_set_by text,ADD COLUMN yolo_set_at timestamptz,
            ADD COLUMN access_policy jsonb,ADD COLUMN updated_at timestamptz;
          CREATE TABLE free_agent_events(id bigserial PRIMARY KEY,agent_id text,kind text,detail jsonb);
          CREATE TABLE daemon_token_exchanges(agent_id text,consumed_at timestamptz);
          CREATE TABLE daemon_tokens(agent_id text,revoked_at timestamptz);
          CREATE TABLE agent_schedules(agent_id text,workspace_id uuid);
          CREATE TABLE agent_grants(id text,room_id uuid,agent_id text,workspace_id uuid,status text,decided_by text,decided_at timestamptz);`);
        const owner = new OwnedModelAttempts(observe(f.left, async sql => {
          if (pause && sql.includes('pg_advisory_xact_lock_shared')) { pause = false; authorityHeld.resolve(); await releaseHandoff.promise; }
        }), f.credentials), admitted = await owner.reserve(f.actor, ONE, payload(), reserve);
        const writer = observe(f.right, async (sql, tx) => {
          if (sql.includes('UPDATE free_agents SET removed_at=')) {
            pid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid)); rowHeld.resolve(); await releaseRetire.promise;
          }
        });
        retirement = writer.transaction(tx => retireAgentFromWorkspace(tx, { workspaceId: MODEL_WORKSPACE, agentId: MODEL_AGENT,
          remover: { pubkey: MODEL_OWNER, name: 'Synthetic owner', kind: 'human' }, removed: { pubkey: MODEL_AGENT, name: 'Synthetic agent', kind: 'agent' } }));
        void retirement.catch(error => { early = error; rowHeld.resolve(); }); await rowHeld.promise; if (early) throw early;
        const start = vi.fn(async () => 'must not enter'); pause = true; handoff = owner.handoff(admitted.permit!, start);
        void handoff.catch(error => { early = error; authorityHeld.resolve(); }); await authorityHeld.promise; if (early) throw early;
        releaseRetire.resolve(); await blocked(f.admin, await pid.promise); releaseHandoff.resolve();
        await expect(handoff).rejects.toMatchObject({ code: '55P03' }); await retirement; expect(start).not.toHaveBeenCalled();
        await expect(f.credentials.authenticate(f.left, f.issued.token)).rejects.toThrow('authority');
        expect((await f.left.query('SELECT hidden_from_roster FROM identities WHERE id=$1', [MODEL_AGENT])).rows).toEqual([{ hidden_from_roster: true }]);
      } finally {
        releaseRetire.resolve(); releaseHandoff.resolve();
        await Promise.allSettled([retirement, handoff].filter((work): work is NonNullable<typeof work> => work !== undefined)); await f.close();
      }
    }, 20_000);
  
    it('serializes a generation writer behind old reservation COMMIT, then rolls its new credential composition back on UNKNOWN', async () => {
      const f = await fixture(), reserved = deferred<void>(), release = deferred<void>(), pid = deferred<number>(); let early: unknown;
      let first: ReturnType<OwnedModelAttempts['reserve']> | undefined, next: Promise<unknown> | undefined;
      try {
        const owner = new OwnedModelAttempts(f.left, f.credentials);
        first = owner.reserve(f.actor, ONE, payload(), async tx => { const value = await reserve(tx); reserved.resolve(); await release.promise; return value; });
        void first.catch(error => { early = error; reserved.resolve(); }); await reserved.promise; if (early) throw early;
        const issue = vi.spyOn(f.credentials, 'issueInTransaction');
        next = f.right.transaction(async tx => {
          pid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
          await tx.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='synthetic-command'`);
          await tx.query(`UPDATE agent_commands SET state='claimed',generation_id='next-generation',claimed_at=clock_timestamp(),
            turn_owner_connection_id='synthetic-connection',turn_owner_epoch=1 WHERE id='synthetic-command'`);
          return f.credentials.issueInTransaction(tx, { agentId: MODEL_AGENT, commandId: 'synthetic-command', generationId: 'next-generation',
            source: { connectionId: 'synthetic-connection', epoch: 1 } });
        });
        const rejected = expect(next).rejects.toMatchObject({ code: '23514', message: OWNED_MODEL_UNKNOWN_GENERATION_MESSAGE });
        await blocked(f.admin, await pid.promise); release.resolve(); expect((await first).permit).toBeDefined(); await rejected;
        expect(issue).not.toHaveBeenCalled(); // persisted SQL floor protects old callers without this hook
        expect((await f.left.query('SELECT generation_id,state FROM agent_commands')).rows).toEqual([{ generation_id: 'synthetic-generation', state: 'claimed' }]);
        expect((await f.left.query(`SELECT 1 FROM agent_command_generation_owners WHERE generation_id='next-generation'`)).rowCount).toBe(0);
        expect((await f.left.query('SELECT * FROM owned_model_credentials')).rowCount).toBe(1);
        expect((await f.left.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
      } finally { release.resolve(); await Promise.allSettled([first, next].filter((work): work is NonNullable<typeof work> => work !== undefined)); await f.close(); }
    }, 20_000);
  
    it('refuses an old actor reservation promptly behind an uncommitted generation writer, before its quota hook can run', async () => {
      const f = await fixture(), held = deferred<void>(), release = deferred<void>(); let early: unknown, writer: Promise<unknown> | undefined;
      try {
        writer = f.right.transaction(async tx => {
          await tx.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='synthetic-command'`);
          held.resolve(); await release.promise;
        });
        void writer.catch(error => { early = error; held.resolve(); }); await held.promise; if (early) throw early;
        const quota = vi.fn(reserve);
        await expect(new OwnedModelAttempts(f.left, f.credentials).reserve(f.actor, ONE, payload(), quota)).rejects.toMatchObject({ code: '55P03' });
        expect(quota).not.toHaveBeenCalled(); expect((await f.left.query('SELECT * FROM owned_model_attempts')).rowCount).toBe(0);
        release.resolve(); await writer;
      } finally { release.resolve(); await Promise.allSettled(writer ? [writer] : []); await f.close(); }
    }, 20_000);
  });
});


describe("pending-attachment-deadline.postgres", () => {
  const url = serverDatabaseUrl;
  if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Attachment retention proof requires isolated loopback PostgreSQL');
  }
  describe.skipIf(!url)('Pending attachment deadline ownership', () => {
    it('uses database time and waits for a locked due row so rollback cannot silently lose retention', async () => {
      const pool = new Pool({ connectionString: url, max: 3 });
      const schema = `attachment_due_${randomUUID().replaceAll('-', '')}`;
      const owner = await pool.connect(), writer = await pool.connect();
      try {
        await owner.query(`CREATE SCHEMA ${schema}`);
        await owner.query(`SET search_path TO ${schema}`);
        await writer.query(`SET search_path TO ${schema}`);
        // Minimal concurrency fixture. Migrated-schema coverage is in data-cleanup
        // and postgres-live; the indexed-future fixture is not a rollout-cost proof.
        await owner.query(`CREATE TABLE rooms(id text PRIMARY KEY,archived_at timestamptz);
          CREATE TABLE agent_pending_attachments(id serial PRIMARY KEY,room_id text,agent_id text,request_id text,created_at timestamptz);
          CREATE TABLE agent_commands(room_id text,agent_id text,turn_request_id text,action text,state text);
          CREATE TABLE agent_turns(room_id text,agent_id text,request_id text,status text);
          INSERT INTO rooms VALUES('room',NULL);
          INSERT INTO agent_pending_attachments(room_id,agent_id,request_id,created_at)
            VALUES('room','agent','request',now()+interval '1 hour'-interval '24 hours');`);
        const source = readFileSync("apps/server/src/pending-attachment-source.ts", 'utf8');
        for (const index of source.match(/CREATE INDEX IF NOT EXISTS[^;]+;/g) ?? []) await owner.query(index);
        await owner.query(`INSERT INTO agent_pending_attachments(room_id,agent_id,request_id,created_at)
          SELECT 'room','agent','later',now()+interval '1 day' FROM generate_series(1,10000)`);
        await owner.query('ANALYZE agent_pending_attachments');
        let deadlineSql = '';
        const db = { query: (sql: string, values?: unknown[]) => {
          if (sql.includes('delay_ms')) deadlineSql = sql;
          return owner.query(sql, values);
        } } as unknown as SqlDatabase;
        const loop = new PendingAttachmentCleanupLoop(db);
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2099-01-01'));
        expect(await loop.runOnce()).toBe(0);
        const future = await loop.nextDelayMs();
        expect(future).toBeGreaterThan(3_500_000); expect(future).toBeLessThanOrEqual(3_600_000);
        const plan = (await owner.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${deadlineSql}`)).rows[0]['QUERY PLAN'][0].Plan;
        expect(JSON.stringify(plan)).toContain('agent_pending_attachments_due_idx');
        expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(60);
        await owner.query("DELETE FROM agent_pending_attachments WHERE request_id='later'");
        await owner.query("UPDATE agent_pending_attachments SET created_at=now()-interval '2 days'");
        await writer.query('BEGIN');
        await writer.query('SELECT * FROM agent_pending_attachments FOR UPDATE');
        expect(await loop.runOnce()).toBe(0);
        const pid = (await owner.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const pending = loop.nextDelayMs();
        try {
          let waiting = false;
          for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
            waiting = (await pool.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
          }
          expect(waiting).toBe(true);
        } finally { await writer.query('ROLLBACK'); }
        expect(await pending).toBe(0);
        expect(await loop.runOnce()).toBe(1);
        expect(await loop.nextDelayMs()).toBeUndefined();
      } finally {
        vi.useRealTimers();
        await writer.query('ROLLBACK');
        await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        owner.release(); writer.release(); await pool.end();
      }
    });
  });
});


describe("postgres-live", async () => {
  const AUTHOR = 'a'.repeat(64);
  const WORKSPACE = '11111111-1111-4111-8111-111111111111';
  const ROOM = '22222222-2222-4222-8222-222222222222';
  
  const DATABASE_SNAPSHOT = await (async () => {
    const database = await migratedDatabase();
    try {
      return await database.snapshot();
    } finally {
      await database.close();
    }
  })();
  
  class PgliteListenClient extends EventEmitter implements LivePgClient {
    private releases: Array<() => Promise<void>> = [];
    readonly payloads: string[] = [];
  
    constructor(private readonly database: PgliteDatabase) {
      super();
    }
  
    async connect(): Promise<void> {}
  
    async query(sql: string): Promise<void> {
      const channel = sql.slice(7);
      if (![POSTGRES_LIVE_CHANNEL, COMMAND_COMPLETION_CHANNEL].includes(channel)) throw new Error(`unexpected query: ${sql}`);
      this.releases.push(await this.database.client.listen(channel, (payload) => {
        if (channel === POSTGRES_LIVE_CHANNEL) this.payloads.push(payload);
        this.emit('notification', { channel, payload });
      }));
    }
  
    async end(): Promise<void> {
      for (const release of this.releases.splice(0)) await release();
    }
  
    async drop(): Promise<void> {
      await this.end();
      this.emit('end');
    }
  }
  
  async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await predicate()).toBe(true);
  }
  
  /** Wait until every earlier notification has reached the parent, then forget them. */
  async function settle(parent: LiveEvent[]): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    parent.length = 0;
  }
  
  /** Reads the database clock shifted by `offsetMs`, as a skewed server would. */
  class SkewedClockDatabase implements SqlDatabase {
    offsetMs = 0;
  
    constructor(private readonly database: SqlDatabase) {}
  
    query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) {
      return this.database.query<Row>(
        sql.replaceAll('now()', `(now()+interval '${this.offsetMs} milliseconds')`), values);
    }
  
    transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
      return work(this);
    }
  }
  
  describe('Postgres live fanout', () => {
    let database: PgliteDatabase;
    const listeners: PostgresLiveListener[] = [];
    const completionReleases: Array<() => void> = [];
  
    beforeEach(async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      database = PgliteDatabase.fromSnapshot(DATABASE_SNAPSHOT);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`, [
        AUTHOR,
      ]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
      await database.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,
        [ROOM, WORKSPACE, AUTHOR],
      );
    });
  
    afterEach(async () => {
      for (const release of completionReleases.splice(0)) release();
      await Promise.all(listeners.map((listener) => listener.stop()));
      await database.close();
      vi.restoreAllMocks();
    });
  
    it('DISPLAY-DEADLINE: committed deadline changes admit work; ordinary messages and rollback do not', async () => {
      const live = new LiveHub(), events: LiveEvent[] = [];
      live.subscribeAll(event => events.push(event));
      const client = new PgliteListenClient(database), listener = new PostgresLiveListener(database, live, () => client);
      const wake = vi.fn();
      completionReleases.push(subscribeCommandCompletion(DISPLAY_DEADLINE_KEY, wake));listeners.push(listener);
      void listener.run();await eventually(() => wake.mock.calls.length === 1);wake.mockClear();
      await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('deadline-source',$1,$2,'ordinary')`,[ROOM,AUTHOR]);
      await settle(events);expect(wake).not.toHaveBeenCalled();
      await database.query("UPDATE messages SET text='Please help' WHERE id='deadline-source'");
      await eventually(() => wake.mock.calls.length === 1);wake.mockClear();
      await database.query("UPDATE messages SET text='Please review' WHERE id='deadline-source'");
      await settle(events);expect(wake).not.toHaveBeenCalled();
      await expect(database.transaction(async db => {
        await db.query("UPDATE messages SET text='ordinary' WHERE id='deadline-source'");
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      await settle(events);expect(wake).not.toHaveBeenCalled();
      await database.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,first_seen_at) VALUES($1,'deadline-source',$2,now())`,[AUTHOR,WORKSPACE]);
      await eventually(() => wake.mock.calls.length === 1);wake.mockClear();
      await database.query("UPDATE messages SET text='ordinary' WHERE id='deadline-source'");
      await eventually(() => wake.mock.calls.length === 1);wake.mockClear();
      // A pre-existing metadata timestamp only becomes a deadline when its card type does.
      await database.query(`UPDATE messages SET card=jsonb_build_object('expiresAt',1234567890000) WHERE id='deadline-source'`);
      await settle(events);expect(wake).not.toHaveBeenCalled();
      await database.query("UPDATE messages SET card_type='squire-approval' WHERE id='deadline-source'");
      await eventually(() => wake.mock.calls.length === 1);
    });
  
    it('DISPLAY-IDLE: empty and failed deadline owners do no work over an idle day', async () => {
      let now = 0;
      const query = vi.fn(database.query.bind(database));
      const expiry = new DeadlineExpiry({query});
      const work = new BackgroundWork(() => now, () => {});
      work.addDeadline('display', async fresh => (await expiry.runOnce(fresh)) ?? undefined);
      expect(await work.run(true)).toBe(Infinity);
      const initial = query.mock.calls.length;
      now += 86_400_000;expect(await work.run(false)).toBe(Infinity);expect(query).toHaveBeenCalledTimes(initial);
      query.mockRejectedValueOnce(new Error('unavailable'));
      work.wake('display');await expect(work.run(false)).rejects.toThrow('unavailable');
      now += 86_400_000;expect(await work.run(false)).toBe(Infinity);expect(query).toHaveBeenCalledTimes(initial + 1);
      work.wake('display','actual-recovery');expect(await work.run(false)).toBe(Infinity);
      expect(query.mock.calls.length).toBeGreaterThan(initial + 1);
    });
  
    it('SENTRY-ELIGIBILITY: only committed recipient or triage authority changes wake a pending digest', async () => {
      const agent='b'.repeat(64);
      await database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Recipient')",[agent]);
      await database.query("INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Triage')",[SENTRY_TRIAGE_ROOM,WORKSPACE,ROOM]);
      await database.query(`INSERT INTO sentry_wake_issues(issue_id,event_type,title,level,culprit,permalink,
        first_seen,last_seen,event_count,delivery_hash) VALUES('1','issue.created','Synthetic','error','','',now(),now(),1,'hash')`);
      const live=new LiveHub(),events:LiveEvent[]=[];live.subscribeAll(event=>events.push(event));
      const client=new PgliteListenClient(database),listener=new PostgresLiveListener(database,live,()=>client),wake=vi.fn();
      completionReleases.push(subscribeCommandCompletion(sentryEligibilityKey(agent),wake));
      completionReleases.push(subscribeCommandCompletion(sentryEligibilityKey('sentry'),wake));listeners.push(listener);
      void listener.run();
      // Each exact subscription receives one recovery hint after both LISTENs.
      await eventually(()=>wake.mock.calls.length===2);wake.mockClear();
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[WORKSPACE,ROOM,agent]);
      await eventually(()=>wake.mock.calls.length===1);wake.mockClear();
      await database.query("UPDATE identities SET name='Renamed' WHERE id=$1",[agent]);
      await database.query("UPDATE rooms SET name='Renamed' WHERE id=$1",[SENTRY_TRIAGE_ROOM]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,[WORKSPACE,ROOM,AUTHOR]);
      await settle(events);expect(wake).not.toHaveBeenCalled();
      await expect(database.transaction(async db=>{
        await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[ROOM,agent]);
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      await settle(events);expect(wake).not.toHaveBeenCalled();
      await database.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[ROOM,agent]);
      await eventually(()=>wake.mock.calls.length===1);wake.mockClear();
      await database.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[SENTRY_TRIAGE_ROOM]);
      await eventually(()=>wake.mock.calls.length===1);wake.mockClear();
      await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('sentry-wait',$1,$2,'fixture')`,[SENTRY_TRIAGE_ROOM,AUTHOR]);
      await database.query(`INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,answerable,blocking)
        VALUES($1,$2,'sentry-wait',now(),true,true)`,[SENTRY_TRIAGE_ROOM,AUTHOR]);
      await eventually(()=>wake.mock.calls.length===1);wake.mockClear();
      await database.query("DELETE FROM corner_owed WHERE message_id='sentry-wait'");
      await eventually(()=>wake.mock.calls.length===1);wake.mockClear();
      await database.query('UPDATE sentry_wake_issues SET pending=false');
      await database.query('UPDATE rooms SET archived_at=NULL WHERE id=$1',[SENTRY_TRIAGE_ROOM]);
      await settle(events);expect(wake).not.toHaveBeenCalled();
    });
  
    it('ATTACHMENT-DUE-SOURCE: committed queue and eligibility changes wake privately; progress and rollback do not', async () => {
      const agent = 'b'.repeat(64);
      await database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Agent')", [agent]);
      const live = new LiveHub(), events: LiveEvent[] = [];
      live.subscribeAll(event => events.push(event));
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      const wake = vi.fn(); completionReleases.push(subscribeCommandCompletion(PENDING_ATTACHMENT_DUE_KEY, wake)); listeners.push(listener);
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      await database.query(`INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size,request_id)
        VALUES($1,$2,'/v1/media/test','test','text/plain',1,'request')`, [ROOM,agent]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      await database.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
        VALUES($1,'request',$2,'working','generation')`, [ROOM,agent]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      await database.query("UPDATE rooms SET name='Renamed' WHERE id=$1", [ROOM]);
      await database.query("UPDATE agent_pending_attachments SET name='renamed' WHERE room_id=$1", [ROOM]);
      await database.query("UPDATE agent_turns SET generation_id='replacement' WHERE room_id=$1", [ROOM]);
      await settle(events); expect(wake).not.toHaveBeenCalled();
      await expect(database.transaction(async db => {
        await db.query("UPDATE agent_turns SET status='complete' WHERE room_id=$1", [ROOM]);
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      await settle(events); expect(wake).not.toHaveBeenCalled();
      await database.query("UPDATE agent_turns SET status='complete' WHERE room_id=$1", [ROOM]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('attachment-source',$1,$2,'work')`, [ROOM,agent]);
      await database.query(`INSERT INTO agent_commands
        (id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth)
        VALUES('attachment-command',$1,$2,'attachment-source','request','input','test','attachment-command','attachment-source',0)`, [ROOM,agent]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      await database.query("UPDATE agent_commands SET reason='progress' WHERE id='attachment-command'");
      await settle(events); expect(wake).not.toHaveBeenCalled();
      await database.query("UPDATE agent_commands SET state='cancelled' WHERE id='attachment-command'");
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      await database.query("UPDATE rooms SET archived_at=now() WHERE id=$1", [ROOM]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      await database.query("DELETE FROM agent_pending_attachments WHERE room_id=$1", [ROOM]);
      await eventually(() => wake.mock.calls.length === 1);
      expect(client.payloads.some(payload => payload.includes('attachment_due'))).toBe(false);
    });
  
    it('SCHEDULE-DUE-SOURCE: only committed calendar and eligibility changes wake its private owner', async () => {
      const agent = 'b'.repeat(64), schedule = '33333333-3333-4333-8333-333333333333';
      await database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Scheduler')", [agent]);
      const live = new LiveHub(), events: LiveEvent[] = [];
      live.subscribeAll(event => events.push(event));
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      const wake = vi.fn(); completionReleases.push(subscribeCommandCompletion(AGENT_SCHEDULE_DUE_KEY, wake)); listeners.push(listener);
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      await database.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
        VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":5}','Synthetic',now()+interval '1 hour')`,
        [schedule,WORKSPACE,ROOM,agent,AUTHOR]);
      await eventually(() => wake.mock.calls.length === 1);
      await settle(events); wake.mockClear();
      await database.query("UPDATE rooms SET name='Renamed' WHERE id=$1", [ROOM]);
      await database.query("UPDATE identities SET name='Renamed' WHERE id=$1", [agent]);
      await database.query('UPDATE agent_schedules SET failed_due_at=next_run_at,failed_revision=updated_at WHERE id=$1', [schedule]);
      await settle(events); expect(wake).not.toHaveBeenCalled();
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE,ROOM,agent]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      await database.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [ROOM,agent]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      await database.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [ROOM]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      await database.query('UPDATE rooms SET archived_at=NULL WHERE id=$1', [ROOM]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      const child = '44444444-4444-4444-8444-444444444444';
      await database.query("INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Child')", [child,WORKSPACE,ROOM]);
      await database.query('UPDATE agent_schedules SET room_id=$2 WHERE id=$1', [schedule,child]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      // Child schedule access is inherited from this parent membership.
      await database.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2', [ROOM,agent]);
      await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
      await expect(database.transaction(async db => {
        await db.query("UPDATE agent_schedules SET next_run_at=next_run_at+interval '1 hour' WHERE id=$1", [schedule]);
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      await settle(events); expect(wake).not.toHaveBeenCalled();
      await database.query("UPDATE agent_schedules SET updated_at=updated_at+interval '1 second' WHERE id=$1", [schedule]);
      await eventually(() => wake.mock.calls.length === 1);
      expect(events.some(event => event.type === 'invalidate' && event.reason === 'postgres:agent_schedule_due')).toBe(false);
    });
  
    it('BRANCH-DERIVED: room archival and fact updates publish closeRequested without the retired flag', async () => {
      const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Corner')`, [corner, WORKSPACE, ROOM]);
      await database.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`, [corner]);
      const live = new LiveHub();
      const received: LiveEvent[] = [];
      live.subscribe(corner, event => received.push(event));
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      await database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]);
      await eventually(() => received.some(event => event.type === 'invalidate' && event.reason === 'postgres:rooms' && event.closeRequested === true));
      await database.query(`UPDATE corner_facts SET locked=locked WHERE corner_id=$1`, [corner]);
      await eventually(() => received.some(event => event.type === 'invalidate' && event.reason === 'postgres:corner_facts' && event.closeRequested === true));
      await database.query(`UPDATE corner_github_cache SET lifecycle=lifecycle WHERE corner_id=$1`, [corner]);
      await eventually(() => received.some(event => event.type === 'invalidate' && event.reason === 'postgres:corner_github_cache' && event.closeRequested === true));
    });
  
    it('re-arms Sentry batching on every server without publishing a Room message', async () => {
      const live = new LiveHub();
      const received: LiveEvent[] = [];
      live.subscribeAll(event => received.push(event));
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const wake = vi.fn();
      listener.setOwedWake(wake);
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      await database.query(`SELECT pg_notify($1,$2)`, [POSTGRES_LIVE_CHANNEL,
        JSON.stringify({ table: 'sentry_wake_state', operation: 'UPDATE', roomId: '' })]);
      await eventually(() => wake.mock.calls.length === 1);
      expect(wake).toHaveBeenCalledWith('sentry');
      expect(received).toEqual([]);
    });
  
    /** Open a corner under ROOM with one owed item that expires at `expiresAt`. */
    async function insertExpiringOwed(expiresAt: Date): Promise<void> {
      const corner = 'cccccccc-cccc-4ccc-8ccc-ccccccccccce';
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
        [corner, WORKSPACE, ROOM, AUTHOR],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES('owed-x',$1,$2,'question')`,
        [corner, AUTHOR]);
      await database.query(
        `INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,expires_at,answerable)
         VALUES($1,$2,'owed-x',now(),$3,true)
         ON CONFLICT (message_id,person_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
        [corner, AUTHOR, expiresAt]);
    }
  
    it('publishes owner-scoped install, vault and agent commits without an idle read', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
  
      const agent = 'b'.repeat(64);
      const connector = '33333333-3333-4333-8333-333333333333';
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')`, [agent]);
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, AUTHOR]);
      await database.query(`INSERT INTO workspace_connectors
        (id,workspace_id,owner_identity_id,connector_type,helper_agent_id)
        VALUES($1,$2,$3,'tailscale',$4)`, [connector, WORKSPACE, AUTHOR, agent]);
      await database.query(`INSERT INTO workspace_connections
        (id,connector_id,owner_identity_id,reference) VALUES($1,$2,$3,'vault-ref')`,
        ['44444444-4444-4444-8444-444444444444', connector, AUTHOR]);
      await eventually(() => ['agent', 'install', 'workbench'].every((resource) =>
        received.some((event) => event.type === 'resource-change' &&
          event.resource === resource)));
      expect(received).toContainEqual({ type: 'resource-change', roomId: '',
        ownerId: AUTHOR, resource: 'install', resourceId: connector });
      expect(received).toContainEqual({ type: 'resource-change', roomId: '',
        ownerId: AUTHOR, resource: 'workbench' });
    });
  
    it('MCP-DISCOVERY-1: committed public discovery invalidates only the requesting owner Workbench', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll(event => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      await database.transaction(async db => {
        await db.query(`INSERT INTO connector_discovery_cache(cache_key,manifests,expires_at) VALUES('search:fly','[]',now()+interval '1 minute')`);
        await db.query(`SELECT pg_notify($1,$2)`, [POSTGRES_LIVE_CHANNEL,
          JSON.stringify({ table: 'connector_discovery_cache', operation: 'UPDATE', roomId: '', ownerId: AUTHOR })]);
        expect(received.filter(event => event.type === 'resource-change')).toHaveLength(0);
      });
      await eventually(() => received.some(event => event.type === 'resource-change' && event.resource === 'workbench'));
      expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR, resource: 'workbench' });
      expect((await database.query(`SELECT cache_key FROM connector_discovery_cache`)).rows).toEqual([{ cache_key: 'search:fly' }]);
    });
  
    it('wallet-2593: committed wallet revocation invalidates only the owner Workbench', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll(event => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      await database.query(`INSERT INTO wallet_bindings(identity_id,workspace_id,cdp_user_id,eoa_address,delegation_standing)
        VALUES($1,$2,'wallet-test','0xabc',true)`, [AUTHOR, WORKSPACE]);
      await settle(received);
      await database.query(`UPDATE wallet_bindings SET delegation_standing=false,delegation_expires_at=NULL WHERE identity_id=$1`, [AUTHOR]);
      await eventually(() => received.some(event => event.type === 'resource-change' && event.resource === 'workbench'));
      expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR, resource: 'workbench' });
    });
  
    it('labels only isolated usage writes so negotiated clients can suppress broad agent reads',async()=>{
      const live=new LiveHub(),client=new PgliteListenClient(database);
      const listener=new PostgresLiveListener(database,live,()=>client);listeners.push(listener);
      const received:LiveEvent[]=[];live.subscribeAll(event=>received.push(event));void listener.run();
      await eventually(()=>listener.projectionHealth().connected);
      const agent='b'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')`,[agent]);
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,AUTHOR]);await settle(received);
      await database.query(`UPDATE agents SET usage_snapshot=$2::jsonb,updated_at=now() WHERE agent_id=$1`,[agent,JSON.stringify({updatedAt:1,windows:[]})]);
      await eventually(()=>received.some(event=>event.type==='resource-change'&&event.resourceId===agent));
      expect(received).toContainEqual(expect.objectContaining({type:'resource-change',resource:'agent',resourceId:agent,usageOnly:true}));
      await settle(received);
      await database.query(`UPDATE agents SET selected_model='different-model',usage_snapshot=$2::jsonb,updated_at=now() WHERE agent_id=$1`,[agent,JSON.stringify({updatedAt:2,windows:[]})]);
      await eventually(()=>received.some(event=>event.type==='resource-change'&&event.resourceId===agent));
      expect(received.find(event=>event.type==='resource-change'&&event.resourceId===agent)).not.toHaveProperty('usageOnly');
    });
  
    it('publishes account usage only to matching owner-bound agents and ignores metadata-only writes',async()=>{
      const live=new LiveHub(),client=new PgliteListenClient(database);
      const listener=new PostgresLiveListener(database,live,()=>client);listeners.push(listener);
      const received:LiveEvent[]=[];live.subscribeAll(event=>received.push(event));void listener.run();
      await eventually(()=>listener.projectionHealth().connected);
      const first='b'.repeat(64),second='c'.repeat(64),foreign='d'.repeat(64),otherOwner='e'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','First'),($2,'agent','Second'),($3,'agent','Foreign'),($4,'human','Other')`,[first,second,foreign,otherOwner]);
      const account=(await database.query<{id:string}>(`INSERT INTO usage_accounts(owner_id,provider,account_key,usage)
        VALUES($1,'openai','synthetic-account','{"updatedAt":1,"windows":[]}'::jsonb) RETURNING id::text`,[AUTHOR])).rows[0]!.id;
      await database.query(`INSERT INTO agents(agent_id,owner_id,usage_account_id) VALUES($1,$4,$5::bigint),($2,$4,$5::bigint),($3,$6,$5::bigint)`,[first,second,foreign,AUTHOR,account,otherOwner]);
      await settle(received);
      const before=client.payloads.filter(raw=>JSON.parse(raw).table==='usage_accounts').length;
      await database.query(`UPDATE usage_accounts SET updated_at=now() WHERE id=$1::bigint`,[account]);await settle(received);
      expect(client.payloads.filter(raw=>JSON.parse(raw).table==='usage_accounts')).toHaveLength(before);
      await database.query(`UPDATE usage_accounts SET usage='{"updatedAt":2,"windows":[]}'::jsonb,updated_at=now() WHERE id=$1::bigint`,[account]);
      await eventually(()=>received.filter(event=>event.type==='resource-change'&&event.usageOnly).length===2);
      const changes=received.filter(event=>event.type==='resource-change');
      expect(changes).toEqual([
        {type:'resource-change',roomId:'',ownerId:AUTHOR,resource:'agent',resourceId:first,usageOnly:true},
        {type:'resource-change',roomId:'',ownerId:AUTHOR,resource:'agent',resourceId:second,usageOnly:true},
      ]);
      const payload=client.payloads.map(raw=>JSON.parse(raw)).reverse().find(item=>item.table==='usage_accounts');
      expect(payload).toMatchObject({ownerId:AUTHOR,accountId:account});expect(payload).not.toHaveProperty('usage');
    });
  
    it('publishes machine broker reports and sign-in progress to the owner surfaces', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => listener.projectionHealth().connected);
      const agent = 'b'.repeat(64);
      await database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')", [agent]);
      await database.query("INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'machine')",
        [agent, AUTHOR]);
      await settle(received);
      await database.query("UPDATE agents SET squire_report=$2::jsonb,squire_work=$3::jsonb WHERE agent_id=$1",
        [agent, JSON.stringify({ status: 'error', errorMessage: 'Squire broker unavailable', reportedAt: 1 }),
          JSON.stringify({ generation: 1, install: true, steps: [] })]);
      await eventually(() => received.some((event) => event.type === 'resource-change' && event.resource === 'workbench')
        && received.some((event) => event.type === 'resource-change' && event.resource === 'install'));
      expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR, resource: 'workbench' });
      expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR,
        resource: 'install', resourceId: 'squire:machine' });
    });
  
    it('names a Workspace header or identity change by id, and only to who shares it', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const events: LiveEvent[] = [];
      live.subscribeAll((event) => events.push(event));
      void listener.run();
      await eventually(() => listener.projectionHealth().connected);
  
      const workspaceMate = 'c'.repeat(64);
      const roomMate = 'd'.repeat(64);
      const outsider = 'e'.repeat(64);
      const otherWorkspace = '55555555-5555-4555-8555-555555555555';
      const otherRoom = '66666666-6666-4666-8666-666666666666';
      for (const [id, name] of [[workspaceMate, 'Mate'], [roomMate, 'Guest'], [outsider, 'Outsider']])
        await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$2)`, [id, name]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Elsewhere')`, [otherWorkspace]);
      await database.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Shared')`,
        [otherRoom, otherWorkspace, roomMate],
      );
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
        ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),
        ($2,NULL,$5,'owner'),($2,NULL,$6,'member'),($2,$7,$5,'owner'),($2,$7,$3,'member')`,
        [WORKSPACE, otherWorkspace, AUTHOR, workspaceMate, roomMate, outsider, otherRoom]);
  
      await database.query(`UPDATE workspaces SET about='no header change' WHERE id=$1`, [WORKSPACE]);
      await database.query(`UPDATE identities SET welcome_cards_due=false WHERE id=$1`, [AUTHOR]);
      await database.query(`UPDATE workspaces SET name='Renamed' WHERE id=$1`, [WORKSPACE]);
      await database.query(`UPDATE identities SET name='Author Two' WHERE id=$1`, [AUTHOR]);
      await eventually(() => events.some((event) =>
        event.type === 'invalidate' && event.reason === 'postgres:identities'));
      const changes = events.filter((event) => event.type === 'invalidate' &&
        (event.reason === 'postgres:workspaces' || event.reason === 'postgres:identities'));
      expect(changes).toEqual([
        { type: 'invalidate', roomId: '', reason: 'postgres:workspaces', workspaceId: WORKSPACE },
        { type: 'invalidate', roomId: '', reason: 'postgres:identities', personId: AUTHOR },
      ]);
  
      const phone = new PhoneService(database, 'http://local.test');
      const workspace = await phone.liveWorkspaceChange(WORKSPACE);
      expect(workspace?.workspace).toEqual({ id: WORKSPACE, name: 'Renamed' });
      expect([...workspace!.viewers].sort()).toEqual([AUTHOR, workspaceMate].sort());
  
      const person = await phone.livePersonChange(AUTHOR);
      expect(person?.person).toEqual({ pubkey: AUTHOR, kind: 'human', name: 'Author Two' });
      expect(person?.pushLevel).toBe('attention');
      expect([...person!.viewers].sort()).toEqual([AUTHOR, workspaceMate, roomMate].sort());
      // A viewer who shares no Workspace or Room with the person never hears it.
      expect(person!.viewers.has(outsider)).toBe(false);
  
      await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [workspaceMate]);
      expect((await phone.livePersonChange(AUTHOR))!.viewers.has(workspaceMate)).toBe(false);
      expect((await phone.liveWorkspaceChange(WORKSPACE))!.viewers.has(workspaceMate)).toBe(false);
    });
  
    it('wakes push only after message and device writes commit', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const wake = vi.fn();
      listener.setPushWake(wake);
      void listener.run();
      await eventually(() => listener.projectionHealth().connected);
      await eventually(() => wake.mock.calls.length === 1);
      wake.mockClear();
      await database.transaction(async (db) => {
        await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment)
          VALUES('push-wake-device',$1,'ios','physical')`, [AUTHOR]);
        await db.query(`INSERT INTO messages(id,room_id,author_id,text)
          VALUES('push-wake-message',$1,$2,'hello')`, [ROOM, AUTHOR]);
        expect(wake).not.toHaveBeenCalled();
      });
      await eventually(() => wake.mock.calls.length === 2);
      await database.query(`INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
        VALUES($1,$2,now(),'push-wake-message')`, [ROOM, AUTHOR]);
      expect(wake).toHaveBeenCalledTimes(2);
    });
  
    it('wakes AI-client webhook delivery only when a tag commits', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const wake = vi.fn();
      listener.setMcpWebhookWake(wake);
      void listener.run();
      await eventually(() => listener.projectionHealth().connected);
      await database.transaction(async (db) => {
        await db.query(`SELECT pg_notify($1,$2)`, [POSTGRES_LIVE_CHANNEL,
          JSON.stringify({ table: MCP_WEBHOOK_TABLE, operation: 'INSERT', roomId: ROOM })]);
        expect(wake).not.toHaveBeenCalled();
      });
      await eventually(() => wake.mock.calls.length === 1);
    });
  
    it('fans out one committed helper release without a follow-up read', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const events: LiveEvent[] = [];
      live.subscribeAll((event) => events.push(event));
      void listener.run();
      await eventually(() => listener.projectionHealth().connected);
      const query = vi.spyOn(database, 'query');
      await database.query(`INSERT INTO helper_release_notifications(singleton,version,sha)
        VALUES(true,'v0.0.128',$1)`, ['a'.repeat(40)]);
      await eventually(() => events.some((event) => event.type === 'helper-release'));
      expect(events.filter((event) => event.type === 'helper-release')).toEqual([{
        type: 'helper-release',
        version: 'v0.0.128', sha: 'a'.repeat(40),
      }]);
      expect(query).toHaveBeenCalledTimes(1);
    });
  
    it('delivers read-mark changes to the listener with the reader identity', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const events: LiveEvent[] = [];
      const release = live.subscribe(ROOM, (event) => events.push(event));
      void listener.run();
      await eventually(() => listener.projectionHealth().connected);
      await database.query(
        `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
         VALUES($1,$2,now(),$3)`,
        [ROOM, AUTHOR, 'a'.repeat(64)],
      );
      await eventually(() => events.some((event) =>
        event.type === 'invalidate' && event.reason === 'postgres:room_read_marks'));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'invalidate', roomId: ROOM, readerId: AUTHOR,
      }));
      release();
      await listener.stop();
    });
  
    it('routes a bookmark change to its owner without broadcasting its content', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const events: LiveEvent[] = [];
      live.subscribeAll((event) => events.push(event));
      void listener.run();
      await eventually(() => listener.projectionHealth().connected);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text)
        VALUES('saved-message',$1,$2,'private content')`, [ROOM, AUTHOR]);
      await database.query(`INSERT INTO message_bookmarks(
        identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,
        message_created_at
      ) SELECT $1,$2,$3,id,'Room','room',created_at FROM messages WHERE id='saved-message'`,
      [AUTHOR, WORKSPACE, ROOM]);
      await eventually(() => events.some((event) => event.type === 'invalidate' &&
        event.reason === 'postgres:message_bookmarks'));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'invalidate', roomId: '', reason: 'postgres:message_bookmarks',
        readerId: AUTHOR, workspaceId: WORKSPACE, messageId: 'saved-message',
      }));
      expect(client.payloads.find((payload) => payload.includes('message_bookmarks')))
        .not.toContain('private content');
    });
  
    it('coalesces a section clear into one Needs-you wake per Room', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const events: LiveEvent[] = [];
      live.subscribeAll((event) => events.push(event));
      void listener.run();
      await eventually(() => listener.projectionHealth().connected);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text)
        VALUES('ask-one',$1,$2,'@author please review?'),
          ('ask-two',$1,$2,'@author please approve?')`, [ROOM, AUTHOR]);
      await database.transaction(async (db) => {
        await db.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at)
          VALUES($1,'ask-one',$2,now()),($1,'ask-two',$2,now())`, [AUTHOR, WORKSPACE]);
      });
      await eventually(() => events.some((event) => event.type === 'invalidate' &&
        event.reason === 'postgres:needs_you_marks'));
      expect(events.filter((event) => event.type === 'invalidate' &&
        event.reason === 'postgres:needs_you_marks')).toEqual([
        expect.objectContaining({ roomId: '', readerId: AUTHOR, sourceRoomId: ROOM }),
      ]);
      expect(client.payloads.filter((payload) => payload.includes('needs_you_marks')))
        .toHaveLength(1);
    });
  
    it('bounds notification DB projections and coalesces a repeated repository wake', async () => {
      let releaseReads!: () => void;
      const readBarrier = new Promise<void>((resolve) => { releaseReads = resolve; });
      let active = 0;
      let peak = 0;
      let repositoryReads = 0;
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM rooms WHERE repository_key')) {
          active++;
          peak = Math.max(peak, active);
          await readBarrier;
          active--;
          repositoryReads++;
        }
        return { rows: [], rowCount: 0 };
      });
      const client = new EventEmitter() as EventEmitter & LivePgClient;
      let listening = false;
      client.connect = async () => undefined;
      client.query = async () => { listening = true; };
      client.end = async () => { client.emit('end'); };
      const live = new LiveHub();
      const listener = new PostgresLiveListener(
        { query, transaction: vi.fn() }, live, () => client,
      );
      listeners.push(listener);
      const running = listener.run();
      await eventually(() => listening);
      for (let index = 0; index < 15; index++)
        client.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({
          table: 'github_repositories', operation: 'UPDATE', roomId: ROOM,
          repositoryId: String(index),
        }) });
      expect(listener.projectionHealth()).toMatchObject({
        connected: true, active: 2, queued: 13, delivered: 0, failed: 0,
      });
      expect(listener.projectionHealth().oldestActiveAgeMs).not.toBeNull();
      expect(listener.projectionHealth().oldestQueuedAgeMs).not.toBeNull();
      client.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({
        table: 'github_repositories', operation: 'UPDATE', roomId: ROOM, repositoryId: '5',
      }) });
      expect(listener.projectionHealth().queued).toBe(13);
      releaseReads();
      await eventually(() => repositoryReads === 15);
      expect(peak).toBe(2);
      expect(listener.projectionHealth()).toMatchObject({
        active: 0, queued: 0, dropped: 0, delivered: 15, failed: 0,
        oldestActiveAgeMs: null, oldestQueuedAgeMs: null,
      });
      const health = listener.projectionHealth();
      expect(health.lastNotificationAt).not.toBeNull();
      expect(health.lastDeliveredAt).toBeGreaterThanOrEqual(health.lastNotificationAt!);
      expect(health.lastDeliveryAgeMs).not.toBeNull();
      expect(listener.projectionHealth().deliveryAgeBuckets.reduce((sum, count) => sum + count, 0))
        .toBe(15);
      await listener.stop();
      await running;
      expect(listener.projectionHealth().connected).toBe(false);
    });
  
    it('sends one recovery resync after a saturated notification backlog drains', async () => {
      let releaseReads!: () => void;
      const readBarrier = new Promise<void>((resolve) => { releaseReads = resolve; });
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM rooms WHERE repository_key')) await readBarrier;
        return { rows: [], rowCount: 0 };
      });
      const client = new EventEmitter() as EventEmitter & LivePgClient;
      let listening = false;
      client.connect = async () => undefined;
      client.query = async () => { listening = true; };
      client.end = async () => { client.emit('end'); };
      const live = new LiveHub();
      const resync = vi.fn();
      live.subscribeResync(resync);
      const listener = new PostgresLiveListener(
        { query, transaction: vi.fn() }, live, () => client,
      );
      listeners.push(listener);
      const running = listener.run();
      await eventually(() => listening && resync.mock.calls.length === 1);
      resync.mockClear();
      for (let index = 0; index < 520; index++)
        client.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({
          table: 'github_repositories', operation: 'UPDATE', roomId: ROOM,
          repositoryId: String(index),
        }) });
      expect(listener.projectionHealth()).toMatchObject({
        active: 2, queued: 512, dropped: 6, resyncPending: true,
      });
      releaseReads();
      await eventually(() => listener.projectionHealth().active === 0 &&
        listener.projectionHealth().queued === 0);
      expect(resync).toHaveBeenCalledOnce();
      await listener.stop();
      await running;
    });
  
    it('fans a committed write from server A to a subscriber on server B', async () => {
      const liveA = new LiveHub();
      const liveB = new LiveHub();
      const clientsA: PgliteListenClient[] = [];
      const clientsB: PgliteListenClient[] = [];
      const listenerA = new PostgresLiveListener(
        database,
        liveA,
        () => {
          const client = new PgliteListenClient(database);
          clientsA.push(client);
          return client;
        },
      );
      const listenerB = new PostgresLiveListener(
        database,
        liveB,
        () => {
          const client = new PgliteListenClient(database);
          clientsB.push(client);
          return client;
        },
      );
      listeners.push(listenerA, listenerB);
      void listenerA.run();
      void listenerB.run();
      await eventually(() => clientsA.length === 1 && clientsB.length === 1);
  
      const received: LiveEvent[] = [];
      liveB.subscribe(ROOM, (event) => received.push(event));
      // Every successful LISTEN (including its first) now resyncs to recover a
      // delivery written before the listener was ready. Let that connection
      // establishment event settle before verifying the next committed write.
      await eventually(() =>
        received.some((event) => event.type === 'invalidate' && event.reason === 'resync'),
      );
      received.length = 0;
      await database.transaction(async (transaction) => {
        await transaction.query(
          `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'hello')`,
          ['1'.repeat(64), ROOM, AUTHOR],
        );
        expect(received).toEqual([]);
      });
  
      await eventually(() => received.length === 1);
      expect(received).toEqual([
        expect.objectContaining({
          type: 'invalidate',
          roomId: ROOM,
          agentId: AUTHOR,
          messageId: '1'.repeat(64),
        }),
      ]);
      expect(clientsB[0]!.payloads).toHaveLength(1);
      expect(JSON.parse(clientsB[0]!.payloads[0]!)).toEqual(
        expect.objectContaining({
          table: 'messages',
          operation: 'INSERT',
          roomId: ROOM,
          messageId: '1'.repeat(64),
          agentId: AUTHOR,
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
          databaseAt: expect.any(Number),
        }),
      );
      expect(received[0]).toEqual(
        expect.objectContaining({
          trace: expect.objectContaining({
            id: expect.stringMatching(/^[0-9a-f]{32}$/),
            databaseAt: expect.any(Number),
            emittedAt: expect.any(Number),
          }),
        }),
      );
      expect(clientsB[0]!.payloads[0]).not.toContain('hello');
    });
  
    it('publishes room-scoped message and turn notifications without a database lookup', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const query = vi.fn(database.query.bind(database));
      const listener = new PostgresLiveListener(
        { query, transaction: database.transaction.bind(database) },
        live,
        () => client,
      );
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribe(ROOM, (event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      received.length = 0;
      query.mockClear();
  
      for (const table of ['messages', 'agent_turns']) {
        client.emit('notification', {
          channel: POSTGRES_LIVE_CHANNEL,
          payload: JSON.stringify({
            table,
            operation: table === 'messages' ? 'INSERT' : 'UPDATE',
            roomId: ROOM,
            agentId: AUTHOR,
            ...(table === 'messages' ? { messageId: 'message-id' } : { requestId: 'request-id' }),
          }),
        });
      }
  
      await eventually(() => received.length === 2);
      expect(query).not.toHaveBeenCalled();
      expect(received.map((event) => event.type === 'invalidate' && event.reason)).toEqual([
        'postgres:messages',
        'postgres:agent_turns',
      ]);
      expect(received).toEqual([
        expect.objectContaining({ messageId: 'message-id' }),
        expect.objectContaining({ requestId: 'request-id' }),
      ]);
    });
  
    it('relays a newer helper connection epoch to every other server instance', async () => {
      const agent = 'f'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      received.length = 0;
  
      // Server A accepts the connection against its own hub; B learns through PostgreSQL.
      const epoch = await claimAgentConnection(database, new LiveHub(), agent, { lifecycleId: 'life' }, {
        connectionId: 'connection-a', instanceId: 'server-a',
      });
      await eventually(() => received.some((event) => event.type === 'agent-connection'));
      expect(received.filter((event) => event.type === 'agent-connection')).toEqual([
        { type: 'agent-connection', roomId: '', agentId: agent, epoch },
      ]);
    });
  
    it('delivers a membership change as an agent-directed invalidation', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      received.length = 0;
  
      const freshRoom = '99999999-9999-4999-8999-999999999999';
      await database.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'milo')`,
        [freshRoom, WORKSPACE, AUTHOR],
      );
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WORKSPACE, freshRoom, AUTHOR],
      );
  
      await eventually(() =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'postgres:memberships' &&
            event.targetAgentId === AUTHOR &&
            event.roomId === freshRoom,
        ),
      );
    });
  
    it('carries exact Workspace and identity on committed membership insert, revoke and deletion', async () => {
      // Install this trigger revision explicitly; the root owns production markers.
      await database.query((await postgresLiveSchema()));
      const live = new LiveHub(), client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener); const received: LiveEvent[] = [];
      live.subscribeAll(event => received.push(event)); void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      const changes = () => received.filter(event => event.type === 'invalidate' && event.reason === 'postgres:memberships' &&
        event.roomId === '' && event.workspaceId === WORKSPACE && event.readerId === AUTHOR && event.targetAgentId === AUTHOR);
      await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, AUTHOR]);
      await eventually(() => changes().length === 1);
      await database.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`, [WORKSPACE, AUTHOR]);
      await eventually(() => changes().length === 2);
      await database.query(`DELETE FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`, [WORKSPACE, AUTHOR]);
      await eventually(() => changes().length === 3);
      expect(client.payloads.map(value => JSON.parse(value)).filter(value => value.table === 'memberships'))
        .toEqual(expect.arrayContaining(['INSERT','UPDATE','DELETE'].map(operation => expect.objectContaining({
          operation, workspaceId: WORKSPACE, identityId: AUTHOR, roomId: '',
        }))));
    });
  
    it('pushes an expired Registry OAuth attempt when its server clock ends', async () => {
      const helper = 'b'.repeat(64);
      const connector = '55555555-5555-4555-8555-555555555555';
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')`, [helper]);
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [helper, AUTHOR]);
      await database.query(
        `INSERT INTO workspace_connectors(
          id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,status,
          registry_server_name,registry_version,registry_manifest,display_name)
         VALUES($1,$2,$3,'registry-mcp',$4,$4,'installing','app.linear/linear','1.0.1',
           $5::jsonb,'Linear')`,
        [connector, WORKSPACE, AUTHOR, helper,
          JSON.stringify({ name: 'app.linear/linear', version: '1.0.1' })],
      );
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      await database.query(
        `INSERT INTO registry_mcp_oauth_attempts(state,connector_id,expires_at)
         VALUES('registry-expiry-test',$1,now()+interval '100 milliseconds')`,
        [connector],
      );
      await eventually(() => received.some((event) => event.type === 'invalidate' &&
        event.reason === 'connector-assignment' && event.targetAgentId === helper));
    });
  
    it('names the parent Room and corner opener on a sparse corner preference invalidate', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      received.length = 0;
  
      const corner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
        [corner, WORKSPACE, ROOM, AUTHOR],
      );
  
  
      await database.query(`INSERT INTO corner_person_state(corner_id,identity_id,subscriptions_overridden) VALUES($1,$2,true)`,[corner,AUTHOR]);
      await eventually(() =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'postgres:memberships' &&
            event.targetAgentId === AUTHOR &&
            event.roomId === corner &&
            event.parentRoomId === ROOM &&
            event.openedBy === AUTHOR &&
            event.removed !== true,
        ),
      );
  
      // Preference invalidations retain the current corner metadata.
      const opener = 'b'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [opener]);
      await insertCornerFacts(database, { cornerId: corner, ownerAgentId: opener });
      received.length = 0;
      await database.query(`INSERT INTO corner_person_state(corner_id,identity_id,subscriptions_overridden) VALUES($1,$2,true)`,[corner,opener]);
      await eventually(() =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'postgres:memberships' &&
            event.targetAgentId === opener &&
            event.openedBy === opener &&
            event.archived !== true,
        ),
      );
  
      // An existing archived corner still identifies itself on a preference change.
      await database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]);
      const latecomer = 'c'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Cee')`, [
        latecomer,
      ]);
      received.length = 0;
  
  
      await database.query(`INSERT INTO corner_person_state(corner_id,identity_id,subscriptions_overridden) VALUES($1,$2,true)`,[corner,latecomer]);
      await eventually(() =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'postgres:memberships' &&
            event.targetAgentId === latecomer &&
            event.archived === true,
        ),
      );
    });
  
    it('names the parent Room and opener on a queued command for a corner this helper never watched', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
  
      const corner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const target = 'c'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Cee')`, [
        target,
      ]);
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
        [corner, WORKSPACE, ROOM, AUTHOR],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES('tag-source',$1,$2,'@cee fix this')`,
        [corner, AUTHOR],
      );
      received.length = 0;
  
      await database.query(
        `INSERT INTO agent_commands(
           id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
           root_command_id,root_source_message_id,agent_depth
         ) VALUES($1,$2,$3,'tag-source',$4,'input','agent_tag',$1,'tag-source',0)`,
        ['command-1', corner, target, 'f'.repeat(64)],
      );
  
      await eventually(() =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'postgres:agent_commands' &&
            event.targetAgentId === target &&
            event.roomId === corner &&
            event.parentRoomId === ROOM &&
            event.openedBy === AUTHOR,
        ),
      );
    });
  
    it('marks a command released only when it leaves claimed', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
  
      const worker = 'c'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Cee')`, [
        worker,
      ]);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES('work-source',$1,$2,'@cee work')`,
        [ROOM, AUTHOR],
      );
      const commandEvents = () =>
        received.filter(
          (event) => event.type === 'invalidate' && event.reason === 'postgres:agent_commands',
        );
      await database.query(
        `INSERT INTO agent_commands(
           id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
           root_command_id,root_source_message_id,agent_depth
         ) VALUES($1,$2,$3,'work-source',$4,'input','human_tag',$1,'work-source',0)`,
        ['work-1', ROOM, worker, 'f'.repeat(64)],
      );
      await database.query(
        `UPDATE agent_commands SET state='claimed',lease_expires_at=now()+interval '90 seconds' WHERE id='work-1'`,
      );
      await database.query(
        `UPDATE agent_commands SET lease_expires_at=now()+interval '120 seconds' WHERE id='work-1'`,
      );
      await eventually(() => commandEvents().length === 3);
      expect(commandEvents().some((event) => event.type === 'invalidate' && event.commandReleased))
        .toBe(false);
  
      await database.query(`UPDATE agent_commands SET state='complete' WHERE id='work-1'`);
      await eventually(() => commandEvents().length === 4);
      expect(commandEvents()[3]).toMatchObject({ targetAgentId: worker, commandReleased: true });
    });
  
    it('nudges the parent Room only when a corner status input changes', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const parent: LiveEvent[] = [];
      live.subscribe(ROOM, (event) => parent.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
  
      const corner = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const agent = 'e'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
        [corner, WORKSPACE, ROOM, AUTHOR],
      );
      await insertCornerFacts(database, { cornerId: corner, ownerAgentId: agent });
      const nudges = () =>
        parent.filter((event) => event.type === 'invalidate' && event.reason === 'corner-status');
      await settle(parent);
  
      await database.query(
        `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'r1',$2,'working')`,
        [corner, agent],
      );
      await eventually(() => nudges().length === 1);
      // A heartbeat that only restamps the running turn changes no status.
      await database.query(
        `UPDATE agent_turns SET created_at=now() WHERE room_id=$1 AND request_id='r1'`,
        [corner],
      );
      await database.query(
        `UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND request_id='r1'`,
        [corner],
      );
      await eventually(() => nudges().length === 2);
      await database.query(
        `UPDATE corner_github_cache SET lifecycle='{"lifecycle":"pr-open","checks":"pending"}'::jsonb
         WHERE corner_id=$1`,
        [corner],
      );
      await eventually(() => nudges().length === 3);
      // An approval waiting inside the corner is the parent Room's needs-you dot.
      await database.query(
        `INSERT INTO permission_authority(room_id,permission_id,principal_id,request_id,scope,status)
         VALUES($1,'perm-1',$2,'r1','{}'::jsonb,'pending')`,
        [corner, agent],
      );
      await eventually(() => nudges().length === 4);
      await database.query(
        `UPDATE permission_authority SET status='authorized' WHERE room_id=$1`,
        [corner],
      );
      await eventually(() => nudges().length === 5);
      // A top-level Room's own turn has no parent to nudge.
      await database.query(
        `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'r2',$2,'working')`,
        [ROOM, agent],
      );
      await eventually(() =>
        parent.some(
          (event) => event.type === 'invalidate' && event.reason === 'postgres:agent_turns',
        ),
      );
      expect(nudges()).toHaveLength(5);
      expect(nudges()).toEqual(
        Array(5).fill({ type: 'invalidate', roomId: ROOM, reason: 'corner-status' }),
      );
    });
  
    it('OBJECTIVE-BRIEF: emits corner-text for opening objectives and latest brief inserts/edits', async () => {
      const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const agent = 'e'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Worker')`,[agent]);
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,AUTHOR]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'member')`,[WORKSPACE,ROOM,agent]);
      await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
        VALUES($1,$2,$3,$4,'Goal')`,[corner,WORKSPACE,ROOM,AUTHOR]);
      const live = new LiveHub(), client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database,live,()=>client);
      listeners.push(listener);
      const parent: LiveEvent[] = [];
      live.subscribe(ROOM,event=>parent.push(event));
      void listener.run();
      await eventually(()=>client.listenerCount('notification')===1);
      const textChanged = () => parent.some(event=>event.type==='invalidate' && event.reason==='corner-text');
      const opening = await createAgentCommand(database,{roomId:corner,agentId:agent,sourceMessageId:null,
        reason:'corner_objective',privatePayload:{text:'Authorized order',objective:'Opening goal',authorId:AUTHOR,fromRoomId:ROOM,kind:'order'}});
      expect(opening).toBeDefined();
      await eventually(textChanged);
      await settle(parent);
      await database.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{objective}','"Edited goal"') WHERE id=$1`,[opening!.id]);
      await eventually(textChanged);
      await settle(parent);
      await database.query(`INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
        VALUES($1,1,'Approved scope','Brief goal',$2,$3)`,[corner,AUTHOR,ROOM]);
      await eventually(textChanged);
      await settle(parent);
      await database.query(`UPDATE corner_brief_revisions SET objective='Current goal' WHERE corner_id=$1`,[corner]);
      await eventually(textChanged);
      await settle(parent);
      await database.query(`INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
        VALUES($1,2,'New approved scope','New goal',$2,$3)`,[corner,AUTHOR,ROOM]);
      await eventually(textChanged);
      await settle(parent);
      await database.query(`UPDATE corner_brief_revisions SET objective='Historical goal' WHERE corner_id=$1 AND revision=1`,[corner]);
      await database.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{objective}','"Historical opening"') WHERE id=$1`,[opening!.id]);
      await settle([]);
      expect(textChanged()).toBe(false);
      expect(client.payloads.map(payload=>JSON.parse(payload)).filter(payload=>payload.cornerTextChanged))
        .toEqual(expect.arrayContaining([expect.objectContaining({table:'agent_commands'}),expect.objectContaining({table:'corner_brief_revisions'})]));
    });
  
    it('nudges the parent Room for every projected corner-row change', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const parent: LiveEvent[] = [];
      live.subscribe(ROOM, (event) => parent.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      const nudges = () =>
        parent.filter((event) => event.type === 'invalidate' && event.reason === 'corner-status');
  
      const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const agent = 'e'.repeat(64);
      const reader = 'f'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader')`, [reader]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`,[WORKSPACE,ROOM,agent,reader]);
      // A new corner is a new row in its parent's list.
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
        [corner, WORKSPACE, ROOM, AUTHOR],
      );
      await eventually(() => nudges().length >= 1);
      await insertCornerFacts(database, { cornerId: corner, ownerAgentId: agent });
      await settle(parent);
  
      const expectNudge = async (write: () => Promise<unknown>) => {
        await settle(parent);
        await write();
        await eventually(() => nudges().length >= 1);
      };
  
      await expectNudge(() => createAgentCommand(database, {
        id: 'queued-state-proof', roomId: corner, agentId: agent, sourceMessageId: null,
        reason: 'order', privatePayload: { text: 'Continue', kind: 'order', authorId: AUTHOR, fromRoomId: ROOM },
      }));
      await expectNudge(() => database.query(`UPDATE agent_commands SET state='complete' WHERE id='queued-state-proof'`));
      // A person's tag assigns the worker through its command, not a column.
      await expectNudge(() => assignCornerWorker(database, corner, agent));
      await expectNudge(() => database.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,standing)
        VALUES($1,$2,'owner')`, [corner,reader]));
      await expectNudge(() => database.query(`UPDATE corner_merge_holds SET released_at=now(),released_by=$2
        WHERE corner_id=$1`, [corner,reader]));
      // A review verdict or ask_human writes only a run card.
      await expectNudge(() => recordCornerRun(database, corner, 'review'));
      await expectNudge(() => recordCornerRun(database, corner, 'ask_human'));
      await expectNudge(() => database.query(
        `INSERT INTO corner_follows(corner_id,identity_id) VALUES($1,$2)`, [corner, reader]));
      await expectNudge(() => database.query(
        `DELETE FROM corner_follows WHERE corner_id=$1 AND identity_id=$2`, [corner, reader]));
      await expectNudge(() => database.query(
        `INSERT INTO corner_person_state(corner_id,identity_id,subscriptions_overridden) VALUES($1,$2,true)`,
        [corner,reader]));
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES('owed-1',$1,$2,'question')`,
        [corner, agent]);
      await expectNudge(() => database.query(
        `INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,expires_at,answerable)
         VALUES($1,$2,'owed-1',now(),now()+interval '1 hour',true)
         ON CONFLICT (message_id,person_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
        [corner, reader]));
      const textNudges = () => parent.filter(event => event.type === 'invalidate' && event.reason === 'corner-text');
      const priorTitleNudges = textNudges().length;
      await expectNudge(() => database.query(`UPDATE rooms SET name='renamed' WHERE id=$1`, [corner]));
      await eventually(() => textNudges().length > priorTitleNudges);
      await expectNudge(() => database.query(
        `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
        [ROOM, reader]));
      await expectNudge(() => database.query(
        `UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]));
  
      // Every other projected column: objective, initiator, row stamp,
      // brief revision and the newest chat message.
      const priorGoalNudges = textNudges().length;
      await expectNudge(() => database.query(
        `INSERT INTO corner_brief_revisions(corner_id,revision,content,objective,author_id,source_room_id)
         VALUES($1,1,'brief','still fix it',$2,$3)`, [corner,agent,ROOM]));
      await eventually(() => textNudges().length > priorGoalNudges);
      await expectNudge(() => database.query(`UPDATE rooms SET updated_at=now() WHERE id=$1`, [corner]));
      expect(textNudges()).toHaveLength(0);
      await expectNudge(() => seedCornerOpening(database, {
        cornerId: corner, agentId: agent, commissionedBy: reader,
      }));
      await expectNudge(() => database.query(`UPDATE rooms SET updated_at=now() WHERE id=$1`, [corner]));
      await expectNudge(() => database.query(
        `INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
         VALUES($1,2,'brief',$2,$3)`, [corner, agent, ROOM]));
      await expectNudge(() => database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES('latest-1',$1,$2,'done')`,
        [corner, agent]));
      await expectNudge(() => database.query(
        `UPDATE messages SET text='done, edited' WHERE id='latest-1'`));
      await expectNudge(() => database.query(
        `UPDATE messages SET presentation='activity' WHERE id='latest-1'`));
  
      // A write that changes no corner-row column stays off the parent.
      await settle(parent);
      await database.query(`UPDATE corner_facts SET locked=locked WHERE corner_id=$1`, [corner]);
      await database.query(
        `UPDATE rooms SET repository_updated_at=now() WHERE id=$1`, [corner]);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES('step-1',$1,$2,'step','activity')`,
        [corner, agent]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(nudges()).toEqual([]);
    });
  
    it('nudges the parent Room on every server machine, whichever one wrote', async () => {
      const machines = [new LiveHub(), new LiveHub()];
      const parents: LiveEvent[][] = [[], []];
      for (const [index, live] of machines.entries()) {
        const client = new PgliteListenClient(database);
        const listener = new PostgresLiveListener(database, live, () => client);
        listeners.push(listener);
        live.subscribe(ROOM, (event) => parents[index]!.push(event));
        void listener.run();
        await eventually(() => client.listenerCount('notification') === 1);
      }
      const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccf';
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
        [corner, WORKSPACE, ROOM, AUTHOR],
      );
      await settle(parents[0]!);
      await settle(parents[1]!);
      // Neither machine publishes in-process: only the committed rename runs.
      await database.query(`UPDATE rooms SET name='renamed' WHERE id=$1`, [corner]);
      for (const parent of parents)
        await eventually(() => parent.some((event) =>
          event.type === 'invalidate' && event.reason === 'corner-status'));
    });
  
    it('delivers one parent nudge for an owed refresh that rewrites many rows', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
      const agent = 'e'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
        [corner, WORKSPACE, ROOM, AUTHOR],
      );
      for (const id of ['owed-a', 'owed-b', 'owed-c'])
        await database.query(
          `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'question')`,
          [id, corner, agent]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      client.payloads.length = 0;
      await database.transaction(async (db) => {
        await db.query(`DELETE FROM corner_owed WHERE corner_id=$1`, [corner]);
        for (const id of ['owed-a', 'owed-b', 'owed-c'])
          await db.query(
            `INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,answerable)
             VALUES($1,$2,$3,now(),true)`,
            [corner, AUTHOR, id]);
      });
      await eventually(() => client.payloads.some((raw) => raw.includes('"corner_owed"')));
      expect(client.payloads.filter((raw) => raw.includes('"corner_owed"'))).toHaveLength(1);
    });
  
    it('nudges the parent Room on every machine when the leader sees an owed item expire', async () => {
      const machines = [new LiveHub(), new LiveHub()];
      const parents: LiveEvent[][] = [[], []];
      const wakes = [0, 0];
      for (const [index, live] of machines.entries()) {
        const client = new PgliteListenClient(database);
        const listener = new PostgresLiveListener(database, live, () => client);
        listener.setOwedWake(() => { wakes[index]! += 1; });
        listeners.push(listener);
        live.subscribe(ROOM, (event) => parents[index]!.push(event));
        void listener.run();
        await eventually(() => client.listenerCount('notification') === 1);
      }
      const expiresAt = new Date(Date.now() + 60_000);
      await insertExpiringOwed(expiresAt);
      // A new owed row wakes the leader so it can re-arm for the new deadline.
      await eventually(() => wakes.every((count) => count >= 1));
      const clock = new SkewedClockDatabase(database);
      const expiry = new DeadlineExpiry(clock);
      expect(await expiry.runOnce(true)).toBeGreaterThan(50_000);
      await settle(parents[0]!);
      await settle(parents[1]!);
  
      // No write happens at expiry: only the leader's job announces it.
      clock.offsetMs = 60_000;
      await expiry.runOnce();
      for (const parent of parents)
        await eventually(() => parent.some((event) =>
          event.type === 'invalidate' && event.reason === 'corner-status'));
      // The same expiry is announced once per leader.
      clock.offsetMs = 61_000;
      await settle(parents[0]!);
      await expiry.runOnce();
      expect(parents[0]).toEqual([]);
    });
  
    it('decides an owed expiry by the database clock when the app clock runs ahead', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const parent: LiveEvent[] = [];
      live.subscribe(ROOM, (event) => parent.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      const expiresAt = new Date(Date.now() + 60_000);
      await insertExpiringOwed(expiresAt);
      // PGlite reads the JS clock, so the database is held back to stay put
      // while the app clock jumps ten minutes past the expiry.
      const skewMs = 10 * 60_000;
      const clock = new SkewedClockDatabase(database);
      clock.offsetMs = -skewMs;
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      try {
        vi.setSystemTime(Date.now() + skewMs);
        expect(Date.now()).toBeGreaterThan(expiresAt.getTime());
        const expiry = new DeadlineExpiry(clock);
        expect(await expiry.runOnce(true)).toBeGreaterThan(50_000);
        await settle(parent);
        await expiry.runOnce();
        expect(parent).toEqual([]);
  
        // The database reaches the expiry: announced once, then never again.
        clock.offsetMs = -skewMs + 60_000;
        await expiry.runOnce();
        await eventually(() => parent.some((event) =>
          event.type === 'invalidate' && event.reason === 'corner-status'));
        clock.offsetMs = -skewMs + 61_000;
        await settle(parent);
        await expiry.runOnce();
        expect(parent).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  
    it('leaves a top-level Room membership without a corner opener', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      received.length = 0;
  
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WORKSPACE, ROOM, AUTHOR],
      );
  
      await eventually(() =>
        received.some(
          (event) => event.type === 'invalidate' && event.reason === 'postgres:memberships',
        ),
      );
      expect(
        received.filter((event) => event.type === 'invalidate' && event.openedBy !== undefined),
      ).toEqual([]);
    });
  
    it('delivers a connector-assignment wake without a catalog', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      received.length = 0;
  
      await notifyConnectorAssignment(database, AUTHOR);
  
      await eventually(
        () =>
          received.some(
            (event) =>
              event.type === 'invalidate' &&
              event.reason === 'connector-assignment' &&
              event.targetAgentId === AUTHOR,
          ),
      );
    });
  
    it('delivers a Squire machine-grant wake as an agent-config invalidation', async () => {
      const agent = 'b'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'member')`,
        [WORKSPACE, ROOM, agent],
      );
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      received.length = 0;
  
      await notifyAgentConfigChange(database, agent, WORKSPACE);
  
      await eventually(
        () =>
          received.some(
            (event) =>
              event.type === 'invalidate' &&
              event.reason === 'agent-config' &&
              event.targetAgentId === agent &&
              event.roomId === ROOM,
          ),
      );
    });
  
    it('delivers a phone-side model/effort change as an agent-config invalidation', async () => {
      const live = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client);
      listeners.push(listener);
      const received: LiveEvent[] = [];
      live.subscribeAll((event) => received.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
      received.length = 0;
  
      // PhoneService.updateAgentModel writes this synthetic payload directly
      // inside the selection transaction — the agents table has no Room for a
      // row trigger, so the wake rides the same pg_notify channel.
      await database.query(`SELECT pg_notify($1, $2)`, [
        POSTGRES_LIVE_CHANNEL,
        JSON.stringify({ table: 'agent_config', operation: 'UPDATE', roomId: ROOM, agentId: AUTHOR }),
      ]);
  
      await eventually(
        () =>
          received.some(
            (event) =>
              event.type === 'invalidate' &&
              event.reason === 'agent-config' &&
              event.targetAgentId === AUTHOR &&
              event.roomId === ROOM,
          ),
      );
    });
  
    it('fans an agent presence fact to every joined Room on another server', async () => {
      const otherRoom = '33333333-3333-4333-8333-333333333333';
      const agent = 'b'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other')`, [
        otherRoom,
        WORKSPACE,
      ]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$4,'member'),($1,$3,$4,'member')`,
        [WORKSPACE, ROOM, otherRoom, agent],
      );
      const liveB = new LiveHub();
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, liveB, () => client);
      listeners.push(listener);
      void listener.run();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await announceAgentLifecycle(database, new LiveHub(), ROOM, agent, { lifecycleId: 'boot' });
      await eventually(() => liveB.latestAgentPresence(agent, ROOM)?.status === 'online');
      expect(liveB.latestAgentPresence(agent, otherRoom)?.status).toBe('online');
      await announceAgentLifecycle(database, new LiveHub(), otherRoom, agent, {
        lifecycleId: 'boot',
      });
      await eventually(() => liveB.latestAgentPresence(agent, otherRoom)?.status === 'online');
      const presenceRows = await database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM live_outputs
         WHERE agent_id=$1 AND kind='presence'`,
        [agent],
      );
      expect(presenceRows.rows[0]?.count).toBe('1');
      await database.query(
        `UPDATE live_outputs SET body=body || jsonb_build_object(
        'status','offline','observedAt',(body->>'observedAt')::bigint+1) WHERE agent_id=$1`,
        [agent],
      );
      await eventually(() => liveB.latestAgentPresence(agent, otherRoom)?.status === 'offline');
      expect(liveB.latestAgentPresence(agent, ROOM)?.status).toBe('offline');
    });
  
    it('fans one canonical presence notification across thirty Rooms on each listener', async () => {
      const agent = 'b'.repeat(64);
      const roomIds = Array.from(
        { length: 30 },
        (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      );
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
      for (const roomId of roomIds) {
        await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Load')`, [
          roomId,
          WORKSPACE,
        ]);
        await database.query(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
           VALUES($1,$2,$3,'member')`,
          [WORKSPACE, roomId, agent],
        );
      }
      for (const roomId of roomIds)
        await database.query(
          `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
           VALUES($1,$2,'presence','presence',$3::jsonb)`,
          [
            roomId,
            agent,
            JSON.stringify({
              status: 'online',
              observedAt: 1,
              evidenceNonce: 'before',
              lifecycleId: 'boot',
            }),
          ],
        );
      const queryA = vi.fn(database.query.bind(database));
      const queryB = vi.fn(database.query.bind(database));
      const liveA = new LiveHub();
      const liveB = new LiveHub();
      const clientA = new PgliteListenClient(database);
      const clientB = new PgliteListenClient(database);
      const listenerA = new PostgresLiveListener(
        { query: queryA, transaction: database.transaction.bind(database) },
        liveA,
        () => clientA,
      );
      const listenerB = new PostgresLiveListener(
        { query: queryB, transaction: database.transaction.bind(database) },
        liveB,
        () => clientB,
      );
      listeners.push(listenerA, listenerB);
      void listenerA.run();
      void listenerB.run();
      await eventually(() => queryA.mock.calls.length > 0 && queryB.mock.calls.length > 0);
      queryA.mockClear();
      queryB.mockClear();
  
      const publishA = vi.spyOn(liveA, 'publish');
      const publishB = vi.spyOn(liveB, 'publish');
      const evidence = new ConnectionPresence(database, new LiveHub());
      await evidence.evidence(roomIds[0], agent);
  
      await eventually(
        () =>
          liveA.latestAgentPresence(agent, roomIds[0])?.status === 'online' &&
          liveB.latestAgentPresence(agent, roomIds[0])?.status === 'online',
      );
      await evidence.stop();
      const stored = await database.query<{ body: { evidenceNonce?: string } }>(
        `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
        [agent],
      );
      expect(stored.rows.filter((row) => row.body.evidenceNonce !== 'before')).toHaveLength(1);
      expect(clientA.payloads).toHaveLength(1);
      expect(clientB.payloads).toHaveLength(1);
      expect(queryA).toHaveBeenCalledTimes(1);
      expect(queryB).toHaveBeenCalledTimes(1);
      for (const query of [queryA.mock.calls[0]?.[0], queryB.mock.calls[0]?.[0]]) {
        expect(query).toContain('SELECT membership.room_id,presence.body');
        expect(query?.match(/SELECT body FROM live_outputs/g)).toHaveLength(1);
      }
      expect(publishA).toHaveBeenCalledTimes(roomIds.length);
      expect(publishB).toHaveBeenCalledTimes(roomIds.length);
      expect([...queryA.mock.calls, ...queryB.mock.calls].map(([sql]) => sql)).toContainEqual(
        expect.stringContaining('room_access'),
      );
      for (const roomId of roomIds) {
        expect(liveA.latestAgentPresence(agent, roomId)?.status).toBe('online');
        expect(liveB.latestAgentPresence(agent, roomId)?.status).toBe('online');
      }
    });
  
    it('rehydrates a missed delivery deadline when its first LISTEN connection opens', async () => {
      const agent = 'b'.repeat(64);
      const live = new LiveHub();
      const presence = new ConnectionPresence(database, live, 50);
      await database.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Bee','bee')`,
        [agent],
      );
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, AUTHOR]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [WORKSPACE, ROOM, AUTHOR, agent],
      );
      try {
        await presence.start();
        await presence.announce(ROOM, agent, { lifecycleId: 'boot' });
        await database.query(
          `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@bee Are you there?')`,
          ['2'.repeat(64), ROOM, AUTHOR],
        );
        const client = new PgliteListenClient(database);
        const listener = new PostgresLiveListener(database, live, () => client);
        listeners.push(listener);
        void listener.run();
        await eventually(async () => {
          const row = await database.query<{ body: { status: string } }>(
            `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
            [agent],
          );
          return row.rows[0]?.body.status === 'offline';
        });
      } finally {
        await presence.stop();
      }
    });
  
    it('broadcasts resync after its listener connection is restored', async () => {
      const live = new LiveHub();
      const clients: PgliteListenClient[] = [];
      let reconnect!: () => void;
      const reconnectReady = new Promise<void>(resolve => { reconnect = resolve; });
      const listener = new PostgresLiveListener(
        database,
        live,
        () => {
          const client = new PgliteListenClient(database);
          if (clients.length) client.connect = () => reconnectReady;
          clients.push(client);
          return client;
        },
      );
      listeners.push(listener);
      void listener.run();
      await eventually(() => listener.projectionHealth().connected);
  
      const received: LiveEvent[] = [];
      const recovered: string[] = [];
      live.subscribe(ROOM, (event) => {
        received.push(event);
        if (event.type === 'invalidate' && event.reason === 'resync') {
          void database
            .query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 ORDER BY id`, [ROOM])
            .then((rows) => recovered.push(...rows.rows.map((row) => row.id)));
        }
      });
      await clients[0]!.drop();
      const missedId = '2'.repeat(64);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'while down')`,
        [missedId, ROOM, AUTHOR],
      );
      reconnect();
      await eventually(() => clients.length === 2);
      await eventually(() => received.some((event) => event.type === 'invalidate'));
      await eventually(() => recovered.includes(missedId));
  
      expect(received).toContainEqual({ type: 'invalidate', roomId: ROOM, reason: 'resync' });
      expect(recovered).toContain(missedId);
    });
  });
});


describe("push-outbox", () => {
  const person = 'a'.repeat(64), author = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  async function setup(db: SqlDatabase) {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle,push_level)
      VALUES($1,'human','Owner','owner','full'),($2,'human','Peer','peer','full')`, [person, author]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [workspace, room, person, author]);
    await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
      VALUES('proof-device',$1,'android','physical',now()-interval '1 day')`, [person]);
    await db.query(`INSERT INTO push_delivery_floors(id,started_at)
      VALUES('message-delivery',now()-interval '1 day')`);
  }
  async function post(db: SqlDatabase, id: string) {
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner hello')`, [id, room, author]);
  }
  
  it('rolls back fanout with the message, backfills cutover once, and honors old claims', async () => {
    const db = new PgliteDatabase();
    try {
      await setup(db);
      await expect(db.transaction(async tx => {
        await post(tx, 'rolled-back');
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(0);
      await post(db, 'old-delivered');
      await post(db, 'old-pending');
      await post(db, 'old-retry');
      await post(db, 'old-failed');
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner')`, [workspace, person]);
      await db.query(`INSERT INTO workspace_join_notifications(id,workspace_id,room_id,joining_identity_id,text)
        VALUES('join-pending',$1,$2,$3,'Peer joined'),('join-delivered',$1,$2,$3,'Peer joined')`,
        [workspace, room, author]);
      await db.query(`INSERT INTO workspace_join_notification_devices(notification_id,device_token)
        VALUES('join-pending','proof-device'),('join-delivered','proof-device')`);
      await db.query(`DELETE FROM push_outbox`);
      await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status)
        VALUES('old-delivered','proof-device','delivered'),('join-delivered','proof-device','delivered'),
          ('old-failed','proof-device','failed')`);
      await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,attempts,next_retry_at)
        VALUES('old-retry','proof-device','retryable',2,now()+interval '1 minute')`);
      await backfillPushOutbox(db);
      await backfillPushOutbox(db);
      expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(6);
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(2);
      expect(send.mock.calls.map(([, message]) => message.messageId).sort()).toEqual(['join-pending','old-pending']);
      expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(0);
      await db.query(`UPDATE push_delivery_claims SET next_retry_at=now()-interval '1 second'
        WHERE message_id='old-retry'`);
      expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(1);
      expect((await db.query(`SELECT status,attempts FROM push_delivery_claims WHERE message_id='old-retry'`)).rows)
        .toEqual([{ status: 'delivered', attempts: 3 }]);
    } finally { await db.close(); }
  });
  
  it('recovers a leased entry after restart and a claim abandoned before provider send', async () => {
    const db = new PgliteDatabase();
    try {
      await setup(db);
      await post(db, 'abandoned');
      await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,claimed_at)
        VALUES('abandoned','proof-device','claimed',now()-interval '2 minutes')`);
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(1);
      expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(0);
      expect(send).toHaveBeenCalledOnce();
    } finally { await db.close(); }
  });
  
  const postgresUrl = serverDatabaseUrl;
  if (postgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(postgresUrl).hostname))
    throw new Error('push proofs require isolated loopback PostgreSQL');
  
  describe.skipIf(!postgresUrl)('R-PUSH-SCAN-LOCK', () => {
    it('delivers under load while messages ACCESS EXCLUSIVE is acquired without migration retries', async () => {
      const schema = `push_proof_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: postgresUrl, max: 1 });
      await admin.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`);
      await admin.query(`CREATE SCHEMA ${schema}`);
      const config = postgresPoolConfig(postgresUrl!, 2, 'long-running');
      config.options = `${config.options} -c search_path=${schema},public`;
      const jobs = new PostgresDatabase('', 2, { mode: 'long-running', pool: new Pool(config) });
      const owner = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
        connectionString: postgresUrl, max: 1, options: `-c search_path=${schema},public -c lock_timeout=1000ms`,
      }) });
      let running: Promise<number> | undefined;
      let releaseSend: (() => void) | undefined;
      try {
        await setup(owner);
        expect((await jobs.query(`SHOW statement_timeout`)).rows[0]!.statement_timeout).toBe('2s');
        expect((await jobs.query(`SHOW lock_timeout`)).rows[0]!.lock_timeout).toBe('500ms');
        // This history predates both outbox and replay cutover. Seed it without
        // fanout or source journals; fresh messages below exercise every trigger.
        await owner.query(`ALTER TABLE messages DISABLE TRIGGER USER`);
        await owner.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
          SELECT 'history-'||n,$1,$2,repeat('@owner historical message ',100),now()-interval '1 day'
          FROM generate_series(1,50000) n`, [room, author]);
        await owner.query(`ALTER TABLE messages ENABLE TRIGGER USER`);
        await owner.query(`INSERT INTO messages(id,room_id,author_id,text)
          SELECT 'fresh-'||n,$1,$2,'@owner fresh' FROM generate_series(1,300) n`, [room, author]);
        // Negative control matches the long-held ACCESS SHARE incident. No retries.
        const legacy = await admin.connect();
        try {
          await legacy.query('BEGIN');
          await legacy.query(`SELECT id FROM ${schema}.messages LIMIT 1`);
          await expect(owner.transaction(async tx => {
            await tx.query(`LOCK TABLE messages IN ACCESS EXCLUSIVE MODE`);
          })).rejects.toMatchObject({ code: '55P03' });
        } finally { await legacy.query('ROLLBACK'); legacy.release(); }
        let startedSend!: () => void;
        const sending = new Promise<void>(resolve => { releaseSend = resolve; });
        const started = new Promise<void>(resolve => { startedSend = resolve; });
        const send = vi.fn(async () => { startedSend(); await sending; });
        const loop = new PushDeliveryLoop(jobs, { send });
        const candidateQueries: {sql: string; values?: unknown[]}[] = [];
        const transaction = jobs.transaction.bind(jobs);
        vi.spyOn(jobs,'transaction').mockImplementation(async work => transaction(async tx => {
          const query = vi.spyOn(tx,'query');
          try { return await work(tx); }
          finally { for (const [sql,values] of query.mock.calls)
            if (sql.includes('FROM unclaimed')) candidateQueries.push({sql,values}); }
        }));
        running = loop.runOnce();
        await Promise.race([started, running.then(() => { throw new Error("no delivery started"); })]);
        const lockDurations: number[] = [];
        for (let n = 0; n < 20; n++) {
          const began = Date.now();
          await owner.transaction(async tx => { await tx.query(`LOCK TABLE messages IN ACCESS EXCLUSIVE MODE`); });
          lockDurations.push(Date.now() - began);
          releaseSend!();
        }
        expect(Math.max(...lockDurations)).toBeLessThan(1000);
        console.info(`R-PUSH-SCAN-LOCK: 300 deliveries; 20 locks; max lock handoff ${Math.max(...lockDurations)}ms`);
        expect(await running).toBe(300);
        expect(send).toHaveBeenCalledTimes(300);
        const candidate = candidateQueries[0]!;
        const explain = await jobs.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${candidate.sql}`, candidate.values);
        const visit = (node: Record<string, unknown>) => {
          if (node['Relation Name'] === 'messages') {
            expect(node['Node Type']).not.toBe('Seq Scan');
            expect(String(node['Index Cond'] ?? node['Recheck Cond'])).toMatch(/\bid\b/);
          }
          for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
        };
        visit((explain.rows[0]!['QUERY PLAN'] as { Plan: Record<string, unknown> }[])[0]!.Plan);
      } finally {
        releaseSend?.();
        await running?.catch(() => undefined);
        await jobs.close(); await owner.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
      }
    }, 120_000);
  });
  
  it('R-PUSH-BACKLOG: delivers a DM behind ineligible notes and drops expired rows', async () => {
    const db = new PgliteDatabase();
    try {
      await setup(db);
      await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`, [person]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type)
        SELECT 'noise-'||n,$1,$2,'GitHub check updated','system','github-corner-note'
        FROM generate_series(1,200) n`, [room, author]);
      // Seed rows left by the previous enqueue policy, even after new writes are filtered.
      await db.query(`INSERT INTO push_outbox(message_id,device_token,expires_at)
        SELECT id,'proof-device',created_at+interval '1 hour' FROM messages WHERE id LIKE 'noise-%'
        ON CONFLICT DO NOTHING`);
      await db.query(`UPDATE push_outbox SET not_before=now()-interval '2 minutes'`);
      await db.query(`INSERT INTO push_outbox(message_id,device_token,not_before,expires_at)
        SELECT 'expired-'||n,'proof-device',now()-interval '3 minutes',now()-interval '1 second'
        FROM generate_series(1,1100) n`);
      const dm = '33333333-3333-4333-8333-333333333333';
      await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants)
        VALUES($1,$2,'DM',$3::jsonb)`, [dm, workspace, JSON.stringify([person,author])]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`, [workspace,dm,person,author]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('fresh-dm',$1,$2,'Hello from your DM')`, [dm,author]);
      const send = vi.fn().mockResolvedValue(undefined);
      const signal = vi.spyOn(sentry,'captureServerError').mockImplementation(()=>{});
      const began = performance.now();
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(1);
      expect(await loop.runOnce()).toBe(0);
      expect(signal).toHaveBeenCalledOnce();
      expect(signal).toHaveBeenCalledWith(expect.any(Error),{background_job:'push',signal:'push-outbox-backlog'});
      signal.mockRestore();
      const elapsed = performance.now() - began;
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith('proof-device',expect.objectContaining({ messageId:'fresh-dm',title:'@peer' }));
      expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(0);
      expect((await db.query(`SELECT reason,count(*)::int count FROM push_outbox_retirements GROUP BY reason ORDER BY reason`)).rows)
        .toEqual([{reason:'expired',count:1100},{reason:'ineligible',count:200}]);
      // Retirement evidence must not suppress an edit that becomes deliverable.
      await db.query(`UPDATE messages SET text='@owner please read',presentation='message',card_type=NULL WHERE id='noise-1'`);
      expect(await loop.runOnce()).toBe(1);
      expect(send).toHaveBeenLastCalledWith('proof-device',expect.objectContaining({messageId:'noise-1'}));
      console.info(`R-PUSH-BACKLOG: discarded 1300 rows, delivered DM; ${(1301/(elapsed/1000)).toFixed(1)} rows/sec (${elapsed.toFixed(1)} ms), local provider stand-in`);
    } finally { await db.close(); }
  });
  
  it('batches suppression with parity for mute, live view, server lease and both read rules', async () => {
    const db = new PgliteDatabase();
    try {
      await setup(db);
      const names = ['muted','view','lease','recent','read','stale'];
      for (const name of names) {
        const id = createHash('sha256').update(name).digest('hex');
        await db.query(`INSERT INTO identities(id,kind,name,handle,push_level) VALUES($1,'human',$2,$2,'full')`,[id,name]);
        await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[workspace,room,id]);
        await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
          VALUES($1,$2,'android','physical',now()-interval '1 day')`,[name,id]);
      }
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('batch',$1,$2,'Untargeted full-mode prose')`,[room,author]);
      await db.query(`UPDATE memberships SET push_muted=true WHERE identity_id=$1`,[createHash('sha256').update('muted').digest('hex')]);
      await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('alive')`);
      await db.query(`INSERT INTO room_push_views(room_id,identity_id,session_id,instance_id,expires_at)
        VALUES($1,$2,'view',NULL,now()+interval '1 minute'),
          ($1,$3,'lease','alive',now()-interval '1 minute'),
          ($1,$4,'stale','gone',now()-interval '1 minute')`,
        [room,createHash('sha256').update('view').digest('hex'),createHash('sha256').update('lease').digest('hex'),createHash('sha256').update('stale').digest('hex')]);
      await db.query(`INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id,updated_at)
        SELECT $1::uuid,$2::text,now()-interval '1 day','older',now()
        UNION ALL SELECT $1::uuid,$3::text,created_at,id,now()-interval '1 minute' FROM messages WHERE id='batch'`,
        [room,createHash('sha256').update('recent').digest('hex'),createHash('sha256').update('read').digest('hex')]);
      const sqls: string[] = [];
      const transaction = db.transaction.bind(db);
      vi.spyOn(db,'transaction').mockImplementation(async work => transaction(async tx => {
        const query = vi.spyOn(tx,'query');
        try { return await work(tx); }
        finally { sqls.push(...query.mock.calls.map(([sql])=>sql)); }
      }));
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await new PushDeliveryLoop(db,{send}).runOnce()).toBe(2);
      expect(send.mock.calls.map(([token])=>token).sort()).toEqual(['proof-device','stale']);
      expect((await db.query(`SELECT device_token FROM push_delivery_claims WHERE status='suppressed' ORDER BY device_token`)).rows
        .map(row=>row.device_token)).toEqual(['lease','muted','read','recent','view']);
      expect(sqls.filter(sql=>sql.includes('SELECT candidate.message_id,candidate.token'))).toHaveLength(1);
    } finally { await db.close(); }
  });
  
  it('does not enqueue cards the delivery policy unconditionally excludes', async () => {
    const db = new PgliteDatabase();
    try {
      await setup(db);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type)
        VALUES('excluded',$1,$2,'Order reference','card','agent-command')`,[room,author]);
      expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(0);
    } finally { await db.close(); }
  });
  
  
  it('does not send a claim that expires while waiting for provider capacity', async () => {
    const db = new PgliteDatabase();
    try {
      await setup(db);
      await post(db,'expires-before-send');
      const query = db.query.bind(db);
      const future = Date.now()+2*60*60*1000;
      vi.spyOn(db,'query').mockImplementation(async (sql,values) => {
        const result = await query(sql,values);
        if (sql.includes('INSERT INTO push_delivery_claims AS claim'))
          vi.spyOn(Date,'now').mockReturnValue(future);
        return result;
      });
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await new PushDeliveryLoop(db,{send}).runOnce()).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect((await query(`SELECT status,error FROM push_delivery_claims WHERE message_id='expires-before-send'`)).rows)
        .toEqual([{status:'failed',error:'Push expired before provider send'}]);
      expect((await query(`SELECT * FROM push_outbox`)).rows).toHaveLength(0);
    } finally { vi.restoreAllMocks(); await db.close(); }
  });
  
  it('preserves the old selector delivery set and retires only rows it would never select', async () => {
    const db = new PgliteDatabase();
    try {
      await setup(db);
      const full = 'c'.repeat(64), off = 'd'.repeat(64), agent = 'e'.repeat(64);
      await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`,[person]);
      await db.query(`INSERT INTO identities(id,kind,name,handle,push_level)
        VALUES($1,'human','Full','full','full'),($2,'human','Off','off','off'),
          ($3,'agent','Agent','agent','attention')`,[full,off,agent]);
      for (const id of [full,off,agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'member')`,[workspace,room,id]);
      await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
        VALUES('full-device',$1,'android','physical',now()-interval '1 day'),
          ('off-device',$2,'android','physical',now()-interval '1 day')`,[full,off]);
      const dm = '33333333-3333-4333-8333-333333333333';
      await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants)
        VALUES($1,$2,'DM',$3::jsonb)`,[dm,workspace,JSON.stringify([person,author])]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`,[workspace,dm,person,author]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('reply-source',$1,$2,'Earlier owner message')`,[room,person]);
      const cases = [
        {id:'github-note',presentation:'system',cardType:'github-corner-note'},
        {id:'github-reply',presentation:'system',cardType:'github-corner-note',reply:'reply-source'},
        {id:'command',presentation:'card',cardType:'agent-command'},
        {id:'plain',text:'Untargeted prose'},
        {id:'tag',text:'@owner Please look'},
        {id:'quoted-tag',text:'`@owner` is quoted'},
        {id:'choice',presentation:'card',cardType:'choice',card:{mode:'question',mentionIds:[person]}},
        {id:'multi-choice',presentation:'card',cardType:'choice',card:{mode:'question',mentionIds:[person,full]}},
        {id:'closed-choice',presentation:'card',cardType:'choice',card:{mode:'question',status:'closed',mentionIds:[person]}},
        {id:'offline',presentation:'card',cardType:'machine-offline',card:{status:'open',ownerId:person}},
        {id:'retired-merge',presentation:'card',cardType:'corner-merge-yes',text:'@owner merged'},
        {id:'relay',presentation:'card',cardType:'relay',card:{direction:'up'}},
        {id:'automatic',presentation:'card',cardType:'grant-auto'},
        {id:'dm',channel:dm},
        {id:'dm-note',channel:dm,presentation:'system',cardType:'github-corner-note'},
        {id:'retry'},
        {id:'claimed'},
      ];
      for (const row of cases) await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,reply_to_message_id)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[row.id,row.channel??room,author,row.text??'Unaddressed update',
          row.presentation??'message',row.cardType??null,JSON.stringify(row.card??null),row.reply??null]);
      await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'working-turn',$2,'working')`,[room,agent]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,request_id)
        VALUES('working',$1,$2,'@owner final answer','working-turn')`,[room,agent]);
      for (const id of [person,full,off]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'member')`,[workspace,id]);
      await db.query(`INSERT INTO workspace_join_notifications(id,workspace_id,room_id,joining_identity_id,text)
        VALUES('join-parity',$1,$2,$3,'Peer joined')`,[workspace,room,author]);
      await db.query(`INSERT INTO workspace_join_notification_devices(notification_id,device_token)
        VALUES('join-parity','proof-device'),('join-parity','full-device'),('join-parity','off-device')`);
      const key = (message: string,token: string) => JSON.stringify([message,token]);
      const queued = async () => (await db.query<{message_id:string;device_token:string}>(`SELECT message_id,device_token FROM push_outbox`)).rows;
      const newlyQueued = new Set((await queued()).map(row=>key(row.message_id,row.device_token)));
      for (const id of ['github-note','command','multi-choice','closed-choice','retired-merge','relay','automatic','dm-note'])
        expect([...newlyQueued].some(value=>JSON.parse(value)[0]===id),id).toBe(false);
      expect(newlyQueued.has(key('github-reply','proof-device'))).toBe(true);
      // Recreate all old fanout rows and context, including those new writes omit.
      await db.query(`INSERT INTO push_message_context(message_id,room_id,author_id,request_id,turn_ids,burst_ids,expires_at)
        SELECT id,room_id,author_id,request_id,ARRAY[id],ARRAY[id],created_at+interval '1 hour' FROM messages
        ON CONFLICT DO NOTHING`);
      await db.query(`INSERT INTO push_outbox(message_id,device_token,expires_at)
        SELECT m.id,device.token,m.created_at+interval '1 hour' FROM messages m
        JOIN room_access member ON member.room_id=m.room_id AND member.removed_at IS NULL AND member.identity_id<>m.author_id
        JOIN push_devices device ON device.identity_id=member.identity_id ON CONFLICT DO NOTHING`);
      await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,next_retry_at)
        VALUES('retry','proof-device','retryable',now()+interval '5 minutes')`);
      await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status)
        VALUES('claimed','proof-device','claimed')`);
      // The frozen selection read two corner columns that are now derived from the opening order.
      const legacySql = (await readFile("apps/server/src/test-fixtures/push-selection-before-backlog.sql",'utf8'))
        .replaceAll('finished.commissioned_by', cornerCommissionerSql('finished.corner_id'))
        .replaceAll('finished.owner_agent_id', cornerOwnerSql('finished.corner_id'));
      const before = await queued();
      const eligible = async (rows: typeof before) => new Set((await db.query<{message_id:string;token:string}>(legacySql,
        [JSON.stringify(rows)])).rows.map(row=>key(row.message_id,row.token)));
      const oldEligible = await eligible(before);
      expect(oldEligible.size).toBeGreaterThan(0);
      for (const value of oldEligible) expect(newlyQueued.has(value),`enqueue removed old-eligible ${value}`).toBe(true);
      const sent: string[] = [];
      const loop = new PushDeliveryLoop(db,{send:async (token,message)=>{sent.push(key(message.messageId,token));}});
      await loop.runOnce();
      expect(new Set(sent)).toEqual(oldEligible);
      const after = new Set((await queued()).map(row=>key(row.message_id,row.device_token)));
      const claims = new Set((await db.query<{message_id:string;device_token:string}>(`SELECT message_id,device_token FROM push_delivery_claims`))
        .rows.map(row=>key(row.message_id,row.device_token)));
      const retired = before.map(row=>key(row.message_id,row.device_token)).filter(value=>!after.has(value)&&!claims.has(value));
      expect(retired.length).toBeGreaterThan(0);
      for (const value of retired) expect(oldEligible.has(value),`retired old-eligible ${value}`).toBe(false);
      // Retained preferences and working turns can still become deliverable.
      expect(after.has(key('plain','proof-device'))).toBe(true);
      expect(after.has(key('working','proof-device'))).toBe(true);
      expect(after.has(key('retry','proof-device'))).toBe(true);
      expect(after.has(key('claimed','proof-device'))).toBe(true);
      expect(after.has(key('join-parity','proof-device'))).toBe(true);
      await db.query(`UPDATE identities SET push_level='full' WHERE id IN ($1,$2)`,[person,off]);
      await db.query(`UPDATE agent_turns SET status='complete' WHERE request_id='working-turn'`);
      const oldEligibleAfterChange = await eligible(await queued());
      sent.length=0;
      await loop.runOnce();
      expect(new Set(sent)).toEqual(oldEligibleAfterChange);
      expect(sent).toContain(key('plain','proof-device'));
      expect(sent).toContain(key('working','proof-device'));
      expect(sent).toContain(key('join-parity','proof-device'));
      console.info(`Legacy parity: ${oldEligible.size} initial deliveries preserved; ${retired.length} ineligible rows retired; ${sent.length} preference/turn deliveries preserved`);
    } finally { await db.close(); }
  });
  
  
  it('BEELINE-SERVER-17: parks preference backlog until a preference change or expiry', async () => {
    const db = new PgliteDatabase();
    try {
      await setup(db);
      await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`, [person]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text)
        SELECT 'preference-'||n,$1,$2,'Ordinary room conversation' FROM generate_series(1,1100) n`, [room,author]);
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db,{send});
      await loop.runOnce();
      await loop.runOnce();
      expect(send).not.toHaveBeenCalled();
      expect((await db.query(`SELECT * FROM push_outbox WHERE not_before<>expires_at`)).rows).toHaveLength(0);
      expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(1100);
      await post(db,'direct-attention');
      expect(await loop.runOnce()).toBe(1);
      expect(send).toHaveBeenCalledWith('proof-device',expect.objectContaining({messageId:'direct-attention'}));
      // Changing preferences wakes the retained prose without waiting for expiry.
      await db.query(`UPDATE identities SET push_level='full' WHERE id=$1`,[person]);
      expect((await db.query(`SELECT * FROM push_outbox WHERE not_before<=now()`)).rows).toHaveLength(1100);
      await loop.runOnce();
      await loop.runOnce();
      expect(send.mock.calls.some(([,message])=>message.messageId.startsWith('preference-'))).toBe(true);
      await db.query(`UPDATE identities SET push_level='off' WHERE id=$1`,[person]);
      await post(db,'off-expiry');
      await loop.runOnce();
      expect((await db.query(`SELECT * FROM push_outbox WHERE message_id='off-expiry' AND not_before=expires_at`)).rows).toHaveLength(1);
      await db.query(`UPDATE push_outbox SET expires_at=now()-interval '1 second' WHERE message_id='off-expiry'`);
      await loop.runOnce();
      expect((await db.query(`SELECT reason FROM push_outbox_retirements WHERE message_id='off-expiry'`)).rows)
        .toEqual([{reason:'expired'}]);
      expect(send.mock.calls.some(([,message])=>message.messageId==='off-expiry')).toBe(false);
    } finally { await db.close(); }
  });
  
  it('keeps disabled-platform retries and a preference wake concurrent with parking', async () => {
    const db = new PgliteDatabase();
    try {
      await setup(db);
      await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`,[person]);
      await db.query(`UPDATE push_devices SET platform='ios' WHERE token='proof-device'`);
      await post(db,'disabled-ios');
      const send = vi.fn().mockResolvedValue(undefined);
      await new PushDeliveryLoop(db,{send}).runOnce();
      expect((await db.query(`SELECT * FROM push_outbox WHERE not_before<expires_at`)).rows).toHaveLength(1);
      await db.query(`UPDATE identities SET push_level='off' WHERE id=$1`,[person]);
      const query = db.query.bind(db);
      let changed = false;
      const spy = vi.spyOn(db,'query').mockImplementation(async (sql,values) => {
        if (!changed && sql.includes('AND queue.not_before=due.lease_until')) {
          changed=true;
          await query(`UPDATE identities SET push_level='attention' WHERE id=$1`,[person]);
        }
        return query(sql,values);
      });
      const loop = new PushDeliveryLoop(db,undefined,{send});
      await loop.runOnce();
      spy.mockRestore();
      expect(changed).toBe(true);
      expect((await db.query(`SELECT * FROM push_outbox WHERE not_before<=now()`)).rows).toHaveLength(1);
      expect(await loop.runOnce()).toBe(1);
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith('proof-device',expect.objectContaining({messageId:'disabled-ios'}));
    } finally { await db.close(); }
  });
  
  it('BEELINE-SERVER-17: message edits wake parked mentions but preserve retry deadlines', async () => {
    const db = new PgliteDatabase();
    try {
      await setup(db);
      await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`,[person]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text)
        VALUES('edited-prose',$1,$2,'Ordinary conversation')`,[room,author]);
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db,{send});
      await loop.runOnce();
      expect((await db.query(`SELECT * FROM push_outbox WHERE not_before=expires_at`)).rows).toHaveLength(1);
      await db.query(`UPDATE messages SET text='@owner please read this' WHERE id='edited-prose'`);
      expect(await loop.runOnce()).toBe(1);
      expect(send).toHaveBeenCalledWith('proof-device',expect.objectContaining({messageId:'edited-prose'}));
      await db.query(`UPDATE messages SET text='Ordinary conversation again' WHERE id='edited-prose'`);
      expect(await loop.runOnce()).toBe(0);
      await db.query(`UPDATE messages SET text='@owner mention again' WHERE id='edited-prose'`);
      expect(await loop.runOnce()).toBe(0);
      expect(send).toHaveBeenCalledOnce();
      await post(db,'edited-retry');
      await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,next_retry_at)
        VALUES('edited-retry','proof-device','retryable',now()+interval '5 minutes')`);
      const before = (await db.query(`SELECT not_before FROM push_outbox WHERE message_id='edited-retry'`)).rows;
      await db.query(`UPDATE messages SET text='@owner edited retry' WHERE id='edited-retry'`);
      expect((await db.query(`SELECT not_before FROM push_outbox WHERE message_id='edited-retry'`)).rows).toEqual(before);
      expect(await loop.runOnce()).toBe(0);
      expect(send).toHaveBeenCalledOnce();
    } finally { await db.close(); }
  });
});


describe("router-group-c-completion.postgres", () => {
  const url = serverDatabaseUrl;
  if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Group C proofs require isolated loopback PostgreSQL');
  function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  async function fixture() {
    const schema = `group_c_completion_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
    const a = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const b = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const listener = new Client(config);
    const barriers = new Map<string, () => void>();
    listener.on('notification', event => {
      if (event.channel !== COMMAND_COMPLETION_CHANNEL || !event.payload) return;
      notifyCommandCompletion(event.payload);
      barriers.get(event.payload)?.();
    });
    await listener.connect();
    await listener.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
    return { a, b,
      // A notification after a writer transaction proves all earlier notifications
      // on this connection have been handled; no sleep/poll discovers completion.
      flush: async () => {
        const payload = JSON.stringify({ barrier: randomUUID() }), done = deferred();
        barriers.set(payload, () => done.resolve());
        await b.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, payload]);
        await done.promise;
        barriers.delete(payload);
      },
      close: async () => {
        await listener.end(); await Promise.all([a.close(), b.close()]);
        await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
      },
    };
  }
  afterEach(() => vi.useRealTimers());
  
  describe.skipIf(!url)('Group C P7/P9/P12 real PostgreSQL correlated completion', () => {
    it.each(['https://github.com', 'https://accounts.google.com'])(
      'F11: %s pending ten minutes has no timed inspection; only its committed ticket wakes it', async issuer => {
        const f = await fixture();
        const abort = new AbortController();
        let waiting: Promise<BindTicket | null> | undefined;
        try {
          const reader = new AuthStore(f.a), writer = new AuthStore(f.b);
          await writer.migrate();
          const hash = createHash('sha256').update(randomUUID()).digest('hex');
          const other = createHash('sha256').update(randomUUID()).digest('hex');
          const started = deferred(), inspected = vi.fn(async () => {
            const value = await reader.findTicket(hash); started.resolve(); return value;
          });
          const ticket: BindTicket = { challenge: 'c'.repeat(43), community: 'synthetic.test', issuer,
            audience: 'fixture', subject: 'synthetic-person', createdAt: new Date(),
            expiresAt: new Date(Date.now() + 1_200_000), attemptCount: 0, consumedAt: null, boundPubkey: null };
          const key: CommandCompletionKey = { principal: 'auth', operation: 'ticket', commandId: hash };
          const released = vi.fn();
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
          waiting = waitForAuthTicket(wake => {
            const stop = subscribeCommandCompletion(key, wake);
            return () => { released(); stop(); };
          }, inspected, 1_200_000, abort.signal);
          await started.promise;
          await vi.advanceTimersByTimeAsync(600_000);
          expect(inspected).toHaveBeenCalledTimes(1);
          await writer.createTicket(other, ticket); await f.flush();
          expect(inspected).toHaveBeenCalledTimes(1);
          // The actual trigger's notification must disappear with its write.
          await expect(f.b.transaction(async tx => {
            await new AuthStore(tx).createTicket(hash, ticket);
            throw new Error('synthetic rollback');
          })).rejects.toThrow('synthetic rollback');
          await f.flush(); expect(inspected).toHaveBeenCalledTimes(1);
          await writer.createTicket(hash, ticket);
          expect(await waiting).toMatchObject({ issuer, subject: ticket.subject });
          expect(inspected).toHaveBeenCalledTimes(2); expect(released).toHaveBeenCalledTimes(1);
          await f.flush(); await vi.advanceTimersByTimeAsync(86_400_000);
          expect(inspected).toHaveBeenCalledTimes(2);
        } finally {
          abort.abort(); await waiting?.catch(() => undefined); vi.useRealTimers(); await f.close();
        }
      });
  
    it('F21: a pending payment waits ten minutes, ignores foreign identity and rollback, then consumes its committed result once', async () => {
      const f = await fixture(), abort = new AbortController();
      const started = deferred(), release = deferred();
      let effect: Promise<unknown> | undefined, waiting: ReturnType<RouterCommandLedger['wait']> | undefined;
      try {
        await f.a.query(ROUTER_COMMAND_SCHEMA);
        const key = { principal: 'payer', operation: 'payment', commandId: randomUUID() }, args = { amount: '1', asset: 'synthetic' };
        const first = new RouterCommandLedger(f.a);
        effect = first.external(key, args, async () => { started.resolve(); await release.promise; return { txId: 'synthetic-confirmed' }; });
        await started.promise;
        const initiallyRead = deferred(); let reads = 0;
        const observed: SqlDatabase = { transaction: work => f.b.transaction(work), query: async (sql, values) => {
          const result = await f.b.query(sql, values);
          if (sql.startsWith('SELECT digest,state,result,coverage,')) { reads++; initiallyRead.resolve(); }
          return result;
        } };
        const second = new RouterCommandLedger(observed);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        waiting = second.wait(key, args, 1_200_000, abort.signal);
        await initiallyRead.promise;
        await vi.advanceTimersByTimeAsync(600_000); expect(reads).toBe(1);
        for (const wrong of [{ ...key, principal: 'other' }, { ...key, operation: 'other' }, { ...key, commandId: 'other' }])
          await f.a.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, JSON.stringify(wrong)]);
        await f.flush(); expect(reads).toBe(1);
        await expect(f.a.transaction(async tx => {
          await tx.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, JSON.stringify(key)]);
          throw new Error('synthetic rollback');
        })).rejects.toThrow('synthetic rollback');
        await f.flush(); expect(reads).toBe(1);
        release.resolve(); await effect;
        expect(await waiting).toMatchObject({ state: 'committed', result: { txId: 'synthetic-confirmed' } });
        // The local completion wake and actual LISTEN wake may overlap; neither
        // can inspect again once the waiter has finished.
        await f.flush(); const settledReads = reads;
        await vi.advanceTimersByTimeAsync(86_400_000); expect(reads).toBe(settledReads);
        const replayEffect = vi.fn();
        expect(await second.external(key, args, replayEffect)).toMatchObject({ state: 'committed' });
        expect(replayEffect).not.toHaveBeenCalled();
      } finally {
        abort.abort(); release.resolve(); await effect?.catch(() => undefined);
        await waiting?.catch(() => undefined); vi.useRealTimers(); await f.close();
      }
    });
  
    it('F18/F21: a lost external response stays UNKNOWN across pools and an idle day without redispatch', async () => {
      const f = await fixture();
      try {
        await f.a.query(ROUTER_COMMAND_SCHEMA);
        const key = { principal: 'payer', operation: 'payment', commandId: randomUUID() }, args = { amount: '1' };
        await f.a.query('CREATE TABLE provider_effects(id text)');
        const lostReply = vi.fn(async () => {
          // The synthetic provider commits before its response is lost. No
          // uniqueness constraint masks a duplicate dispatch in this proof.
          await f.b.query('INSERT INTO provider_effects VALUES($1)', [key.commandId]);
          throw new Error('synthetic lost provider result');
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await expect(new RouterCommandLedger(f.a).external(key, args, lostReply)).rejects.toThrow('synthetic lost provider result');
        await vi.advanceTimersByTimeAsync(86_400_000);
        expect(lostReply).toHaveBeenCalledTimes(1);
        const replay = vi.fn(async () => 'must not dispatch');
        for (let n = 0; n < 3; n++)
          expect(await new RouterCommandLedger(f.b).external(key, args, replay)).toMatchObject({ state: 'unknown' });
        expect(replay).not.toHaveBeenCalled();
        expect((await f.a.query('SELECT * FROM provider_effects')).rows).toEqual([{ id: key.commandId }]);
      } finally { vi.useRealTimers(); await f.close(); }
    });
  });
});


describe("router-group-c-oauth.postgres", () => {
  const url = serverDatabaseUrl;
  if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Group C OAuth proof requires isolated loopback PostgreSQL');
  function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
  
  describe.skipIf(!url)('Group C P7/P12 real PostgreSQL OAuth HTTP handoff', () => {
    it('F21: ten pending minutes inspect once; foreign completion cannot wake the waiter and a lost HTTP result replays the same committed code', async () => {
      const schema = `group_c_oauth_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
      const db = new PostgresDatabase('', 2, { pool: new Pool(config) }), listener = new Client(config);
      const notices: string[] = [], requests: ClientRequest[] = [];
      let reads = 0, inspection = deferred(), foreignDelivered = deferred();
      listener.on('notification', event => {
        if (event.channel === COMMAND_COMPLETION_CHANNEL && event.payload) {
          notices.push(event.payload); notifyCommandCompletion(event.payload); foreignDelivered.resolve();
        }
      });
      const observed: SqlDatabase = { transaction: work => db.transaction(work), query: async (sql, args) => {
        const result = await db.query(sql, args);
        if (sql.startsWith('SELECT code,error FROM rooms_mcp_handoffs')) { reads++; inspection.resolve(); }
        return result;
      } };
      const oauth = new RoomsMcpOAuth(observed, 'http://synthetic.invalid', {} as TokenAuth, undefined, () => true);
      const server = createServer((request, response) => {
        void oauth.handle(request, response, new URL(request.url!, 'http://synthetic.invalid')).catch(() => response.destroy());
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = (state: string, waitMs = 600_000) => {
        const headers = deferred();
        const done = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
          const request = httpRequest(origin + '/mcp/oauth/handoff', { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
            headers.resolve(); let text = '';
            response.on('data', chunk => { text += chunk; }); response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
          });
          requests.push(request); request.on('error', reject); request.end(JSON.stringify({ state, completionV1: true, waitMs }));
        });
        return { headers: headers.promise, done };
      };
      let pending: ReturnType<typeof post> | undefined;
      try {
        await db.query('CREATE TABLE identities(id text PRIMARY KEY); CREATE TABLE messages(id text PRIMARY KEY,author_id text,room_id uuid,reply_to_message_id text,presentation text); CREATE TABLE rooms(id uuid PRIMARY KEY)');
        await db.query(ROOMS_MCP_SCHEMA); await listener.connect(); await listener.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
        const state = randomUUID().replaceAll('-', '') + 'synthetic';
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        pending = post(state); await pending.headers; await inspection.promise;
        await vi.advanceTimersByTimeAsync(599_999); expect(reads).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending.done).toEqual({ status: 200, body: { error: 'authorization_pending' } }); expect(reads).toBe(1);
        inspection = deferred(); pending = post(state); await pending.headers; await inspection.promise;
        expect(reads).toBe(2);
        foreignDelivered = deferred();
        await fetch(origin + '/mcp/oauth/handoff?state=' + 'z'.repeat(43) + '&code=foreign-code'); await foreignDelivered.promise;
        expect(reads).toBe(2);
        await fetch(origin + '/mcp/oauth/handoff?state=' + state + '&code=synthetic-code');
        expect(await pending.done).toEqual({ status: 200, body: { code: 'synthetic-code' } }); expect(reads).toBe(3);
        // Treat that first body as lost. Replay retrieves the same receipt;
        // no provider token exchange or regenerated authorization is performed.
        expect(await post(state).done).toEqual({ status: 200, body: { code: 'synthetic-code' } }); expect(reads).toBe(4);
        expect(JSON.stringify(notices)).not.toContain(state); expect(JSON.stringify(notices)).not.toContain('synthetic-code');
        await vi.advanceTimersByTimeAsync(86_400_000); expect(reads).toBe(4);
      } finally {
        for (const request of requests) request.destroy(); await pending?.done.catch(() => undefined); vi.useRealTimers();
        await new Promise<void>(resolve => server.close(() => resolve())); await listener.end(); await db.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
      }
    });
  });
});


describe("router-release-migration.postgres", () => {
  const url = serverDatabaseUrl;
  if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Router migration proof requires isolated loopback PostgreSQL');
  
  it.skipIf(!url)('runs release migration twice then serves Tray and owned models without fixture DDL', async () => {
    const schema = `router_release_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    const db = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
      connectionString: url, max: 1, options: `-c search_path=${schema},public`,
    }) });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(db);
      await migrate(db);
  
      const { credentials, actor, issued } = await seedOwnedModelFixture(db, { installSchema: false });
      expect(await db.transaction(tx => credentials.issueInTransaction(tx, MODEL_CLAIM))).toEqual(issued);
      const attempts = new OwnedModelAttempts(db, credentials), requestId = randomUUID();
      const payload = { model: MODEL, messages: [], max_tokens: 8 };
      const admitted = await attempts.reserve(actor, requestId, payload, async () => ({
        reservation: { day: '2026-11-04', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 }, payload,
      }));
      expect(admitted.receipt.state).toBe('unknown');
      await expect(db.query(`UPDATE agent_commands SET generation_id='new-generation' WHERE id=$1`,
        [MODEL_CLAIM.commandId])).rejects.toThrow('UNKNOWN blocks a new command generation');
      const dispatched = await attempts.handoff(admitted.permit!, async body => JSON.parse(body));
      expect(dispatched.state).toBe('started');
      expect(await dispatched.completion).toEqual(payload);
      expect(await attempts.settleUsage(actor, requestId, { tokens: 3, usd: 0.001 }, 'succeeded', async () => {}))
        .toMatchObject({ requestId, state: 'succeeded' });
  
      const author = 'd'.repeat(64), messageId = 'e'.repeat(64);
      await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Author','author')`, [author]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
        ($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [MODEL_WORKSPACE, MODEL_ROOM, MODEL_OWNER]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Saved text')`, [messageId, MODEL_ROOM, author]);
      const phone = new PhoneService(db, 'https://synthetic.invalid');
      const read = (): Promise<RouterSnapshot<'needs-you-tray'>> => phone.readRouterSnapshot(
        { family: 'needs-you-tray', workspaceId: MODEL_WORKSPACE }, MODEL_OWNER) as Promise<RouterSnapshot<'needs-you-tray'>>;
      await phone.execute('setMessageBookmark', { roomId: MODEL_ROOM, messageId, bookmarked: true }, MODEL_OWNER);
      const saved = (await read()).value.saved.rows[0]!;
      expect(saved.value).toMatchObject({ messageId, text: 'Saved text', available: true });
      await db.query(`UPDATE messages SET text='Edited text' WHERE id=$1`, [messageId]);
      await db.query(`UPDATE identities SET name='Renamed author' WHERE id=$1`, [author]);
      expect((await read()).value.saved.rows[0]!.value).toMatchObject({ text: 'Edited text', author: { name: 'Renamed author' } });
      const causes = (await db.query<{ event: Record<string, unknown> }>(`SELECT event FROM live_journal
        WHERE event->>'sourceTable' IN ('tray-saved-window','tray-saved-source','tray-projection')
          AND event->>'trayReaderId'=$1 ORDER BY sequence`, [MODEL_OWNER])).rows.map(row => row.event);
      expect(new Set(causes.map(cause => cause.sourceTable))).toEqual(new Set([
        'tray-saved-window', 'tray-saved-source', 'tray-projection',
      ]));
      expect(routerSourcePlan(causes, MODEL_OWNER, MODEL_WORKSPACE).families.has('needs-you-tray')).toBe(true);
      // Re-running release DDL preserves persisted credential, attempt and
      // bookmark identity instead of resetting the live router's source rows.
      const before = (await read()).value.saved.rows;
      await migrate(db);
      expect((await read()).value.saved.rows).toEqual(before);
      expect(await credentials.authenticate(db, issued.token)).toBeTruthy();
      expect((await db.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'succeeded' }]);
      await phone.execute('clearMessageBookmarks', { workspaceId: MODEL_WORKSPACE }, MODEL_OWNER);
      expect((await read()).value.saved.rows).toEqual([]);
    } finally {
      await db.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }, 60_000);
});


describe("router-schema-rollback", () => {
  // Execute retained historical source, not a reimplementation of its equality
  // check. Only the successful database-read path is in scope. Any retry/error
  // helper invocation fails immediately rather than scheduling historical timers.
  function historicalReadiness() {
    const exports = {} as {
      REQUIRED_SCHEMA_VERSION: number;
      markSchemaCurrent(database: SqlDatabase): Promise<void>;
      assertSchemaCurrent(database: SqlDatabase): Promise<void>;
    };
    const unexpected = () => { throw new Error('Historical retry path is outside this proof'); };
    const source = readFileSync("apps/server/src/fixtures/schema46-readiness.source.txt", 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    runInNewContext(outputText, {
      exports, pause: unexpected, isTransientDatabaseConnectionError: unexpected,
      SCHEMA_RETRY_DELAYS_MS: [],
    });
    return exports;
  }
  
  it('keeps historical boot valid through additive readiness while requiring completed router migrations', async () => {
    const database = new PgliteDatabase();
    const old = historicalReadiness();
    try {
      expect(old.REQUIRED_SCHEMA_VERSION).toBe(46);
      await old.markSchemaCurrent(database);
      await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
      await expect(assertSchemaCurrent(database)).rejects.toThrow('release migration step');
  
      await markSchemaCurrent(database);
      await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
      await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
      expect((await database.query('SELECT version FROM beeline_schema_state')).rows).toEqual([{ version: 46 }]);
      expect((await database.query('SELECT version FROM beeline_router_schema_state')).rows).toEqual([{ version: 62 }]);
  
      // A historical migration can still mark its baseline without deleting the
      // additive marker. This does not claim it understands router commands.
      await old.markSchemaCurrent(database);
      await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
      await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
  
      await database.query('UPDATE beeline_router_schema_state SET version=60');
      await expect(assertSchemaCurrent(database)).rejects.toThrow('expected router schema version 62, found 60');
      await expect(old.assertSchemaCurrent(database)).resolves.toBeUndefined();
      await database.query('DELETE FROM beeline_router_schema_state');
      await expect(assertSchemaCurrent(database)).rejects.toThrow('expected router schema version 62, found no marker');
      await markSchemaCurrent(database);
      await database.query('UPDATE beeline_schema_state SET version=45');
      await expect(assertSchemaCurrent(database)).rejects.toThrow('expected schema version 46, found 45');
    } finally {
      await database.close();
    }
  }, 20_000);
});


describe("tray-choice-clock-owner.postgres", () => {
  const url=serverDatabaseUrl;
  if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Choice clock proof requires isolated loopback PostgreSQL');
  const person='a'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222',choice='33333333-3333-4333-8333-333333333333';
  const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
  async function fixture(){
    const schema=`choice_clock_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public -c lock_timeout=150ms`,max:2};
    const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
    const locks=new Pool({connectionString:url,max:1}),connection=await locks.connect();
    const held=new Set<PoolClient>([connection]);
    try{
      await connection.query('SELECT pg_advisory_lock($1)',[BACKGROUND_LEADER_LOCK_KEY]);
      await first.query(`CREATE TABLE identities(id text PRIMARY KEY,kind text,name text,handle text,avatar text,face_id text);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
        CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,presentation text DEFAULT 'message',
          card_type text,card jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT now());
        CREATE TABLE needs_you_marks(identity_id text,message_id text,workspace_id uuid,first_seen_at timestamptz,cleared_at timestamptz);
        CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,agent_id text,message_id text,mode text,prompt text,
          constraint_text text,options jsonb,electorate text[],status text,closes_at timestamptz,workflow_run_id text);
        CREATE TABLE room_choice_votes(choice_id uuid,voter_id text,option_id text,created_at timestamptz DEFAULT now());
        CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz NOT NULL);
        INSERT INTO live_server_instances VALUES('owner',clock_timestamp());
        INSERT INTO identities(id,kind,name) VALUES('${person}','human','Synthetic');
        INSERT INTO rooms(id,workspace_id) VALUES('${room}','${workspace}');
        INSERT INTO memberships VALUES('${workspace}',NULL,'${person}',NULL),('${workspace}','${room}','${person}',NULL);`);
      await first.query(DURABLE_LIVE_SCHEMA);await first.query(BACKGROUND_OWNERSHIP_SCHEMA);
      await first.query(TRAY_CLOCK_SOURCE_SCHEMA);await first.query(TRAY_CLOCK_OWNER_SCHEMA);
      await first.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
        VALUES('card',$1,$2,'Synthetic poll','card','choice','{"status":"open"}')`,[room,person]);
      await first.query(`INSERT INTO room_choices(id,workspace_id,room_id,agent_id,message_id,mode,prompt,options,electorate,status,closes_at)
        VALUES($1,$2,$3,$4,'card','poll','Synthetic?',$5::jsonb,$6::text[],'open',clock_timestamp()-interval '1 second')`,
      [choice,workspace,room,person,JSON.stringify([{optionId:'A',letter:'A',label:'One',consequence:'One'},{optionId:'B',letter:'B',label:'Two',consequence:'Two'}]),[person,'b'.repeat(64)]]);
    }catch(error){connection.release(true);await Promise.all([first.close(),second.close(),locks.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();throw error;}
    return{first,second,connection,
      drop:(client:PoolClient)=>{if(held.delete(client))client.release(true);},
      acquire:async()=>{const client=await locks.connect();held.add(client);await client.query('SELECT pg_advisory_lock($1)',[BACKGROUND_LEADER_LOCK_KEY]);return client;},
      close:async()=>{for(const client of held)client.release(true);held.clear();await Promise.all([first.close(),second.close(),locks.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
  }
  
  describe.skipIf(!url)('real PostgreSQL owned choice expiry races',()=>{
    it('refuses a legacy-held source before its authority request instead of deadlocking or applying a partial close',async()=>{
      const f=await fixture(),held=deferred(),release=deferred();const core=new BackgroundOwnership(f.first,'owner');
      const epoch=await core.claim(f.connection);let writer:Promise<unknown>|undefined;
      try{
        writer=f.second.transaction(async tx=>{
          await tx.query('SELECT id FROM room_choices WHERE id=$1 FOR UPDATE',[choice]);held.resolve();await release.promise;
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
          await tx.query(`UPDATE room_choices SET closes_at=closes_at+interval '1 microsecond' WHERE id=$1`,[choice]);
        });
        await held.promise;await expect(new TrayChoiceClockOwner(core).drain(epoch)).rejects.toMatchObject({code:'55P03'});
        expect((await f.first.query('SELECT status FROM room_choices')).rows).toEqual([{status:'open'}]);
        expect((await f.first.query('SELECT revision::text FROM tray_clock_state')).rows).toEqual([{revision:'0'}]);
        release.resolve();await writer;
        expect((await new TrayChoiceClockOwner(core).drain(epoch)).consumed).toBe(true);
      }finally{release.resolve();await writer?.catch(()=>{});core.revoke(epoch);await f.close();}
    });
  
    it('rolls actual poll/card/source/clock back if the lease expires after the callback and before SQL COMMIT',async()=>{
      const f=await fixture(),returned=deferred(),commit=deferred();let delay=false;
      const observed:SqlDatabase={query:(sql,args)=>f.first.query(sql,args),transaction:work=>f.first.transaction(async tx=>{
        const result=await work(tx);if(delay){returned.resolve();await commit.promise;}return result;
      })};
      const core=new BackgroundOwnership(observed,'owner'),epoch=await core.claim(f.connection);let flight:Promise<unknown>|undefined;
      try{
        await f.first.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '88 seconds'`);delay=true;
        flight=new TrayChoiceClockOwner(core).drain(epoch);const rejected=expect(flight).rejects.toMatchObject({code:'23514'});
        await returned.promise;expect((await f.second.query('SELECT status FROM room_choices')).rows).toEqual([{status:'open'}]);
        await f.second.query('SELECT pg_sleep(2.1)');commit.resolve();await rejected;
        expect((await f.second.query('SELECT status FROM room_choices')).rows).toEqual([{status:'open'}]);
        expect((await f.second.query(`SELECT card->>'status' status FROM messages WHERE id='card'`)).rows).toEqual([{status:'open'}]);
        expect((await f.second.query('SELECT state FROM tray_clock_deadlines')).rows).toEqual([{state:'pending'}]);
        expect((await f.second.query('SELECT revision::text FROM tray_clock_state')).rows).toEqual([{revision:'0'}]);
        expect((await f.second.query('SELECT * FROM tray_clock_owner_fences')).rows).toEqual([]);
      }finally{commit.resolve();await flight?.catch(()=>{});core.revoke(epoch);await f.close();}
    });
    it('rejects actual COMMIT after the bound lock backend disappears with a fresh aggregate lease, preserving domain/card/source/clock',async()=>{
      const f=await fixture(),returned=deferred(),commit=deferred();let delay=false;
      const observed:SqlDatabase={query:(sql,args)=>f.first.query(sql,args),transaction:work=>f.first.transaction(async tx=>{
        const result=await work(tx);if(delay){returned.resolve();await commit.promise;}return result;
      })};
      const core=new BackgroundOwnership(observed,'owner'),epoch=await core.claim(f.connection);let flight:Promise<unknown>|undefined;
      let replacement:BackgroundOwnership|undefined,replacementEpoch:Awaited<ReturnType<BackgroundOwnership['claim']>>|undefined;
      try{
        delay=true;flight=new TrayChoiceClockOwner(core).drain(epoch);const rejected=expect(flight).rejects.toMatchObject({code:'23514'});
        await returned.promise;
        expect((await f.second.query(`SELECT beeline_background_backend_holds(lock_backend_pid,lock_backend_start) held
          FROM background_leader_owners`)).rows).toEqual([{held:true}]);
        f.drop(f.connection);const next=await f.acquire();
        expect((await f.second.query(`SELECT beeline_background_backend_holds(owner.lock_backend_pid,owner.lock_backend_start) held,
          server.renewed_at>clock_timestamp()-interval '90 seconds' fresh FROM background_leader_owners owner
          JOIN live_server_instances server ON server.instance_id=owner.instance_id`)).rows).toEqual([{held:false,fresh:true}]);
        commit.resolve();await rejected;
        expect((await f.second.query('SELECT status FROM room_choices')).rows).toEqual([{status:'open'}]);
        expect((await f.second.query(`SELECT card->>'status' status FROM messages WHERE id='card'`)).rows).toEqual([{status:'open'}]);
        expect((await f.second.query('SELECT state FROM tray_clock_deadlines')).rows).toEqual([{state:'pending'}]);
        expect((await f.second.query('SELECT revision::text FROM tray_clock_state')).rows).toEqual([{revision:'0'}]);
        expect((await f.second.query('SELECT * FROM tray_clock_owner_fences')).rows).toEqual([]);
        replacement=new BackgroundOwnership(f.second,'owner');replacementEpoch=await replacement.claim(next);
        expect((await new TrayChoiceClockOwner(replacement).drain(replacementEpoch)).consumed).toBe(true);
        expect((await new TrayChoiceClockOwner(replacement).drain(replacementEpoch)).consumed).toBe(false);
        expect((await f.second.query('SELECT revision::text FROM tray_clock_state')).rows).toEqual([{revision:'1'}]);
      }finally{commit.resolve();await flight?.catch(()=>{});core.revoke(epoch);if(replacement&&replacementEpoch)replacement.revoke(replacementEpoch);await f.close();}
    });
  });
});


describe("tray-decision-command.postgres", () => {
  const url = serverDatabaseUrl;
  if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Tray decision proofs require isolated loopback PostgreSQL');
  const A = 'a'.repeat(64), B = 'b'.repeat(64), AGENT = 'c'.repeat(64), RUN = 'd'.repeat(64);
  const W = '11111111-1111-4111-8111-111111111111', ROOM = '22222222-2222-4222-8222-222222222222';
  const CORNER = '33333333-3333-4333-8333-333333333333', CHOICE = '44444444-4444-4444-8444-444444444444';
  const GRANT = '55555555-5555-4555-8555-555555555555';
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  
  /** Only a schema created by this test is dropped. Real pools establish the
   * legacy run/source→authority order; the selected adapter must never wait
   * in the reverse order. Actual legacy skip/card DML completes afterward. */
  async function rig(work: (reader: SqlDatabase, writer: SqlDatabase) => Promise<void>) {
    const schema = `tray_decision_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
    const reader = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const writer = new PostgresDatabase('', 2, { pool: new Pool(config) });
    try {
      await reader.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE identities(id text PRIMARY KEY,kind text,name text,handle text,avatar text,face_id text,hidden_from_roster boolean);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(id bigserial PRIMARY KEY,workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
        CREATE VIEW room_access AS SELECT member.* FROM memberships member
          WHERE member.room_id IS NULL OR EXISTS(SELECT 1 FROM rooms surface WHERE surface.id=member.room_id AND surface.parent_id IS NULL)
          UNION ALL SELECT parent.id,corner.workspace_id,corner.id,parent.identity_id,parent.role,parent.removed_at
          FROM rooms corner JOIN memberships parent ON parent.room_id=corner.parent_id
          WHERE corner.parent_id IS NOT NULL AND corner.archived_at IS NULL;
        CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text);
        CREATE TABLE workspace_apps(id uuid PRIMARY KEY,workspace_id uuid,owner_identity_id text);
        CREATE TABLE agent_grants(id uuid PRIMARY KEY,agent_id text,workspace_id uuid,room_id uuid,kind text,target text,app_id uuid,status text,superseded_at timestamptz);
        CREATE TABLE permission_authority(permission_id text PRIMARY KEY,room_id uuid,principal_id text,status text);
        CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,card_type text,card jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT now());
        CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,agent_id text,message_id text,mode text,prompt text,
          constraint_text text,options jsonb,electorate text[],status text,closes_at timestamptz,workflow_run_id text);
        CREATE TABLE connector_offers(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,message_id text,addressee_id text,connector_type text,status text);
        CREATE TABLE message_bookmarks(identity_id text,workspace_id uuid,room_id uuid,message_id text);
        CREATE TABLE needs_you_marks(identity_id text,workspace_id uuid,message_id text);`);
      await reader.query(DURABLE_LIVE_SCHEMA);
      await reader.query(ROUTER_PROJECTION_SCHEMA);
      await reader.query(ROUTER_COMMAND_SCHEMA);
      await reader.query(`INSERT INTO workspaces VALUES($1)`, [W]);
      await reader.query(`INSERT INTO rooms(id,workspace_id,parent_id) VALUES($1,$3,NULL),($2,$3,$1)`, [ROOM, CORNER, W]);
      await reader.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Other'),($3,'agent','Agent')`, [A, B, AGENT]);
      await reader.query(`INSERT INTO agents VALUES($1,$2)`, [AGENT, A]);
      await reader.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [W, ROOM, A]);
      await reader.query(`INSERT INTO messages(id,room_id,author_id,card_type,card) VALUES('choice-card',$1,$2,$3,$4::jsonb)`, [CORNER, AGENT, CHOICE_CARD_TYPE,
        JSON.stringify({ runId: RUN, attempt: 0, requester: { pubkey: A } })]);
      await reader.query(`INSERT INTO room_choices(id,workspace_id,room_id,agent_id,message_id,mode,prompt,options,electorate,status,closes_at,workflow_run_id)
        VALUES($1,$2,$3,$4,'choice-card','question','Synthetic?',$5::jsonb,$6::text[],'open',clock_timestamp()+interval '10 minutes',$7)`,
      [CHOICE, W, CORNER, AGENT, JSON.stringify([{ optionId: 'A', letter: 'A', label: 'Stop', consequence: 'Stop' }]), [A], RUN]);
      // This is the real capture/fence trigger, not a hand-written notification.
      await reader.query(TRAY_MUTABLE_SOURCE_SCHEMA);
      await work(reader, writer);
    } finally {
      await Promise.all([reader.close(), writer.close()]);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
  function selected(reader: SqlDatabase, live: LiveHub) {
    const phone = new PhoneService(reader, 'https://synthetic.invalid', undefined, undefined, live);
    return (id: string) => dispatchTrayDecisionCommand(new RouterCommandLedger(reader), phone, live,
      'skipChoice', { choiceId: CHOICE }, A, { v: 1, id });
  }
  async function unchanged(reader: SqlDatabase, publish: unknown) {
    expect((await reader.query('SELECT status FROM room_choices WHERE id=$1', [CHOICE])).rows).toEqual([{ status: 'open' }]);
    expect((await reader.query('SELECT * FROM router_commands')).rows).toEqual([]);
    expect((await reader.query(`SELECT * FROM live_journal WHERE event->>'sourceTable'='tray-projection'`)).rows).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  }
  
  describe.skipIf(!url)('real PostgreSQL selected Tray decision contention', () => {
    it('refuses a legacy-held workflow lock before effects, then the legacy holder commits its actual skip/card change', async () => {
      await rig(async (reader, writer) => {
        const live = new LiveHub(), publish = vi.spyOn(live, 'publish'), held = deferred(), release = deferred();
        const legacy = writer.transaction(async tx => {
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [workflowRunLockKey(RUN)]);
          held.resolve(); await release.promise;
          // The source trigger requests this existing authority fence after the
          // legacy run lock. The selected adapter must already have refused.
          await skipRoomChoice(tx, { choiceId: CHOICE, viewerId: A }, { wake: false });
        });
        try {
          await held.promise;
          await expect(selected(reader, live)('busy-run')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('busy') });
          await unchanged(reader, publish);
          release.resolve(); await legacy;
          expect((await reader.query('SELECT status FROM room_choices WHERE id=$1', [CHOICE])).rows).toEqual([{ status: 'skipped' }]);
          expect((await reader.query(`SELECT card->>'status' status FROM messages WHERE id='choice-card'`)).rows).toEqual([{ status: 'skipped' }]);
          expect((await reader.query(`SELECT count(*)::int count FROM live_journal WHERE event->>'sourceTable'='tray-projection'`)).rows[0]?.count).toBeGreaterThan(0);
        } finally { release.resolve(); await legacy; }
      });
    });
  
    it('refuses NOWAIT source-row contention instead of deadlocking with a legacy source→authority writer', async () => {
      await rig(async (reader, writer) => {
        await reader.query(`UPDATE messages SET card=card-'runId' WHERE id='choice-card'`);
        await reader.query('UPDATE room_choices SET workflow_run_id=NULL WHERE id=$1', [CHOICE]);
        await reader.query(`DELETE FROM live_journal WHERE event->>'sourceTable'='tray-projection'`);
        const live = new LiveHub(), publish = vi.spyOn(live, 'publish'), held = deferred(), release = deferred();
        const legacy = writer.transaction(async tx => {
          await tx.query('SELECT id FROM room_choices WHERE id=$1 FOR UPDATE', [CHOICE]);
          held.resolve(); await release.promise;
          await skipRoomChoice(tx, { choiceId: CHOICE, viewerId: A }, { wake: false });
        });
        try {
          await held.promise;
          await expect(selected(reader, live)('busy-choice')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('busy') });
          await unchanged(reader, publish);
          release.resolve(); await legacy;
          expect((await reader.query('SELECT status FROM room_choices WHERE id=$1', [CHOICE])).rows).toEqual([{ status: 'skipped' }]);
        } finally { release.resolve(); await legacy; }
      });
    });
  
    it('observes committed parent-Room revocation and refuses without a decision or compatibility notification', async () => {
      await rig(async (reader, writer) => {
        await reader.query(`UPDATE messages SET card=card-'runId' WHERE id='choice-card'`);
        await reader.query('UPDATE room_choices SET workflow_run_id=NULL WHERE id=$1', [CHOICE]);
        await reader.query(`DELETE FROM live_journal WHERE event->>'sourceTable'='tray-projection'`);
        await writer.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE identity_id=$1 AND room_id=$2', [A, ROOM]);
        const live = new LiveHub(), publish = vi.spyOn(live, 'publish');
        await expect(selected(reader, live)('revoked')).rejects.toThrow('room access denied');
        await unchanged(reader, publish);
      });
    });
  
    it('uses the current resource owner and refuses an old owner after another pool commits transfer', async () => {
      await rig(async (reader, writer) => {
        await reader.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,status)
          VALUES($1,$2,$3,$4,'path','/synthetic','pending')`, [GRANT, AGENT, W, CORNER]);
        await writer.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1', [AGENT, B]);
        const live = new LiveHub(), publish = vi.spyOn(live, 'publish'), phone = new PhoneService(reader, 'https://synthetic.invalid', undefined, undefined, live);
        await expect(dispatchTrayDecisionCommand(new RouterCommandLedger(reader), phone, live, 'decideAgentGrant',
          { grantId: GRANT, decision: 'always' }, A, { v: 1, id: 'former-owner' })).rejects.toThrow('owner');
        expect((await reader.query('SELECT status FROM agent_grants WHERE id=$1', [GRANT])).rows).toEqual([{ status: 'pending' }]);
        expect((await reader.query('SELECT * FROM router_commands')).rows).toEqual([]);
        expect(publish).not.toHaveBeenCalled();
      });
    });
  });
});


describe("tray-release-migration", () => {
  const viewer = 'a'.repeat(64), author = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Reader','reader'),($2,'human','Author','author')`, [viewer, author]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Migration proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Source Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [workspace, room, viewer]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('saved',$1,$2,'Saved text')`, [room, author]);
  });
  afterEach(async () => { await db.close(); });
  
  const bookmark = () => db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,
    source_room_name,source_room_kind,message_created_at)
    SELECT $1,$2,$3,id,'Source Room','room',created_at FROM messages WHERE id='saved'
    ON CONFLICT(identity_id,message_id) DO NOTHING`, [viewer, workspace, room]);
  const read = () => new PhoneService(db, 'https://synthetic.invalid').readRouterSnapshot(
    { family: 'needs-you-tray', workspaceId: workspace }, viewer) as Promise<RouterSnapshot<'needs-you-tray'>>;
  
  it('reads and clears populated canonical Tray after release migration alone', async () => {
    await bookmark();
    const snapshot = await read();
    expect(snapshot.value.saved.rows).toHaveLength(1);
    expect(snapshot.value.saved.rows[0]!.value).toMatchObject({messageId:'saved', text:'Saved text', available:true});
    await db.query(`UPDATE messages SET text='Edited saved text' WHERE id='saved'`);
    expect((await read()).value.saved.rows[0]!.value.text).toBe('Edited saved text');
    const sources = (await db.query<{event: {sourceTable:string; table?:string}}>(
      `SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-saved-source'`)).rows;
    expect(sources.some(row => row.event.table === 'messages')).toBe(true);
    await db.query(`UPDATE identities SET name='Renamed author' WHERE id=$1`, [author]);
    expect((await read()).value.saved.rows[0]!.value.author?.name).toBe('Renamed author');
    expect((await db.query(`SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-projection'
      AND event->>'table'='identities' AND event->>'trayReaderId'=$1`, [viewer])).rows.length).toBeGreaterThan(0);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('question',$1,$2,'@reader please review?')`, [room, author]);
    expect((await read()).value.needs.items.map(item => item.messageId)).toEqual(['question']);
    await new PhoneService(db, 'https://synthetic.invalid').execute('clearNeedsYouSection', {workspaceId:workspace}, viewer);
    expect((await read()).value.needs.items).toEqual([]);
    await new PhoneService(db, 'https://synthetic.invalid').execute('clearMessageBookmarks', {workspaceId:workspace}, viewer);
    expect((await read()).value.saved.rows).toEqual([]);
    expect((await db.query('SELECT * FROM message_bookmarks')).rows).toEqual([]);
  });
  
  it('upgrades legacy bookmarks idempotently while preserving old writers', async () => {
    // Recreate the release's pre-canonical Saved schema in this isolated database.
    await db.query(`DROP FUNCTION beeline_saved_source_capture() CASCADE;
      DROP FUNCTION beeline_saved_window_capture() CASCADE;
      DROP FUNCTION beeline_saved_window_identity() CASCADE;
      ALTER TABLE message_bookmarks DROP COLUMN bookmark_id;`);
    await bookmark();
    await migrate(db);
    const upgraded = (await read()).value.saved.rows[0]!;
    expect(upgraded.value).toMatchObject({messageId:'saved', text:'Saved text', available:true});
    expect(upgraded.bookmarkId).toBeTruthy();
    await migrate(db);
    await bookmark();
    expect((await read()).value.saved.rows).toEqual([upgraded]);
    await new PhoneService(db, 'https://synthetic.invalid').execute('clearMessageBookmarks', {workspaceId:workspace}, viewer);
    await bookmark();
    const recreated = (await read()).value.saved.rows[0]!;
    expect(recreated.bookmarkId).not.toBe(upgraded.bookmarkId);
    expect(recreated.value.messageId).toBe('saved');
  });
});
