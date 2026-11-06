import { describe, expect, it, vi, createPushTestSender, PushDeliveryLoop, migratedDatabase, PhoneService, ApnsPushError, ensureSystemDirectMessageRoom, SYSTEM_IDENTITY_ID, cornerTitle, type ReadClearCursor } from './test-support-background.test-support.js';

describe('background advisory-lock ownership', () => {
  // G9-R7: read notifications delivered hours before the read must still
  // clear. The one-hour claim cleanup keeps an iOS or Android device's
  // delivered claims until a read-clear push names them.
  it('clears read notifications delivered more than an hour before the read', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        ios = 'c0ffee'.repeat(10) + 'abcd',
        android = 'android-token';
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
         VALUES($1,$3,'ios','physical',now()-interval '3 hours'),
               ($2,$3,'android','physical',now()-interval '3 hours')`,
        [ios, android, human],
      );
      for (const [index, id] of [...readIds, unread].entries()) {
        await db.query(
          `INSERT INTO messages(id,room_id,author_id,text,created_at)
           VALUES($1,$2,$3,'hi',now()-interval '2 hours'+$4*interval '1 second')`,
          [id, room, agent, index],
        );
        await db.query(
          `INSERT INTO push_delivery_claims(message_id,device_token,status,claimed_at,completed_at)
           VALUES($1,$2,'delivered',now()-interval '2 hours',now()-interval '2 hours'),
                 ($1,$3,'delivered',now()-interval '2 hours',now()-interval '2 hours')`,
          [id, ios, android],
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
      expect([...dismissed].sort()).toEqual([...readIds].sort());
      expect(dismissed.has(unread)).toBe(false);
      expect(
        (
          await db.query<{ count: number }>(
            `SELECT count(*)::int count FROM push_delivery_claims WHERE device_token=$1`,
            [android],
          )
        ).rows[0]?.count,
      ).toBe(readIds.length + 1);
    } finally {
      await db.close();
    }
  });

  // G9-R8: a read days old whose cursor message was delivered but never
  // named still clears it; a newer unread notification stays.
  it('clears an unnamed cursor notification of a read days old', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        ios = 'c0ffee'.repeat(10) + 'abcd',
        cursor = '1'.repeat(64),
        unread = 'f'.repeat(64);
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
         VALUES($1,$2,'ios','physical',now()-interval '3 days')`,
        [ios, human],
      );
      for (const [index, id] of [cursor, unread].entries()) {
        await db.query(
          `INSERT INTO messages(id,room_id,author_id,text,created_at)
           VALUES($1,$2,$3,'hi',now()-interval '2 days 1 hour'+$4*interval '1 second')`,
          [id, room, agent, index],
        );
        await db.query(
          `INSERT INTO push_delivery_claims(message_id,device_token,status,claimed_at,completed_at)
           VALUES($1,$2,'delivered',now()-interval '2 days 1 hour',now()-interval '2 days 1 hour')`,
          [id, ios],
        );
      }
      await db.query(
        `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id,updated_at)
         SELECT room_id,$2,created_at,id,now()-interval '2 days' FROM messages WHERE id=$1`,
        [cursor, human],
      );
      const clearRead = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(
        db,
        undefined,
        { send: vi.fn().mockResolvedValue(undefined), clearRead },
      );
      for (let pass = 0; pass < 3; pass += 1) {
        await loop.runOnce();
      }
      const dismissed = clearRead.mock.calls.flatMap(([, reads]: [string, ReadClearCursor[]]) =>
        reads.flatMap((read) => [read.messageId, ...read.readMessageIds]),
      );
      expect(dismissed).toEqual([cursor]);
    } finally {
      await db.close();
    }
  });

  // Audit 9.3: the viewer's own message from another device advances their
  // read mark (advanceAuthorReadMark), so it clears the notifications before
  // it like any other read.
  it('clears read notifications when the viewer replies from another device', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        first = '1'.repeat(64),
        second = '2'.repeat(64),
        reply = '3'.repeat(64),
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
      const clearRead = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(
        db,
        undefined,
        { send: vi.fn().mockResolvedValue(undefined), clearRead },
      );
      await loop.runOnce();
      expect(clearRead).not.toHaveBeenCalled();

      await new PhoneService(db, 'http://local.test').execute(
        'sendRoomMessage',
        { roomId: room, text: 'on it', messageId: reply },
        human,
      );
      await loop.runOnce();
      expect(clearRead).toHaveBeenCalledOnce();
      expect(clearRead).toHaveBeenLastCalledWith(ios, [
        { channelId: room, messageId: reply, readMessageIds: [second, first] },
      ]);
    } finally {
      await db.close();
    }
  });

  // Audit 9.3 Android: the same rule clears an Android phone's shade through FCM.
  it('clears an Android device through its own sender with the same read rule', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        other = '33333333-3333-4333-8333-333333333333',
        first = '1'.repeat(64),
        second = '2'.repeat(64),
        later = '3'.repeat(64),
        elsewhere = '4'.repeat(64),
        android = 'android-device-token-12345678901234567890';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Other')`,
        [room, other, workspace],
      );
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
         ($1,$5,$7,'one',now()-interval '3 minutes'),($2,$5,$7,'two',now()-interval '2 minutes'),
         ($3,$5,$7,'three',now()-interval '1 minute'),($4,$6,$7,'there',now()-interval '2 minutes')`,
        [first, second, later, elsewhere, room, other, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
         VALUES($1,$2,'android','physical',now()-interval '1 hour')`,
        [android, human],
      );
      await db.query(
        `INSERT INTO push_delivery_claims(message_id,device_token,status)
         SELECT id,$1,'delivered' FROM messages`,
        [android],
      );
      const androidClear = vi.fn().mockResolvedValue(undefined);
      const iosClear = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(
        db,
        { send: vi.fn().mockResolvedValue(undefined), clearRead: androidClear },
        { send: vi.fn().mockResolvedValue(undefined), clearRead: iosClear },
      );
      await db.query(
        `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
         SELECT room_id,$2,created_at,id FROM messages WHERE id=$1`,
        [second, human],
      );
      await loop.runOnce();
      expect(iosClear).not.toHaveBeenCalled();
      expect(androidClear).toHaveBeenCalledOnce();
      expect(androidClear).toHaveBeenLastCalledWith(android, [
        { channelId: room, messageId: second, readMessageIds: [first] },
      ]);
      const unnamed = await db.query<{ message_id: string }>(
        `SELECT message_id FROM push_delivery_claims WHERE read_cleared_at IS NULL ORDER BY message_id`,
      );
      // The newer message and the unread Room keep their notifications.
      expect(unnamed.rows.map((row) => row.message_id)).toEqual([later, elsewhere]);
    } finally {
      await db.close();
    }
  });

  // A token handed to another person must not clear the last person's
  // notifications when the new owner reads the same Room.
  it('names only claims for messages since the device registered', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        before = '1'.repeat(64),
        after = '2'.repeat(64),
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
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
         ($1,$3,$4,'one',now()-interval '2 hours'),($2,$3,$4,'two',now()-interval '1 minute')`,
        [before, after, room, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
         VALUES($1,$2,'ios','physical',now()-interval '1 hour')`,
        [ios, human],
      );
      await db.query(
        `INSERT INTO push_delivery_claims(message_id,device_token,status) VALUES
         ($1,$3,'delivered'),($2,$3,'delivered')`,
        [before, after, ios],
      );
      await db.query(
        `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
         SELECT room_id,$2,created_at,id FROM messages WHERE id=$1`,
        [after, human],
      );
      const clearRead = vi.fn().mockResolvedValue(undefined);
      await new PushDeliveryLoop(
        db,
        undefined,
        { send: vi.fn().mockResolvedValue(undefined), clearRead },
      ).runOnce();
      expect(clearRead).toHaveBeenLastCalledWith(ios, [
        { channelId: room, messageId: after, readMessageIds: [] },
      ]);
    } finally {
      await db.close();
    }
  });

  it('records an APNs failure once and never retries it after time or another event', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64);
      const workspace = '11111111-1111-4111-8111-111111111111';
      const room = '22222222-2222-4222-8222-222222222222';
      const message = '1'.repeat(64);
      const token = 'c0ffee'.repeat(10) + 'abcd';
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
        [token, human],
      );
      const send = vi
        .fn()
        .mockRejectedValueOnce(new Error('APNs request timed out'))
        .mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send: vi.fn() }, { send });
      await loop.runOnce();
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner hello')`,
        [message, room, agent],
      );
      expect(await loop.runOnce()).toBe(0);
      expect((await db.query(`SELECT status,attempts FROM push_delivery_claims WHERE message_id=$1`, [message])).rows)
        .toEqual([{ status: 'failed', attempts: 1 }]);
      expect(await loop.runOnce()).toBe(0);
      await db.query(`UPDATE messages SET text=text||' edited' WHERE id=$1`, [message]);
      expect(await loop.runOnce()).toBe(0);
      expect(send).toHaveBeenCalledOnce();
    } finally { await db.close(); }
  });

  it('routes test pushes by device platform and excludes iOS without APNs configuration', async () => {
    const db = await migratedDatabase();
    try {
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
    const db = await migratedDatabase();
    try {
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
    const db = await migratedDatabase();
    try {
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
      await db.query(`UPDATE identities SET push_level='attention' WHERE kind='human'`);
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
         ($12,$13,$3,'A direct message','message',NULL,NULL),
         ($14,$2,$3,'Muted corner answer','card','relay',$15::jsonb)`,
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
          '9'.repeat(64),
          JSON.stringify({
            direction: 'up',
            cornerId: directRoom,
            anchorMessageId: '5'.repeat(64),
          }),
        ],
      );
      expect(await loop.runOnce()).toBe(2);
      expect(send).toHaveBeenCalledTimes(2);
      expect(await loop.runOnce()).toBe(0);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Bee: @owner Please review', title: '#Room' }),
      );
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Bee: A direct message' }),
      );
      // A DM is titled as the Room list names it: `@` and the peer's handle.
      expect(
        send.mock.calls.find(([, message]) => message.text === 'Bee: A direct message')![1],
      ).toHaveProperty('title', '@bee');
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
          title: '#Room/Corner',
        }),
      );
      // G9-R9: a corner under a DM takes the same `#<parent>/<corner>` title
      // the app gives it, not a DM peer title and not none.
      const dmCorner = '55555555-5555-4555-8555-555555555555';
      await db.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'fix-auth')`,
        [dmCorner, workspace, directRoom],
      );

      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text)
         VALUES($1,$2,$3,'@owner Review this DM corner')`,
        ['a1'.repeat(32), dmCorner, agent],
      );
      expect(await loop.runOnce()).toBe(1);
      expect(send).toHaveBeenLastCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({
          messageId: 'a1'.repeat(32),
          channelId: dmCorner,
          cornerId: dmCorner,
          title: cornerTitle('Direct', 'fix-auth', dmCorner),
        }),
      );
      expect(cornerTitle('Direct', 'fix-auth', dmCorner)).toBe('#Direct/fix-auth');
    } finally {
      await db.close();
    }
  });

  it('names the inline action a notification can answer, and only that one', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        agentDm = '33333333-3333-4333-8333-333333333333';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle,push_level)
         VALUES($1,'human','Owner','owner','attention'),($2,'agent','Wren','wren','off')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Direct',$3::jsonb)`,
        [agentDm, workspace, JSON.stringify([human, agent].sort())],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member'),($1,$3,$4,'member')`,
        [workspace, human, agentDm, agent],
      );
      const systemDm = await ensureSystemDirectMessageRoom(db, workspace, human);
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
        [human],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      const grant = (id: string, status: string) =>
        db.query(
          `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
           VALUES($1,$2,$3,'host','api.stripe.com','checking the webhook',$4,$5,$6)`,
          [id, agent, workspace, human, agentDm, status],
        );
      const pending = '55555555-5555-4555-8555-555555555555',
        second = '66666666-6666-4666-8666-666666666666',
        settled = '77777777-7777-4777-8777-777777777777';
      await grant(pending, 'pending');
      await grant(second, 'pending');
      await grant(settled, 'once');
      const card = (grants: string[]) =>
        JSON.stringify({
          agent: { pubkey: agent, name: 'wren' },
          grants: grants.map((grantId) => ({ grantId, kind: 'host', target: 'api.stripe.com' })),
        });
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES
         ($1,$2,$3,'@wren asked @owner for host api.stripe.com','card','grant-request',$4::jsonb),
         ($5,$2,$3,'@wren asked @owner for host api.stripe.com and host b','card','grant-request',$6::jsonb),
         ($7,$2,$3,'@wren asked @owner for host api.stripe.com','card','grant-request',$8::jsonb),
         ($9,$2,$3,'Beeline 1.2 is out','system',NULL,NULL),
         ($10,$11,$12,'are you there?','message',NULL,NULL)`,
        [
          '1'.repeat(64),
          systemDm,
          SYSTEM_IDENTITY_ID,
          card([pending]),
          '2'.repeat(64),
          card([pending, second]),
          '3'.repeat(64),
          card([settled]),
          '4'.repeat(64),
          '5'.repeat(64),
          agentDm,
          agent,
        ],
      );
      expect(await loop.runOnce()).toBe(5);
      const sent = new Map(
        send.mock.calls.map(([, message]) => [message.messageId as string, message.action]),
      );
      expect(sent.get('1'.repeat(64))).toEqual({
        kind: 'grant',
        grantId: pending,
        grantKind: 'host',
        grantTarget: 'api.stripe.com',
        agentName: 'wren',
      });
      // Three buttons cannot answer two asks, and a settled ask needs none.
      expect(sent.get('2'.repeat(64))).toBeUndefined();
      expect(sent.get('3'.repeat(64))).toBeUndefined();
      // The @system DM is read-only: no Reply on its lines.
      expect(sent.get('4'.repeat(64))).toBeUndefined();
      expect(sent.get('5'.repeat(64))).toEqual({ kind: 'reply', authorName: 'Wren' });
    } finally {
      await db.close();
    }
  });

  it('sends a permission ask whole and stays quiet for an automatic access receipt', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '33333333-3333-4333-8333-333333333333';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle,push_level)
         VALUES($1,'human','Owner','owner','attention'),($2,'agent','Wren','wren','off')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
        [workspace, human],
      );
      const systemDm = await ensureSystemDirectMessageRoom(db, workspace, human);
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
        [human],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      const pending = '55555555-5555-4555-8555-555555555555',
        auto = '66666666-6666-4666-8666-666666666666';
      const target = `node scripts/check.mjs ${'--workspace apps/server '.repeat(8).trim()}`;
      await db.query(
        `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,auto)
         VALUES($1,$3,$4,'command',$6,'check',$5,$7,'pending',false),
               ($2,$3,$4,'mcp','openaiDeveloperDocs','read docs',$5,$7,'approved',true)`,
        [pending, auto, agent, workspace, human, target, room],
      );
      const ask = `Owner wants wren to use ${target}`;
      expect(ask.length).toBeGreaterThan(200);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES
         ($1,$2,$3,$4,'card','grant-request',$5::jsonb),
         ($6,$2,$3,'@wren was granted mcp openaiDeveloperDocs · auto-approved','system','grant-auto',$7::jsonb)`,
        [
          '1'.repeat(64),
          systemDm,
          agent,
          ask,
          JSON.stringify({
            agent: { pubkey: agent, name: 'wren' },
            grants: [{ grantId: pending, kind: 'command', target }],
          }),
          '2'.repeat(64),
          JSON.stringify({ grantId: auto }),
        ],
      );
      expect(await loop.runOnce()).toBe(1);
      expect(send.mock.calls.map(([, message]) => message)).toEqual([
        expect.objectContaining({ messageId: '1'.repeat(64), text: ask, permission: true }),
      ]);
    } finally {
      await db.close();
    }
  });
});
