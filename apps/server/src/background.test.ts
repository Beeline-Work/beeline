import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundLeader,
  createPushTestSender,
  MediaExpiryLoop,
  PushDeliveryLoop,
  runMaintenance,
  type LeaderConnection,
} from './background.js';
import { migrate } from './database.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PgliteDatabase } from './test-support.js';
import { MEDIA_SWEEP_INTERVAL_MS, MEDIA_TTL_HOURS, mediaTtlHours } from './media-ttl.js';
import { ApnsPushError } from './apns-push.js';

describe('background advisory-lock ownership', () => {
  it('releases and reconnects after its dedicated connection health check fails', async () => {
    let connections = 0;
    let released = false;
    let cycles = 0;
    const connectDedicated = async (): Promise<LeaderConnection> => {
      connections += 1;
      const connection = connections;
      return {
        query: async <Row>(sql: string) => {
          if (sql === 'SELECT 1' && connection === 1) throw new Error('connection died');
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] as Row[] };
          return { rows: [{} as Row] };
        },
        release: (destroy) => {
          if (connection === 1 && destroy) released = true;
        },
      };
    };
    const leader = new BackgroundLeader(
      { connectDedicated },
      async () => {
        cycles += 1;
      },
      1,
    );
    const running = leader.run();

    await until(() => cycles > 0);
    leader.stop();
    await running;

    expect(connections).toBeGreaterThanOrEqual(2);
    expect(released).toBe(true);
  });

  it('moves work to the peer after the lock-holder connection dies', async () => {
    const lock = new FakeAdvisoryLock();
    let first = 0;
    let second = 0;
    const leaderA = new BackgroundLeader(
      { connectDedicated: () => lock.connect('a') },
      async () => {
        first += 1;
      },
      5,
    );
    const leaderB = new BackgroundLeader(
      { connectDedicated: () => lock.connect('b') },
      async () => {
        second += 1;
      },
      5,
    );
    const runningA = leaderA.run();
    const runningB = leaderB.run();
    await until(() => first > 1);
    expect(second).toBe(0);
    lock.killOwner();
    leaderA.stop();
    await until(() => second > 1);
    leaderB.stop();
    await Promise.all([runningA, runningB]);
    expect(first).toBeGreaterThan(1);
    expect(second).toBeGreaterThan(1);
  });
  it('bounds push history before resolving tags and still delivers a fresh mention', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64);
      const workspace = '11111111-1111-4111-8111-111111111111';
      const room = '22222222-2222-4222-8222-222222222222';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle)
         VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [workspace, room, human, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
         VALUES('device-token-12345678901234567890',$1,'android','physical',now()-interval '2 days')`,
        [human],
      );
      await db.query(
        `INSERT INTO push_delivery_floors(id,started_at)
         VALUES('message-delivery',now()-interval '2 days')`,
      );
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         SELECT lpad(n::text,64,'0'),$1,$2,repeat('@owner historical message ',100),
           now()-interval '1 day' FROM generate_series(1,21630) n`,
        [room, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
         SELECT 'device-token-' || n::text || '-12345678901234567890',$1,'android','physical',
           now()-interval '2 days' FROM generate_series(1,6) n`,
        [human],
      );
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
         SELECT 'recent-activity-' || lpad(n::text,6,'0'),$1,$2,'heartbeat','activity',
           now()-interval '30 minutes' FROM generate_series(1,960) n`,
        [room, agent],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      const query = vi.spyOn(db, 'query');
      expect(await loop.runOnce()).toBe(0);
      const candidateQueries = query.mock.calls.filter(([sql]) => sql.includes('FROM unclaimed'));
      expect(candidateQueries).toHaveLength(1);
      const sql = candidateQueries[0]![0];
      query.mockRestore();
      expect(send).not.toHaveBeenCalled();

      const result = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
      type Plan = { Plans?: Plan[]; [key: string]: unknown };
      const root = (result.rows[0]!['QUERY PLAN'] as Array<{ Plan: Plan }>)[0]!.Plan;
      const nodes: Plan[] = [];
      const visit = (node: Plan) => {
        nodes.push(node);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(root);
      expect(
        nodes.some(
          (node) => node['Node Type'] === 'CTE Scan' && node['CTE Name'] === 'recent_messages',
        ),
      ).toBe(true);
      expect(
        Number(
          nodes.find((node) => node['Subplan Name'] === 'CTE recent_messages')?.['Actual Rows'],
        ),
      ).toBe(0);
      expect(nodes.some((node) => node.Alias === 'tagged_member')).toBe(false);
      for (const node of nodes.filter(
        (node) =>
          node['Node Type'] === 'Seq Scan' &&
          ['identities', 'push_devices'].includes(String(node['Relation Name'])),
      ))
        expect(Number(node['Actual Loops'])).toBeLessThanOrEqual(1);
      const ambiguityScan = nodes.find((node) => node.Alias === 'rival_member');
      expect(ambiguityScan).toBeDefined();
      expect(ambiguityScan!['Actual Loops']).toBe(0);

      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner new message')`,
        ['f'.repeat(64), room, agent],
      );
      expect(await loop.runOnce()).toBe(7);
      expect(send).toHaveBeenCalledTimes(7);
      expect(await loop.runOnce()).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('holds a cadence floor even when wakeups ask for back-to-back push scans', async () => {
    const db = new PgliteDatabase();
    let now = 1_000;
    try {
      await migrate(db);
      const query = vi.spyOn(db, 'query');
      const loop = new PushDeliveryLoop(db, { send: async () => {} }, undefined, 5_000, () => now);

      await loop.runIfDue();
      const afterFirst = query.mock.calls.length;
      await loop.runIfDue();
      expect(query).toHaveBeenCalledTimes(afterFirst);
      expect(loop.millisecondsUntilNextRun()).toBe(5_000);

      now += 5_000;
      await loop.runIfDue();
      expect(query.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      await db.close();
    }
  });

  it('persists an FCM failure without claiming a successful delivery', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [workspace, room, human, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('device-token-12345678901234567890',$1,'android','physical')`,
        [human],
      );
      const loop = new PushDeliveryLoop(db, {
        send: async () => {
          throw new Error('FCM unavailable');
        },
      });
      await loop.runOnce();
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner hello')`,
        ['1'.repeat(64), room, agent],
      );
      expect(await loop.runOnce()).toBe(0);
      expect(
        (
          await db.query<{ status: string; error: string }>(
            `SELECT status,error FROM push_delivery_claims`,
          )
        ).rows[0],
      ).toEqual({ status: 'failed', error: 'FCM unavailable' });
    } finally {
      await db.close();
    }
  });
  it('removes an FCM-unregistered device after recording its failed delivery', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        token = 'unregistered-device-token-1234567890';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [workspace, room, human, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES($1,$2,'android','physical')`,
        [token, human],
      );
      const loop = new PushDeliveryLoop(db, {
        send: async () => {
          const error = new Error('NotRegistered');
          Object.assign(error, { code: 'messaging/registration-token-not-registered' });
          throw error;
        },
      });
      await loop.runOnce();
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner hello')`,
        ['1'.repeat(64), room, agent],
      );
      expect(await loop.runOnce()).toBe(0);
      expect((await db.query(`SELECT 1 FROM push_devices WHERE token=$1`, [token])).rowCount).toBe(
        0,
      );
    } finally {
      await db.close();
    }
  });
  it('leaves a registered iOS device alone instead of feeding it to Firebase', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        apns = 'c0ffee'.repeat(10) + 'abcd';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [workspace, room, human, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES($1,$2,'ios','physical')`,
        [apns, human],
      );
      const send = vi.fn(async () => {
        const error = new Error('The registration token is not a valid FCM token');
        Object.assign(error, { code: 'messaging/invalid-registration-token' });
        throw error;
      });
      const loop = new PushDeliveryLoop(db, { send });
      await loop.runOnce();
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner hello')`,
        ['1'.repeat(64), room, agent],
      );

      expect(await loop.runOnce()).toBe(0);
      expect(send).not.toHaveBeenCalled();
      // The registration survives: an APNs token is not FCM's to reject.
      expect((await db.query(`SELECT 1 FROM push_devices WHERE token=$1`, [apns])).rowCount).toBe(
        1,
      );
    } finally {
      await db.close();
    }
  });
  it('routes Android devices to Firebase and iOS devices to APNs', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        android = 'android-device-token-12345678901234567890',
        ios = 'c0ffee'.repeat(10) + 'abcd';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [workspace, room, human, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
         ($1,$3,'android','physical'),($2,$3,'ios','physical')`,
        [android, ios, human],
      );
      const firebaseSend = vi.fn().mockResolvedValue(undefined);
      const apnsSend = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send: firebaseSend }, { send: apnsSend });
      expect(await loop.runOnce()).toBe(0);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner hello')`,
        ['1'.repeat(64), room, agent],
      );

      expect(await loop.runOnce()).toBe(2);
      expect(firebaseSend).toHaveBeenCalledOnce();
      expect(firebaseSend).toHaveBeenCalledWith(android, expect.objectContaining({ roomId: room }));
      expect(apnsSend).toHaveBeenCalledOnce();
      expect(apnsSend).toHaveBeenCalledWith(ios, expect.objectContaining({ roomId: room }));
    } finally {
      await db.close();
    }
  });
  it('routes test pushes by device platform and excludes iOS without APNs configuration', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        android = 'android-device-token-12345678901234567890',
        ios = 'c0ffee'.repeat(10) + 'abcd';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner')`,
        [human],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
         ($1,$3,'android','physical'),($2,$3,'ios','physical')`,
        [android, ios, human],
      );
      const firebaseSend = vi.fn().mockResolvedValue(undefined);
      const apnsSend = vi.fn().mockResolvedValue(undefined);

      await createPushTestSender(db, { send: firebaseSend }, { send: apnsSend })(human);
      expect(firebaseSend).toHaveBeenCalledWith(android, expect.objectContaining({ type: 'test' }));
      expect(apnsSend).toHaveBeenCalledWith(ios, expect.objectContaining({ type: 'test' }));

      firebaseSend.mockClear();
      apnsSend.mockClear();
      await createPushTestSender(db, { send: firebaseSend })(human);
      expect(firebaseSend).toHaveBeenCalledOnce();
      expect(firebaseSend).toHaveBeenCalledWith(android, expect.objectContaining({ type: 'test' }));
      expect(apnsSend).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });
  it('deletes an APNs-unregistered device but retains a transiently failing one', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        ios = 'c0ffee'.repeat(10) + 'abcd',
        transientIos = 'decade'.repeat(10) + '1234';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [workspace, room, human, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
         ($1,$3,'ios','physical'),($2,$3,'ios','physical')`,
        [ios, transientIos, human],
      );
      const loop = new PushDeliveryLoop(
        db,
        { send: vi.fn().mockResolvedValue(undefined) },
        {
          send: vi.fn(async (token) => {
            if (token === ios)
              throw new ApnsPushError(
                'APNs request failed (410 Unregistered)',
                410,
                'Unregistered',
                'unregistered',
              );
            throw new ApnsPushError(
              'APNs request failed (500 InternalServerError)',
              500,
              'InternalServerError',
              'retryable',
            );
          }),
        },
      );
      await loop.runOnce();
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner hello')`,
        ['1'.repeat(64), room, agent],
      );

      expect(await loop.runOnce()).toBe(0);
      expect((await db.query(`SELECT 1 FROM push_devices WHERE token=$1`, [ios])).rowCount).toBe(0);
      expect(
        (await db.query(`SELECT 1 FROM push_devices WHERE token=$1`, [transientIos])).rowCount,
      ).toBe(1);
    } finally {
      await db.close();
    }
  });
  it('delivers only new attention events to the addressed human device', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        otherHuman = 'b'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        directRoom = '33333333-3333-4333-8333-333333333333';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'human','Other','other'),($3,'agent','Bee','bee')`,
        [human, otherHuman, agent],
      );
      await db.query(`UPDATE identities SET push_level='all' WHERE kind='human'`);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,direct_participants)
         VALUES($1,$3,'Room',NULL),($2,$3,'Direct',$4::jsonb)`,
        [room, directRoom, workspace, JSON.stringify([human, agent].sort())],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),
               ($1,$6,$3,'owner'),($1,$6,$5,'member')`,
        [workspace, room, human, otherHuman, agent, directRoom],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
         ('owner-device-token-12345678901234567890',$1,'android','physical'),
         ('other-device-token-12345678901234567890',$2,'android','physical')`,
        [human, otherHuman],
      );
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         VALUES($1,$2,$3,'@owner old mention',now()-interval '1 hour')`,
        ['0'.repeat(64), room, agent],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES
         ($1,$2,$3,'@owner Please review','message',NULL,NULL),
         ($4,$2,$3,'Untargeted','message',NULL,NULL),
         ($5,$2,$6,'@owner My own mention','message',NULL,NULL),
         ($7,$2,$3,'','activity',NULL,NULL),
         ($8,$2,$3,'@bee opened a corner Ship push policy','card','daemon-fact',$9::jsonb),
         ($10,$2,$3,'@bee merged Ship push policy','card','daemon-fact',$11::jsonb),
         ($12,$13,$3,'A direct message','message',NULL,NULL)`,
        [
          '1'.repeat(64),
          room,
          agent,
          '2'.repeat(64),
          '3'.repeat(64),
          human,
          '4'.repeat(64),
          '5'.repeat(64),
          JSON.stringify({
            type: 'corner-open',
            cornerId: directRoom,
            objective: 'Ship push policy',
          }),
          '6'.repeat(64),
          JSON.stringify({
            type: 'corner-complete',
            cornerId: directRoom,
            objective: 'Ship push policy',
            outcome: 'landed',
          }),
          '7'.repeat(64),
          directRoom,
        ],
      );
      expect(await loop.runOnce()).toBe(6);
      expect(send).toHaveBeenCalledTimes(6);
      expect(await loop.runOnce()).toBe(0);
      expect(send).toHaveBeenCalledTimes(6);
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Bee: @owner Please review' }),
      );
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({
          text: '@bee opened a corner Ship push policy',
          target: 'corner',
          roomId: room,
          channelId: directRoom,
          cornerId: directRoom,
        }),
      );
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({
          text: '@bee merged Ship push policy',
          target: 'corner',
          roomId: room,
          channelId: directRoom,
          cornerId: directRoom,
        }),
      );
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Bee: A direct message' }),
      );
      expect(send).not.toHaveBeenCalledWith(
        'other-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Untargeted' }),
      );
      // Ordinary corner mentions must name the corner, not its parent, in both
      // destination fields. The phone prefers cornerId over channelId.
      const corner = '44444444-4444-4444-8444-444444444444';
      await db.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Corner')`,
        [corner, workspace, room],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'member')`,
        [workspace, corner, human],
      );
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text)
         VALUES($1,$2,$3,'@owner Review this corner')`,
        ['8'.repeat(64), corner, agent],
      );
      expect(await loop.runOnce()).toBe(1);
      expect(send).toHaveBeenLastCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({
          messageId: '8'.repeat(64),
          target: 'message',
          roomId: room,
          channelId: corner,
          cornerId: corner,
        }),
      );
    } finally {
      await db.close();
    }
  });
  it("does not deliver another person's corner event to a default mine member", async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        other = 'b'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        corner = '33333333-3333-4333-8333-333333333333';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Owner','owner'),($2,'human','Other','other'),($3,'agent','Bee','bee')`,
        [human, other, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES
         ($1,$3,'Room',NULL),($2,$3,'Corner',$1)`,
        [room, corner, workspace],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
        [workspace, room, human, other, agent],
      );
      await db.query(
        `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective)
         VALUES($1,$2,$3,'Other work')`,
        [corner, agent, other],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
        [human],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
         VALUES($1,$2,$3,'@bee opened a corner Other work','card','daemon-fact',$4::jsonb)`,
        [
          '1'.repeat(64),
          room,
          agent,
          JSON.stringify({ type: 'corner-open', cornerId: corner, objective: 'Other work' }),
        ],
      );

      expect(await loop.runOnce()).toBe(0);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });
  it('suppresses the expected PR-open push after a corner-open push', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        corner = '33333333-3333-4333-8333-333333333333',
        token = 'owner-device-token-12345678901234567890';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES
         ($1,$3,'Room',NULL),($2,$3,'Corner',$1)`,
        [room, corner, workspace],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$4,'owner'),($1,$2,$5,'member'),
         ($1,$3,$4,'owner'),($1,$3,$5,'member')`,
        [workspace, room, corner, human, agent],
      );
      await db.query(
        `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective)
         VALUES($1,$2,$3,'Ship push policy')`,
        [corner, agent, human],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES($1,$2,'android','physical')`,
        [token, human],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);

      await db.query(
        `INSERT INTO messages
           (id,room_id,author_id,text,presentation,card_type,card,system_event)
         VALUES
           ($1,$4,$6,'@bee opened a corner Ship push policy','card','daemon-fact',$7::jsonb,NULL),
           ($2,$5,$6,'@GitHub opened a pull request Ship push policy','system',
             'github-corner-note',$8::jsonb,$9::jsonb),
           ($3,$4,$6,'@bee merged Ship push policy','card','daemon-fact',$10::jsonb,NULL)`,
        [
          '1'.repeat(64),
          '2'.repeat(64),
          '3'.repeat(64),
          room,
          corner,
          agent,
          JSON.stringify({ type: 'corner-open', cornerId: corner, objective: 'Ship push policy' }),
          JSON.stringify({ source: 'github' }),
          JSON.stringify({ verb: 'opened a pull request' }),
          JSON.stringify({
            type: 'corner-complete',
            cornerId: corner,
            objective: 'Ship push policy',
            outcome: 'landed',
          }),
        ],
      );

      expect(await loop.runOnce()).toBe(2);
      expect(send.mock.calls.map(([, message]) => message.messageId)).toEqual([
        '1'.repeat(64),
        '3'.repeat(64),
      ]);
      expect(
        (
          await db.query<{ message_id: string; status: string }>(
            `SELECT message_id,status FROM push_delivery_claims ORDER BY message_id`,
          )
        ).rows,
      ).toEqual([
        { message_id: '1'.repeat(64), status: 'delivered' },
        { message_id: '2'.repeat(64), status: 'suppressed' },
        { message_id: '3'.repeat(64), status: 'delivered' },
      ]);
      expect(await loop.runOnce()).toBe(0);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      await db.close();
    }
  });
  it.each([
    ['off', []],
    ['direct', ['dm', 'mention', 'reply', 'implicit', 'ask']],
    ['mine', ['dm', 'mention', 'reply', 'implicit', 'ask', 'my-corner']],
    ['all', ['dm', 'mention', 'reply', 'implicit', 'ask', 'my-corner', 'other-corner']],
  ] as const)('selects the push candidate matrix for %s', async (level, expected) => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        other = 'b'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        directRoom = '33333333-3333-4333-8333-333333333333',
        mineCorner = '44444444-4444-4444-8444-444444444444',
        otherCorner = '55555555-5555-4555-8555-555555555555';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle,push_level) VALUES
         ($1,'human','Owner','owner',$4),($2,'human','Other','other','mine'),
         ($3,'agent','Bee','bee','mine')`,
        [human, other, agent, level],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id,direct_participants) VALUES
         ($1,$4,'Room',NULL,NULL),($2,$4,'Direct',NULL,$5::jsonb),
         ($3,$4,'Mine',$1,NULL),($6,$4,'Other',$1,NULL)`,
        [
          room,
          directRoom,
          mineCorner,
          workspace,
          JSON.stringify([human, agent].sort()),
          otherCorner,
        ],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),
         ($1,$6,$3,'owner'),($1,$6,$5,'member')`,
        [workspace, room, human, other, agent, directRoom],
      );
      await db.query(
        `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective) VALUES
         ($1,$3,$4,'Mine'),($2,$3,$5,'Other')`,
        [mineCorner, otherCorner, agent, human, other],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
        [human],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);

      const authored = '0'.repeat(64);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'My prior turn')`,
        [authored, room, human],
      );
      const cases = {
        mention: '1'.repeat(64),
        reply: '2'.repeat(64),
        implicit: '3'.repeat(64),
        ask: '4'.repeat(64),
        'my-corner': '5'.repeat(64),
        'other-corner': '6'.repeat(64),
        plain: '7'.repeat(64),
        dm: '8'.repeat(64),
      } as const;
      await db.query(
        `INSERT INTO messages
           (id,room_id,author_id,text,presentation,reply_to_message_id,request_id,card_type,card)
         VALUES
           ($1,$9,$10,'@owner mention','message',NULL,NULL,NULL,NULL),
           ($2,$9,$10,'Reply','message',$11,NULL,NULL,NULL),
           ($3,$9,$10,'Implicit','message',NULL,$11,NULL,NULL),
           ($4,$9,$10,'Bee asks Owner','card',NULL,NULL,'permission',$12::jsonb),
           ($5,$9,$10,'Mine opened','card',NULL,NULL,'daemon-fact',$13::jsonb),
           ($6,$9,$10,'Other opened','card',NULL,NULL,'daemon-fact',$14::jsonb),
           ($7,$9,$10,'Plain agent message','message',NULL,NULL,NULL,NULL),
           ($8,$15,$10,'Direct message','message',NULL,NULL,NULL,NULL)`,
        [
          cases.mention,
          cases.reply,
          cases.implicit,
          cases.ask,
          cases['my-corner'],
          cases['other-corner'],
          cases.plain,
          cases.dm,
          room,
          agent,
          authored,
          JSON.stringify({ status: 'pending', requester: { pubkey: human } }),
          JSON.stringify({ type: 'corner-open', cornerId: mineCorner }),
          JSON.stringify({ type: 'corner-open', cornerId: otherCorner }),
          directRoom,
        ],
      );

      await loop.runOnce();
      const byId = new Map(Object.entries(cases).map(([name, id]) => [id, name]));
      expect(send.mock.calls.map(([, message]) => byId.get(message.messageId)).sort()).toEqual(
        [...expected].sort(),
      );
    } finally {
      await db.close();
    }
  });
  it('retains imported historical presence while expiring ordinary live output', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
         VALUES($1,$2,'legacy','presence','{"status":"online","observedAt":1}',to_timestamp(1)),
               ($1,$2,'expired-turn','draft','{}',to_timestamp(1))`,
        [room, agent],
      );
      await runMaintenance(db);
      expect(
        (await db.query<{ turn_id: string }>(`SELECT turn_id FROM live_outputs`)).rows,
      ).toEqual([{ turn_id: 'legacy' }]);
    } finally {
      await db.close();
    }
  });
});

describe('media TTL sweep', () => {
  const owner = 'c'.repeat(64);
  const fresh = '33333333-3333-4333-8333-333333333333';
  const stale = '44444444-4444-4444-8444-444444444444';

  async function seed() {
    const db = new PgliteDatabase();
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [owner]);
    await db.query(
      `INSERT INTO media(id,owner_id,bytes,mime_type,name,sha256,created_at)
       VALUES($1,$3,'\\x00','image/png','fresh.png',$4,now()-interval '23 hours'),
             ($2,$3,'\\x01','image/png','stale.png',$5,now()-interval '25 hours')`,
      [fresh, stale, owner, 'a'.repeat(64), 'b'.repeat(64)],
    );
    return db;
  }

  it('deletes only media past the TTL and tombstones exactly what it deleted', async () => {
    const db = await seed();
    try {
      expect(MEDIA_TTL_HOURS).toBe(24);
      expect(await new MediaExpiryLoop(db).runOnce()).toBe(1);
      expect((await db.query<{ id: string }>(`SELECT id::text id FROM media`)).rows).toEqual([
        { id: fresh },
      ]);
      expect(
        (await db.query<{ id: string }>(`SELECT id::text id FROM media_expirations`)).rows,
      ).toEqual([{ id: stale }]);
    } finally {
      await db.close();
    }
  });

  it('sweeps hourly, not on every one-second background cycle', async () => {
    const db = await seed();
    try {
      const loop = new MediaExpiryLoop(db);
      const started = Date.now();
      expect(await loop.runOnce(started)).toBe(1);
      // The 23-hour-old row is past the TTL by the time an hour goes by, and is
      // still there because the second cycle never ran a DELETE.
      await db.query(`UPDATE media SET created_at=now()-interval '48 hours'`);
      expect(await loop.runOnce(started + MEDIA_SWEEP_INTERVAL_MS - 1)).toBe(0);
      expect((await db.query(`SELECT id FROM media`)).rows).toHaveLength(1);
      expect(await loop.runOnce(started + MEDIA_SWEEP_INTERVAL_MS)).toBe(1);
      expect((await db.query(`SELECT id FROM media`)).rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it('takes one env override for the window and ignores an unusable value', async () => {
    expect(mediaTtlHours({} as NodeJS.ProcessEnv)).toBe(MEDIA_TTL_HOURS);
    expect(mediaTtlHours({ MEDIA_TTL_HOURS: 'soon' } as NodeJS.ProcessEnv)).toBe(MEDIA_TTL_HOURS);
    expect(mediaTtlHours({ MEDIA_TTL_HOURS: '0' } as NodeJS.ProcessEnv)).toBe(MEDIA_TTL_HOURS);
    expect(mediaTtlHours({ MEDIA_TTL_HOURS: '72' } as NodeJS.ProcessEnv)).toBe(72);
    const db = await seed();
    try {
      expect(await new MediaExpiryLoop(db, 72).runOnce()).toBe(0);
      expect((await db.query(`SELECT id FROM media`)).rows).toHaveLength(2);
    } finally {
      await db.close();
    }
  });
});

class FakeAdvisoryLock {
  owner: string | undefined;
  dead = new Set<string>();
  sequence = 0;
  async connect(process: string): Promise<LeaderConnection> {
    const id = `${process}-${++this.sequence}`;
    return {
      query: async <Row>(sql: string) => {
        if (this.dead.has(id)) throw new Error('connection died');
        if (sql.includes('pg_try_advisory_lock')) {
          const locked = !this.owner || this.owner === id;
          if (locked) this.owner = id;
          return { rows: [{ locked }] as Row[] };
        }
        return { rows: [{} as Row] };
      },
      release: () => {
        if (this.owner === id) this.owner = undefined;
      },
    };
  }
  killOwner() {
    if (this.owner) this.dead.add(this.owner);
  }
}
async function until(check: () => boolean) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
