import { CornerAccessDatabase, CommandScopedDatabase, describe, expect, it, vi, INSTITUTIONAL_HISTORY_MAX_AGE_DAYS, assertSchemaCurrent, backfillMessageSearchDocuments, MESSAGE_SEARCH_DOCUMENT_MAX_BYTES, migrate, APP_POOL_WAIT_TIMEOUT_MS, postgresPoolConfig, REQUIRED_SCHEMA_VERSION, REQUIRED_ROUTER_SCHEMA_VERSION, migrateData, PostgresDatabase, HEALTH_POOL_WAIT_TIMEOUT_MS, MIGRATION_LOCK_TIMEOUT_MS, MIGRATION_STATEMENT_TIMEOUT_MS, isTransientDatabaseConnectionError, PgliteDatabase, migratedDatabase, requireRoomSlug, reserveRoomName, result, TERMINATED, stubClient, poolHandingOut, poolWithQuery, type Pool, type SqlDatabase } from './test-support-database.test-support.js';



it('removes installed Tray clocks and unused provider effects while source writes still work', async () => {
  const database = await migratedDatabase();
  try {
    await database.query(`CREATE TABLE tray_clock_sources(id text);
      CREATE TABLE tray_clock_deadlines(id text);
      CREATE TABLE tray_clock_state(id text);
      CREATE TABLE tray_clock_readiness(id text);
      CREATE TABLE tray_clock_readiness_floor(id text);
      CREATE TABLE tray_clock_health(id text);
      CREATE TABLE tray_clock_owner_fences(id text);
      CREATE TABLE background_leader_owners(id text);
      CREATE TABLE background_effect_attempts(id text);
      CREATE FUNCTION beeline_tray_clock_capture() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO tray_clock_sources VALUES(NEW.id); RETURN NEW; END $$;
      CREATE TRIGGER beeline_tray_clock_message_insert AFTER INSERT ON messages
        FOR EACH ROW EXECUTE FUNCTION beeline_tray_clock_capture();`);
    await migrate(database);
    await migrate(database);
    expect((await database.query(`SELECT tablename FROM pg_tables WHERE schemaname=current_schema()
      AND (tablename LIKE 'tray_clock_%' OR tablename IN ('background_leader_owners','background_effect_attempts'))`)).rows).toEqual([]);
    expect((await database.query(`SELECT proname FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
      AND (proname LIKE 'beeline_tray_clock_%' OR proname IN ('beeline_register_tray_clock_owner','beeline_commit_tray_clock_owner','beeline_background_backend_holds'))`)).rows).toEqual([]);
    const author='f'.repeat(64), workspace='11111111-1111-4111-8111-111111119991', room='22222222-2222-4222-8222-222222229991';
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`,[author]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Clock migration proof')`,[workspace]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof Room')`,[room,workspace]);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES('clock-migration-message',$1,$2,'Please review?')`, [room,author]);
    expect((await database.query(`SELECT text FROM messages WHERE id='clock-migration-message'`)).rows).toEqual([{text:'Please review?'}]);
  } finally { await database.close(); }
});


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
describe('named prepared Room reads', () => {
  it('retains names through access and transaction scopes and separates SQL variants', async () => {
    const client = stubClient();
    const database = new PostgresDatabase('', 1, { pool: poolHandingOut([client, client, client]) });
    const scoped = new CommandScopedDatabase(new CornerAccessDatabase(database));
    const sql = 'SELECT member.identity_id FROM memberships member WHERE member.identity_id=$1';
    await scoped.query(sql, ['first'], 'phone-room-test');
    await scoped.transaction(tx => scoped.run(tx, () => scoped.query(sql, ['second'], 'phone-room-test')));
    await scoped.query(sql + ' AND member.removed_at IS NULL', ['third'], 'phone-room-test');
    const prepared = client.query.mock.calls.filter(([query]) => typeof query === 'object')
      .map(([query]) => query as { name: string; text: string; values: unknown[] });
    expect(prepared).toHaveLength(3);
    expect(prepared[0]).toMatchObject({
      name: expect.stringMatching(/^phone-room-test-/),
      text: sql.replace('FROM memberships', 'FROM room_access'), values: ['first'],
    });
    expect(prepared[1]).toMatchObject({ name: prepared[0]!.name, text: prepared[0]!.text, values: ['second'] });
    expect(prepared[2]!.name).not.toBe(prepared[0]!.name);
    expect(prepared[2]!.values).toEqual(['third']);
    expect(database.queryProfiles().top.some(profile => profile.calls === 2)).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(3);
    await database.close();
  });
});
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
});
