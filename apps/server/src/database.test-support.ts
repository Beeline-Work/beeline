import { readFile } from 'node:fs/promises';

import { priorReleaseCornerListSql } from './fixtures/sentry-22-load-corners.js';

import { CornerAccessDatabase } from './corner-access-database.js';

import { CommandScopedDatabase } from './command-scoped-database.js';

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Pool } from 'pg';

import { INSTITUTIONAL_HISTORY_MAX_AGE_DAYS } from '@beeline/api-contract/daemon';

import { DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID } from '@beeline/api-contract/phone';

import {
  assertSchemaCurrent,
  DatabaseTransactionStartError,
  backfillAgentHandles,
  backfillMessageSearchDocuments,
  MESSAGE_SEARCH_DOCUMENT_MAX_BYTES,
  backfillInstitutionalMemoryRollout,
  backfillPerItemEventSubscriptions,
  MESSAGE_CURSOR_MS_SQL,
  migrate,
  APP_POOL_WAIT_TIMEOUT_MS,
  APP_STATEMENT_TIMEOUT_MS,
  ENRICHMENT_POOL_WAIT_TIMEOUT_MS,
  ENRICHMENT_STATEMENT_TIMEOUT_MS,
  postgresPoolConfig,
  REQUIRED_SCHEMA_VERSION,
  REQUIRED_ROUTER_SCHEMA_VERSION,
  markSchemaCurrent,
  migrateData,
  PostgresDatabase,
  HEALTH_POOL_WAIT_TIMEOUT_MS,
  MIGRATION_LOCK_TIMEOUT_MS,
  MIGRATION_STATEMENT_TIMEOUT_MS,
  isTransientDatabaseConnectionError,
  type SqlDatabase,
} from './database.js';

import { PgliteDatabase, migratedDatabase } from './test-support.js';

import { requireRoomSlug, reserveRoomName } from './room-names.js';


export function result<Row>(rows: Row[]) {
  return { rows, rowCount: rows.length };
}


export const TERMINATED = () => new Error('Connection terminated unexpectedly');


export function stubClient() {
  const client = new EventEmitter() as EventEmitter & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  client.query = vi.fn().mockResolvedValue(result([]));
  client.release = vi.fn();
  return client;
}


export function poolHandingOut(clients: unknown[]) {
  const connect = vi.fn();
  clients.forEach((client) => connect.mockResolvedValueOnce(client));
  return { query: vi.fn(), on: vi.fn(), connect, end: vi.fn() } as unknown as Pool;
}


export function poolWithQuery(query: ReturnType<typeof vi.fn>): Pool {
  const connect = vi.fn(async () => {
    const client = stubClient();
    client.query = query;
    return client;
  });
  return { query: vi.fn(), on: vi.fn(), connect, end: vi.fn() } as unknown as Pool;
}
export function fixtureScope10() {

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
return {
AUTHOR,
WORKSPACE,
ROOM,
get database(){return database;}, set database(value: typeof database){database=value;},
};
}
export function fixtureScope11() {

  const OWNER = 'a'.repeat(64);

  const MEMBER = 'b'.repeat(64);

  const WORKSPACE = '11111111-1111-4111-8111-111111111111';

  let database: PgliteDatabase;


  beforeEach(async () => {
    database = await migratedDatabase();
  });


  afterEach(() => database.close());
return {
OWNER,
MEMBER,
WORKSPACE,
get database(){return database;}, set database(value: typeof database){database=value;},
};
}
export function fixtureScope12() {

  const OWNER = 'a'.repeat(64);

  let database: PgliteDatabase;

  beforeEach(async () => {
    database = await migratedDatabase();
  });

  afterEach(() => database.close());
return {
OWNER,
get database(){return database;}, set database(value: typeof database){database=value;},
};
}
export function fixtureScope13() {

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
return {
OWNER,
ON_AGENT,
OFF_AGENT,
FRESH_AGENT,
get database(){return database;}, set database(value: typeof database){database=value;},
};
}
export function fixtureScope14() {

  const STAGED = '10000000-0000-4000-8000-000000000011';

  const PAUSED = '10000000-0000-4000-8000-000000000012';

  const OFF = '10000000-0000-4000-8000-000000000013';

  const PLAIN = '10000000-0000-4000-8000-000000000014';

  let database: PgliteDatabase;

  beforeEach(async () => {
    database = await migratedDatabase();
  });

  afterEach(() => database.close());
return {
STAGED,
PAUSED,
OFF,
PLAIN,
get database(){return database;}, set database(value: typeof database){database=value;},
};
}
export function fixtureScope15() {

  let database: PgliteDatabase;

  beforeEach(async () => {
    database = await migratedDatabase();
  });

  afterEach(() => database.close());
return {
get database(){return database;}, set database(value: typeof database){database=value;},
};
}
export function fixtureScope16() {

  const AGENT_A = 'a'.repeat(64);

  const AGENT_B = 'b'.repeat(64);

  const WORKSPACE = '11111111-1111-4111-8111-111111111111';

  const ROOM = '22222222-2222-4222-8222-222222222222';
return {
AGENT_A,
AGENT_B,
WORKSPACE,
ROOM,
};
}
export function fixtureScope18() {

  let database: PgliteDatabase;


  beforeEach(async () => {
    database = await migratedDatabase();
  });


  afterEach(() => database.close());
return {
get database(){return database;}, set database(value: typeof database){database=value;},
};
}
export function fixtureScope19() {

  let database: PgliteDatabase;


  beforeEach(async () => {
    database = await migratedDatabase();
  });


  afterEach(() => database.close());
return {
get database(){return database;}, set database(value: typeof database){database=value;},
};
}
export function fixtureScope20() {

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
return {
parent,
corner,
installation,
instance,
viewer,
seedCorner,
readPriorRelease,
};
}
export { readFile } from 'node:fs/promises';
export { priorReleaseCornerListSql } from './fixtures/sentry-22-load-corners.js';
export { CornerAccessDatabase } from './corner-access-database.js';
export { CommandScopedDatabase } from './command-scoped-database.js';
export { EventEmitter } from 'node:events';
export { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
export { INSTITUTIONAL_HISTORY_MAX_AGE_DAYS } from '@beeline/api-contract/daemon';
export { DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID } from '@beeline/api-contract/phone';
export { assertSchemaCurrent, DatabaseTransactionStartError, backfillAgentHandles, backfillMessageSearchDocuments, MESSAGE_SEARCH_DOCUMENT_MAX_BYTES, backfillInstitutionalMemoryRollout, backfillPerItemEventSubscriptions, MESSAGE_CURSOR_MS_SQL, migrate, APP_POOL_WAIT_TIMEOUT_MS, APP_STATEMENT_TIMEOUT_MS, ENRICHMENT_POOL_WAIT_TIMEOUT_MS, ENRICHMENT_STATEMENT_TIMEOUT_MS, postgresPoolConfig, REQUIRED_SCHEMA_VERSION, REQUIRED_ROUTER_SCHEMA_VERSION, markSchemaCurrent, migrateData, PostgresDatabase, HEALTH_POOL_WAIT_TIMEOUT_MS, MIGRATION_LOCK_TIMEOUT_MS, MIGRATION_STATEMENT_TIMEOUT_MS, isTransientDatabaseConnectionError } from './database.js';
export { PgliteDatabase, migratedDatabase } from './test-support.js';
export { requireRoomSlug, reserveRoomName } from './room-names.js';
export type { Pool } from 'pg';
export type { SqlDatabase } from './database.js';
