import { createAgentCommand, claimAgentCommand } from '.././agent-command.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { LiveHub } from '.././live.js';
import { isRoomView, readRoomHistoryOutline, ROOM_VIEW_MESSAGE_LIMIT, type RoomHistoryOutline, type RoomHistoryView, type RoomView } from '@beeline/api-contract/phone';
import { announceAgentLifecycle } from '.././connection-presence.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM, next } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: history-reads', () => {
const fixture = monolithFixture();


  it('projects exact Room read cursors and omits unread state from corners', async () => {
    const corner = '44444444-4444-4444-8444-444444444444';
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Cursor corner')`,
      [corner, WORKSPACE, ROOM],
    );
    for (const [index, id] of [ROOM, corner].entries()) {
      const read = `${index}f`.padEnd(64, 'f');
      const unread = `${index}a`.padEnd(64, 'a');
      await fixture.database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
        ($1,$3,$4,'Read','2026-09-12 01:00:00.100+00'),
        ($2,$3,$4,'Unread','2026-09-12 01:00:00.900+00')`,
        [read, unread, id, AGENT],
      );
      if (id === corner) {
        const view = await fixture.phone.readRoom(id, HUMAN);
        expect(view?.messages.map((message) => message.id)).toEqual([read, unread]);
        expect(view?.viewer.readCursor).toBeUndefined();
        continue;
      }
      expect((await fixture.phone.readRoom(id, HUMAN))?.viewer.readCursor).toEqual({
        messageId: null,
        firstUnreadMessageId: read,
        unreadCount: 2,
      });
      await fixture.phone.markRead(id, read, HUMAN);
      const view = await fixture.phone.readRoom(id, HUMAN);
      expect(view?.messages.map((message) => message.id)).toEqual([read, unread]);
      expect(view?.messages.map((message) => message.createdAtMs)).toEqual([
        Date.parse('2026-09-12T01:00:00.100Z'),
        Date.parse('2026-09-12T01:00:00.900Z'),
      ]);
      // A full read carries each row's write counter, as a delta does.
      expect(view?.messages.map((message) => message.version)).toEqual([0, 0]);
      expect(view?.viewer.readCursor).toEqual({
        messageId: read,
        firstUnreadMessageId: unread,
        unreadCount: 1,
      });
      expect(isRoomView(view)).toBe(true);
      expect(isRoomView({ ...view, viewer: { ...view!.viewer, readCursor: undefined } })).toBe(
        true,
      );
      // The agent's own messages are not unread; the human's cursor never leaks.
      expect((await fixture.phone.readRoom(id, AGENT))?.viewer.readCursor).toEqual({
        messageId: null,
        firstUnreadMessageId: null,
        unreadCount: 0,
      });
      await fixture.phone.markRead(id, unread, HUMAN);
      expect((await fixture.phone.readRoom(id, HUMAN))?.viewer.readCursor).toEqual({
        messageId: unread,
        firstUnreadMessageId: null,
        unreadCount: 0,
      });
    }
  });


  it('pages Workspace members at the query, keeps totals, searches past the first page, and load-more appends', async () => {
    const extras = Array.from({ length: 21 }, (_, index) => ({
      id: createHash('sha256').update(`member-page-${index}`).digest('hex'),
      name: `Zebra ${String(index).padStart(2, '0')}`,
    }));
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle)
       SELECT extra->>'id','human',extra->>'name',lower(replace(extra->>'name',' ',''))
       FROM jsonb_array_elements($1::jsonb) extra`,
      [JSON.stringify(extras)],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       SELECT $1,NULL,extra->>'id','member'
       FROM jsonb_array_elements($2::jsonb) extra`,
      [WORKSPACE, JSON.stringify(extras)],
    );
    const first = (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}`)).json()) as {
      members: Array<{ identity: { pubkey: string; name: string }; role: string }>;
      peopleTotal: number;
      membersTruncated: boolean;
    };
    expect(first.peopleTotal).toBe(1 + extras.length);
    expect(first.members.length).toBeLessThan(first.peopleTotal);
    expect(first.membersTruncated).toBe(true);
    expect(first.members[0]?.role).toBe('owner');
    const offPage = extras[extras.length - 1]!;
    expect(first.members.map((member) => member.identity.pubkey)).not.toContain(offPage.id);

    const search = (await (
      await fixture.request(
        `/v1/phone/workspaces/${WORKSPACE}/members?q=${encodeURIComponent(offPage.name)}`,
      )
    ).json()) as typeof first;
    expect(search.peopleTotal).toBe(1);
    expect(search.members.map((member) => member.identity.pubkey)).toEqual([offPage.id]);

    const more = (await (
      await fixture.request(
        `/v1/phone/workspaces/${WORKSPACE}/members?kind=human&offset=${first.members.length}`,
      )
    ).json()) as typeof first;
    const ids = [...first.members, ...more.members].map((member) => member.identity.pubkey);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(offPage.id);
    expect(more.peopleTotal).toBe(first.peopleTotal);
  });


  it('lets an author or Workspace manager delete a message while retaining its transcript record', async () => {
    const authorMessageId = 'd'.repeat(64);
    await fixture.phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, messageId: authorMessageId, text: 'remove me' },
      AGENT,
    );
    await fixture.phone.execute(
      'setMessageBookmark',
      { roomId: ROOM, messageId: authorMessageId, bookmarked: true },
      HUMAN,
    );
    const memoryItemId = '95000000-0000-4000-8000-000000000001';
    await fixture.database.query(
      `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,
          audience_kind,confidence,version,created_by_command_id)
       VALUES($1,$2,'workspace_fact','message.delete-proof','Delete this source.',$3,$4,
          'workspace',0.9,1,'integration-delete-command')`,
      [memoryItemId, WORKSPACE, ROOM, authorMessageId],
    );
    await fixture.database.query(
      `INSERT INTO institutional_memory_item_sources(item_id,message_id) VALUES($1,$2)`,
      [memoryItemId, authorMessageId],
    );
    const deleteReceipt = await fixture.phone.execute('deleteRoomMessage', { roomId: ROOM, messageId: authorMessageId }, AGENT);
    expect(deleteReceipt).toMatchObject({ id: authorMessageId, deleted: true, presentation: 'system' });

    const authorDeleted = (await fixture.phone.readRoom(ROOM, HUMAN))!.messages.find(
      (message) => message.id === authorMessageId,
    );
    expect(authorDeleted).toMatchObject({
      text: '@bee deleted a message',
      presentation: 'system',
      deleted: true,
      systemEvent: {
        subject: { kind: 'agent', id: AGENT, name: '@bee' },
        verb: 'deleted',
        object: { text: 'a message' },
      },
    });
    expect(authorDeleted?.systemEvent?.consequence).toBeUndefined();
    expect(authorDeleted?.attachments).toBeUndefined();
    expect(authorDeleted?.reactions).toBeUndefined();
    expect(
      (await fixture.phone.execute('listMessageBookmarks', { workspaceId: WORKSPACE }, HUMAN)).bookmarks,
    ).toContainEqual(expect.objectContaining({ messageId: authorMessageId, available: false }));
    expect(
      (
        await fixture.database.query<{ state: string; body: string; deleted_at: Date | null }>(
          `SELECT state,body,deleted_at FROM institutional_memory_items WHERE id=$1`,
          [memoryItemId],
        )
      ).rows[0],
    ).toMatchObject({ state: 'stale', body: '' });

    const managerMessageId = 'e'.repeat(64);
    await fixture.phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, messageId: managerMessageId, text: 'manager removes this' },
      AGENT,
    );
    const laterMessageId = 'f'.repeat(64);
    await fixture.phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, messageId: laterMessageId, text: 'said after' },
      HUMAN,
    );
    const beforeDelete = (await fixture.phone.readRoom(ROOM, HUMAN))!.messages;
    await fixture.phone.execute('deleteRoomMessage', { roomId: ROOM, messageId: managerMessageId }, HUMAN);
    const afterDelete = (await fixture.phone.readRoom(ROOM, HUMAN))!.messages;
    const managerDeleted = afterDelete.find((message) => message.id === managerMessageId);
    expect(managerDeleted).toMatchObject({
      text: '@owner deleted a message · sent by @bee',
      presentation: 'system',
      deleted: true,
      createdAtMs: beforeDelete.find((message) => message.id === managerMessageId)?.createdAtMs,
      systemEvent: {
        subject: { kind: 'person', id: HUMAN, name: '@owner' },
        verb: 'deleted',
        object: { text: 'a message' },
        consequence: 'sent by @bee',
      },
    });
    // The line takes the deleted message's place; nothing new lands at the bottom.
    expect(afterDelete.map((message) => message.id)).toEqual(
      beforeDelete.map((message) => message.id),
    );
    expect(afterDelete.at(-1)?.id).toBe(laterMessageId);
    await fixture.phone.execute('deleteRoomMessage', { roomId: ROOM, messageId: managerMessageId }, AGENT);
    expect(
      (await fixture.phone.readRoom(ROOM, HUMAN))!.messages.find(
        (message) => message.id === managerMessageId,
      )?.text,
    ).toBe('@owner deleted a message · sent by @bee');

    await expect(
      fixture.phone.execute(
        'reactToMessage',
        { roomId: ROOM, messageId: managerMessageId, emoji: '👍' },
        HUMAN,
      ),
    ).rejects.toThrow('message is not available for reaction');
  });


  it('authenticates a daemon on the existing live socket and replays its cursor gap', async () => {
    await announceAgentLifecycle(fixture.database, new LiveHub(), ROOM, AGENT, {
      lifecycleId: 'routing-fixture',
    });
    const activation = (await (
      await fixture.daemonOperation('getRoomInbox', { roomId: ROOM })
    ).json()) as { cursor?: string };
    expect(activation).toMatchObject({ dispatchVersion: 1 });
    const connect = async () => {
      const socket = new WebSocket(`${fixture.origin.replace('http', 'ws')}/v1/phone/live`, [
        `bearer.${fixture.daemonToken}`,
      ]);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      return socket;
    };

    const first = await connect();
    const firstReplay = next(first, 'inbox');
    first.send(JSON.stringify({ type: 'subscribe', roomId: ROOM, cursor: activation.cursor }));
    await next(first, 'subscribed');
    const firstCursor = (await firstReplay).cursor as string | undefined;
    first.close();
    await new Promise<void>((resolve) => first.once('close', resolve));

    const expectedIds = ['7'.repeat(64), '8'.repeat(64), '9'.repeat(64)];
    for (const [index, messageId] of expectedIds.entries()) {
      expect(
        (
          await fixture.operation('sendRoomMessage', {
            roomId: ROOM,
            messageId,
            text: `@bee while disconnected ${index + 1}`,
            mentions: [AGENT],
          })
        ).status,
      ).toBe(200);
    }

    const second = await connect();
    const replayed = next(second, 'inbox');
    second.send(JSON.stringify({ type: 'subscribe', roomId: ROOM, cursor: firstCursor }));
    await next(second, 'subscribed');
    const items = (await replayed).items as Array<{ id: string }>;
    expect(items.filter((item) => expectedIds.includes(item.id)).map((item) => item.id)).toEqual(
      expectedIds,
    );
    second.close();
  });


  it('delivers a durable command whose source was committed behind the history cursor', async () => {
    const cursorId = 'a'.repeat(64);
    const lateId = '1'.repeat(64);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES($1,$2,$3,'@bee cursor row',now() - interval '1 second')`,
      [cursorId, ROOM, HUMAN],
    );
    const activation = (await (
      await fixture.daemonOperation('getRoomInbox', { roomId: ROOM })
    ).json()) as { cursor?: string };
    expect(activation).toMatchObject({ dispatchVersion: 1 });

    // This is the observable result of the T5b interleaving: transaction B's
    // older-created row becomes visible only after the cursor has advanced.
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES($1,$2,$3,'@bee late commit',now() - interval '3 seconds')`,
      [lateId, ROOM, HUMAN],
    );
    await fixture.database.transaction((tx) =>
      createAgentCommand(tx, {
        roomId: ROOM,
        agentId: AGENT,
        sourceMessageId: lateId,
        reason: 'human_tag',
      }),
    );
    const strict = (await (
      await fixture.daemonOperation('getRoomInbox', { roomId: ROOM, after: activation.cursor })
    ).json()) as { items: Array<{ id: string }> };
    expect(strict.items).toContainEqual(expect.objectContaining({ id: lateId }));

  });


  it('fetches an exact Room message in bounded pages under Room membership', async () => {
    const messageId = createHash('sha256').update('long-room-message').digest('hex');
    const body = 'A'.repeat(4_000) + '😀' + 'B'.repeat(4_000);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,attachments)
       VALUES($1,$2,$3,$4,'message',$5::jsonb)`,
      [
        messageId,
        ROOM,
        HUMAN,
        body,
        JSON.stringify([{ url: 'https://media.example/image.png', mimeType: 'image/png' }]),
      ],
    );
    const first = (await (
      await fixture.daemonOperation('getRoomMessage', {
        roomId: ROOM,
        messageId,
      })
    ).json()) as { body: string; nextOffset?: number; attachments: Array<{ url: string }> };
    expect(first.body).toBe(body.slice(0, 4_000));
    expect(first.nextOffset).toBe(4_000);
    expect(first.attachments).toEqual([
      { url: 'https://media.example/image.png', mimeType: 'image/png' },
    ]);
    let assembled = first.body;
    let offset = first.nextOffset;
    while (offset !== undefined) {
      const page = (await (
        await fixture.daemonOperation('getRoomMessage', {
          roomId: ROOM,
          messageId,
          offset,
        })
      ).json()) as { body: string; nextOffset?: number };
      assembled += page.body;
      offset = page.nextOffset;
    }
    expect(assembled.length).toBe(body.length);
    expect(assembled).toContain('😀');
    expect(assembled === body).toBe(true);
    const otherRoom = await fixture.daemonOperation('getRoomMessage', {
      roomId: '99999999-9999-4999-8999-999999999999',
      messageId,
    });
    expect(otherRoom.ok).toBe(false);
  });


  it('reads a corner turn’s own transcript message id from the corner Room', async () => {
    // A corner turn reads messages that live in the corner itself: the active
    // command carries the corner roomId and the transcript ids belong to it.
    const cornerId = '22222222-2222-4222-8222-222222222226';
    const transcriptId = createHash('sha256').update('corner-transcript-row').digest('hex');
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Message corner')`,
      [cornerId, WORKSPACE, ROOM],
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES
       ($1,$2,$3,'Corner trigger','message'),
       ($4,$2,$3,'Corner transcript row the turn must read','message')`,
      ['corner-trigger', cornerId, HUMAN, transcriptId],
    );
    await fixture.database.transaction(async (tx) => {
      const command = await createAgentCommand(tx, {
        roomId: cornerId,
        agentId: AGENT,
        sourceMessageId: 'corner-trigger',
        turnRequestId: 'corner-request',
        reason: 'fixture',
      });
      expect(command).toBeTruthy();
      await claimAgentCommand(tx, cornerId, AGENT, command!.id, 'corner-generation');
    });
    // The helper sends its turn context with the read, so the server binds it
    // to the active corner command; the primary lookup scopes to the corner.
    const read = (await (
      await fixture.daemonOperation('getRoomMessage', {
        roomId: cornerId,
        messageId: transcriptId,
        requestId: 'corner-request',
        generationId: 'corner-generation',
      })
    ).json()) as { body: string };
    expect(read.body).toBe('Corner transcript row the turn must read');
    // The parent Room holds no transcript rows of this corner, so a message
    // id that exists only there must not resolve inside the corner.
    const absent = await fixture.daemonOperation('getRoomMessage', {
      roomId: cornerId,
      messageId: createHash('sha256').update('not-in-corner').digest('hex'),
    });
    expect(absent.ok).toBe(false);
  });


  it('names the stored sha256 of each ready attachment in getRoomMessage', async () => {
    const mediaId = '33333333-3333-4333-8333-333333333331';
    const digest = createHash('sha256').update('screenshot-bytes').digest('hex');
    await fixture.database.query(
      `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
       VALUES($1,$2,'media',$3,'image/jpeg','24419.jpg',16,$4,'ready',now()+interval '24 hours')`,
      [mediaId, HUMAN, `media/${HUMAN}/${digest}`, digest],
    );
    const messageId = createHash('sha256').update('attachment-digest-message').digest('hex');
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,attachments)
       VALUES($1,$2,$3,'screenshot','message',$4::jsonb)`,
      [
        messageId,
        ROOM,
        HUMAN,
        JSON.stringify([
          { url: `https://server.example/v1/media/${mediaId}`, name: '24419.jpg', mimeType: 'image/jpeg', size: 16 },
          { url: 'https://media.example/legacy.png', mimeType: 'image/png' },
        ]),
      ],
    );
    const read = (await (
      await fixture.daemonOperation('getRoomMessage', { roomId: ROOM, messageId })
    ).json()) as { attachments: Array<{ sha256?: string }> };
    expect(read.attachments.map((attachment) => attachment.sha256)).toEqual([digest, undefined]);
  });


  it('keeps attachment-only chat previews, timestamps, and unread state through the phone API', async () => {
    const messageId = 'f'.repeat(64);
    const attachment = {
      url: 'https://media.test/photo.png',
      name: 'photo.png',
      mimeType: 'image/png',
      size: 42,
    };
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,attachments,created_at)
       VALUES($1,$2,$3,'',$4::jsonb,'2026-09-23T12:34:56Z')`,
      [messageId, ROOM, AGENT, JSON.stringify([attachment])],
    );
    const readChats = async () => {
      const response = await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`);
      expect(response.status).toBe(200);
      const view = (await response.json()) as {
        chats: Array<{ room: { id: string }; unread: boolean; latestMessage?: unknown }>;
      };
      return view.chats.find((chat) => chat.room.id === ROOM);
    };
    expect(await readChats()).toMatchObject({
      unread: true,
      latestMessage: {
        id: messageId,
        text: '',
        createdAt: Date.parse('2026-09-23T12:34:56Z') / 1000,
        attachments: [attachment],
      },
    });
    expect((await fixture.request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId })).status).toBe(204);
    expect(await readChats()).toMatchObject({
      unread: false,
      latestMessage: { id: messageId, attachments: [attachment] },
    });
  });


  it('pages archived corners ten at a time by closure, without skips or repeats', async () => {
    // 23 closed corners. Pairs share an exact closure instant, and neighbours
    // differ by one microsecond, so a cursor rounded to the millisecond, or
    // one without the id tiebreak, would skip or repeat rows.
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
       SELECT ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,$1,$2,'Closed ' || i,
         timestamptz '2026-09-01 00:00:00.000001+00' + (i/2) * interval '1 microsecond'
       FROM generate_series(1,23) i`,
      [WORKSPACE, ROOM],
    );
    const expected = (
      await fixture.database.query<{ id: string }>(
        `SELECT id::text FROM rooms WHERE parent_id=$1 AND archived_at IS NOT NULL
         ORDER BY archived_at DESC,id DESC`,
        [ROOM],
      )
    ).rows.map((row) => row.id);
    const page = async (before?: string) =>
      (await (
        await fixture.request(
          `/v1/phone/rooms/${ROOM}/corners?archived=1${
            before ? `&before=${encodeURIComponent(before)}` : ''
          }`,
        )
      ).json()) as { corners: Array<{ corner: { id: string } }>; nextArchived?: string };

    const first = await page();
    // Work closed after the first page is newer than its cursor, so it cannot
    // shift the later pages.
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
       VALUES('00000000-0000-4000-8000-000000000099',$1,$2,'Closed later',now())`,
      [WORKSPACE, ROOM],
    );
    const second = await page(first.nextArchived);
    const third = await page(second.nextArchived);
    expect([first, second, third].map((item) => item.corners.length)).toEqual([10, 10, 3]);
    expect(first.nextArchived).toMatch(/^\d+,[0-9a-f-]{36}$/);
    expect(third).not.toHaveProperty('nextArchived');
    expect(
      [first, second, third].flatMap((item) => item.corners.map((row) => row.corner.id)),
    ).toEqual(expected);
    expect(
      (await fixture.request(`/v1/phone/rooms/${ROOM}/corners?archived=1&before=yesterday`)).status,
    ).toBe(400);
  });


  it('keeps a Room view valid when live activity joins a full transcript', async () => {
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT lpad(to_hex(item),64,'0'),$1,$2,'Stored ' || item,to_timestamp(1700000000 + item)
       FROM generate_series(1,$3) AS stored(item)`,
      [ROOM, HUMAN, ROOM_VIEW_MESSAGE_LIMIT],
    );
    const requestId = 'e'.repeat(64);
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
          agentId: AGENT,
          roomId: ROOM,
          requestId,
          status: 'working',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.daemonOperation('postAgentActivity', {
          agentId: AGENT,
          roomId: ROOM,
          requestId,
          activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }],
        })
      ).status,
    ).toBe(200);

    const roomView = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(roomView)).toBe(true);
    expect(roomView.messages).toHaveLength(ROOM_VIEW_MESSAGE_LIMIT);
    expect(roomView.messages).toContainEqual(
      expect.objectContaining({
        author: expect.objectContaining({ pubkey: AGENT }),
        presentation: 'activity',
        activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }],
      }),
    );
    expect(roomView.messages.map((message) => message.id)).not.toContain('0'.repeat(63) + '1');
  });


  it('pages every earlier corner row when the opening boundary shares its second', async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'same-second-history',
      name: 'Same-second-history',
      objective: 'Keep every earlier transcript row.',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const ids = Array.from({ length: ROOM_VIEW_MESSAGE_LIMIT * 2 + 2 }, (_, index) =>
      (index + 1).toString(16).padStart(64, '0'),
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT id,$1,$2,'Same-second row ' || ordinal,
              '2040-01-01T00:00:00Z'::timestamptz + ordinal * interval '1 millisecond'
       FROM unnest($3::text[]) WITH ORDINALITY AS inserted(id,ordinal)`,
      [cornerId, HUMAN, ids],
    );

    const corner = (await (await fixture.request(`/v1/phone/rooms/${cornerId}`)).json()) as RoomView;
    expect(corner.messages.map((message) => message.id)).toEqual(ids.slice(32));

    const boundary = corner.messages[0]!;
    const firstPage = (await (
      await fixture.request(
        `/v1/phone/rooms/${cornerId}/history?before=${boundary.createdAt},${boundary.id}`,
      )
    ).json()) as RoomHistoryView;
    expect(firstPage.messages.map((message) => message.id)).toEqual(ids.slice(2, 32));
    expect(firstPage.nextBefore).toEqual({
      createdAt: firstPage.messages[0]!.createdAt,
      id: firstPage.messages[0]!.id,
    });

    const oldestPage = (await (
      await fixture.request(
        `/v1/phone/rooms/${cornerId}/history?before=${firstPage.nextBefore!.createdAt},${firstPage.nextBefore!.id}`,
      )
    ).json()) as RoomHistoryView;
    expect(oldestPage.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining(ids.slice(0, 2)),
    );
    expect(oldestPage.nextBefore).toBeUndefined();
  });


  it('reads a distant message directly and pages forward to the recent tail', async () => {
    const ids = Array.from({ length: 227 }, (_, index) =>
      (index + 1).toString(16).padStart(64, '0'),
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT id,$1,$2,'History row ' || ordinal,
              '2040-01-01T00:00:00Z'::timestamptz + ordinal * interval '1 millisecond'
       FROM unnest($3::text[]) WITH ORDINALITY AS inserted(id,ordinal)`,
      [ROOM, HUMAN, ids],
    );

    const target = ids[26]!;
    const aroundResponse = await fixture.request(`/v1/phone/rooms/${ROOM}/history?around=${target}`);
    expect(aroundResponse.status).toBe(200);
    const around = (await aroundResponse.json()) as RoomHistoryView;
    expect(around.messages.map((message) => message.id)).toEqual(ids.slice(11, 41));

    const seen = new Set(around.messages.map((message) => message.id));
    let cursor = around.messages.at(-1)!.id;
    for (let pageNumber = 0; pageNumber < 7; pageNumber += 1) {
      const response = await fixture.request(`/v1/phone/rooms/${ROOM}/history?after=${cursor}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as RoomHistoryView;
      for (const message of page.messages) {
        expect(seen.has(message.id)).toBe(false);
        seen.add(message.id);
      }
      if (page.messages.length === 0) break;
      cursor = page.messages.at(-1)!.id;
    }
    expect([...seen]).toEqual(ids.slice(11));

    const outsider = await fixture.phoneToken('outsider');
    expect((await fixture.request(`/v1/phone/rooms/${ROOM}/history?around=${target}`, 'GET', undefined, outsider)).status).toBe(404);
    expect((await fixture.request(`/v1/phone/rooms/${ROOM}/history?after=${target}`, 'GET', undefined, outsider)).status).toBe(404);
  });


  it("outlines every local day of a corner's history in the reader's time zone", async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'history-outline',
      name: 'History-outline',
      objective: 'Place the scrubber against every message.',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const outlineIn = async (tz: string) =>
      (await (
        await fixture.request(`/v1/phone/rooms/${cornerId}/outline?tz=${encodeURIComponent(tz)}`)
      ).json()) as RoomHistoryOutline;
    const before = await outlineIn('Asia/Kolkata');
    expect(readRoomHistoryOutline(before)).toEqual(before);
    const ids = ['c', 'd', 'e', 'f'].map((digit) => digit.repeat(64));
    // 18:20Z and 18:45Z are 23:50 on 1 Jan and 00:15 on 2 Jan in India
    // (UTC+5:30): one UTC hour, two local days.
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES($1,$5,$6,'Before IST midnight','2040-01-01T18:20:00Z'),
             ($2,$5,$6,'Same evening','2040-01-01T18:25:00Z'),
             ($3,$5,$6,'After IST midnight','2040-01-01T18:45:00Z'),
             ($4,$5,$6,'Same India day','2040-01-02T18:05:00Z')`,
      [...ids, cornerId, HUMAN],
    );

    const india = await outlineIn('Asia/Kolkata');
    expect(readRoomHistoryOutline(india)).toEqual(india);
    expect(india.timeZone).toBe('Asia/Kolkata');
    expect(india.total).toBe(before.total + 4);
    expect(india.newest).toEqual({
      id: ids[3],
      createdAt: Date.parse('2040-01-02T18:05:00Z') / 1_000,
    });
    const first = (id: string, iso: string) => ({
      id,
      createdAt: Date.parse(iso) / 1_000,
      authorName: 'Owner',
      authorHandle: 'owner',
    });
    expect(india.days.filter((day) => day.day >= '2040-01-01')).toEqual([
      { day: '2040-01-01', count: 2, first: first(ids[0]!, '2040-01-01T18:20:00Z') },
      // 00:15 and 23:35 on 2 Jan in India.
      { day: '2040-01-02', count: 2, first: first(ids[2]!, '2040-01-01T18:45:00Z') },
    ]);
    // The same messages fall on two UTC days.
    expect(
      (await outlineIn('UTC')).days
        .filter((day) => day.day >= '2040-01-01')
        .map((day) => day.count),
    ).toEqual([3, 1]);

    for (const tz of ['', '+05:30', 'Not/AZone']) {
      const rejected = await fixture.request(
        `/v1/phone/rooms/${cornerId}/outline?tz=${encodeURIComponent(tz)}`,
      );
      expect(rejected.status).toBe(400);
    }
  });


  it('outlines every day of a history longer than twenty thousand days', async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'long-history-outline',
      name: 'Long-history-outline',
      objective: 'Keep the oldest day reachable.',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const before = (await (
      await fixture.request(`/v1/phone/rooms/${cornerId}/outline?tz=UTC`)
    ).json()) as RoomHistoryOutline;
    // This is a history-read fixture, not a test of per-message search,
    // follow or owed-item writes. Skip user triggers during the bulk seed;
    // foreign-key constraints remain active, and all hooks resume before HTTP.
    await fixture.database.transaction(async (fixture) => {
      await fixture.query('ALTER TABLE messages DISABLE TRIGGER USER');
      await fixture.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         SELECT lpad(to_hex(day),64,'0'),$1,$2,'Day ' || day,
                '1980-01-01T12:00:00Z'::timestamptz + (day - 1) * interval '1 day'
         FROM generate_series(1,20001) AS day`,
        [cornerId, HUMAN],
      );
      await fixture.query('ALTER TABLE messages ENABLE TRIGGER USER');
    });
    const outline = (await (
      await fixture.request(`/v1/phone/rooms/${cornerId}/outline?tz=UTC`)
    ).json()) as RoomHistoryOutline;
    expect(readRoomHistoryOutline(outline)).toEqual(outline);
    expect(outline.total).toBe(before.total + 20_001);
    const inserted = outline.days.filter((day) => day.day < '2035-01-01');
    expect(inserted).toHaveLength(20_001);
    expect(inserted[0]).toEqual({
      day: '1980-01-01',
      count: 1,
      first: {
        id: '1'.padStart(64, '0'),
        createdAt: Date.parse('1980-01-01T12:00:00Z') / 1_000,
        authorName: 'Owner',
        authorHandle: 'owner',
      },
    });
  });


  it('restarts history from the current tail when a cached cursor was deleted', async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'deleted-history-cursor',
      name: 'Deleted-cursor-history',
      objective: 'Recover older transcript rows.',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const earlierId = 'a'.repeat(64);
    const deletedId = 'b'.repeat(64);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES($1,$3,$4,'Earlier row','2040-01-01T00:00:00Z'),
             ($2,$3,$4,'Cached boundary','2040-01-02T00:00:00Z')`,
      [earlierId, deletedId, cornerId, HUMAN],
    );
    await fixture.database.query(`DELETE FROM messages WHERE id=$1`, [deletedId]);

    const page = (await (
      await fixture.request(`/v1/phone/rooms/${cornerId}/history?before=2209075200,${deletedId}`)
    ).json()) as RoomHistoryView;
    expect(page.messages.map((message) => message.id)).toContain(earlierId);
  });
});
