import { describe, expect, it, LiveHub, PostgresLiveListener, AUTHOR, ROOM, PgliteListenClient, eventually, fixtureScope1, type LiveEvent } from './test-support-postgres-live.test-support.js';

describe('Postgres live fanout', () => {
const scope1 = fixtureScope1();




  it('broadcasts resync after its listener connection is restored', async () => {
    const live = new LiveHub();
    const clients: PgliteListenClient[] = [];
    let reconnect!: () => void;
    const reconnectReady = new Promise<void>(resolve => { reconnect = resolve; });
    const listener = new PostgresLiveListener(
      scope1.database,
      live,
      () => {
        const client = new PgliteListenClient(scope1.database);
        if (clients.length) client.connect = () => reconnectReady;
        clients.push(client);
        return client;
      },
    );
    scope1.listeners.push(listener);
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);

    const received: LiveEvent[] = [];
    const recovered: string[] = [];
    live.subscribe(ROOM, (event) => {
      received.push(event);
      if (event.type === 'invalidate' && event.reason === 'resync') {
        void scope1.database
          .query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 ORDER BY id`, [ROOM])
          .then((rows) => recovered.push(...rows.rows.map((row) => row.id)));
      }
    });
    await clients[0]!.drop();
    const missedId = '2'.repeat(64);
    await scope1.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'while down')`,
      [missedId, ROOM, AUTHOR],
    );
    reconnect();
    await eventually(() => clients.length === 2);
    await eventually(() => received.some((event) => event.type === 'invalidate'));
    await eventually(() => recovered.includes(missedId));

    expect(received).toContainEqual({ type: 'invalidate', roomId: ROOM, reason: 'resync' });
    expect(recovered).toContain(missedId);
  });
});
