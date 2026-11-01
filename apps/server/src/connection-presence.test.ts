import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { ConnectionPresence, recordAgentEvidence, claimAgentConnection } from './connection-presence.js';
import { LiveHub } from './live.js';
import { runMaintenance } from './background.js';
import type { SqlDatabase } from './database.js';
import { createAgentCommand } from './agent-command.js';

const ROOM = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const AGENT = 'b'.repeat(64);
const HUMAN = 'a'.repeat(64);
const MESSAGE = 'c'.repeat(64);

describe('delivery-driven presence', () => {
  let database: PgliteDatabase;
  let live: LiveHub;
  let presence: ConnectionPresence;
  beforeEach(async () => {
    database = await migratedDatabase();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner',NULL),($2,'agent','Bee','bee')`,
      [HUMAN, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'General'),($2,$3,'Other')`,
      [ROOM, OTHER, WORKSPACE],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$4,'member'),($1,$3,$4,'member'),($1,$2,$5,'owner')`,
      [WORKSPACE, ROOM, OTHER, AGENT, HUMAN],
    );
    live = new LiveHub();
    presence = new ConnectionPresence(database, live, 50);
  });
  afterEach(async () => {
    await presence.stop();
    vi.useRealTimers();
    await database.close();
  });
  async function body() {
    return (
      await database.query<{
        body: { status: string; observedAt: number; expiresAt?: number; lifecycleId: string };
      }>(`SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence' LIMIT 1`, [AGENT])
    ).rows[0]!.body;
  }
  async function message() {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@bee Hello')`,
      [MESSAGE, ROOM, HUMAN],
    );
    await presence.observe(ROOM);
  }
  async function elapsed() {
    await vi.advanceTimersByTimeAsync(100);
  }
  it('starts no repeating command, commander wake, or corner attention sweep', async()=>{
    const interval=vi.spyOn(globalThis,'setInterval');
    await presence.start();
    expect(interval.mock.calls.map(call=>call[1])).toEqual([30000]);
    interval.mockRestore();
  });
  it('re-sends pending work on both connection and reconnect without a periodic tick',async()=>{
    const command=await createAgentCommand(database,{roomId:ROOM,agentId:AGENT,sourceMessageId:null,reason:'human_tag'});
    await database.query(`UPDATE agent_commands SET renudged_at=now()-interval '1 hour' WHERE id=$1`,[command!.id]);
    await presence.renewLease();
    await claimAgentConnection(database,live,AGENT,{lifecycleId:'connect'},{connectionId:'one',instanceId:presence.instanceId});
    const first=(await database.query<{renudged_at:Date}>('SELECT renudged_at FROM agent_commands WHERE id=$1',[command!.id])).rows[0]!.renudged_at;
    await claimAgentConnection(database,live,AGENT,{lifecycleId:'reconnect'},{connectionId:'two',instanceId:presence.instanceId});
    const second=(await database.query<{renudged_at:Date}>('SELECT renudged_at FROM agent_commands WHERE id=$1',[command!.id])).rows[0]!.renudged_at;
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
    expect(first.getTime()).toBeGreaterThan(Date.now()-10000);
  });
  it('clears unclaimed optimistic work at the pickup deadline without a reply', async () => {
    const command = await createAgentCommand(database, {
      roomId: ROOM, agentId: AGENT, sourceMessageId: null, turnRequestId: MESSAGE, reason: 'human_tag',
    });
    await database.query(`UPDATE agent_turns SET created_at=now()-interval '1 second' WHERE request_id=$1`, [MESSAGE]);
    const invalidations: string[] = [];
    const unsubscribe = live.subscribeAll(event => {
      if (event.type === 'invalidate') invalidations.push(event.reason);
    });
    await presence.start();
    // The stored deadline has already elapsed; this exercises recovery as well.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await database.query(`SELECT * FROM agent_turns WHERE request_id=$1`, [MESSAGE])).rows).toEqual([]);
    expect((await database.query(`SELECT * FROM messages`)).rows).toEqual([]);
    expect((await database.query(`SELECT state FROM agent_commands WHERE id=$1`, [command!.id])).rows).toEqual([{ state: 'pending' }]);
    expect(invalidations).toContain('turn');
    unsubscribe();
  });
  it('does not let the optimistic deadline clear a helper generation that took over', async () => {
    await createAgentCommand(database, { roomId: ROOM, agentId: AGENT, sourceMessageId: null, turnRequestId: MESSAGE, reason: 'human_tag' });
    await presence.start();
    await database.query(`UPDATE agent_turns SET generation_id='real-helper' WHERE request_id=$1`, [MESSAGE]);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await database.query(`SELECT status,generation_id FROM agent_turns WHERE request_id=$1`, [MESSAGE])).rows)
      .toEqual([{ status: 'working', generation_id: 'real-helper' }]);
  });
  it('uses one bounded query and never resolves tags in historical messages during recovery', async () => {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT lpad(n::text,64,'0'),$1,$2,repeat('@bee historical message ',100),
         now()-interval '1 day'
       FROM generate_series(1,21630) n`,
      [ROOM, HUMAN],
    );
    await presence.announce(ROOM, AGENT, { lifecycleId: 'current' });
    const query = vi.spyOn(database, 'query');
    await presence.observe();
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0]!;
    query.mockRestore();

    // Inspect execution, not a timing threshold: the materialization barrier
    // must discard history BEFORE the expensive current-roster tag subplan.
    const result = await database.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
    const root = (result.rows[0]!['QUERY PLAN'] as Array<{ Plan: Record<string, any> }>)[0]!.Plan;
    const nodes: Array<Record<string, any>> = [];
    const visit = (node: Record<string, any>) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(root);
    expect(
      nodes.some((node) => node['Node Type'] === 'CTE Scan' && node['CTE Name'] === 'candidates'),
    ).toBe(true);
    const messageScan = nodes.find((node) => node['Relation Name'] === 'messages');
    expect(messageScan).toBeDefined();
    expect(String(messageScan!['Index Cond'] ?? messageScan!['Recheck Cond'])).toContain(
      'created_at',
    );
    expect(nodes.some((node) => node.Alias === 'tagged_member')).toBe(false);
    const ambiguityScan = nodes.find((node) => node.Alias === 'rival_member');
    expect(ambiguityScan).toBeDefined();
    expect(ambiguityScan!['Actual Loops']).toBe(0);
  });

  it('serializes and coalesces overlapping observations across Rooms', async () => {
    await presence.stop();
    const releases: Array<() => void> = [];
    const rooms: unknown[] = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    const observingDatabase = {
      query: async (_sql: string, values: unknown[] = []) => {
        rooms.push(values[0]);
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
        return { rows: [], rowCount: 0 };
      },
      transaction: async () => {
        throw new Error('not used');
      },
    } as unknown as SqlDatabase;
    presence = new ConnectionPresence(observingDatabase, new LiveHub());

    const first = presence.observe(ROOM);
    await vi.waitFor(() => expect(rooms).toHaveLength(1));
    const burst = [
      ...Array.from({ length: 50 }, () => presence.observe(ROOM)),
      ...Array.from({ length: 50 }, () => presence.observe(OTHER)),
    ];
    releases.shift()!();
    await vi.waitFor(() => expect(rooms).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(rooms).toHaveLength(3));
    releases.shift()!();
    await Promise.all([first, ...burst]);

    expect(rooms).toEqual([ROOM, ROOM, OTHER]);
    expect(maximumInFlight).toBe(1);
  });

  it('debounces a burst of live invalidations for one Room into one observation', async () => {
    await presence.stop();
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const observingDatabase = {
      query,
      transaction: async () => {
        throw new Error('not used');
      },
    } as unknown as SqlDatabase;
    live = new LiveHub();
    presence = new ConnectionPresence(observingDatabase, live);

    for (let event = 0; event < 100; event += 1)
      live.publish({ type: 'invalidate', roomId: ROOM, reason: 'postgres:messages' });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  });

  it('keeps the stored evidence unchanged while readers age it out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await body()).toMatchObject({ status: 'online', lifecycleId: 'boot-1' });
    expect((await body()).expiresAt).toBeUndefined();
  });
  it('advances pushed evidence on each authenticated refresh, including the same second', async () => {
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    const announced = (await body()).observedAt;
    await recordAgentEvidence(database, live, ROOM, AGENT);
    const first = (await body()).observedAt;
    await recordAgentEvidence(database, live, OTHER, AGENT);
    const second = (await body()).observedAt;
    expect(first).toBeGreaterThan(announced);
    expect(second).toBeGreaterThan(first);
    expect(live.latestAgentPresence(AGENT, ROOM)?.observedAt).toBe(second);
    expect(live.latestAgentPresence(AGENT, OTHER)?.observedAt).toBe(second);
  });
  it('uses a turn as delivery proof, then marks an unanswered attempt offline for every viewer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await message();
    await database.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status)
      VALUES($1,$2,$3,'complete')`,
      [ROOM, MESSAGE, AGENT],
    );
    await elapsed();
    expect((await body()).status).toBe('online');
    // The socket may have disappeared; the authenticated turn remains proof.
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@bee Are you there?')`,
      ['d'.repeat(64), ROOM, HUMAN],
    );
    await presence.observe(ROOM);
    await elapsed();
    expect((await body()).status).toBe('offline');
    expect(live.latestAgentPresence(AGENT, ROOM)?.status).toBe('offline');
    expect(live.latestAgentPresence(AGENT, OTHER)?.status).toBe('offline');
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    expect((await body()).status).toBe('online');
    expect(live.latestAgentPresence(AGENT, OTHER)?.status).toBe('online');
  });
  it('Reproduction VOICE-OFFLINE-1: a spoken turn the call answered itself never reports the helper offline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    const call = '44444444-4444-4444-8444-444444444444';
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Voice call')`,
      ['f'.repeat(64), ROOM, HUMAN],
    );
    await database.query(`INSERT INTO voice_calls(id,room_id,message_id) VALUES($1,$2,$3)`, [
      call,
      ROOM,
      'f'.repeat(64),
    ]);
    await database.query(
      `WITH message AS (INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@bee Are you there?') RETURNING id)
       INSERT INTO voice_messages(message_id,call_id) SELECT id,$4 FROM message`,
      [MESSAGE, ROOM, HUMAN, call],
    );
    await presence.observe(ROOM);
    await elapsed();
    expect((await body()).status).toBe('online');
    expect(
      (await database.query(`SELECT 1 FROM messages WHERE card_type='turn-failed'`)).rowCount,
    ).toBe(0);
    // A spoken order does wake the helper, so its silence still counts.
    const ordered = 'd'.repeat(64);
    await database.query(
      `WITH message AS (INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@bee Fix the build') RETURNING id)
       INSERT INTO voice_messages(message_id,call_id) SELECT id,$4 FROM message`,
      [ordered, ROOM, HUMAN, call],
    );
    await database.query(
      `INSERT INTO voice_orders(source_message_id,call_id,agent_id) VALUES($1,$2,$3)`,
      [ordered, call, AGENT],
    );
    await presence.observe(ROOM);
    await elapsed();
    expect((await body()).status).toBe('offline');
  });
  it('recovers an outstanding delivery deadline after a server redeploy without polling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await message();
    await presence.stop();
    live = new LiveHub();
    presence = new ConnectionPresence(database, live, 50);
    await presence.start();
    expect((await body()).status).toBe('online');
    await elapsed();
    expect((await body()).status).toBe('offline');
  });
  it('cannot let an old delivery deadline demote a recovered lifecycle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await message();
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-2' });
    await elapsed();
    expect((await body()).status).toBe('online');
  });
  it('does not turn refused work into an availability failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await database.query(
      `UPDATE agents SET access_policy='{"type":"allowlist","allow":[]}'::jsonb WHERE agent_id=$1`,
      [AGENT],
    );
    await message();
    await elapsed();
    expect((await body()).status).toBe('online');
  });
  it('does not call a live helper offline when no turn starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await database.query(
      `INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('live-helper',clock_timestamp())
       ON CONFLICT (instance_id) DO UPDATE SET renewed_at=clock_timestamp()`,
    );
    await database.query(
      `INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
       VALUES($1,1,'live-helper','live-helper')`,
      [AGENT],
    );
    await message();
    await elapsed();
    expect((await body()).status).toBe('online');
    expect((await database.query(`SELECT 1 FROM messages WHERE card_type='turn-failed'`)).rowCount).toBe(0);
  });
  it('does not let activity in another Room conceal this failed delivery', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await message();
    await database.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status)
      VALUES($1,$2,$3,'working')`,
      [OTHER, 'e'.repeat(64), AGENT],
    );
    await elapsed();
    expect((await body()).status).toBe('offline');
  });
  it('rechecks permission before blaming a delivery that was revoked while waiting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await message();
    await database.query(
      `UPDATE agents SET access_policy='{"type":"allowlist","allow":[]}'::jsonb WHERE agent_id=$1`,
      [AGENT],
    );
    await elapsed();
    expect((await body()).status).toBe('online');
  });
  it('lets authenticated evidence revive a failed lifecycle after a server restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await message();
    await elapsed();
    await presence.stop();
    presence = new ConnectionPresence(database, new LiveHub(), 50);
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    expect((await body()).status).toBe('online');
  });

  it('requires authenticated evidence instead of accepting a lifecycle-less announcement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await message();
    await elapsed();
    await presence.stop();
    presence = new ConnectionPresence(database, new LiveHub(), 50);
    await presence.announce(ROOM, AGENT);
    expect(await body()).toMatchObject({ status: 'offline', lifecycleId: 'boot-1' });
  });

  it('cannot let a deadline overwrite authenticated evidence that arrived after the mention', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await message();
    await presence.evidence(ROOM, AGENT);
    await elapsed();
    expect((await body()).status).toBe('online');
  });

  it('does not demote authenticated arrival while its durable refresh is blocked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await message();
    const original = database.query.bind(database);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(database, 'query').mockImplementation((async (sql: string, values?: unknown[]) => {
      if (sql.includes('WITH previous AS MATERIALIZED')) await held;
      return original(sql, values);
    }) as typeof database.query);

    const durable = presence.evidence(ROOM, AGENT);
    await elapsed();
    expect((await body()).status).toBe('online');
    release();
    await durable;
  });

  it('coalesces a burst to one in-flight and one pending durable evidence refresh', async () => {
    await presence.stop();
    presence = new ConnectionPresence(database, new LiveHub(), 50, 0);
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    const original = database.query.bind(database);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let evidenceStatements = 0;
    vi.spyOn(database, 'query').mockImplementation((async (sql: string, values?: unknown[]) => {
      if (sql.includes('WITH previous AS MATERIALIZED')) {
        evidenceStatements += 1;
        if (evidenceStatements === 1) await held;
      }
      return original(sql, values);
    }) as typeof database.query);

    const first = presence.evidence(ROOM, AGENT);
    const burst = Array.from({ length: 100 }, () => presence.evidence(OTHER, AGENT));
    release();
    await Promise.all([first, ...burst]);

    expect(evidenceStatements).toBe(2);
    expect(await body()).toMatchObject({ status: 'online', lifecycleId: 'boot-1' });
  });

  it('rate-limits durable evidence refreshes while preserving one trailing refresh', async () => {
    await presence.stop();
    presence = new ConnectionPresence(database, new LiveHub(), 50, 20);
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await presence.evidence(ROOM, AGENT);
    const original = database.query.bind(database);
    let evidenceStatements = 0;
    vi.spyOn(database, 'query').mockImplementation((async (sql: string, values?: unknown[]) => {
      if (sql.includes('WITH previous AS MATERIALIZED')) evidenceStatements += 1;
      return original(sql, values);
    }) as typeof database.query);

    await Promise.all(Array.from({ length: 100 }, () => presence.evidence(ROOM, AGENT)));
    expect(evidenceStatements).toBe(1);

    await Promise.all(Array.from({ length: 100 }, () => presence.evidence(OTHER, AGENT)));
    expect(evidenceStatements).toBe(2);
    expect(await body()).toMatchObject({ status: 'online', lifecycleId: 'boot-1' });
  });

  it('merges evidence into the current row without replacing newer lifecycle metadata', async () => {
    await presence.announce(ROOM, AGENT, {
      lifecycleId: 'boot-new',
      releaseVersion: 'v9',
      sourceSha: 'new-source',
    });
    await recordAgentEvidence(database, live, OTHER, AGENT);
    expect(await body()).toMatchObject({
      status: 'online',
      lifecycleId: 'boot-new',
      releaseVersion: 'v9',
      sourceSha: 'new-source',
    });
  });

  it('WAKE-STORM: real helper changes recover adapter failures without clearing authentication failures', async () => {
    await presence.announce(ROOM, AGENT, { lifecycleId: 'old', releaseVersion: 'v9', sourceSha: 'old-build' });
    const fail = async (kind: string) => {
      const command = await createAgentCommand(database, { roomId: ROOM, agentId: AGENT, sourceMessageId: null, reason: 'human_tag' });
      await database.query(`UPDATE agent_commands SET state='complete',completed_at=now(),
        review_context=jsonb_build_object('failureKind',$2::text) WHERE id=$1`, [command!.id,kind]);
      await database.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,failure_reason)
        VALUES($1,$2,$3,'failed',$4) ON CONFLICT(room_id,request_id,agent_id)
        DO UPDATE SET status='failed',failure_reason=EXCLUDED.failure_reason`, [ROOM,command!.turn_request_id,AGENT,kind]);
      return command!.id;
    };
    const protocol = await fail('helper-out-of-date');
    const auth = await fail('not-signed-in');
    const recovered = async (id: string) => (await database.query<{ recovered: boolean }>(
      `SELECT review_context ? 'helperRecoveredAt' recovered FROM agent_commands WHERE id=$1`, [id])).rows[0]!.recovered;
    await presence.announce(ROOM, AGENT, { lifecycleId: 'same', releaseVersion: 'v9', sourceSha: 'old-build' });
    expect(await recovered(protocol)).toBe(false);
    await presence.announce(ROOM, AGENT, { lifecycleId: 'new-build', releaseVersion: 'v9', sourceSha: 'new-build' });
    expect(await recovered(protocol)).toBe(true);
    expect(await recovered(auth)).toBe(false);
    const failedAgain = await fail('helper-out-of-date');
    await presence.announce(ROOM, AGENT, { lifecycleId: 'reconnect', releaseVersion: 'v9', sourceSha: 'new-build' });
    expect(await recovered(failedAgain)).toBe(false);
    await presence.announce(ROOM, AGENT, { lifecycleId: 'upgraded', releaseVersion: 'v10' });
    expect(await recovered(failedAgain)).toBe(true);
    expect(await recovered(auth)).toBe(false);
  });

  it('keeps the helper version recovery signal across announcements without version metadata', async () => {
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-new', releaseVersion: 'v9', sourceSha: 'source-v9' });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-new' });
    expect(await body()).toMatchObject({ releaseVersion: 'v9', sourceSha: 'source-v9' });
  });

  it('makes a first lifecycle announcement authoritative over a concurrent evidence insert', async () => {
    await presence.stop();
    let insertedEvidence = false;
    const racingDatabase: SqlDatabase = {
      query: database.query.bind(database),
      transaction: async (work) =>
        database.transaction(async (transaction) => {
          const racingTransaction: SqlDatabase = {
            transaction: transaction.transaction.bind(transaction),
            query: async (sql, values) => {
              if (
                !insertedEvidence &&
                sql.includes('INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body') &&
                sql.includes("VALUES($1,$2,'presence','presence',$3::jsonb")
              ) {
                insertedEvidence = true;
                await recordAgentEvidence(transaction, live, ROOM, AGENT);
              }
              return transaction.query(sql, values);
            },
          };
          return work(racingTransaction);
        }),
    };
    presence = new ConnectionPresence(racingDatabase, live, 50);

    await presence.announce(ROOM, AGENT, {
      lifecycleId: 'boot-authoritative',
      releaseVersion: 'v10',
      sourceSha: 'lifecycle-source',
    });

    expect(insertedEvidence).toBe(true);
    expect(await body()).toMatchObject({
      status: 'online',
      lifecycleId: 'boot-authoritative',
      releaseVersion: 'v10',
      sourceSha: 'lifecycle-source',
    });
    const rows = await database.query(
      `SELECT 1 FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
      [AGENT],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('retains lifecycle facts through maintenance and makes no idle writes', async () => {
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await database.query(
      `UPDATE live_outputs SET updated_at=now()-interval '3 hours' WHERE agent_id=$1`,
      [AGENT],
    );
    await runMaintenance(database);
    expect((await body()).status).toBe('online');
    // Database work stays on real timers. A day of fake timeouts with a frozen
    // Date re-arms deadline timers forever and the worker never reports back.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const query = vi.spyOn(database, 'query');
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(query).not.toHaveBeenCalled();
  });
});
