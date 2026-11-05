import { reportSquireWork, squireWorkStatus } from './squire-machine.js';

import { DISPLAY_DEADLINE_KEY } from './deadline-expiry-source.js';

import { BackgroundWork } from './background-work.js';

import { SENTRY_TRIAGE_ROOM, sentryEligibilityKey } from './sentry-wake-source.js';

import { PENDING_ATTACHMENT_DUE_KEY } from './pending-attachment-source.js';

import { AGENT_SCHEDULE_DUE_KEY } from './agent-schedule-source.js';

import { COMMAND_COMPLETION_CHANNEL, subscribeCommandCompletion } from './command-completion.js';

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueryResultRow } from 'pg';

import { type SqlDatabase } from './database.js';

import { DeadlineExpiry } from './deadline-expiry.js';

import { LiveHub, type LiveEvent } from './live.js';

import {
  announceAgentLifecycle,
  claimAgentConnection,
  ConnectionPresence,
} from './connection-presence.js';

import {
  notifyAgentConfigChange,
  notifyConnectorAssignment,
  POSTGRES_LIVE_CHANNEL,
  postgresLiveSchema,
  PostgresLiveListener,
  type LivePgClient,
} from './postgres-live.js';

import { seedCornerOpening, PgliteDatabase, migratedDatabase, assignCornerWorker, recordCornerRun, insertCornerFacts } from './test-support.js';

import { PhoneService } from './phone-service.js';

import { createAgentCommand } from './agent-command.js';

import { MCP_WEBHOOK_TABLE } from './rooms-mcp-members.js';


export const AUTHOR = 'a'.repeat(64);

export const WORKSPACE = '11111111-1111-4111-8111-111111111111';

export const ROOM = '22222222-2222-4222-8222-222222222222';


export const DATABASE_SNAPSHOT = await (async () => {
  const database = await migratedDatabase();
  try {
    return await database.snapshot();
  } finally {
    await database.close();
  }
})();


export class PgliteListenClient extends EventEmitter implements LivePgClient {
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


export async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await predicate()).toBe(true);
}


/** Wait until every earlier notification has reached the parent, then forget them. */
export async function settle(parent: LiveEvent[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  parent.length = 0;
}


/** Reads the database clock shifted by `offsetMs`, as a skewed server would. */
export class SkewedClockDatabase implements SqlDatabase {
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
export function fixtureScope1() {

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
return {
get database(){return database;}, set database(value: typeof database){database=value;},
listeners,
completionReleases,
insertExpiringOwed,
};
}
export { reportSquireWork, squireWorkStatus } from './squire-machine.js';
export { DISPLAY_DEADLINE_KEY } from './deadline-expiry-source.js';
export { BackgroundWork } from './background-work.js';
export { SENTRY_TRIAGE_ROOM, sentryEligibilityKey } from './sentry-wake-source.js';
export { PENDING_ATTACHMENT_DUE_KEY } from './pending-attachment-source.js';
export { AGENT_SCHEDULE_DUE_KEY } from './agent-schedule-source.js';
export { COMMAND_COMPLETION_CHANNEL, subscribeCommandCompletion } from './command-completion.js';
export { EventEmitter } from 'node:events';
export { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
export { DeadlineExpiry } from './deadline-expiry.js';
export { LiveHub } from './live.js';
export { announceAgentLifecycle, claimAgentConnection, ConnectionPresence } from './connection-presence.js';
export { notifyAgentConfigChange, notifyConnectorAssignment, POSTGRES_LIVE_CHANNEL, postgresLiveSchema, PostgresLiveListener } from './postgres-live.js';
export { seedCornerOpening, PgliteDatabase, migratedDatabase, assignCornerWorker, recordCornerRun, insertCornerFacts } from './test-support.js';
export { PhoneService } from './phone-service.js';
export { createAgentCommand } from './agent-command.js';
export { MCP_WEBHOOK_TABLE } from './rooms-mcp-members.js';
export type { QueryResultRow } from 'pg';
export type { SqlDatabase } from './database.js';
export type { LiveEvent } from './live.js';
export type { LivePgClient } from './postgres-live.js';
