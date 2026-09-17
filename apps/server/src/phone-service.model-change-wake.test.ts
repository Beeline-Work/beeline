import { describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import { migrate, type QueryResult, type SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

const OWNER = 'a'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM_A = '22222222-2222-4222-8222-222222222221';
const ROOM_B = '22222222-2222-4222-8222-222222222222';

type Notify = { channel: string; payload: Record<string, unknown> };

/** Records the pg_notify wakes a transaction issues, then delegates. */
class RecordingDatabase implements SqlDatabase {
  readonly notifies: Notify[];
  constructor(
    private readonly inner: SqlDatabase,
    notifies: Notify[] = [],
  ) {
    this.notifies = notifies;
  }
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    if (sql.includes('pg_notify')) {
      this.notifies.push({
        channel: values[0] as string,
        payload: JSON.parse(values[1] as string) as Record<string, unknown>,
      });
    }
    return this.inner.query<Row>(sql, values);
  }
  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.inner.transaction((database) =>
      work(new RecordingDatabase(database, this.notifies)),
    );
  }
}

async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Charles','lunchboxfortwo'),($2,'agent','Bee','bee')`,
    [OWNER, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES
      ($1,$3,$4,'one'),($2,$3,$4,'two')`,
    [ROOM_A, ROOM_B, WORKSPACE, OWNER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,$4,$2,'owner'),
      ($1,NULL,$5,'member'),($1,$3,$5,'member'),($1,$4,$5,'member')`,
    [WORKSPACE, OWNER, ROOM_A, ROOM_B, AGENT],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
  await database.query(`UPDATE agents SET model_catalog=$2::jsonb WHERE agent_id=$1`, [
    AGENT,
    JSON.stringify([
      { id: 'model', category: 'model', options: [{ id: 'sonnet-5' }, { id: 'opus-6' }] },
      { id: 'effort', category: 'reasoning_effort', options: [{ id: 'high' }, { id: 'max' }] },
    ]),
  ]);
  return database;
}

const change = (database: RecordingDatabase, input: Record<string, unknown>) =>
  new PhoneService(database, 'http://local.test')
    .execute(
      'updateAgentModelSelection',
      { workspaceId: WORKSPACE, agentId: AGENT, ...input },
      OWNER,
    )
    .then(() => database.notifies);

const wake = (notify: Notify) => notify.payload;

describe('a model/effort selection change wakes the agent daemon', () => {
  it('publishes one agent-config wake per Room when the selection changes', async () => {
    const database = await fixture();
    try {
      const notifies = await change(new RecordingDatabase(database), {
        model: 'opus-6',
        effort: 'max',
      });
      expect(notifies.map((notify) => notify.channel)).toEqual([
        POSTGRES_LIVE_CHANNEL,
        POSTGRES_LIVE_CHANNEL,
      ]);
      expect(notifies.map(wake)).toEqual([
        { table: 'agent_config', operation: 'UPDATE', roomId: ROOM_A, agentId: AGENT },
        { table: 'agent_config', operation: 'UPDATE', roomId: ROOM_B, agentId: AGENT },
      ]);
      expect(
        (
          await database.query<{ selected_model: string | null; selected_effort: string | null }>(
            `SELECT selected_model,selected_effort FROM agents WHERE agent_id=$1`,
            [AGENT],
          )
        ).rows[0],
      ).toEqual({ selected_model: 'opus-6', selected_effort: 'max' });
    } finally {
      await database.close();
    }
  });

  it('publishes nothing when the selection did not change', async () => {
    const database = await fixture();
    try {
      const recorder = new RecordingDatabase(database);
      await change(recorder, { model: 'sonnet-5', effort: 'high' });
      expect(recorder.notifies).toHaveLength(2);
      // The exact same selection again: the row is rewritten, but nothing
      // changed, so no wake may leave — a reconnect-shaped no-op stays silent.
      const repeat = new RecordingDatabase(database);
      await change(repeat, { model: 'sonnet-5', effort: 'high' });
      expect(repeat.notifies).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it('publishes a wake for an effort-only change too', async () => {
    const database = await fixture();
    try {
      const recorder = new RecordingDatabase(database);
      await change(recorder, { effort: 'max' });
      expect(recorder.notifies.map(wake)).toEqual([
        { table: 'agent_config', operation: 'UPDATE', roomId: ROOM_A, agentId: AGENT },
        { table: 'agent_config', operation: 'UPDATE', roomId: ROOM_B, agentId: AGENT },
      ]);
    } finally {
      await database.close();
    }
  });
});
