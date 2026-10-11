import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { TokenAuth } from './auth.js';
import { migrate } from './database.js';
import type { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase } from './test-support.js';

// Reproduction R-J28/R-J29/R-J30: one real database, LISTEN bridge, phone
// socket server and phone operations. A write from one session must reach
// another session's socket, and never a viewer outside the shared scope.
const VIEWER = 'a'.repeat(64);
const MATE = 'b'.repeat(64);
const OUTSIDER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ELSEWHERE = '22222222-2222-4222-8222-222222222222';

const SNAPSHOT = await (async () => {
  const database = new PgliteDatabase();
  try {
    await migrate(database);
    return await database.snapshot();
  } finally {
    await database.close();
  }
})();

class PgliteListenClient extends EventEmitter implements LivePgClient {
  private release?: () => Promise<void>;
  constructor(private readonly database: PgliteDatabase) { super(); }
  async connect(): Promise<void> {}
  async query(): Promise<void> {
    this.release = await this.database.client.listen(POSTGRES_LIVE_CHANNEL, (payload) =>
      this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload }));
  }
  async end(): Promise<void> { await this.release?.(); }
}

function frames(socket: WebSocket, type: string): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  socket.on('message', (raw) => {
    const value = JSON.parse(String(raw)) as Record<string, unknown>;
    if (value.type === type) seen.push(value);
  });
  return seen;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('live Workspace and identity changes across sessions', () => {
  let database: PgliteDatabase;
  let listener: PostgresLiveListener;
  let server: Server;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    database = PgliteDatabase.fromSnapshot(SNAPSHOT);
    for (const [id, name] of [[VIEWER, 'Viewer'], [MATE, 'Mate'], [OUTSIDER, 'Outsider']])
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$2)`, [id, name]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Studio'),($2,'Elsewhere')`,
      [WORKSPACE, ELSEWHERE]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($2,NULL,$5,'owner')`,
      [WORKSPACE, ELSEWHERE, VIEWER, MATE, OUTSIDER]);
    const live = new LiveHub();
    listener = new PostgresLiveListener(database, live, () => new PgliteListenClient(database), 1);
    void listener.run();
    await until(() => listener.projectionHealth().connected);
    server = createBeelineServer({
      database,
      auth: { authenticatePhone: async (raw: string) =>
        raw === 'outsider' ? OUTSIDER : raw === 'mate' ? MATE : VIEWER } as unknown as TokenAuth,
      phone: new PhoneService(database, 'http://local.test'),
      daemon: {} as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await listener.stop();
    await database.close();
    vi.restoreAllMocks();
  });

  async function open(token: string): Promise<WebSocket> {
    const { port } = server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, [`bearer.${token}`]);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return socket;
  }

  it('sends a person rename made in another session to who shares a Workspace only', async () => {
    const viewer = await open('viewer');
    const outsider = await open('outsider');
    const viewerFrames = frames(viewer, 'person-changed');
    const outsiderFrames = frames(outsider, 'person-changed');
    const phone = new PhoneService(database, 'http://local.test');
    await phone.execute('updatePersonProfile', { name: 'Mate Renamed' }, MATE);
    await until(() => viewerFrames.length > 0);
    expect(viewerFrames).toEqual([{ type: 'person-changed', roomId: '',
      person: { pubkey: MATE, kind: 'human', name: 'Mate Renamed' } }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(outsiderFrames).toEqual([]);
  });

  it('sends a Workspace rename to its members only', async () => {
    const viewer = await open('viewer');
    const outsider = await open('outsider');
    const viewerFrames = frames(viewer, 'workspace-changed');
    const outsiderFrames = frames(outsider, 'workspace-changed');
    const phone = new PhoneService(database, 'http://local.test');
    await phone.execute('updateWorkspace', { workspaceId: WORKSPACE, name: 'Atelier' }, VIEWER);
    await until(() => viewerFrames.length > 0);
    expect(viewerFrames).toEqual([{ type: 'workspace-changed', roomId: '',
      workspace: { id: WORKSPACE, name: 'Atelier' } }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(outsiderFrames).toEqual([]);
  });

  it('sends a push level change from another device to its owner only', async () => {
    const viewer = await open('viewer');
    const mate = await open('mate');
    const outsider = await open('outsider');
    const viewerFrames = frames(viewer, 'person-changed');
    const mateFrames = frames(mate, 'person-changed');
    const outsiderFrames = frames(outsider, 'person-changed');
    const phone = new PhoneService(database, 'http://local.test');
    await phone.execute('updateIdentityPushLevel', { pushLevel: 'off' }, VIEWER);
    await until(() => viewerFrames.length > 0);
    expect(viewerFrames).toEqual([{ type: 'person-changed', roomId: '',
      person: { pubkey: VIEWER, kind: 'human', name: 'Viewer' }, pushLevel: 'off' }]);
    // A Workspace co-member shares the person but not their own setting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mateFrames).toEqual([]);
    expect(outsiderFrames).toEqual([]);
  });
});
