import { phoneFetch } from '../../../tests/helpers/phone-operation.js';

import type { AddressInfo } from 'node:net';

import WebSocket from 'ws';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Pool } from 'pg';

import { PostgresDatabase, type SqlDatabase } from './database.js';

import type { TokenAuth } from './auth.js';

import type { PhoneService } from './phone-service.js';

import { type RoomLiveDelta } from '@beeline/api-contract/phone';

import type { DaemonService } from './daemon-service.js';

import { WorkspaceSkillNotFoundError } from './institutional-skills.js';

import { LiveHub } from './live.js';

import { createBeelineServer, maxLiveDbTasks, type ServerOptions } from './server.js';

import { databaseConnectionBudget } from './database-budget.js';



export function canReadRoomsFrom(canReadRoom: (roomId: string, identityId: string) => Promise<boolean>) {
  return async (roomIds: readonly string[], identityId: string) => {
    const allowed = new Set<string>();
    for (const roomId of roomIds) {
      if (await canReadRoom(roomId, identityId)) allowed.add(roomId);
    }
    return allowed;
  };
}


export function nextSocketMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`websocket ${type} timeout`));
    }, 3_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}


export function nextSocketMessages(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      if (messages.length !== count) return;
      cleanup();
      resolve(messages);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`websocket ${count}-message timeout`));
    }, 3_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}


export function expectNoSocketMessageOfType(
  socket: WebSocket,
  type: string,
  durationMs = 25,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type !== type) return;
      cleanup();
      reject(new Error(`unexpected websocket message: ${raw.toString()}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}


export function expectNoSocketMessage(socket: WebSocket, durationMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      cleanup();
      reject(new Error(`unexpected websocket message: ${raw.toString()}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}
export function fixtureScope1() {

  const servers: ReturnType<typeof createBeelineServer>[] = [];


  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });


  async function get(path: string, database: SqlDatabase, extra: Partial<ServerOptions> = {},
    requestInit: RequestInit = {}): Promise<Response> {
    const server = createBeelineServer({
      database,
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
      ...extra,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return fetch(`http://127.0.0.1:${port}${path}`, requestInit);
  }
return {
servers,
get,
};
}
export function fixtureScope2() {

  const servers: ReturnType<typeof createBeelineServer>[] = [];

  const sockets: WebSocket[] = [];


  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });
return {
servers,
sockets,
};
}
export function fixtureScope3() {

  const servers: ReturnType<typeof createBeelineServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });
return {
servers,
};
}
export function fixtureScope4() {

  const servers: ReturnType<typeof createBeelineServer>[] = [];

  const sockets: WebSocket[] = [];


  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });


  async function connect(
    readLiveDelta: PhoneService['readLiveDelta'],
    projectCommittedLiveDelta: PhoneService['projectCommittedLiveDelta'] = vi
      .fn()
      .mockResolvedValue(null),
    canReadRoom = vi.fn().mockResolvedValue(true),
    livePaintDiagnostics = false,
    databaseQuery = vi.fn(),
    liveChatCornerStatus?: PhoneService['liveChatCornerStatus'],
    readLiveDeltas?: PhoneService['readLiveDeltas'],
    readLiveBookmark?: PhoneService['readLiveBookmark'],
    liveNeedsYou?: PhoneService['liveNeedsYou'],
    phoneReads: Partial<PhoneService> = {},
    sidebarPreviews = false,
    roomId = 'room-live',
  ) {
    const live = new LiveHub();
    const liveDraftSnapshot = vi.fn().mockResolvedValue([]);
    const server = createBeelineServer({
      database: { query: databaseQuery, transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: {
        canReadRoom,
        canReadRooms: canReadRoomsFrom(canReadRoom),
        liveDraftSnapshot,
        readLiveDelta,
        // The server reads every row through the batch; by default it is the
        // per-viewer read for each socket.
        readLiveDeltas: readLiveDeltas ?? (async (room, viewers, target) => {
          const deltas = new Map<string, RoomLiveDelta>();
          for (const viewer of viewers) {
            const delta = await readLiveDelta(room, viewer, target);
            if (delta) deltas.set(viewer, delta);
          }
          return deltas;
        }) satisfies PhoneService['readLiveDeltas'],
        readLiveBookmark,
        liveNeedsYou,
        projectCommittedLiveDelta,
        liveChatCornerStatus,
        ...phoneReads,
      } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live,
      livePaintDiagnostics,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const subscribed = nextSocketMessage(socket, 'subscribed');
    socket.send(JSON.stringify({ type: 'subscribe', roomId, ...(sidebarPreviews ? { sidebarPreviews: true } : {}) }));
    await subscribed;
    return { live, roomId, socket, port, liveDraftSnapshot };
  }
return {
servers,
sockets,
connect,
};
}
export { phoneFetch } from '../../../tests/helpers/phone-operation.js';
export { AddressInfo } from 'node:net';
export { default as WebSocket } from 'ws';
export { afterEach, describe, expect, it, vi } from 'vitest';
export { PostgresDatabase } from './database.js';
export { WorkspaceSkillNotFoundError } from './institutional-skills.js';
export { LiveHub } from './live.js';
export { createBeelineServer, maxLiveDbTasks } from './server.js';
export { databaseConnectionBudget } from './database-budget.js';
export type { Pool } from 'pg';
export type { SqlDatabase } from './database.js';
export type { TokenAuth } from './auth.js';
export type { PhoneService } from './phone-service.js';
export type { RoomLiveDelta } from '@beeline/api-contract/phone';
export type { DaemonService } from './daemon-service.js';
export type { ServerOptions } from './server.js';
