import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';

/**
 * The read cursor over the real HTTP and WebSocket surface: the boundary a
 * phone writes, the count served beside it, mark-unread putting it back, and
 * the one definition of unread that the cursor and the deck now share.
 *
 * The server STORES readership; it does not do work for it. A read mark
 * therefore costs exactly one write and publishes nothing — no live frame, no
 * invalidation, no refetch on anybody's device. The socket assertions below
 * are what hold that line.
 */
const OWNER = createHash('sha256').update('github:owner').digest('hex');
const OTHER = createHash('sha256').update('github:recipient').digest('hex');
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
/** Four agent messages, oldest first, at distinct stored times. */
const MESSAGES = ['1a', '2b', '3c', '4d'].map((seed, index) => ({
  id: seed.padEnd(64, seed[1]!),
  at: `2026-09-12 01:00:0${index}.000+00`,
}));

describe('the read cursor over the live phone surface', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  let origin: string;
  let server: ReturnType<typeof createBeelineServer>;
  let ownerToken: string;
  let otherToken: string;
  let phone: PhoneService;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await new AuthStore(database as unknown as TransactionalDatabase).migrate();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject) VALUES
       ($1,'human','Owner','owner','owner'),
       ($2,'human','Recipient','recipient','recipient'),
       ($3,'agent','Bee','bee',NULL)`,
      [OWNER, OTHER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
       ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member')`,
      [WORKSPACE, OWNER, OTHER, AGENT, ROOM],
    );
    for (const message of MESSAGES) {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,$5)`,
        [message.id, ROOM, AGENT, `message ${message.id.slice(0, 2)}`, message.at],
      );
    }
    auth = new TokenAuth(database, async (proof) => {
      const login = proof === 'proof' ? 'owner' : proof === 'recipient-proof' ? 'recipient' : proof;
      return { subject: login, login, name: login[0]!.toUpperCase() + login.slice(1) };
    });
    const live = new LiveHub();
    phone = new PhoneService(database, 'http://placeholder', undefined, undefined, live);
    const daemon = new DaemonService(database, live, async () => ({
      token: 'github-room-token',
      expiresAt: Date.now() + 60_000,
    }));
    server = createBeelineServer({
      database,
      auth,
      phone,
      daemon,
      live,
      mediaMaximumBytes: 1024 * 1024,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ownerToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
    otherToken = (await auth.exchangeGitHubOidc('recipient-proof')).accessToken;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close?.();
  });

  const request = (path: string, method = 'GET', payload?: unknown, token = ownerToken) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });

  const cursor = async (token = ownerToken) => {
    const view = (await (
      await request(`/v1/phone/rooms/${ROOM}`, 'GET', undefined, token)
    ).json()) as {
      viewer: {
        readCursor?: {
          messageId: string | null;
          firstUnreadMessageId: string | null;
          unreadCount?: number;
        };
      };
    };
    return view.viewer.readCursor;
  };

  const deckRow = async (token = ownerToken) => {
    const view = (await (
      await request(`/v1/phone/workspaces/${WORKSPACE}/chats`, 'GET', undefined, token)
    ).json()) as { chats: Array<{ room: { id: string }; unread: boolean }> };
    return view.chats.find((chat) => chat.room.id === ROOM)!;
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('serves the count beside the boundary, and takes it back on mark-unread', async () => {
    expect(await cursor()).toEqual({
      messageId: null,
      firstUnreadMessageId: MESSAGES[0]!.id,
      unreadCount: 4,
    });
    expect((await deckRow()).unread).toBe(true);

    // The viewport reaches the second message and stops. This is the write the
    // debounced advancer makes — a mid-transcript row, not the tail.
    expect(
      (await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: MESSAGES[1]!.id }))
        .status,
    ).toBe(204);
    expect(await cursor()).toEqual({
      messageId: MESSAGES[1]!.id,
      firstUnreadMessageId: MESSAGES[2]!.id,
      unreadCount: 2,
    });

    // Reaching the newest row settles the Room.
    await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: MESSAGES[3]!.id });
    expect(await cursor()).toEqual({
      messageId: MESSAGES[3]!.id,
      firstUnreadMessageId: null,
      unreadCount: 0,
    });
    expect((await deckRow()).unread).toBe(false);

    // Mark-unread from the third message. The monotonic guard that makes
    // markRead forward-only must not apply here.
    expect(
      (await request(`/v1/phone/rooms/${ROOM}/unread`, 'POST', { messageId: MESSAGES[2]!.id }))
        .status,
    ).toBe(204);
    expect(await cursor()).toEqual({
      messageId: MESSAGES[1]!.id,
      firstUnreadMessageId: MESSAGES[2]!.id,
      unreadCount: 2,
    });
    expect((await deckRow()).unread).toBe(true);

    // The other member's own cursor was never touched by any of it.
    expect((await cursor(otherToken))?.unreadCount).toBe(4);
  });

  it('costs a read mark nothing on the live lane — no frame, no invalidation', async () => {
    // Two subscribed sockets: the writer's own, and another member's. A read
    // mark must reach neither, because either would buy a full Room GET.
    const sockets = await Promise.all(
      [ownerToken, otherToken].map(async (token) => {
        const socket = new WebSocket(`${origin.replace('http', 'ws')}/v1/phone/live`, [
          `bearer.${token}`,
        ]);
        await new Promise<void>((resolve, reject) => {
          socket.once('open', () => resolve());
          socket.once('error', reject);
        });
        const frames: unknown[] = [];
        socket.on('message', (raw) => {
          const value = JSON.parse(raw.toString()) as { type?: string };
          if (value.type !== 'subscribed') frames.push(value);
        });
        socket.send(JSON.stringify({ type: 'subscribe', roomId: ROOM }));
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('subscribe timeout')), 3000);
          socket.on('message', function onMessage(raw) {
            if ((JSON.parse(raw.toString()) as { type?: string }).type !== 'subscribed') return;
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve();
          });
        });
        return { socket, frames };
      }),
    );
    try {
      await settle();
      for (const entry of sockets) entry.frames.length = 0;

      await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: MESSAGES[1]!.id });
      await request(`/v1/phone/rooms/${ROOM}/unread`, 'POST', { messageId: MESSAGES[0]!.id });
      await settle();

      // Nothing at all: not a delta, not an invalidation, on either socket.
      expect(sockets.map((entry) => entry.frames)).toEqual([[], []]);
    } finally {
      for (const entry of sockets) entry.socket.close();
    }
  });

  it('marks the whole Room unread when nothing precedes the chosen message', async () => {
    await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: MESSAGES[3]!.id });
    expect((await cursor())?.unreadCount).toBe(0);

    expect(
      (await request(`/v1/phone/rooms/${ROOM}/unread`, 'POST', { messageId: MESSAGES[0]!.id }))
        .status,
    ).toBe(204);
    expect(await cursor()).toEqual({
      messageId: null,
      firstUnreadMessageId: MESSAGES[0]!.id,
      unreadCount: 4,
    });
  });

  it('counts the cursor and the deck boolean over one definition of unread', async () => {
    // An agent narrating a turn writes activity rows. They are the case the
    // old definitions disagreed on: the cursor's `presentation<>'activity'`
    // and the deck's allowlist both excluded them, but the phone's own queue
    // counted them, so a long turn inflated the reader's count past anything
    // the server would agree to. Nothing counts them now.
    for (const [index, id] of ['9e', '8f'].entries()) {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
         VALUES($1,$2,$3,'narrating','activity',$4)`,
        [id.padEnd(64, id[1]!), ROOM, AGENT, `2026-09-12 01:00:1${index}.000+00`],
      );
    }

    // Still the four real messages, and the Room is still unread.
    expect((await cursor())?.unreadCount).toBe(4);
    expect((await deckRow()).unread).toBe(true);

    // Reading the newest real message settles the Room, even though two newer
    // activity rows sit past the mark. The cursor and the deck agree.
    await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: MESSAGES[3]!.id });
    expect(await cursor()).toEqual({
      messageId: MESSAGES[3]!.id,
      firstUnreadMessageId: null,
      unreadCount: 0,
    });
    expect((await deckRow()).unread).toBe(false);
  });

  it('caps the count rather than scanning a whole abandoned backlog', async () => {
    for (let index = 0; index < 120; index += 1) {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,$5)`,
        [
          `c${index.toString().padStart(2, '0')}`.padEnd(64, 'c'),
          ROOM,
          AGENT,
          `bulk ${index}`,
          new Date(Date.parse('2026-09-12T02:00:00Z') + index * 1000).toISOString(),
        ],
      );
    }
    expect((await cursor())?.unreadCount).toBe(99);
  });

  it('refuses a read or unread write against a Room the caller cannot read', async () => {
    const outsider = createHash('sha256').update('github:outsider').digest('hex');
    await database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject) VALUES($1,'human','Out','out','outsider')`,
      [outsider],
    );
    const outsiderToken = (await auth.exchangeGitHubOidc('outsider')).accessToken;
    for (const path of ['read', 'unread']) {
      const response = await request(
        `/v1/phone/rooms/${ROOM}/${path}`,
        'POST',
        { messageId: MESSAGES[0]!.id },
        outsiderToken,
      );
      expect(response.status).not.toBe(204);
    }
    const marks = await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM room_read_marks WHERE identity_id=$1`,
      [outsider],
    );
    expect(marks.rows[0]!.count).toBe('0');
  });
});
