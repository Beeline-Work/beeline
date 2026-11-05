import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import type { PhoneResponseFrame } from '@beeline/api-contract/phone';
import { TokenAuth } from './auth.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { REVIEW_IDENTITY_ID } from './review-access.js';
import { createBeelineServer } from './server.js';
import { createStarterInvite } from './starter-invite.js';
import { migratedDatabase } from './test-support.js';

it.each(['ordinary', 'review'] as const)('joins a Room-targeted invite through the live socket as an %s person', async kind => {
  const db = await migratedDatabase();
  const live = new LiveHub();
  const auth = new TokenAuth(db, async subject => ({ subject, login: subject, name: subject }));
  const phone = new PhoneService(db, 'http://local.test', undefined, undefined, live);
  const server = createBeelineServer({ database: db, auth, phone, live,
    daemon: new DaemonService(db, live), mediaMaximumBytes: 1 });
  let socket: WebSocket | undefined;
  try {
    const owner = 'a'.repeat(64), workspace = randomUUID(), room = randomUUID();
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner')`, [owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Invite test')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'Target','invite-only')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [workspace, room, owner]);
    const tokens = kind === 'review' ? await auth.exchangeReviewIdentity() : await auth.exchangeGitHubOidc('invite-socket-person');
    if (kind === 'review') expect(tokens.identityId).toBe(REVIEW_IDENTITY_ID);
    const invite = await createStarterInvite(db, room, owner, 'http://local.test');
    const token = new URL(invite.url).pathname.split('/').at(-1)!;
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    socket = new WebSocket(`${origin}/v1/phone/live`, [`bearer.${tokens.accessToken}`]);
    await once(socket, 'open');
    let sequence = 0;
    const request = (op: string, args: object) => new Promise<PhoneResponseFrame>((resolve, reject) => {
      const id = `invite-${++sequence}`;
      const timer = setTimeout(() => finish(new Error('invite socket deadline')), 20_000);
      const finish = (value: PhoneResponseFrame | Error) => {
        clearTimeout(timer); socket!.off('message', message); socket!.off('close', close);
        if (value instanceof Error) reject(value); else resolve(value);
      };
      const message = (raw: WebSocket.RawData) => { const value = JSON.parse(String(raw)); if (value.t === 'res' && value.id === id) finish(value); };
      const close = () => finish(new Error('connection closed before invite answer'));
      socket!.on('message', message); socket!.once('close', close);
      socket!.send(JSON.stringify({ t: 'req', id, op, args }));
    });
    expect(await request('resolveInvite', { token })).toMatchObject({ ok: true, result: { name: 'Invite test' } });
    if (kind === 'ordinary') {
      // The write has committed when its invalidation is published, before
      // the socket response is sent. Lose that response and confirm on a new
      // connection, just as the phone does after an ambiguous join result.
      const publish = live.publish.bind(live);
      const loseReply = vi.spyOn(live, 'publish').mockImplementation(event => {
        publish(event);
        if (event.type === 'invalidate' && event.reason === 'phone-write') socket!.terminate();
      });
      await expect(request('redeemInvite', { token })).rejects.toThrow('connection closed before invite answer');
      loseReply.mockRestore();
      socket = new WebSocket(`${origin}/v1/phone/live`, [`bearer.${tokens.accessToken}`]);
      await once(socket, 'open');
      expect(await request('redeemInvite', { token })).toMatchObject({ ok: true, result: { joined: false, workspaceId: workspace, roomId: room } });
    } else {
      expect(await request('redeemInvite', { token })).toMatchObject({ ok: true, result: { joined: true, workspaceId: workspace, roomId: room } });
    }
    expect((await db.query(`SELECT room_id FROM memberships WHERE workspace_id=$1 AND identity_id=$2 AND removed_at IS NULL`, [workspace, tokens.identityId])).rows)
      .toEqual(expect.arrayContaining([{ room_id: null }, { room_id: room }]));
    expect(await request('readRoom', { roomId: room })).toMatchObject({ ok: true, result: { room: { id: room } } });
    expect(await request('redeemInvite', { token })).toMatchObject({ ok: true, result: { joined: false, roomId: room } });
  } finally {
    vi.restoreAllMocks();
    socket?.terminate(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
  }
}, 30_000);
