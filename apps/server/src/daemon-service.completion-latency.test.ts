import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { QueryResultRow } from 'pg';
import { createAgentCommand, claimAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { migrate, type QueryResult, type SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { PgliteDatabase } from './test-support.js';

const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111118';
const ROOM = '22222222-2222-4222-8222-222222222228';
const REQUEST = 'c'.repeat(64);
const GENERATION = 'latency-generation';
const QUERY_DURATION_MS = 206;
const DELIVERY_AND_PAINT_BUDGET_MS = 174;

type Timing = {
  messageWriteStartedAt?: number;
  messageWriteEndedAt?: number;
  messageWriteStartedAtWall?: number;
  messageWriteEndedAtWall?: number;
  transactionQueries?: number;
  messageWriteQueries?: number;
  queryCalls?: number;
  transactionWrappers?: number;
};

class DelayedDatabase implements SqlDatabase {
  constructor(
    private readonly database: SqlDatabase,
    private readonly timing: Timing,
    private readonly insideTransaction = false,
  ) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.timing.queryCalls = (this.timing.queryCalls ?? 0) + 1;
    if (this.insideTransaction)
      this.timing.transactionQueries = (this.timing.transactionQueries ?? 0) + 1;
    const messageWrite = /INSERT INTO messages\(|WITH inserted AS \(\s*INSERT INTO messages\(/.test(
      sql,
    );
    if (messageWrite) {
      this.timing.messageWriteQueries = (this.timing.messageWriteQueries ?? 0) + 1;
      this.timing.messageWriteStartedAt = performance.now();
      this.timing.messageWriteStartedAtWall = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, QUERY_DURATION_MS));
    const result = await this.database.query<Row>(sql, values);
    if (messageWrite) {
      this.timing.messageWriteEndedAt = performance.now();
      this.timing.messageWriteEndedAtWall = Date.now();
    }
    return result;
  }

  async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    this.timing.transactionWrappers = (this.timing.transactionWrappers ?? 0) + 1;
    // Production's remote database charges one network round trip for BEGIN
    // and another for COMMIT in addition to the application statement.
    await new Promise((resolve) => setTimeout(resolve, QUERY_DURATION_MS));
    const result = await this.database.transaction((database) =>
      work(new DelayedDatabase(database, this.timing, true)),
    );
    await new Promise((resolve) => setTimeout(resolve, QUERY_DURATION_MS));
    return result;
  }
}

describe('agent reply completion latency', () => {
  const database = new PgliteDatabase();

  beforeAll(async () => {
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Human','human'),($2,'agent','Agent','agent')`,
      [HUMAN, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Latency')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,mention_ids)
       VALUES($1,$2,$3,'@agent answer',jsonb_build_array($4::text))`,
      [REQUEST, ROOM, HUMAN, AGENT],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: REQUEST,
      reason: 'human_tag',
    });
    await claimAgentCommand(database, ROOM, AGENT, command!.id, GENERATION);
  });

  afterAll(async () => database.close());

  it('dispatches the committed reply without a serial transaction tail', async () => {
    const timing: Timing = {};
    const delayed = new DelayedDatabase(database, timing);
    const live = new LiveHub();
    const publish = vi.spyOn(live, 'publish');
    const daemon = new DaemonService(
      delayed,
      live,
      undefined,
      undefined,
      false,
      undefined,
      true,
      'machine-test',
    );

    const first = await daemon.execute(
      'postRoomMessage',
      {
        roomId: ROOM,
        requestId: REQUEST,
        generationId: GENERATION,
        text: 'Answer',
        mentionIds: [],
      },
      AGENT,
    );

    const dispatchedAt = performance.now();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invalidate', roomId: ROOM, reason: 'message' }),
    );
    const committedEvent = publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'invalidate' && event.committedRow);
    expect(committedEvent).toMatchObject({
      type: 'invalidate',
      committedRow: { type: 'message', row: { room_id: ROOM, text: 'Answer' } },
      trace: {
        id: expect.any(String),
        databaseAt: expect.any(Number),
        emittedAt: expect.any(Number),
        startedAt: expect.any(Number),
        databaseAwaitResolvedAt: expect.any(Number),
        projectionCompletedAt: expect.any(Number),
        serverInstance: 'machine-test',
      },
    });
    if (committedEvent?.type !== 'invalidate' || !committedEvent.trace)
      throw new Error('committed trace missing');
    expect(committedEvent.trace.startedAt!).toBeGreaterThanOrEqual(
      timing.messageWriteStartedAtWall! - 10,
    );
    expect(committedEvent.trace.startedAt!).toBeLessThanOrEqual(timing.messageWriteEndedAtWall!);
    expect(timing.messageWriteEndedAtWall!).toBeLessThanOrEqual(committedEvent.trace.emittedAt);
    expect(committedEvent.trace.databaseAt).toBeLessThanOrEqual(committedEvent.trace.emittedAt);
    expect(committedEvent.trace.databaseAt).toBeLessThanOrEqual(
      committedEvent.trace.databaseAwaitResolvedAt!,
    );
    expect(committedEvent.trace.databaseAwaitResolvedAt!).toBeLessThanOrEqual(
      committedEvent.trace.projectionCompletedAt!,
    );
    expect(committedEvent.trace.projectionCompletedAt!).toBeLessThanOrEqual(
      committedEvent.trace.emittedAt,
    );
    expect(timing.messageWriteEndedAt).toBeDefined();
    const writeToPublishMs = committedEvent.trace.emittedAt - committedEvent.trace.startedAt!;
    const projectedUpperBoundMs = writeToPublishMs + DELIVERY_AND_PAINT_BUDGET_MS;
    console.info(
      JSON.stringify({
        operation: 'atomic final reply',
        queryDelayMs: QUERY_DURATION_MS,
        explicitTransactionQueries: timing.transactionQueries ?? 0,
        committingStatements: timing.messageWriteQueries,
        writeToPublishMs,
        deliveryAndPaintBudgetMs: DELIVERY_AND_PAINT_BUDGET_MS,
        projectedUpperBoundMs,
      }),
    );
    expect(projectedUpperBoundMs).toBeLessThan(500);
    // The committing CTE is an autocommit statement: no explicit transaction
    // and therefore no separate BEGIN/COMMIT network round trips.
    expect(timing.transactionQueries ?? 0).toBe(0);
    expect(timing.messageWriteQueries).toBe(1);
    expect(dispatchedAt - timing.messageWriteEndedAt!).toBeLessThan(QUERY_DURATION_MS);
    expect(
      (
        await database.query<{ state: string; result_message_id: string | null }>(
          `SELECT state,result_message_id FROM agent_commands WHERE turn_request_id=$1`,
          [REQUEST],
        )
      ).rows[0],
    ).toEqual({ state: 'complete', result_message_id: expect.any(String) });
    const retry = await daemon.execute(
      'postRoomMessage',
      {
        roomId: ROOM,
        requestId: REQUEST,
        generationId: GENERATION,
        text: 'Answer',
        mentionIds: [],
      },
      AGENT,
    );
    expect(retry.id).toBe(first.id);
    await expect(
      daemon.execute(
        'postRoomMessage',
        {
          roomId: ROOM,
          requestId: REQUEST,
          generationId: GENERATION,
          text: 'Different answer',
          mentionIds: [],
        },
        AGENT,
      ),
    ).rejects.toThrow('command result conflict');
    expect(
      (
        await database.query<{ count: number }>(
          `SELECT count(*)::integer count FROM messages WHERE request_id=$1 AND author_id=$2`,
          [REQUEST, AGENT],
        )
      ).rows[0]?.count,
    ).toBe(1);
  }, 10_000);

  it('omits internal server spans unless live-paint diagnostics are enabled', async () => {
    const request = 'f'.repeat(64);
    const generation = `${GENERATION}-ordinary`;
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,mention_ids)
       VALUES($1,$2,$3,'@agent ordinary',jsonb_build_array($4::text))`,
      [request, ROOM, HUMAN, AGENT],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: request,
      reason: 'human_tag',
    });
    await claimAgentCommand(database, ROOM, AGENT, command!.id, generation);
    const live = new LiveHub();
    const publish = vi.spyOn(live, 'publish');

    await new DaemonService(database, live).execute(
      'postRoomMessage',
      { roomId: ROOM, requestId: request, generationId: generation, text: 'Ordinary reply' },
      AGENT,
    );

    const event = publish.mock.calls
      .map(([published]) => published)
      .find((published) => published.type === 'invalidate' && published.committedRow);
    expect(event).toMatchObject({ trace: { startedAt: expect.any(Number) } });
    if (event?.type !== 'invalidate') throw new Error('committed trace missing');
    expect(event.trace).not.toHaveProperty('databaseAwaitResolvedAt');
    expect(event.trace).not.toHaveProperty('projectionCompletedAt');
  });

  it('commits a claimed turn in one representative database round trip', async () => {
    const request = 'd'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,mention_ids)
       VALUES($1,$2,$3,'@agent again',jsonb_build_array($4::text))`,
      [request, ROOM, HUMAN, AGENT],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: request,
      reason: 'human_tag',
    });
    const timing: Timing = {};
    const delayed = new DelayedDatabase(database, timing);
    const startedAt = performance.now();

    await claimAgentCommand(delayed, ROOM, AGENT, command!.id, `${GENERATION}-claim`);

    expect(performance.now() - startedAt).toBeLessThan(QUERY_DURATION_MS * 2);
    expect(timing.transactionWrappers ?? 0).toBe(0);
    expect(timing.queryCalls).toBe(1);
    expect(
      (
        await database.query<{ state: string; status: string }>(
          `SELECT command.state,turn.status
           FROM agent_commands command
           JOIN agent_turns turn ON turn.room_id=command.room_id
             AND turn.request_id=command.turn_request_id AND turn.agent_id=command.agent_id
           WHERE command.id=$1`,
          [command!.id],
        )
      ).rows[0],
    ).toEqual({ state: 'claimed', status: 'working' });
  }, 10_000);

  it('publishes the committed working row with its Room and a pre-write timestamp', async () => {
    const request = 'e'.repeat(64);
    const generation = `${GENERATION}-live`;
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,mention_ids)
       VALUES($1,$2,$3,'@agent live',jsonb_build_array($4::text))`,
      [request, ROOM, HUMAN, AGENT],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: request,
      reason: 'human_tag',
    });
    await claimAgentCommand(database, ROOM, AGENT, command!.id, generation);
    const live = new LiveHub();
    const publish = vi.spyOn(live, 'publish');
    const daemon = new DaemonService(database, live);
    const beforeExecute = Date.now();

    await daemon.execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        requestId: request,
        status: 'working',
        generationId: generation,
        heartbeat: true,
      },
      AGENT,
    );

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'invalidate',
        roomId: ROOM,
        reason: 'turn',
        requestId: request,
        committedRow: {
          type: 'turn',
          row: expect.objectContaining({ room_id: ROOM, status: 'working' }),
        },
        trace: expect.objectContaining({
          startedAt: expect.any(Number),
          databaseAt: expect.any(Number),
          emittedAt: expect.any(Number),
        }),
      }),
    );
    const event = publish.mock.calls.at(-1)?.[0];
    if (event?.type !== 'invalidate' || !event.trace) throw new Error('turn trace missing');
    expect(event.trace.startedAt!).toBeGreaterThanOrEqual(beforeExecute);
    expect(event.trace.startedAt!).toBeLessThanOrEqual(event.trace.databaseAt);
    expect(event.trace.databaseAt).toBeLessThanOrEqual(event.trace.emittedAt);
  });
});
