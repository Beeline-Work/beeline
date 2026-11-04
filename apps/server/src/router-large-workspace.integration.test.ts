import { beforeAll, afterAll, afterEach, expect, it } from 'vitest';
import { phoneRouterHost } from './test-fixtures/test-support-phone-router-host.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { routerSocketProtocol } from './router-socket.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const VIEWER = 'a'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase;
let host: Awaited<ReturnType<typeof phoneRouterHost>>;
beforeAll(async () => { host = await phoneRouterHost(VIEWER); });
afterAll(async () => { await host?.close(); });
afterEach(async () => { await db?.close(); });

it('keeps a loaded Room list live when a Workspace with 1,900 mostly archived Rooms changes', async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic reader')`, [VIEWER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic scale proof')`, [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Experiments')`, [ROOM, WS, VIEWER]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [WS, ROOM, VIEWER]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,archived_at)
    SELECT ('33333333-3333-4333-8333-'||lpad(n::text,12,'0'))::uuid,$1,$2,$3,'Archived corner '||n,now()
    FROM generate_series(1,1899) n`, [WS, ROOM, VIEWER]);
  const live = new LiveHub(), phone = new PhoneService(db, 'https://synthetic.test');
  const frames: Record<string, any>[] = [];
  let delivered!: () => void;
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  const protocol = routerSocketProtocol(db, VIEWER, raw => {
    const frame = JSON.parse(raw); frames.push(frame);
    if (frame.kind) host.phone.routerOwnerReceive(frame);
    if (frame.kind === 'push-commit' || frame.kind === 'router-unavailable') delivered();
  }, { families: ['room-list', 'room-head'], listenerReady: () => true, roomHeadContinuityV1: true },
  { live, phone, rooms: () => [] });
  try {
    await protocol.handle({ type: 'router-negotiate', protocol: 1, families: ['room-list', 'room-head'], authorityFencesV1: true, roomHeadContinuityV1: true });
    const request = { family: 'room-list', workspaceId: WS } as const;
    host.phone.routerOwnerNavigation({ routes: [{ key: 'channels', name: 'beeline/channels', params: { communityId: WS } }] });
    let changed!: () => void;
    const initial = new Promise<void>(resolve => { changed = resolve; });
    const lane = host.phone.acquireRouterLane(request, () => true, () => { if (lane.current().state === 'LIVE') changed(); });
    await host.phone.routerOwnerNegotiated({ generation: 1, families: ['room-list', 'room-head'], authorityFencesV1: true,
      execute: async (input: any) => { const value = await protocol.snapshot(input); await protocol.fenceReply('readRouterSnapshot', input, value, () => undefined); return value; } });
    await initial;
    expect(lane.current().state).toBe('LIVE');
    const snapshot = await protocol.snapshot(request);
    expect(snapshot.value).toMatchObject({ chats: [{ room: { id: ROOM } }] });
    await protocol.fenceReply('readRouterSnapshot', { family: 'room-list', workspaceId: WS }, snapshot, () => undefined);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('scale-update',$1,$2,'A live update')`, [ROOM, VIEWER]);
    live.journalChanged([`workspace:${WS}`]);
    await delivery;
    expect(frames.filter(frame => frame.kind === 'router-unavailable')).toEqual([]);
    expect(frames.some(frame => frame.kind === 'push-commit')).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(lane.current()).toMatchObject({ state: 'LIVE', error: null });
    lane.release();
  } finally { host.phone.routerOwnerDisconnected(); protocol.close(); }
});
