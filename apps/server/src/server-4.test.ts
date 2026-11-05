import { phoneFetch, AddressInfo, WebSocket, describe, expect, it, vi, LiveHub, createBeelineServer, nextSocketMessage, type SqlDatabase, type TokenAuth, type PhoneService, type DaemonService } from './server.test-support.js';

describe('live reconnect admission', () => {

  it('recovers 15 agents twice through a two-connection pool without waiters', async () => {
    let inUse = 0;
    let waiting = 0;
    let peakInUse = 0;
    let peakWaiting = 0;
    const poolWaiters: Array<() => void> = [];
    const query = vi.fn(async () => {
      if (inUse >= 2) {
        waiting++;
        peakWaiting = Math.max(peakWaiting, waiting);
        await new Promise<void>((resolve) => poolWaiters.push(resolve));
        waiting--;
      }
      inUse++;
      peakInUse = Math.max(peakInUse, inUse);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inUse--;
      poolWaiters.shift()?.();
      return { rows: [], rowCount: 0 };
    });
    const database = {
      query,
      transaction: vi.fn(),
      poolCounts: () => ({ total: 2, idle: 2 - inUse, waiting }),
    } as unknown as SqlDatabase;
    const server = createBeelineServer({
      database,
      auth: { authenticateDaemon: vi.fn(async (token: string) => token) } as unknown as TokenAuth,
      phone: {
        canReadRooms: vi.fn(async (roomIds: readonly string[]) => {
          await database.query('SELECT 1');
          return new Set(roomIds);
        }),
      } as unknown as PhoneService,
      daemon: {
        execute: vi.fn(async (name: string) => {
          await database.query('SELECT 1');
          return name === 'getAgentCommands'
            ? { commandProtocol: 1, commands: [] }
            : { items: [] };
        }),
      } as unknown as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    const sockets: WebSocket[] = [];
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      for (let wave = 0; wave < 2; wave++) {
        const waveSockets = Array.from({ length: 15 }, (_, index) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, [
            `bearer.bdt_agent_${index}`,
          ]);
          sockets.push(socket);
          return socket;
        });
        await Promise.all(waveSockets.map(async (socket, index) => {
          await new Promise<void>((resolve, reject) => {
            socket.once('open', () => resolve());
            socket.once('error', reject);
          });
          const commands = nextSocketMessage(socket, 'commands');
          socket.send(JSON.stringify({ type: 'subscribe', roomId: `room-${index}` }));
          await commands;
        }));
        await Promise.all(waveSockets.map((socket) => new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          socket.close();
        })));
      }
      expect(peakInUse).toBeLessThanOrEqual(2);
      expect(peakWaiting).toBe(0);
      const health = await phoneFetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect((await health.json()).database.pool.waiting).toBe(0);
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
