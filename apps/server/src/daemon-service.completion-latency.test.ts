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
const QUERY_DURATION_MS = 60;

type Timing = { messageWriteEndedAt?: number };

class DelayedDatabase implements SqlDatabase {
  constructor(
    private readonly database: SqlDatabase,
    private readonly timing: Timing,
  ) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    await new Promise((resolve) => setTimeout(resolve, QUERY_DURATION_MS));
    const result = await this.database.query<Row>(sql, values);
    if (/INSERT INTO messages\(|WITH inserted AS \(\s*INSERT INTO messages\(/.test(sql))
      this.timing.messageWriteEndedAt = performance.now();
    return result;
  }

  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.database.transaction((database) =>
      work(new DelayedDatabase(database, this.timing)),
    );
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
    const daemon = new DaemonService(delayed, live);

    await daemon.execute(
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
    expect(timing.messageWriteEndedAt).toBeDefined();
    expect(dispatchedAt - timing.messageWriteEndedAt!).toBeLessThan(QUERY_DURATION_MS);
    expect(
      (
        await database.query<{ state: string; result_message_id: string | null }>(
          `SELECT state,result_message_id FROM agent_commands WHERE turn_request_id=$1`,
          [REQUEST],
        )
      ).rows[0],
    ).toEqual({ state: 'complete', result_message_id: expect.any(String) });
  }, 10_000);

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
    const delayed = new DelayedDatabase(database, {});
    const startedAt = performance.now();

    await claimAgentCommand(delayed, ROOM, AGENT, command!.id, `${GENERATION}-claim`);

    expect(performance.now() - startedAt).toBeLessThan(QUERY_DURATION_MS * 2);
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
});
