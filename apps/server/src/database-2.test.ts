import { readFile, EventEmitter, describe, expect, it, vi, DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID, assertSchemaCurrent, DatabaseTransactionStartError, backfillAgentHandles, backfillInstitutionalMemoryRollout, backfillPerItemEventSubscriptions, MESSAGE_CURSOR_MS_SQL, migrate, APP_POOL_WAIT_TIMEOUT_MS, APP_STATEMENT_TIMEOUT_MS, ENRICHMENT_POOL_WAIT_TIMEOUT_MS, ENRICHMENT_STATEMENT_TIMEOUT_MS, postgresPoolConfig, REQUIRED_SCHEMA_VERSION, REQUIRED_ROUTER_SCHEMA_VERSION, markSchemaCurrent, migrateData, PostgresDatabase, isTransientDatabaseConnectionError, PgliteDatabase, migratedDatabase, result, poolWithQuery, fixtureScope10, fixtureScope11, fixtureScope12, fixtureScope13, fixtureScope14, fixtureScope15, fixtureScope16, fixtureScope18, fixtureScope19, fixtureScope20, type Pool, type SqlDatabase } from './database.test-support.js';

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
const scope10 = fixtureScope10();


  it('uses the expression index for the seeded inbox query plan', async () => {
    await scope10.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT lpad(value::text,64,'0'),$1,$2,'message',
              '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 millisecond'
       FROM generate_series(1,10000) value`,
      [scope10.ROOM, scope10.AUTHOR],
    );
    await scope10.database.query(`ANALYZE messages`);

    const explained = await scope10.database.query<Record<'QUERY PLAN', unknown>>(
      `EXPLAIN (FORMAT JSON)
       SELECT id,${MESSAGE_CURSOR_MS_SQL} cursor_ms FROM messages
       WHERE room_id=$1 AND (${MESSAGE_CURSOR_MS_SQL},id)>($2::bigint,$3)
       ORDER BY cursor_ms,id LIMIT 101`,
      [scope10.ROOM, Date.parse('2026-01-01T00:00:05Z'), '0'.repeat(64)],
    );
    const plan = JSON.stringify(explained.rows[0]?.['QUERY PLAN']);
    expect(plan).toContain('messages_room_cursor_idx');
    expect(plan).not.toMatch(/"Node Type":"Seq Scan"[^}]*"Relation Name":"messages"/);
  });


  it('keeps same-millisecond order and cursor round-trips tied to the message id', async () => {
    const lowerId = '1'.repeat(64);
    const higherId = '2'.repeat(64);
    await scope10.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
       ($1,$3,$4,'later microsecond','2026-09-06T12:00:00.000900Z'),
       ($2,$3,$4,'earlier microsecond','2026-09-06T12:00:00.000100Z')`,
      [lowerId, higherId, scope10.ROOM, scope10.AUTHOR],
    );

    const first = await scope10.database.query<{ id: string; cursor_ms: number | string }>(
      `SELECT id,${MESSAGE_CURSOR_MS_SQL} cursor_ms FROM messages
       WHERE room_id=$1 ORDER BY cursor_ms,id LIMIT 1`,
      [scope10.ROOM],
    );
    expect(first.rows).toEqual([{ id: lowerId, cursor_ms: 1_788_696_000_000 }]);
    const cursor = first.rows[0]!;
    const after = await scope10.database.query<{ id: string }>(
      `SELECT id FROM messages WHERE room_id=$1
       AND (${MESSAGE_CURSOR_MS_SQL},id)>($2::bigint,$3)
       ORDER BY ${MESSAGE_CURSOR_MS_SQL},id`,
      [scope10.ROOM, cursor.cursor_ms, cursor.id],
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
    const result = await scope10.database.query<{ old_cursor: string; indexed_cursor: string }>(
      `SELECT floor(extract(epoch FROM created_at)*1000)::bigint old_cursor,
              ${MESSAGE_CURSOR_MS_SQL} indexed_cursor
       FROM unnest($1::timestamptz[]) created_at`,
      [timestamps],
    );

    expect(result.rows.every((row) => row.old_cursor === row.indexed_cursor)).toBe(true);
  });
});
describe('the membership inviter migration', () => {
const scope11 = fixtureScope11();


  it('upgrades legacy inviter references so deleting an inviter preserves the member', async () => {
    await scope11.database.query(`ALTER TABLE memberships DROP CONSTRAINT memberships_invited_by_fkey`);
    await scope11.database.query(
      `ALTER TABLE memberships ADD CONSTRAINT memberships_invited_by_fkey
       FOREIGN KEY (invited_by) REFERENCES identities(id)`,
    );
    await scope11.database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Member')`,
      [scope11.OWNER, scope11.MEMBER],
    );
    await scope11.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [scope11.WORKSPACE]);
    await scope11.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
       VALUES($1,NULL,$2,'member',$3)`,
      [scope11.WORKSPACE, scope11.MEMBER, scope11.OWNER],
    );

    await migrate(scope11.database);
    await scope11.database.query(`DELETE FROM identities WHERE id=$1`, [scope11.OWNER]);

    expect(
      (
        await scope11.database.query<{ invited_by: string | null }>(
          `SELECT invited_by FROM memberships WHERE workspace_id=$1 AND identity_id=$2`,
          [scope11.WORKSPACE, scope11.MEMBER],
        )
      ).rows,
    ).toEqual([{ invited_by: null }]);
  });
});
describe('the three-level push migration', () => {
const scope12 = fixtureScope12();


  it('preserves Full activity across repeated migrations', async () => {
    await scope12.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
      scope12.OWNER,
    ]);
    // Simulate a stored preference before repeating the migration.
    await scope12.database.query(`ALTER TABLE identities DROP CONSTRAINT identities_push_level_check`);
    await scope12.database.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [scope12.OWNER]);
    // Repeated migration must preserve the chosen sensitivity.
    await migrate(scope12.database);
    expect(
      (
        await scope12.database.query<{ push_level: string }>(
          `SELECT push_level FROM identities WHERE id=$1`,
          [scope12.OWNER],
        )
      ).rows[0]?.push_level,
    ).toBe('full');
    await scope12.database.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [scope12.OWNER]);
  });
});
describe('the yolo default migration', () => {
const scope13 = fixtureScope13();


  it('keeps an owner\'s explicit yolo off across a release migration', async () => {
    await scope13.database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Off'),($2,'agent','On')`,
      [scope13.OFF_AGENT, scope13.ON_AGENT],
    );
    await scope13.database.query(
      `INSERT INTO agents(agent_id,owner_id,yolo_mode) VALUES($1,$3,false),($2,$3,true)`,
      [scope13.OFF_AGENT, scope13.ON_AGENT, scope13.OWNER],
    );
    await migrate(scope13.database);
    const rows = await scope13.database.query<{ agent_id: string; yolo_mode: boolean }>(
      `SELECT agent_id,yolo_mode FROM agents ORDER BY agent_id`,
    );
    expect(rows.rows).toEqual([
      { agent_id: scope13.ON_AGENT, yolo_mode: true },
      { agent_id: scope13.OFF_AGENT, yolo_mode: false },
    ]);
  });


  it('defaults a newly created agent to yolo on', async () => {
    await scope13.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Fresh')`, [
      scope13.FRESH_AGENT,
    ]);
    await scope13.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [
      scope13.FRESH_AGENT,
      scope13.OWNER,
    ]);
    const rows = await scope13.database.query<{ yolo_mode: boolean }>(
      `SELECT yolo_mode FROM agents WHERE agent_id=$1`,
      [scope13.FRESH_AGENT],
    );
    expect(rows.rows).toEqual([{ yolo_mode: true }]);
  });
});
describe('the institutional memory rollout migration', () => {
const scope14 = fixtureScope14();


  it('enrolls every Workspace live, advances staged rows, and keeps the off switches', async () => {
    await scope14.database.query(
      `INSERT INTO workspaces(id,name) VALUES($1,'Staged'),($2,'Paused'),($3,'Off'),($4,'Plain')`,
      [scope14.STAGED, scope14.PAUSED, scope14.OFF, scope14.PLAIN],
    );
    await scope14.database.query(
      `INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES
         ($1,'shadow'),($2,'paused'),($3,'off')`,
      [scope14.STAGED, scope14.PAUSED, scope14.OFF],
    );

    // One staged row advances to live and one Workspace with no row is enrolled.
    await expect(backfillInstitutionalMemoryRollout(scope14.database)).resolves.toBe(2);
    const stages = await scope14.database.query<{ workspace_id: string; stage: string }>(
      `SELECT workspace_id,stage FROM institutional_memory_workspace_rollouts
       WHERE workspace_id=ANY($1::uuid[]) ORDER BY workspace_id`,
      [[scope14.STAGED, scope14.PAUSED, scope14.OFF, scope14.PLAIN]],
    );
    expect(new Map(stages.rows.map((row) => [row.workspace_id, row.stage]))).toEqual(
      new Map([
        [scope14.STAGED, 'live'],
        [scope14.PAUSED, 'paused'],
        [scope14.OFF, 'off'],
        [scope14.PLAIN, 'live'],
      ]),
    );

    // A second run has nothing left to do.
    await expect(backfillInstitutionalMemoryRollout(scope14.database)).resolves.toBe(0);
  });


  it('defaults a newly inserted rollout row to live', async () => {
    const NEW = '10000000-0000-4000-8000-000000000015';
    await scope14.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'New')`, [NEW]);
    await scope14.database.query(
      `INSERT INTO institutional_memory_workspace_rollouts(workspace_id) VALUES($1)`,
      [NEW],
    );
    const stage = await scope14.database.query<{ stage: string }>(
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
const scope15 = fixtureScope15();


  it('replaces unrelated and duplicate legacy handles with unique name-derived addresses', async () => {
    const human = 'a'.repeat(64);
    const goosy = 'b'.repeat(64);
    const lumen = 'c'.repeat(64);
    const secondLumen = 'd'.repeat(64);
    await scope15.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Alice','alice'),
       ($2,'agent','Goosy','nora'),
       ($3,'agent','Lumen','una'),
       ($4,'agent','Lumen','nora')`,
      [human, goosy, lumen, secondLumen],
    );
    const workspace = '11111111-1111-4111-8111-111111111111';
    await scope15.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Tubing Crew')`, [workspace]);
    await scope15.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,NULL,$4,'member'),($1,NULL,$5,'member')`,
      [workspace, human, goosy, lumen, secondLumen],
    );

    await expect(backfillAgentHandles(scope15.database)).resolves.toBe(3);
    const rows = await scope15.database.query<{ name: string; handle: string }>(
      `SELECT name,handle FROM identities WHERE kind='agent' ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { name: 'Goosy', handle: 'goosy' },
      { name: 'Lumen', handle: 'lumen' },
      { name: 'Lumen', handle: 'lumen_2' },
    ]);
    await expect(backfillAgentHandles(scope15.database)).resolves.toBe(0);
  });


  it('allocates across every Workspace the agent belongs to', async () => {
    const human = 'e'.repeat(64);
    const agent = 'f'.repeat(64);
    const otherWorkspace = '22222222-2222-4222-8222-222222222222';
    await scope15.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline Welcome')`, [
      DEFAULT_WORKSPACE_ID,
    ]);
    await scope15.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Lumen','lumen'),($2,'agent','Lumen','nora')`,
      [human, agent],
    );
    await scope15.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Elsewhere')`, [
      otherWorkspace,
    ]);
    await scope15.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'member'),($3,NULL,$4,'member'),($1,NULL,$4,'member')`,
      [DEFAULT_WORKSPACE_ID, agent, otherWorkspace, human],
    );

    await migrate(scope15.database);

    expect(
      (await scope15.database.query(`SELECT handle FROM identities WHERE id=$1`, [agent])).rows,
    ).toEqual([{ handle: 'lumen_2' }]);
  });
});
describe('the per-item event subscription migration', () => {
const scope16 = fixtureScope16();


  it('strips exactly the per-item kinds, idempotently, and leaves Room-level kinds alone', async () => {
    const database = await migratedDatabase();
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee'),($2,'agent','Owl')`,
      [scope16.AGENT_A, scope16.AGENT_B],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [scope16.WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
      scope16.ROOM,
      scope16.WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions) VALUES
       ($1,$2,$3,'member','["joined","grant-decided","choice-answered"]'::jsonb),
       ($1,$2,$4,'member','["merged"]'::jsonb)`,
      [scope16.WORKSPACE, scope16.ROOM, scope16.AGENT_A, scope16.AGENT_B],
    );
    await expect(backfillPerItemEventSubscriptions(database)).resolves.toBe(1);
    const rows = await database.query<{ identity_id: string; event_subscriptions: string[] }>(
      `SELECT identity_id,event_subscriptions FROM memberships WHERE room_id=$1 ORDER BY identity_id`,
      [scope16.ROOM],
    );
    expect(rows.rows).toEqual([
      { identity_id: scope16.AGENT_A, event_subscriptions: ['joined'] },
      { identity_id: scope16.AGENT_B, event_subscriptions: ['merged'] },
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
const scope18 = fixtureScope18();


  it('adds machine_id before the unique index when the table already exists without it', async () => {
    // Simulate the pre-migration production shape: a workspace_connectors
    // table that already exists WITHOUT the machine_id column. This is what
    // happens when migrate() runs against a database created by an older
    // release: the CREATE TABLE IF NOT EXISTS is a no-op.
    await scope18.database.query(`DROP TABLE IF EXISTS connection_receipts CASCADE`);
    await scope18.database.query(`DROP TABLE IF EXISTS workspace_connections CASCADE`);
    await scope18.database.query(`DROP TABLE IF EXISTS workspace_connectors CASCADE`);

    // Recreate the old schema: same columns but no machine_id / sign_in / etc.
    await scope18.database.query(`
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
    await scope18.database.query(`
      CREATE UNIQUE INDEX workspace_connectors_owner_unique
        ON workspace_connectors(workspace_id, owner_identity_id, connector_type)
    `);

    // This must NOT throw: after the fix, ADD COLUMN IF NOT EXISTS machine_id
    // runs before the unique index that references it.
    await expect(migrate(scope18.database)).resolves.toBeUndefined();

    // Verify machine_id column exists
    const columns = await scope18.database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='workspace_connectors' AND column_name='machine_id'`,
    );
    expect(columns.rows.length).toBe(1);

    // Verify the unique index on machine_id exists
    const indexes = await scope18.database.query<{ indexname: string }>(
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
const scope19 = fixtureScope19();


  it('widens the agent_grants kind check so an upgraded database accepts an mcp route', async () => {
    // The pre-migration production shape: agent_grants already exists, so the
    // CREATE TABLE IF NOT EXISTS is a no-op and the old CHECK survives.
    await scope19.database.query(
      `ALTER TABLE agent_grants DROP CONSTRAINT IF EXISTS agent_grants_kind_check`,
    );
    await scope19.database.query(`ALTER TABLE agent_grants ADD CONSTRAINT agent_grants_kind_check
        CHECK (kind IN ('path','host','secret','device','budget','command'))`);
    const owner = 'a'.repeat(64);
    const agent = 'b'.repeat(64);
    await scope19.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
      [owner, agent],
    );
    await scope19.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
    await scope19.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline Welcome')`, [
      DEFAULT_WORKSPACE_ID,
    ]);
    await scope19.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'welcome')`, [
      WELCOME_ROOM_ID,
      DEFAULT_WORKSPACE_ID,
    ]);
    const storeRoute = (kind: string) =>
      scope19.database.query(
        `INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status)
           VALUES(gen_random_uuid(),$3,$1,$5,$2,'squire','route it',$4,'pending')`,
        [DEFAULT_WORKSPACE_ID, kind, agent, owner, WELCOME_ROOM_ID],
      );

    await expect(storeRoute('mcp')).rejects.toThrow();

    await migrate(scope19.database);

    await expect(storeRoute('mcp')).resolves.toBeDefined();
    // Widening the vocabulary is not removing it: an unknown kind is still refused.
    await expect(storeRoute('nonsense')).rejects.toThrow();
    expect((await scope19.database.query<{ kind: string }>(`SELECT kind FROM agent_grants`)).rows).toEqual([
      { kind: 'mcp' },
    ]);
  });
});
describe('retired app storage — SENTRY-22', () => {
const scope20 = fixtureScope20();


  it('lets the prior release list corners after retirement, including repair of already dropped tables', async () => {
    const database = await migratedDatabase();
    try {
      await scope20.seedCorner(database);
      // Model a database where #3221 already ran; repairing only future upgrades is insufficient.
      await database.query(`DROP TABLE IF EXISTS corner_apps;
        DROP TABLE IF EXISTS corner_app_bindings;
        DROP TABLE IF EXISTS corner_app_installations;`);
      await expect(scope20.readPriorRelease(database)).rejects.toThrow('corner_app_bindings');
      await migrate(database);
      expect((await scope20.readPriorRelease(database)).app_manifest).toBeNull();
      await migrate(database);
      await scope20.readPriorRelease(database);
    } finally {
      await database.close();
    }
  });


  it('keeps existing retired rows and rollback writes across repeated migrations', async () => {
    const database = await migratedDatabase();
    try {
      await scope20.seedCorner(database);
      await database.query(await readFile(new URL('./fixtures/sentry-22-app-schema.sql', import.meta.url), 'utf8'));
      await database.query(`INSERT INTO corner_app_installations(id,workspace_id,installed_by,manifest)
        VALUES($1,$2,$3,'{"name":"Legacy"}')`, [scope20.installation, DEFAULT_WORKSPACE_ID, scope20.viewer]);
      await database.query(`INSERT INTO corner_app_bindings(corner_id,installation_id,instance_id,bound_by)
        VALUES($1,$2,$3,$4)`, [scope20.corner, scope20.installation, scope20.instance, scope20.viewer]);
      await database.query(`INSERT INTO corner_apps(corner_id,slug,author_agent_id,definition)
        VALUES($1,'legacy',$2,'{"command":"legacy"}')`, [scope20.corner, scope20.viewer]);
      await migrate(database);
      await migrate(database);
      expect((await scope20.readPriorRelease(database)).app_manifest).toEqual({ name: 'Legacy' });
      expect((await database.query(`SELECT definition FROM corner_apps WHERE corner_id=$1`, [scope20.corner])).rows)
        .toEqual([{ definition: { command: 'legacy' } }]);
      // Previous images can still write if rolled back. New images expose no app surfaces.
      await database.query(`UPDATE corner_app_installations SET manifest='{"name":"Rollback"}' WHERE id=$1`, [scope20.installation]);
      expect((await scope20.readPriorRelease(database)).app_manifest).toEqual({ name: 'Rollback' });
    } finally {
      await database.close();
    }
  });
});
