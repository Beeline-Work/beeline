import { describe, expect, it, vi, BackgroundJobRunner, PushDeliveryLoop, migratedDatabase, PhoneService, APNS_MAX_PAYLOAD_BYTES, apnsReadClearRequest, type ReadClearCursor } from './test-support-background.test-support.js';

describe('background advisory-lock ownership', () => {
  it('records a failed job and still runs the next independent job', async () => {
    let clock = 1_000;
    const runner = new BackgroundJobRunner(() => clock);
    const later = vi.fn(async () => {
      clock += 5;
    });
    expect(
      await runner.run('push', async () => {
        clock += 7;
        throw new Error('provider unavailable');
      }),
    ).toEqual({ ok: false });
    await runner.run('schedules', later);
    expect(later).toHaveBeenCalledOnce();
    expect(runner.snapshot()).toEqual({
      push: { lastSuccessAt: null, lastErrorAt: 1_007, lastDurationMs: 7, consecutiveFailures: 1 },
      schedules: {
        lastSuccessAt: 1_012,
        lastErrorAt: null,
        lastDurationMs: 5,
        consecutiveFailures: 0,
      },
    });
    await runner.run('push', async () => {
      clock += 2;
    });
    expect(runner.snapshot().push).toMatchObject({
      lastSuccessAt: 1_014,
      consecutiveFailures: 0,
    });
  });


  it('bounds push history before resolving tags and still delivers a fresh mention', async () => {
    const db = await migratedDatabase();
    try {
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
      // Keep over one page of expired history; query shape and delivery are asserted below.
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         SELECT lpad(n::text,64,'0'),$1,$2,repeat('@owner historical message ',100),
           now()-interval '1 day' FROM generate_series(1,201) n`,
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
      const transactionSqls: string[] = [];
      const transaction = db.transaction.bind(db);
      vi.spyOn(db,'transaction').mockImplementation(async work => transaction(async tx => {
        const query = vi.spyOn(tx,'query');
        try { return await work(tx); }
        finally { transactionSqls.push(...query.mock.calls.map(([sql])=>sql)); }
      }));
      expect(await loop.runOnce()).toBe(0);
      expect(query.mock.calls.some(([sql]) => sql.includes('FROM unclaimed'))).toBe(false);
      expect(send).not.toHaveBeenCalled();

      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner new message')`,
        ['f'.repeat(64), room, agent],
      );
      expect(await loop.runOnce()).toBe(7);
      expect(send).toHaveBeenCalledTimes(7);
      const candidateQueries = transactionSqls.filter(sql => sql.includes('FROM unclaimed'));
      expect(candidateQueries).toHaveLength(1);
      const sql = candidateQueries[0]!;
      query.mockRestore();
      expect(sql).toContain('SELECT * FROM messages WHERE id=queued.message_id OFFSET 0');
      expect(sql).toContain('unnest(context.turn_ids) final_ids(id)');
      expect(sql).not.toContain('FROM messages interruption');
      expect(await loop.runOnce()).toBe(0);
    } finally {
      await db.close();
    }
  });


  it('sends every claimed candidate from one event without a retry batch', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64);
      const agent = 'b'.repeat(64);
      const workspace = '11111111-1111-4111-8111-111111111121';
      const room = '22222222-2222-4222-8222-222222222221';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle)
         VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Push concurrency')`, [workspace]);
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
         SELECT 'conc-token-' || n::text || '-12345678901234567890',$1,'android','physical',
           now()-interval '2 days' FROM generate_series(1,12) n`,
        [human],
      );
      await db.query(
        `INSERT INTO push_delivery_floors(id,started_at)
         VALUES('message-delivery',now()-interval '2 days')`,
      );
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner concurrent')`,
        ['e'.repeat(64), room, agent],
      );
      let inFlight = 0;
      let peak = 0;
      const send = vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
      });
      expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(12);
      expect(send).toHaveBeenCalledTimes(12);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBe(12);
    } finally {
      await db.close();
    }
  });


  it('dispatches a direct message to a Chrome subscription without Firebase configured', async () => {
    const db = await migratedDatabase();
    try {
      const recipient = 'a'.repeat(64),
        sender = 'b'.repeat(64);
      const workspace = '11111111-1111-4111-8111-111111111111';
      const room = '22222222-2222-4222-8222-222222222222';
      const endpoint = 'https://fcm.googleapis.com/fcm/send/test-subscription';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Recipient','recipient'),($2,'human','Sender','sender')`,
        [recipient, sender],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'DM',$3::jsonb)`,
        [room, workspace, JSON.stringify([recipient, sender])],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`,
        [workspace, room, recipient, sender],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment,web_keys) VALUES($1,$2,'web','physical',$3::jsonb)`,
        [endpoint, recipient, JSON.stringify({ p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) })],
      );
      const send = vi.fn(async () => undefined);
      const loop = new PushDeliveryLoop(db, undefined, undefined, { send });
      expect(await loop.runOnce()).toBe(0);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Chrome proof message')`,
        ['c'.repeat(64), room, sender],
      );
      expect(await loop.runOnce()).toBe(1);
      expect(send).toHaveBeenCalledWith(
        endpoint,
        expect.objectContaining({
          text: 'Sender: Chrome proof message',
          recipientIdentityId: recipient,
        }),
      );
    } finally {
      await db.close();
    }
  });


  it('persists an FCM failure without claiming a successful delivery', async () => {
    const db = await migratedDatabase();
    try {
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
    const db = await migratedDatabase();
    try {
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
    const db = await migratedDatabase();
    try {
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
    const db = await migratedDatabase();
    try {
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

  // Audit 9.3: a Room read on another device must clear the phone's shade
  // and badge, not only a Room the phone opens itself.
  it('sends one batched silent read-clear push per iOS device when Rooms are read elsewhere', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        corner = '33333333-3333-4333-8333-333333333333',
        android = 'android-device-token-12345678901234567890',
        ios = 'c0ffee'.repeat(10) + 'abcd';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$3,NULL,'Room'),($2,$3,$1,'fix-auth')`,
        [room, corner, workspace],
      );
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
         ($1,$2,$4,'hello',now()-interval '2 minutes'),($3,$5,$4,'hi',now()-interval '2 minutes'),
         ($6,$2,$4,'again',now()-interval '1 minute')`,
        ['1'.repeat(64), room, '2'.repeat(64), agent, corner, '3'.repeat(64)],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at) VALUES
         ($1,$3,'android','physical',now()-interval '1 hour'),
         ($2,$3,'ios','physical',now()-interval '1 hour')`,
        [android, ios, human],
      );
      await db.query(
        `INSERT INTO push_delivery_claims(message_id,device_token,status)
         SELECT id,$1,'delivered' FROM messages`,
        [ios],
      );
      const firebaseSend = vi.fn().mockResolvedValue(undefined);
      const clearRead = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(
        db,
        { send: firebaseSend },
        { send: vi.fn().mockResolvedValue(undefined), clearRead },
      );
      await loop.runOnce();
      expect(clearRead).not.toHaveBeenCalled();

      const read = (messageId: string) =>
        db.query(
          `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
           SELECT room_id,$2,created_at,id FROM messages WHERE id=$1
           ON CONFLICT(room_id,identity_id) DO UPDATE SET message_id=EXCLUDED.message_id,
             message_created_at=EXCLUDED.message_created_at`,
          [messageId, human],
        );
      await read('1'.repeat(64));
      await loop.runOnce();
      expect(clearRead).toHaveBeenCalledTimes(1);
      expect(clearRead).toHaveBeenLastCalledWith(ios, [
        expect.objectContaining({ channelId: room }),
      ]);

      // Committed reads clear immediately; no interval creates another send.
      await read('2'.repeat(64));
      await read('3'.repeat(64));
      await loop.runOnce();
      expect(clearRead).toHaveBeenCalledTimes(2);
      expect(clearRead.mock.calls[1]![0]).toBe(ios);
      expect(clearRead.mock.calls[1]![1].map((read) => read.channelId).sort()).toEqual(
        [room, corner].sort(),
      );

      await loop.runOnce();
      expect(clearRead).toHaveBeenCalledTimes(2);
      expect(firebaseSend).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });

  // G9-R1: a push names at most 50 Rooms. Overflow,
  // including marks tied on their message's created_at, must go out in later pushes.
  // G9-R5: each push must also fit APNs's 4,096-byte payload limit; 50 Rooms
  // with 64-character message ids made 6,103 bytes.
  it('clears every read Room from one event in payloads that fit APNs', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        ios = 'c0ffee'.repeat(10) + 'abcd',
        count = 50 + 1;
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES($1,$2,'ios','physical')`,
        [ios, human],
      );
      const rooms = (
        await db.query<{ id: string }>(
          `INSERT INTO rooms(id,workspace_id,parent_id,name)
           SELECT gen_random_uuid(),$1,NULL,'Room '||n FROM generate_series(1,$2::int) n RETURNING id::text`,
          [workspace, count],
        )
      ).rows.map((row) => row.id);
      // One statement, so every mark's message shares the same created_at.
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text)
         SELECT md5(id::text)||md5(id::text),id,$1,'hi' FROM rooms`,
        [agent],
      );
      await db.query(
        `INSERT INTO push_delivery_claims(message_id,device_token,status)
         SELECT id,$1,'delivered' FROM messages`,
        [ios],
      );
      await db.query(
        `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
         SELECT room_id,$1,created_at,id FROM messages`,
        [human],
      );
      const clearRead = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(
        db,
        undefined,
        { send: vi.fn().mockResolvedValue(undefined), clearRead },
      );
      await loop.runOnce();
      const sends = clearRead.mock.calls.length;
      await loop.runOnce();
      expect(clearRead).toHaveBeenCalledTimes(sends);
      expect(clearRead.mock.calls.length).toBeGreaterThan(1);
      for (const [token, reads] of clearRead.mock.calls) {
        expect(reads.length).toBeLessThanOrEqual(50);
        const { payload } = apnsReadClearRequest(token, reads, 'app.bundle', 'jwt');
        expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
          APNS_MAX_PAYLOAD_BYTES,
        );
      }
      const cleared = clearRead.mock.calls.flatMap((call) =>
        call[1].map((read: { channelId: string }) => read.channelId),
      );
      expect(new Set(cleared).size).toBe(count);
      expect([...cleared].sort()).toEqual([...rooms].sort());
    } finally {
      await db.close();
    }
  });

  // G9-R2: marking a Room unread moves its mark backwards. That is not a read,
  // so it must not send a silent push that dismisses the Room's notifications.
  it('sends no read-clear push when a Room is marked unread', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        first = '1'.repeat(64),
        second = '2'.repeat(64),
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
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$3,'owner'),($1,$2,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$4,'member')`,
        [workspace, room, human, agent],
      );
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
         ($1,$3,$4,'one',now()-interval '2 minutes'),($2,$3,$4,'two',now()-interval '1 minute')`,
        [first, second, room, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
         VALUES($1,$2,'ios','physical',now()-interval '1 hour')`,
        [ios, human],
      );
      await db.query(
        `INSERT INTO push_delivery_claims(message_id,device_token,status) VALUES
         ($1,$3,'delivered'),($2,$3,'delivered')`,
        [first, second, ios],
      );
      const phone = new PhoneService(db, 'http://local.test');
      const clearRead = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(
        db,
        undefined,
        { send: vi.fn().mockResolvedValue(undefined), clearRead },
      );
      await phone.markRead(room, first, human);
      await loop.runOnce();
      expect(clearRead).toHaveBeenCalledTimes(1);
      // G9-R3: the push carries the server read cursor, so the phone keeps
      // notifications for messages after the read one.
      expect(clearRead).toHaveBeenLastCalledWith(ios, [
        { channelId: room, messageId: first, readMessageIds: [] },
      ]);

      // The mark moves back past every message; second stays in the shade.
      await phone.markUnread(room, first, human);
      await loop.runOnce();
      expect(clearRead).toHaveBeenCalledTimes(1);

      // Reading it is a read, and clears it.
      await phone.markRead(room, second, human);
      await loop.runOnce();
      expect(clearRead).toHaveBeenCalledTimes(2);
      expect(clearRead).toHaveBeenLastCalledWith(ios, [
        { channelId: room, messageId: second, readMessageIds: [] },
      ]);
    } finally {
      await db.close();
    }
  });

  // G9-R3: two messages presented at the same second must not both clear when
  // only the first is read. The push names read messages in server order.
  it('names only the pushed messages at or before the read cursor, in server order', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        zero = '0'.repeat(64),
        first = '1'.repeat(64),
        second = '2'.repeat(64),
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
      // One shared created_at: only (created_at, id) orders these messages.
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
         ($1,$4,$5,'zero',now()-interval '1 minute'),($2,$4,$5,'one',now()-interval '1 minute'),
         ($3,$4,$5,'two',now()-interval '1 minute')`,
        [zero, first, second, room, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
         VALUES($1,$2,'ios','physical',now()-interval '2 hours')`,
        [ios, human],
      );
      await db.query(
        `INSERT INTO push_delivery_claims(message_id,device_token,status) VALUES
         ($1,$4,'delivered'),($2,$4,'delivered'),($3,$4,'delivered')`,
        [zero, first, second, ios],
      );
      const clearRead = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(
        db,
        undefined,
        { send: vi.fn().mockResolvedValue(undefined), clearRead },
      );
      const read = (messageId: string) =>
        db.query(
          `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
           SELECT room_id,$2,created_at,id FROM messages WHERE id=$1
           ON CONFLICT(room_id,identity_id) DO UPDATE SET message_id=EXCLUDED.message_id,
             message_created_at=EXCLUDED.message_created_at`,
          [messageId, human],
        );

      await read(first);
      await loop.runOnce();
      expect(clearRead).toHaveBeenLastCalledWith(ios, [
        expect.objectContaining({ channelId: room, messageId: first, readMessageIds: [zero] }),
      ]);

      await read(second);
      await loop.runOnce();
      expect(clearRead).toHaveBeenLastCalledWith(ios, [
        // first and zero went in the first push, so neither is named again.
        expect.objectContaining({ channelId: room, messageId: second, readMessageIds: [] }),
      ]);
    } finally {
      await db.close();
    }
  });

  // G9-R6: a Room with more read notifications than one push names must
  // still clear them all. Ids left out by the per-Room cap or by the APNs
  // size limit go in a later push; a newer unread notification stays.
  it('clears every read notification from one event without a per-Room id cap', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        ios = 'c0ffee'.repeat(10) + 'abcd';
      const readIds = Array.from({ length: 20 + 2 }, (_, index) =>
        index.toString(16).padStart(64, '0'),
      );
      const unread = 'f'.repeat(64);
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
        `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
         VALUES($1,$2,'ios','physical',now()-interval '2 hours')`,
        [ios, human],
      );
      for (const [index, id] of [...readIds, unread].entries()) {
        await db.query(
          `INSERT INTO messages(id,room_id,author_id,text,created_at)
           VALUES($1,$2,$3,'hi',now()-interval '1 hour'+$4*interval '1 second')`,
          [id, room, agent, index],
        );
        await db.query(
          `INSERT INTO push_delivery_claims(message_id,device_token,status) VALUES($1,$2,'delivered')`,
          [id, ios],
        );
      }
      await db.query(
        `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
         SELECT room_id,$2,created_at,id FROM messages WHERE id=$1`,
        [readIds.at(-1), human],
      );
      const clearRead = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(
        db,
        undefined,
        { send: vi.fn().mockResolvedValue(undefined), clearRead },
      );
      for (let pass = 0; pass < 5; pass += 1) {
        await loop.runOnce();
      }
      const dismissed = new Set(
        clearRead.mock.calls.flatMap(([, reads]: [string, ReadClearCursor[]]) =>
          reads.flatMap((read) => [read.messageId, ...read.readMessageIds]),
        ),
      );
      expect(clearRead).toHaveBeenCalledOnce();
      expect([...dismissed].sort()).toEqual([...readIds].sort());
      expect(dismissed.has(unread)).toBe(false);
    } finally {
      await db.close();
    }
  });
});
