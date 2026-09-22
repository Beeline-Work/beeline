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
 * The read cursor, end to end over the real HTTP and WebSocket surface: the
 * boundary a phone publishes, the copy the same person's other device
 * receives, the count the deck is served, and mark-unread putting it all back.
 *
 * Two sockets stand in for two of ONE person's devices, and a third stands in
 * for the other member of the Room — who must never learn where anybody else
 * is reading.
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
    // The live hub is what carries a moved boundary to the viewer's other
    // devices, so the service under test is wired with one.
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

  const deckRow = async (token = ownerToken) => {
    const view = (await (
      await request(`/v1/phone/workspaces/${WORKSPACE}/chats`, 'GET', undefined, token)
    ).json()) as { chats: Array<{ room: { id: string }; unread: boolean; unreadCount?: number }> };
    return view.chats.find((chat) => chat.room.id === ROOM)!;
  };

  /** One subscribed device. Read-marks it receives are collected as they land. */
  const device = async (token: string) => {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/v1/phone/live`, [
      `bearer.${token}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const marks: Array<{ identityId: string; messageId: string | null; firstUnreadMessageId: string | null }> = [];
    socket.on('message', (raw) => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (value.type === 'read-mark')
        marks.push(
          value as unknown as {
            identityId: string;
            messageId: string | null;
            firstUnreadMessageId: string | null;
          },
        );
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
    return { socket, marks };
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('serves an unread count, publishes a moved boundary to the viewer\'s own devices only, and takes mark-unread back', async () => {
    const phoneDevice = await device(ownerToken);
    const tablet = await device(ownerToken);
    const somebodyElse = await device(otherToken);
    try {
      // The deck says how much is waiting, not merely THAT something is.
      const cold = await deckRow();
      expect(cold.unread).toBe(true);
      expect(cold.unreadCount).toBe(4);

      // The phone's viewport reaches the second message and stops there. This
      // is the write the debounced advancer makes — a mid-transcript row, not
      // the tail the fetched view happens to end on.
      expect((await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: MESSAGES[1]!.id })).status).toBe(204);
      await settle();

      // The tablet — the same person, a different device — is told where they
      // are reading, without asking.
      expect(tablet.marks).toEqual([
        {
          type: 'read-mark',
          roomId: ROOM,
          identityId: OWNER,
          messageId: MESSAGES[1]!.id,
          firstUnreadMessageId: MESSAGES[2]!.id,
        },
      ]);
      // Nobody else in the Room learns any of it.
      expect(somebodyElse.marks).toEqual([]);

      // And the deck now counts only what is genuinely still unread.
      const partlyRead = await deckRow();
      expect(partlyRead.unread).toBe(true);
      expect(partlyRead.unreadCount).toBe(2);

      // Reaching the newest row clears the row entirely.
      expect((await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: MESSAGES[3]!.id })).status).toBe(204);
      await settle();
      const caughtUp = await deckRow();
      expect(caughtUp.unread).toBe(false);
      expect(caughtUp.unreadCount).toBe(0);

      // Mark-unread from the third message: that message and everything after
      // it is unread again, and the boundary travels to the other device too.
      tablet.marks.length = 0;
      expect((await request(`/v1/phone/rooms/${ROOM}/unread`, 'POST', { messageId: MESSAGES[2]!.id })).status).toBe(204);
      await settle();
      const reopened = await deckRow();
      expect(reopened.unread).toBe(true);
      expect(reopened.unreadCount).toBe(2);
      expect(tablet.marks).toEqual([
        {
          type: 'read-mark',
          roomId: ROOM,
          identityId: OWNER,
          messageId: MESSAGES[1]!.id,
          firstUnreadMessageId: MESSAGES[2]!.id,
        },
      ]);
      expect(somebodyElse.marks).toEqual([]);

      // The other member's own row was never touched by any of it.
      const theirs = await deckRow(otherToken);
      expect(theirs.unreadCount).toBe(4);
    } finally {
      for (const open of [phoneDevice, tablet, somebodyElse]) open.socket.close();
    }
  });

  it('marks the whole Room unread when nothing precedes the chosen message', async () => {
    await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: MESSAGES[3]!.id });
    expect((await deckRow()).unreadCount).toBe(0);

    expect(
      (await request(`/v1/phone/rooms/${ROOM}/unread`, 'POST', { messageId: MESSAGES[0]!.id }))
        .status,
    ).toBe(204);
    const all = await deckRow();
    expect(all.unread).toBe(true);
    expect(all.unreadCount).toBe(4);
    expect((await phone.readRoom(ROOM, OWNER))?.viewer.readCursor).toEqual({
      messageId: null,
      firstUnreadMessageId: MESSAGES[0]!.id,
    });
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
    // No mark was written for them either way.
    const marks = await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM room_read_marks WHERE identity_id=$1`,
      [outsider],
    );
    expect(marks.rows[0]!.count).toBe('0');
  });
});
