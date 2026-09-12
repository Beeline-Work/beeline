import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { ConnectionPresence, recordAgentEvidence } from './connection-presence.js';
import { LiveHub } from './live.js';
import { runMaintenance } from './background.js';
import type { SqlDatabase } from './database.js';

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
    database = new PgliteDatabase();
    await migrate(database);
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
      await database.query<{ body: { status: string; expiresAt?: number; lifecycleId: string } }>(
        `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence' LIMIT 1`,
        [AGENT],
      )
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
  it('keeps the stored evidence unchanged while readers age it out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await body()).toMatchObject({ status: 'online', lifecycleId: 'boot-1' });
    expect((await body()).expiresAt).toBeUndefined();
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await database.query(
      `UPDATE live_outputs SET updated_at=now()-interval '3 hours' WHERE agent_id=$1`,
      [AGENT],
    );
    await runMaintenance(database);
    expect((await body()).status).toBe('online');
    const query = vi.spyOn(database, 'query');
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(query).not.toHaveBeenCalled();
  });
});
