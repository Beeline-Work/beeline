import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import { claimAgentCommand, routeHumanMessage } from './agent-command.js';
import { migrate, type QueryResult, type SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';

const HUMAN = 'a'.repeat(64);
const TARGET = 'b'.repeat(64);
const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const BASE_ROOM = '20000000-0000-4000-8000-000000000001';

class CountingDatabase implements SqlDatabase {
  queries = 0;
  transactions = 0;

  constructor(private readonly database: SqlDatabase) {}

  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.queries += 1;
    return this.database.query<Row>(sql, values);
  }

  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return this.database.transaction((database) => work(new CountingDatabase(database)));
  }
}

class DelayedCountingDatabase extends CountingDatabase {
  delayElapsedMs = 0;

  constructor(
    database: SqlDatabase,
    private readonly delayMs: number,
  ) {
    super(database);
  }

  override async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const delayStartedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.delayElapsedMs += performance.now() - delayStartedAt;
    return super.query<Row>(sql, values);
  }
}

function percentile(values: readonly number[], fraction: number): number {
  return (
    [...values].sort((left, right) => left - right)[Math.ceil(values.length * fraction) - 1] ?? 0
  );
}

describe('addressed-message routing and claim scaling', () => {
  const database = new PgliteDatabase();

  beforeAll(async () => {
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Human','human'),($2,'agent','Target','target')`,
      [HUMAN, TARGET],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [TARGET, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Scaling')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Base')`, [
      BASE_ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, HUMAN, TARGET, BASE_ROOM],
    );
    await database.query(`
      CREATE TABLE claim_live_notification_audit(table_name text NOT NULL);
      CREATE OR REPLACE FUNCTION audit_claim_live_notification() RETURNS trigger AS $$
      BEGIN
        INSERT INTO claim_live_notification_audit(table_name) VALUES(TG_TABLE_NAME);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER audit_agent_commands AFTER INSERT OR UPDATE ON agent_commands
        FOR EACH ROW EXECUTE FUNCTION audit_claim_live_notification();
      CREATE TRIGGER audit_agent_turns AFTER INSERT OR UPDATE ON agent_turns
        FOR EACH ROW EXECUTE FUNCTION audit_claim_live_notification();
    `);
  });

  afterAll(async () => database.close());

  async function routeAndClaim(request: string, generation: string) {
    await database.query(`TRUNCATE claim_live_notification_audit`);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@target run')`,
      [request, BASE_ROOM, HUMAN],
    );
    // The request row is already committed: measure only server routing through
    // the helper's atomic claim, excluding fixture reads and writes.
    const counted = new CountingDatabase(database);
    await routeHumanMessage(counted, request);
    const command = (
      await database.query<{ id: string }>(
        `SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`,
        [request, TARGET],
      )
    ).rows[0];
    if (!command) throw new Error('routed command missing');
    await claimAgentCommand(counted, BASE_ROOM, TARGET, command.id, generation);
    const notifications = await database.query<{ table_name: string }>(
      `SELECT table_name FROM claim_live_notification_audit ORDER BY table_name`,
    );
    return { queries: counted.queries, transactions: counted.transactions, notifications };
  }

  it('does constant work with thirty active agents and thirty target memberships', async () => {
    const baseline = await routeAndClaim('1'.repeat(64), 'baseline');

    const unrelatedAgents: string[] = [];
    for (let index = 0; index < 29; index += 1) {
      const agent = `c${index.toString(16).padStart(63, '0')}`;
      unrelatedAgents.push(agent);
      await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3)`, [
        agent,
        `Agent ${index}`,
        `agent-${index}`,
      ]);
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, HUMAN]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WORKSPACE, BASE_ROOM, agent],
      );
    }
    const withThirtyAgents = await routeAndClaim('2'.repeat(64), 'thirty-agents');
    for (const agent of unrelatedAgents) {
      await database.query(`DELETE FROM memberships WHERE identity_id=$1`, [agent]);
      await database.query(`DELETE FROM agents WHERE agent_id=$1`, [agent]);
      await database.query(`DELETE FROM identities WHERE id=$1`, [agent]);
    }

    const additionalRooms: string[] = [];
    for (let index = 0; index < 29; index += 1) {
      const room = `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      additionalRooms.push(room);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,$3)`, [
        room,
        WORKSPACE,
        `Room ${index}`,
      ]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [WORKSPACE, room, HUMAN, TARGET],
      );
    }
    const withThirtyMemberships = await routeAndClaim('3'.repeat(64), 'thirty-memberships');
    for (const room of additionalRooms)
      await database.query(`DELETE FROM rooms WHERE id=$1`, [room]);

    for (const result of [baseline, withThirtyAgents, withThirtyMemberships]) {
      expect(result.queries).toBe(5);
      expect(result.transactions).toBe(0);
      expect(result.notifications.rows.map(({ table_name }) => table_name)).toEqual([
        'agent_commands',
        'agent_commands',
        'agent_turns',
      ]);
    }
  }, 20_000);

  it('scales linearly across twenty concurrent conversations without amplification', async () => {
    await database.query(`TRUNCATE claim_live_notification_audit`);
    const requests = Array.from({ length: 20 }, (_, index) =>
      (index + 10).toString(16).padStart(64, '0'),
    );
    for (const request of requests)
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@target concurrent')`,
        [request, BASE_ROOM, HUMAN],
      );

    const counted = new CountingDatabase(database);
    await Promise.all(
      requests.map(async (request, index) => {
        await routeHumanMessage(counted, request);
        const command = (
          await database.query<{ id: string }>(
            `SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`,
            [request, TARGET],
          )
        ).rows[0];
        if (!command) throw new Error('routed command missing');
        await claimAgentCommand(counted, BASE_ROOM, TARGET, command.id, `concurrent-${index}`);
      }),
    );

    const notifications = await database.query<{ count: number }>(
      `SELECT count(*)::integer count FROM claim_live_notification_audit`,
    );
    expect(counted.queries).toBe(20 * 5);
    expect(counted.transactions).toBe(0);
    expect(notifications.rows[0]?.count).toBe(20 * 3);
  }, 20_000);

  it('keeps sustained atomic claims to one statement with bounded query overhead', async () => {
    const requests = Array.from({ length: 20 }, (_, index) =>
      (index + 40).toString(16).padStart(64, '0'),
    );
    const commands: string[] = [];
    for (const request of requests) {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@target sustained')`,
        [request, BASE_ROOM, HUMAN],
      );
      await routeHumanMessage(database, request);
      const command = (
        await database.query<{ id: string }>(
          `SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`,
          [request, TARGET],
        )
      ).rows[0];
      if (!command) throw new Error('routed command missing');
      commands.push(command.id);
    }

    // Stage-one production traces put a slow representative database operation
    // at 206 ms. Measure the actual timer wait separately: CI scheduler delay
    // must not be mistaken for extra claim work. The exact query/transaction
    // counts below still reject an added statement or BEGIN + COMMIT.
    const measurements = await Promise.all(
      commands.map(async (command, index) => {
        const delayed = new DelayedCountingDatabase(database, 206);
        const beganAt = performance.now();
        await claimAgentCommand(
          delayed,
          BASE_ROOM,
          TARGET,
          command,
          `sustained-generation-${index}`,
        );
        const wallMs = performance.now() - beganAt;
        return {
          wallMs,
          overheadMs: wallMs - delayed.delayElapsedMs,
          queries: delayed.queries,
          transactions: delayed.transactions,
        };
      }),
    );

    const wall = measurements.map(({ wallMs }) => wallMs);
    const overhead = measurements.map(({ overheadMs }) => overheadMs);
    console.info('[claim-latency-regression]', {
      samples: measurements.length,
      representativeQueryMs: 206,
      wallP95Ms: Math.round(percentile(wall, 0.95)),
      overheadP95Ms: Math.round(percentile(overhead, 0.95)),
      overheadP99Ms: Math.round(percentile(overhead, 0.99)),
    });
    expect(measurements.every(({ queries }) => queries === 1)).toBe(true);
    expect(measurements.every(({ transactions }) => transactions === 0)).toBe(true);
    // The old 250 ms wall limit allowed only 44 ms above the synthetic 206 ms
    // delay; passing CI already reaches 248 ms. Local query overhead is 2 ms.
    // A sustained 50 ms query regression still fails this gate.
    expect(percentile(overhead, 0.95)).toBeLessThan(50);
    expect(percentile(overhead, 0.99)).toBeLessThan(100);
  }, 20_000);
});
