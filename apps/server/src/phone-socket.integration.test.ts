import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PHONE_SOCKET_MAX_FRAME_BYTES, PHONE_SOCKET_MAX_IN_FLIGHT,
  type PhoneResponseFrame,
} from '@beeline/api-contract/phone';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import { migrate, type SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { phoneReadLimits } from './phone-read-limit.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase } from './test-support.js';

// Reproduction SOCKET-OPS-1: real HTTP and WebSocket boundaries against an isolated database.
// This is a protocol feature, not a defect report; no production phone can issue it yet.
const VIEWER = 'a'.repeat(64), OUTSIDER = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const MESSAGE = 'c'.repeat(64);
const SNAPSHOT = await (async () => {
  const db = new PgliteDatabase();
  try { await migrate(db); return await db.snapshot(); }
  finally { await db.close(); }
})();

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('SOCKET-OPS-1 phone request/reply', () => {
  let db: PgliteDatabase, phone: PhoneService, live: LiveHub, server: Server, origin: string;
  const sockets: WebSocket[] = [];
  let sequence: number;
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    db = PgliteDatabase.fromSnapshot(SNAPSHOT);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Viewer'),($2,'human','Outsider')`, [VIEWER, OUTSIDER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Socket test')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Room',$3)`, [ROOM, WORKSPACE, VIEWER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [WORKSPACE, ROOM, VIEWER]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'searchable fixture')`, [MESSAGE, ROOM, VIEWER]);
    live = new LiveHub();
    phone = new PhoneService(db, 'http://local.test', undefined, undefined, live);
    server = createBeelineServer({ database: db, phone, live,
      auth: {
        authenticatePhone: async (token: string) => token === 'viewer'.repeat(8) ? VIEWER : token === 'outsider'.repeat(8) ? OUTSIDER : null,
      } as unknown as TokenAuth,
      daemon: {} as DaemonService, mediaMaximumBytes: 1,
      phoneReadLimits: phoneReadLimits({ history: { maxRequestsPerWindow: 4 } }),
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sequence = 0;
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close(); vi.restoreAllMocks();
  });

  async function open(token = 'viewer'): Promise<WebSocket> {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`, [`bearer.${token.repeat(8)}`]);
    socket.setMaxListeners(PHONE_SOCKET_MAX_IN_FLIGHT * 2);
    sockets.push(socket); await once(socket, 'open'); return socket;
  }
  function response(socket: WebSocket, id: string): Promise<PhoneResponseFrame> {
    return new Promise((resolve, reject) => {
      const onMessage = (raw: WebSocket.RawData) => {
        const value = JSON.parse(String(raw));
        if (value.t === 'res' && value.id === id) {
          socket.off('message', onMessage); socket.off('close', onClose); resolve(value);
        }
      };
      const onClose = () => { socket.off('message', onMessage); reject(new Error('socket closed before response')); };
      socket.on('message', onMessage); socket.once('close', onClose);
    });
  }
  function request(socket: WebSocket, op: string, args: object = {}, id = `request-${++sequence}`) {
    const reply = response(socket, id);
    socket.send(JSON.stringify({ t: 'req', id, op, args })); return reply;
  }
  function http(path: string, args?: object, token = 'viewer') {
    return fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token.repeat(8)}`, 'content-type': 'application/json' },
      ...(args === undefined ? {} : { method: 'POST', body: JSON.stringify(args) }),
    });
  }

  it('returns the same authenticated operation result over HTTP and socket, with no read invalidations', async () => {
    const socket = await open();
    const publish = vi.spyOn(live, 'publish');
    for (const [op, args, path] of [
      ['readWorkspaces', {}, '/v1/phone/workspaces'],
      ['readWorkspace', { workspaceId: WORKSPACE }, `/v1/phone/workspaces/${WORKSPACE}`],
      ['readChats', { workspaceId: WORKSPACE }, `/v1/phone/workspaces/${WORKSPACE}/chats`],
      ['readRoom', { roomId: ROOM }, `/v1/phone/rooms/${ROOM}`],
      ['readCorners', { roomId: ROOM }, `/v1/phone/rooms/${ROOM}/corners`],
      ['resolveMessageLink', { messageId: MESSAGE }, `/v1/phone/message-links/${MESSAGE}`],
      ['readHistoryAround', { roomId: ROOM, messageId: MESSAGE }, `/v1/phone/rooms/${ROOM}/history?around=${MESSAGE}`],
    ] as const) {
      const web = await http(path); expect(web.status, op).toBe(200);
      expect(await request(socket, op, args)).toMatchObject({ t: 'res', ok: true, result: await web.json() });
      const generic = await http(`/v1/phone/operations/${op}`, args);
      expect(generic.status).toBe(200);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('matches concurrent results by id and delivers twenty real database reads out of order', async () => {
    const socket = await open();
    const gates = Array.from({ length: 20 }, () => deferred());
    const admitted = deferred();
    const read = phone.readWorkspaces.bind(phone);
    let count = 0;
    vi.spyOn(phone, 'readWorkspaces').mockImplementation(async viewer => {
      const index = count++; if (count === 20) admitted.resolve();
      await gates[index]!.promise; return read(viewer);
    });
    const order: string[] = [];
    socket.on('message', raw => { const value = JSON.parse(String(raw)); if (value.t === 'res') order.push(value.id); });
    const replies = gates.map((_, index) => request(socket, 'readWorkspaces', {}, `concurrent-${index}`));
    await admitted.promise;
    for (let index = 19; index >= 0; index--) {
      gates[index]!.resolve();
      expect(await replies[index]).toMatchObject({ id: `concurrent-${index}`, ok: true, result: { workspaces: expect.any(Array) } });
    }
    expect(order).toEqual(gates.map((_, index) => `concurrent-${19 - index}`));
  });

  it('rejects excess in-flight requests with busy and frees the slots after completion', async () => {
    const socket = await open(), gate = deferred(), admitted = deferred();
    const read = phone.readWorkspaces.bind(phone); let count = 0;
    vi.spyOn(phone, 'readWorkspaces').mockImplementation(async viewer => {
      if (++count === PHONE_SOCKET_MAX_IN_FLIGHT) admitted.resolve();
      await gate.promise; return read(viewer);
    });
    const pending = Array.from({ length: PHONE_SOCKET_MAX_IN_FLIGHT }, () => request(socket, 'readWorkspaces'));
    await admitted.promise;
    expect(await request(socket, 'readWorkspaces')).toMatchObject({ ok: false, error: { code: 'busy', retryable: true } });
    expect(count).toBe(PHONE_SOCKET_MAX_IN_FLIGHT);
    gate.resolve(); expect((await Promise.all(pending)).every(reply => reply.ok)).toBe(true);
    expect(await request(socket, 'readWorkspaces')).toMatchObject({ ok: true });
  });

  it('returns typed errors for unknown operations, malformed frames, validation and current membership', async () => {
    const socket = await open();
    expect(await request(socket, 'notAnOperation')).toMatchObject({ ok: false, error: { code: 'unknown_phone_operation', retryable: false } });
    const malformed = response(socket, 'malformed');
    socket.send(JSON.stringify({ t: 'req', id: 'malformed', op: 'readRoom', args: [] }));
    expect(await malformed).toMatchObject({ ok: false, error: { code: 'invalid_request', retryable: false } });
    expect(await request(socket, 'readRoom', { roomId: 5 })).toMatchObject({ ok: false, error: { code: 'invalid_args', retryable: false } });
    expect(await request(await open('outsider'), 'readRoom', { roomId: ROOM })).toMatchObject({ ok: false, error: { code: 'not_found', retryable: false } });
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [VIEWER]);
    expect(await request(socket, 'readRoom', { roomId: ROOM })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('refuses unauthenticated upgrades with a typed HTTP error', async () => {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`);
    const refused = new Promise<{ status: number; body: unknown }>(resolve => {
      socket.on('unexpected-response', async (_, response) => {
        let raw = ''; for await (const chunk of response) raw += chunk;
        resolve({ status: response.statusCode!, body: JSON.parse(raw) });
        socket.terminate();
      });
      socket.on('error', () => {});
    });
    expect(await refused).toEqual({ status: 401, body: { error: 'phone_token_required' } });
  });

  it('shares history rate limits between legacy HTTP, operation HTTP and the socket', async () => {
    const socket = await open();
    expect((await http(`/v1/phone/rooms/${ROOM}/history`)).status).toBe(200);
    expect((await http('/v1/phone/operations/readHistory', { roomId: ROOM })).status).toBe(200);
    expect(await request(socket, 'readHistory', { roomId: ROOM })).toMatchObject({ ok: true });
    expect(await request(socket, 'readHistoryAfter', { roomId: ROOM, messageId: MESSAGE })).toMatchObject({ ok: true });
    expect(await request(socket, 'readHistory', { roomId: ROOM })).toMatchObject({ ok: false, error: { code: 'too_many_requests', retryable: true } });
    expect((await http(`/v1/phone/rooms/${ROOM}/history`)).status).toBe(429);
  });

  it('creates one message and one reply when retried over both transports, rejecting id collisions', async () => {
    const socket = await open();
    for (const [op, id, extra] of [
      ['sendRoomMessage', 'd'.repeat(64), {}],
      ['sendRoomReply', 'e'.repeat(64), { parentMessageId: MESSAGE }],
    ] as const) {
      const args = { roomId: ROOM, messageId: id, text: 'Retry me', ...extra };
      expect(await request(socket, op, args)).toMatchObject({ ok: true, result: { messageId: id } });
      expect(await request(socket, op, args)).toMatchObject({ ok: true, result: { messageId: id } });
      expect((await http(`/v1/phone/operations/${op}`, args)).status).toBe(200);
      expect((await db.query(`SELECT id FROM messages WHERE id=$1`, [id])).rows).toHaveLength(1);
      expect(await request(socket, op, { ...args, text: 'Different payload' })).toMatchObject({ ok: false, error: { retryable: false } });
    }
    const room = await http(`/v1/phone/rooms/${ROOM}`);
    const view = await room.json() as { messages: { id: string; text: string }[] };
    expect(view.messages.filter(message => message.text === 'Retry me')).toHaveLength(2);
  });

  it('keeps write change notices and read-mark operations identical to the web path', async () => {
    const socket = await open(), publish = vi.spyOn(live, 'publish');
    const args = { roomId: ROOM, messageId: 'f'.repeat(64), text: 'Socket message' };
    expect(await request(socket, 'sendRoomMessage', args)).toMatchObject({ ok: true });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'invalidate', roomId: ROOM, reason: 'phone-write', messageId: args.messageId }));
    publish.mockClear();
    expect(await request(socket, 'markRead', { roomId: ROOM, messageId: args.messageId })).toMatchObject({ ok: true, result: null });
    const incoming = '3'.repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Incoming')`, [incoming, ROOM, OUTSIDER]);
    expect(await request(socket, 'markUnread', { roomId: ROOM, messageId: incoming })).toMatchObject({ ok: true });
    expect(publish).not.toHaveBeenCalled();
    const view = await (await http(`/v1/phone/rooms/${ROOM}`)).json();
    expect(view.viewer.readCursor).toBeDefined();
  });

  it('lets an admitted transaction finish atomically after close and a new socket safely retry it', async () => {
    const socket = await open(), entered = deferred(), proceed = deferred(), settled = deferred();
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(work => transaction(async tx => {
      const result = await work(tx); entered.resolve(); await proceed.promise; return result;
    }).finally(() => settled.resolve()));
    const args = { roomId: ROOM, messageId: '1'.repeat(64), text: 'Survives disconnect' };
    socket.send(JSON.stringify({ t: 'req', id: 'disconnect', op: 'sendRoomMessage', args }));
    await entered.promise;
    socket.close(); await once(socket, 'close');
    proceed.resolve(); await settled.promise;
    expect(await request(await open(), 'sendRoomMessage', args)).toMatchObject({ ok: true });
    expect((await db.query(`SELECT id FROM messages WHERE id=$1`, [args.messageId])).rows).toHaveLength(1);
    expect((await db.query(`SELECT message_id FROM room_read_marks WHERE room_id=$1 AND identity_id=$2`, [ROOM, VIEWER])).rows[0]?.message_id).toBe(args.messageId);
  });

  it('rolls back the entire write if the in-flight transaction fails after socket close', async () => {
    const socket = await open(), entered = deferred(), proceed = deferred(), settled = deferred();
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(work => transaction(async (tx: SqlDatabase) => {
      await work(tx); entered.resolve(); await proceed.promise; throw new Error('Injected transaction failure');
    }).finally(() => settled.resolve()));
    const id = '2'.repeat(64);
    socket.send(JSON.stringify({ t: 'req', id: 'rollback', op: 'sendRoomMessage', args: { roomId: ROOM, messageId: id, text: 'Must roll back' } }));
    await entered.promise; socket.close(); await once(socket, 'close');
    proceed.resolve(); await settled.promise;
    expect((await db.query(`SELECT id FROM messages WHERE id=$1`, [id])).rows).toHaveLength(0);
    expect((await db.query(`SELECT message_id FROM room_read_marks WHERE message_id=$1`, [id])).rows).toHaveLength(0);
  });

  it('closes oversized frames at the existing frame limit', async () => {
    const socket = await open(), closed = once(socket, 'close');
    socket.send(JSON.stringify({ t: 'req', id: 'large', op: 'readWorkspaces', args: { padding: 'x'.repeat(PHONE_SOCKET_MAX_FRAME_BYTES) } }));
    expect((await closed)[0]).toBe(1009);
  });

  it('refuses vault secret submissions with a typed error and does not read or write the database', async () => {
    const socket = await open();
    const before = await db.query(`SELECT id,card,text FROM messages ORDER BY id`);
    const query = vi.spyOn(db, 'query');
    const execute = vi.spyOn(phone, 'execute');
    const secret = 'socket-refused-secret-sentinel';
    const result = await request(socket, 'submitVaultSave', {
      roomId: ROOM, cardId: MESSAGE, values: { password: secret },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_phone_operation', retryable: false } });
    expect(execute).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
    const after = await db.query(`SELECT id,card,text FROM messages ORDER BY id`);
    expect(after.rows).toEqual(before.rows);
    const operation = await http('/v1/phone/operations/submitVaultSave', {
      roomId: ROOM, cardId: MESSAGE, values: { password: secret },
    });
    expect(operation.status).toBe(404);
    expect(await operation.json()).toEqual({ error: 'unknown_phone_operation' });
  });

  it('records page timings and redacts client reports through the same socket and HTTP handlers', async () => {
    const socket = await open(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timing = { durationMs: 120, failed: false, network: { requestToFirstByteMs: 80, serverProcessingMs: 30, jsResponseDelayMs: 5 } };
    expect(await request(socket, 'reportPageLoad', timing)).toMatchObject({ ok: true });
    expect((await http('/v1/phone/observations/page-load', timing)).status).toBe(204);
    const events = await db.query(`SELECT duration_ms,network_rtt_residual_ms,js_response_delay_ms FROM operator_function_events WHERE function_name='page_load'`);
    expect(events.rows).toEqual(Array.from({ length: 2 }, () => ({ duration_ms: 120, network_rtt_residual_ms: 50, js_response_delay_ms: 5 })));
    const report = { scope: 'conversation', message: 'Error https://example.test/?private=yes Bearer private-value',
      stack: 'at Test:1', platform: 'android', platformVersion: '36', releaseSha: 'fixture', runtimeVersion: '34', updateId: 'update' };
    expect(await request(socket, 'reportClientError', report)).toMatchObject({ ok: true });
    expect((await http('/v1/phone/observations/client-error', report)).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]).toEqual(warn.mock.calls[1]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-value');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('?private=yes');
  });
});
