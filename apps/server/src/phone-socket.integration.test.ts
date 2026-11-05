import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PhoneResponseFrame,
} from '@beeline/api-contract/phone';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import { migrate, type SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase } from './test-support.js';
import { OperationOutcomes } from './operation-outcomes.js';
import { commandArgumentDigest } from './router-command-ledger.js';

// Reproduction SOCKET-OPS-1: real HTTP and WebSocket boundaries against an isolated database.
// This is a protocol feature, not a defect report; no production phone can issue it yet.
const VIEWER = 'a'.repeat(64),
  OUTSIDER = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const MESSAGE = 'c'.repeat(64);
const SNAPSHOT = await (async () => {
  const db = new PgliteDatabase();
  try {
    await migrate(db);
    return await db.snapshot();
  } finally {
    await db.close();
  }
})();

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SOCKET-OPS-1 phone request/reply', () => {
  let db: PgliteDatabase, phone: PhoneService, live: LiveHub, server: Server, origin: string;
  const sockets: WebSocket[] = [];
  let sequence: number;
  let outcomes: OperationOutcomes;
  let authenticatePhone: ReturnType<typeof vi.fn<(token: string) => Promise<string | null>>>;
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    db = PgliteDatabase.fromSnapshot(SNAPSHOT);
    await db.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Viewer'),($2,'human','Outsider')`,
      [VIEWER, OUTSIDER],
    );
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Socket test')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Room',$3)`, [
      ROOM,
      WORKSPACE,
      VIEWER,
    ]);
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`,
      [WORKSPACE, ROOM, VIEWER],
    );
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'searchable fixture')`,
      [MESSAGE, ROOM, VIEWER],
    );
    live = new LiveHub();
    phone = new PhoneService(db, 'http://local.test', undefined, undefined, live);
    outcomes = new OperationOutcomes('socket-test');
    authenticatePhone = vi.fn(async (token: string) =>
      token === 'viewer'.repeat(8) ? VIEWER : token === 'outsider'.repeat(8) ? OUTSIDER : null,
    );
    server = createBeelineServer({
      database: db,
      phone,
      live,
      operationOutcomes: outcomes,
      auth: { authenticatePhone } as unknown as TokenAuth,
      daemon: {} as DaemonService,
      mediaMaximumBytes: 1,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sequence = 0;
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    vi.restoreAllMocks();
  });

  async function open(token = 'viewer'): Promise<WebSocket> {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`, [
      `bearer.${token.repeat(8)}`,
    ]);
    socket.setMaxListeners(128);
    sockets.push(socket);
    await once(socket, 'open');
    return socket;
  }
  function response(socket: WebSocket, id: string): Promise<PhoneResponseFrame> {
    return new Promise((resolve, reject) => {
      const onMessage = (raw: WebSocket.RawData) => {
        const value = JSON.parse(String(raw));
        if (value.t === 'res' && value.id === id) {
          socket.off('message', onMessage);
          socket.off('close', onClose);
          resolve(value);
        }
      };
      const onClose = () => {
        socket.off('message', onMessage);
        reject(new Error('socket closed before response'));
      };
      socket.on('message', onMessage);
      socket.once('close', onClose);
    });
  }
  function request(
    socket: WebSocket,
    op: string,
    args: object = {},
    id = `request-${++sequence}`,
    command?: { v: 1; id: string },
  ) {
    const reply = response(socket, id);
    socket.send(JSON.stringify({ t: 'req', id, op, args, ...(command ? { command } : {}) }));
    return reply;
  }
  function http(path: string, args?: object, token = 'viewer') {
    return fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${token.repeat(8)}`, 'content-type': 'application/json' },
      ...(args === undefined ? {} : { method: 'POST', body: JSON.stringify(args) }),
    });
  }

  it('refuses phone-only HTTP writes while socket writes still commit', async () => {
    const execute = vi.spyOn(phone, 'execute');
    const markRead = vi.spyOn(phone, 'markRead');
    const markUnread = vi.spyOn(phone, 'markUnread');
    const before = (await db.query('SELECT id,text,reactions FROM messages ORDER BY id')).rows;
    for (const path of [
      '/v1/phone/operations/sendFromWallet', '/v1/phone/operations/reactToMessage',
      '/v1/phone/operations/readNeedsYou', '/v1/phone/operations/readTray',
      `/v1/phone/rooms/${ROOM}/read`, `/v1/phone/rooms/${ROOM}/unread`,
      ...['join','leave','idle','resume'].map(action => `/v1/phone/voice/${ROOM}/${action}`),
      `/v1/phone/workspaces/${WORKSPACE}/agents/${VIEWER}/voices`,
      `/v1/phone/workspaces/${WORKSPACE}/agents/${VIEWER}/voice-preview`,
      '/v1/phone/observations/client-error', '/v1/phone/observations/page-load',
    ]) expect([404, 405, 409]).toContain((await http(path, { roomId: ROOM, messageId: MESSAGE, text: 'HTTP backdoor' })).status);
    expect(execute).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
    expect(markUnread).not.toHaveBeenCalled();
    expect((await db.query('SELECT id,text,reactions FROM messages ORDER BY id')).rows).toEqual(before);
    expect(await request(await open(), 'sendRoomMessage', {
      roomId: ROOM, messageId: 'd'.repeat(64), text: 'One socket door',
    })).toMatchObject({ ok: true, result: { messageId: 'd'.repeat(64) } });
  });

  it.each([
    ['createWorkspace', { name: 'CLI proof' }, { id: WORKSPACE, roomId: ROOM }],
    ['deleteWorkspace', { workspaceId: WORKSPACE }, undefined],
    ['sendRoomMessage', { roomId: ROOM, messageId: 'd'.repeat(64), text: 'CLI proof' }, { messageId: 'd'.repeat(64) }],
    ['requestCornerClose', { roomId: ROOM }, undefined],
  ] as const)('keeps non-phone tool HTTP operation %s on the shared dispatcher', async (operation, args, result) => {
    const execute = vi.spyOn(phone, 'execute').mockResolvedValue(result as never);
    const reply = await http(`/v1/phone/operations/${operation}`, args);
    expect(reply.status).toBe(result === undefined ? 204 : 200);
    if (result === undefined) expect(await reply.text()).toBe('');
    else expect(await reply.json()).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(operation, args, VIEWER, undefined, undefined, true);
  });

  it('a failed Room request leaves another request and the socket usable', async () => {
    const read = vi.spyOn(phone, 'readRoom').mockRejectedValueOnce(new Error('Room read unavailable'));
    const socket = await open();
    const failed = await request(socket, 'readRoom', { roomId: ROOM });
    expect(failed).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: true } });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const healthy = await request(socket, 'readWorkspaces', {});
    expect(healthy).toMatchObject({ ok: true });
    expect(read).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('installed phones select plain reads through the existing sync acknowledgement',async()=>{
    const socket=await open();
    const synchronized=new Promise<void>(resolve=>{
      const receive=(raw:WebSocket.RawData)=>{
        if(JSON.parse(String(raw)).type!=='sync-ok')return;
        socket.off('message',receive);resolve();
      };
      socket.on('message',receive);
    });
    socket.send(JSON.stringify({type:'router-negotiate',protocol:1,families:['room-head','room-list']}));
    socket.send(JSON.stringify({type:'sync',workspaceCursors:{}}));
    await synchronized;
    expect(await request(socket,'readWorkspaces')).toMatchObject({ok:true});
    expect(await request(socket,'readRoom',{roomId:ROOM})).toMatchObject({ok:true});
  });

  it('authenticates once at upgrade and reuses that identity for operation requests', async () => {
    const socket = await open();
    expect(authenticatePhone).toHaveBeenCalledTimes(1);
    authenticatePhone.mockResolvedValue(null);
    expect(await request(socket, 'readWorkspaces')).toMatchObject({ ok: true });
    expect(await request(socket, 'readRoom', { roomId: ROOM })).toMatchObject({ ok: true });
    expect(authenticatePhone).toHaveBeenCalledTimes(1);
  });

  it('P10: a second policy-off server retains a selected command across socket replacement and repeated migration', async () => {
    // This is the current image with rollout policy absent, not an assertion
    // that a pre-ledger image is a supported rollback target.
    const op = 'reactToMessage';
    const args = { roomId: ROOM, messageId: MESSAGE, emoji: '👍' };
    const command = { v: 1 as const, id: 'rollback-reaction' };
    const selected = createBeelineServer({
      database: db,
      phone,
      live,
      auth: { authenticatePhone } as unknown as TokenAuth,
      daemon: {} as DaemonService,
      mediaMaximumBytes: 1,
    });
    selected.listen(0, '127.0.0.1');
    await once(selected, 'listening');
    let first: PhoneResponseFrame;
    const socket = new WebSocket(
      `ws://127.0.0.1:${(selected.address() as AddressInfo).port}/v1/phone/live`,
      [`bearer.${'viewer'.repeat(8)}`],
    );
    sockets.push(socket);
    try {
      await once(socket, 'open');
      first = await request(socket, op, args, undefined, command);
    } finally {
      socket.terminate();
      await new Promise<void>((resolve) => selected.close(() => resolve()));
    }
    expect(first).toMatchObject({
      ok: true,
      result: { state: 'committed', commandId: command.id },
    });
    const retained = (await db.query('SELECT * FROM router_commands')).rows;
    expect(retained).toHaveLength(1);

    await migrate(db);
    await migrate(db);
    expect((await db.query('SELECT * FROM router_commands')).rows).toEqual(retained);

    const publish = vi.spyOn(live, 'publish');
    const replay = await http(`/v1/phone/operations/${op}`, { ...args, command });
    expect(replay.status).toBe(404);
    const replacement = await open();
    expect(await request(replacement, op, args, undefined, command)).toMatchObject({
      ok: true,
      result: first.ok ? first.result : undefined,
    });
    expect(publish).not.toHaveBeenCalled();
    expect((await db.query('SELECT reactions FROM messages WHERE id=$1', [MESSAGE])).rows).toEqual([
      { reactions: { '👍': [VIEWER] } },
    ]);
    expect(await request(replacement, op, { ...args, emoji: '❤️' }, undefined, command))
      .toMatchObject({ ok: false, error: { code: 'command_identity_conflict' } });
  });

  it.each(['pending', 'unknown', 'result-expired'] as const)(
    'P10: migration and policy rollback preserve %s without redispatch on socket ingress',
    async (outcome) => {
      const op = 'reactToMessage';
      const args = { roomId: ROOM, messageId: MESSAGE, emoji: '👍' };
      const command = { v: 1 as const, id: `rollback-${outcome}` };
      await db.query(
        `INSERT INTO router_commands(principal,operation,command_id,digest,state,result,result_expires_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)`,
        [
          VIEWER,
          op,
          command.id,
          commandArgumentDigest(op, args),
          outcome === 'result-expired' ? 'committed' : outcome,
          outcome === 'result-expired' ? JSON.stringify({ privateResult: 'expired' }) : null,
          outcome === 'result-expired' ? '2000-01-01T00:00:00Z' : null,
        ],
      );
      const retained = (await db.query('SELECT * FROM router_commands')).rows;
      await migrate(db);
      expect((await db.query('SELECT * FROM router_commands')).rows).toEqual(retained);
      const publish = vi.spyOn(live, 'publish');
      const expected = { v: 1, operation: op, commandId: command.id, state: outcome };
      const reply = await http(`/v1/phone/operations/${op}`, { ...args, command });
      expect(reply.status).toBe(404);
      expect(await request(await open(), op, args, undefined, command)).toMatchObject({
        ok: true,
        result: expected,
      });
      expect(publish).not.toHaveBeenCalled();
      expect(
        (await db.query('SELECT reactions FROM messages WHERE id=$1', [MESSAGE])).rows,
      ).toEqual([{ reactions: {} }]);
      expect((await db.query('SELECT * FROM router_commands')).rows).toEqual(retained);
    },
  );

  it('C3 counts socket refusals once each alongside successful operations', async () => {
    const socket = await open('outsider');
    const args = { roomId: ROOM };
    expect(await request(socket, 'listRoomWorkflowRuns', args)).toMatchObject({
      ok: false,
      error: { code: 'access_denied', retryable: false },
    });
    expect(await request(socket, 'listRoomWorkflowRuns', args)).toMatchObject({ok:false,error:{code:'access_denied'}});
    expect(await request(socket, 'readWorkspaces')).toMatchObject({ ok: true });
    expect(await request(socket, 'readWorkspaces')).toMatchObject({ok:true});
    expect(await request(socket, 'notAnOperation')).toMatchObject({
      ok: false,
      error: { code: 'unknown_phone_operation' },
    });
    // Outcomes remain entirely in memory until the background flush.
    expect((await db.query('SELECT * FROM operation_outcomes_hourly')).rows).toEqual([]);
    await outcomes.flush(db);
    expect(
      (
        await db.query(
          `SELECT op,status,code,release,count::int FROM operation_outcomes_hourly ORDER BY op`,
        )
      ).rows,
    ).toEqual([
      { op: 'listRoomWorkflowRuns', status: 403, code: 'Error', release: 'socket-test', count: 2 },
      {
        op: 'notAnOperation',
        status: 404,
        code: 'unknown_phone_operation',
        release: 'socket-test',
        count: 1,
      },
      { op: 'readWorkspaces', status: 200, code: '', release: 'socket-test', count: 2 },
    ]);
  });

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
      [
        'readHistoryAround',
        { roomId: ROOM, messageId: MESSAGE },
        `/v1/phone/rooms/${ROOM}/history?around=${MESSAGE}`,
      ],
    ] as const) {
      const web = await http(path);
      expect(web.status, op).toBe(200);
      const expected = await web.json();
      expect(await request(socket, op, args)).toMatchObject({ t: 'res', ok: true, result: expected });
      const genericRead = await http(`/v1/phone/operations/${op}`, args);
      expect(genericRead.status, op).toBe(200);
      expect(await genericRead.json()).toEqual(expected);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('matches concurrent results by id and delivers twenty real database reads out of order', async () => {
    const socket = await open();
    const gates = Array.from({ length: 20 }, () => deferred());
    const admitted = deferred();
    const read = phone.readWorkspaces.bind(phone);
    let count = 0;
    vi.spyOn(phone, 'readWorkspaces').mockImplementation(async (viewer) => {
      const index = count++;
      if (count === 20) admitted.resolve();
      await gates[index]!.promise;
      return read(viewer);
    });
    const order: string[] = [];
    socket.on('message', (raw) => {
      const value = JSON.parse(String(raw));
      if (value.t === 'res') order.push(value.id);
    });
    const replies = gates.map((_, index) =>
      request(socket, 'readWorkspaces', {}, `concurrent-${index}`),
    );
    await admitted.promise;
    for (let index = 19; index >= 0; index--) {
      gates[index]!.resolve();
      expect(await replies[index]).toMatchObject({
        id: `concurrent-${index}`,
        ok: true,
        result: { workspaces: expect.any(Array) },
      });
    }
    expect(order).toEqual(gates.map((_, index) => `concurrent-${19 - index}`));
  });

  it('does not refuse ordinary concurrent reads at the former admission cap', async () => {
    const socket = await open(), gate = deferred(), admitted = deferred();
    const read = phone.readWorkspaces.bind(phone); let count = 0;
    vi.spyOn(phone, 'readWorkspaces').mockImplementation(async viewer => {
      if (++count === 40) admitted.resolve();
      await gate.promise;
      return read(viewer);
    });
    const pending = Array.from({length: 40}, () => request(socket, 'readWorkspaces'));
    await admitted.promise; gate.resolve();
    expect((await Promise.all(pending)).every(reply => reply.ok)).toBe(true);
  });

  it('returns typed errors for unknown operations, malformed frames, validation and current membership', async () => {
    const socket = await open();
    expect(await request(socket, 'notAnOperation')).toMatchObject({
      ok: false,
      error: { code: 'unknown_phone_operation', retryable: false },
    });
    const malformed = response(socket, 'malformed');
    socket.send(JSON.stringify({ t: 'req', id: 'malformed', op: 'readRoom', args: [] }));
    expect(await malformed).toMatchObject({
      ok: false,
      error: { code: 'invalid_request', retryable: false },
    });
    expect(await request(socket, 'readRoom', { roomId: 5 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_args', retryable: false },
    });
    expect(await request(await open('outsider'), 'readRoom', { roomId: ROOM })).toMatchObject({
      ok: false,
      error: { code: 'not_found', retryable: false },
    });
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [VIEWER]);
    expect(await request(socket, 'readRoom', { roomId: ROOM })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('refuses unauthenticated upgrades with a typed HTTP error', async () => {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`);
    const refused = new Promise<{ status: number; body: unknown }>((resolve) => {
      socket.on('unexpected-response', async (_, response) => {
        let raw = '';
        for await (const chunk of response) raw += chunk;
        resolve({ status: response.statusCode!, body: JSON.parse(raw) });
        socket.terminate();
      });
      socket.on('error', () => {});
    });
    expect(await refused).toEqual({ status: 401, body: { error: 'phone_token_required' } });
  });

  it('serves repeated history reads through the socket without read admission', async () => {
    const socket = await open();
    for (let attempt = 0; attempt < 6; attempt++)
      expect(await request(socket, 'readHistory', {roomId: ROOM})).toMatchObject({ok: true});
  });

  it('LATER-1: an unavailable forward cursor keeps failing while the latest history remains readable', async () => {
    const socket = await open();
    const missingCursor = 'd'.repeat(64);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await request(socket, 'readHistoryAfter', { roomId: ROOM, messageId: missingCursor }),
      ).toMatchObject({ ok: false, error: { code: 'not_found', retryable: false } });
    }
    const response = await http(`/v1/phone/rooms/${ROOM}/history?after=${missingCursor}`);
    expect(response.status).toBe(404);
    expect(await request(socket, 'readHistory', { roomId: ROOM })).toMatchObject({
      ok: true,
      result: { messages: [expect.objectContaining({ id: MESSAGE })] },
    });
  });

  it('creates one message and one reply when retried over the socket, rejecting id collisions', async () => {
    const socket = await open();
    for (const [op, id, extra] of [
      ['sendRoomMessage', 'd'.repeat(64), {}],
      ['sendRoomReply', 'e'.repeat(64), { parentMessageId: MESSAGE }],
    ] as const) {
      const args = { roomId: ROOM, messageId: id, text: 'Retry me', ...extra };
      expect(await request(socket, op, args)).toMatchObject({
        ok: true,
        result: { messageId: id },
      });
      expect(await request(socket, op, args)).toMatchObject({
        ok: true,
        result: { messageId: id },
      });
      expect((await http(`/v1/phone/operations/${op}`, args)).status).toBe(op === 'sendRoomMessage' ? 200 : 404);
      expect((await db.query(`SELECT id FROM messages WHERE id=$1`, [id])).rows).toHaveLength(1);
      expect(await request(socket, op, { ...args, text: 'Different payload' })).toMatchObject({
        ok: false,
        error: { retryable: false },
      });
    }
    const room = await http(`/v1/phone/rooms/${ROOM}`);
    const view = (await room.json()) as { messages: { id: string; text: string }[] };
    expect(view.messages.filter((message) => message.text === 'Retry me')).toHaveLength(2);
  });

  it.each([
    ['socket', 'sendRoomMessage'], ['socket', 'sendRoomReply'],
  ] as const)(
    'SEND-ACK-1: %s %s acknowledges the committed write while onboarding observation is blocked',
    async (_transport, op) => {
      const socket = await open();
      const observing = deferred(),
        releaseObservation = deferred();
      const query = db.query.bind(db);
      const observe = vi.spyOn(db, 'query').mockImplementation(async (sql, values) => {
        if (sql.includes('FROM free_agents f JOIN identities i')) {
          observing.resolve();
          await releaseObservation.promise;
        }
        return query(sql, values);
      });
      const id = 'd'.repeat(64);
      const input = {
        roomId: ROOM,
        messageId: id,
        text: 'Acknowledgement precedes analytics',
        ...(op === 'sendRoomReply' ? { parentMessageId: MESSAGE } : {}),
      };
      const reply = request(socket, op, input);
      let acknowledgedWhileBlocked = false;
      try {
        await observing.promise;
        acknowledgedWhileBlocked = await Promise.race([
          reply.then(
            (frame) => frame.ok && (frame.result as { messageId: string }).messageId === id,
          ),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
        ]);
        // Tracked background work keeps its database alive until observation finishes.
        if (acknowledgedWhileBlocked) expect(db.backgroundWork.isEmpty).toBe(false);
        expect((await query(`SELECT id FROM messages WHERE id=$1`, [id])).rows).toHaveLength(1);
      } finally {
        releaseObservation.resolve();
        await reply;
        await db.backgroundWork.drain();
      }
      expect(acknowledgedWhileBlocked).toBe(true);
      expect(observe.mock.calls.some(([sql]) => sql.includes('onboarding_friend_id=$2'))).toBe(
        true,
      );
      expect(db.backgroundWork.isEmpty).toBe(true);
    },
  );

  it('SEND-ACK-2: failed onboarding observation cannot fail a committed send or escape background draining', async () => {
    const socket = await open();
    const error = new Error('analytics unavailable');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const query = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (sql, values) => {
      if (sql.includes('FROM free_agents f JOIN identities i')) throw error;
      return query(sql, values);
    });
    const id = 'd'.repeat(64);
    expect(
      await request(socket, 'sendRoomMessage', {
        roomId: ROOM,
        messageId: id,
        text: 'Keep the receipt',
      }),
    ).toMatchObject({ ok: true, result: { messageId: id } });
    await db.backgroundWork.drain();
    expect(logged).toHaveBeenCalledWith('[onboarding]', error);
    expect(db.backgroundWork.isEmpty).toBe(true);
    expect((await query(`SELECT id FROM messages WHERE id=$1`, [id])).rows).toHaveLength(1);
  });

  it('keeps write change notices and read-mark operations identical to the web path', async () => {
    const socket = await open(),
      publish = vi.spyOn(live, 'publish');
    const args = { roomId: ROOM, messageId: 'f'.repeat(64), text: 'Socket message' };
    expect(await request(socket, 'sendRoomMessage', args)).toMatchObject({ ok: true });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'invalidate',
        roomId: ROOM,
        reason: 'phone-write',
        messageId: args.messageId,
      }),
    );
    publish.mockClear();
    expect(
      await request(socket, 'markRead', { roomId: ROOM, messageId: args.messageId }),
    ).toMatchObject({ ok: true, result: null });
    const incoming = '3'.repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Incoming')`, [
      incoming,
      ROOM,
      OUTSIDER,
    ]);
    expect(
      await request(socket, 'markUnread', { roomId: ROOM, messageId: incoming }),
    ).toMatchObject({ ok: true });
    expect(publish).not.toHaveBeenCalled();
    const view = await (await http(`/v1/phone/rooms/${ROOM}`)).json();
    expect(view.viewer.readCursor).toBeDefined();
  });

  it('lets an admitted transaction finish atomically after close and a new socket safely retry it', async () => {
    const socket = await open(),
      entered = deferred(),
      proceed = deferred(),
      settled = deferred();
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((work) =>
      transaction(async (tx) => {
        const result = await work(tx);
        entered.resolve();
        await proceed.promise;
        return result;
      }).finally(() => settled.resolve()),
    );
    const args = { roomId: ROOM, messageId: '1'.repeat(64), text: 'Survives disconnect' };
    socket.send(JSON.stringify({ t: 'req', id: 'disconnect', op: 'sendRoomMessage', args }));
    await entered.promise;
    socket.close();
    await once(socket, 'close');
    proceed.resolve();
    await settled.promise;
    expect(await request(await open(), 'sendRoomMessage', args)).toMatchObject({ ok: true });
    expect(
      (await db.query(`SELECT id FROM messages WHERE id=$1`, [args.messageId])).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query(
          `SELECT message_id FROM room_read_marks WHERE room_id=$1 AND identity_id=$2`,
          [ROOM, VIEWER],
        )
      ).rows[0]?.message_id,
    ).toBe(args.messageId);
  });

  it('rolls back the entire write if the in-flight transaction fails after socket close', async () => {
    const socket = await open(),
      entered = deferred(),
      proceed = deferred(),
      settled = deferred();
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((work) =>
      transaction(async (tx: SqlDatabase) => {
        await work(tx);
        entered.resolve();
        await proceed.promise;
        throw new Error('Injected transaction failure');
      }).finally(() => settled.resolve()),
    );
    const id = '2'.repeat(64);
    socket.send(
      JSON.stringify({
        t: 'req',
        id: 'rollback',
        op: 'sendRoomMessage',
        args: { roomId: ROOM, messageId: id, text: 'Must roll back' },
      }),
    );
    await entered.promise;
    socket.close();
    await once(socket, 'close');
    proceed.resolve();
    await settled.promise;
    expect((await db.query(`SELECT id FROM messages WHERE id=$1`, [id])).rows).toHaveLength(0);
    expect(
      (await db.query(`SELECT message_id FROM room_read_marks WHERE message_id=$1`, [id])).rows,
    ).toHaveLength(0);
  });

  it('a frame beyond the former limit does not hang up on the phone', async () => {
    const socket = await open();
    const reply = await request(socket, 'readWorkspaces', { padding: 'x'.repeat(64 * 1024) });
    expect(reply).toMatchObject({ ok: true });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(await request(socket, 'readRoom', { roomId: ROOM })).toMatchObject({ ok: true });
  });

  it('refuses vault secret submissions with a typed error and does not read or write the database', async () => {
    const socket = await open();
    const before = await db.query(`SELECT id,card,text FROM messages ORDER BY id`);
    const query = vi.spyOn(db, 'query');
    const execute = vi.spyOn(phone, 'execute');
    const secret = 'socket-refused-secret-sentinel';
    const result = await request(socket, 'submitVaultSave', {
      roomId: ROOM,
      cardId: MESSAGE,
      values: { password: secret },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unknown_phone_operation', retryable: false },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
    const after = await db.query(`SELECT id,card,text FROM messages ORDER BY id`);
    expect(after.rows).toEqual(before.rows);
    const operation = await http('/v1/phone/operations/submitVaultSave', {
      roomId: ROOM,
      cardId: MESSAGE,
      values: { password: secret },
    });
    expect(operation.status).toBe(404);
    expect(await operation.json()).toEqual({ error: 'not_found' });
  });

  it('records page timings and redacts client reports through the socket', async () => {
    const socket = await open(),
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timing = {
      durationMs: 120,
      failed: false,
      network: { requestToFirstByteMs: 80, serverProcessingMs: 30, jsResponseDelayMs: 5 },
    };
    expect(await request(socket, 'reportPageLoad', timing)).toMatchObject({ ok: true });
    expect((await http('/v1/phone/observations/page-load', timing)).status).toBe(404);
    const events = await db.query(
      `SELECT duration_ms,network_rtt_residual_ms,js_response_delay_ms FROM operator_function_events WHERE function_name='page_load'`,
    );
    expect(events.rows).toEqual(
      Array.from({ length: 1 }, () => ({
        duration_ms: 120,
        network_rtt_residual_ms: 50,
        js_response_delay_ms: 5,
      })),
    );
    const report = {
      scope: 'conversation',
      message: 'Error https://example.test/?private=yes Bearer private-value',
      stack: 'at Test:1',
      platform: 'android',
      platformVersion: '36',
      releaseSha: 'fixture',
      runtimeVersion: '34',
      updateId: 'update',
    };
    expect(await request(socket, 'reportClientError', report)).toMatchObject({ ok: true });
    expect((await http('/v1/phone/observations/client-error', report)).status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-value');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('?private=yes');
  });
});
