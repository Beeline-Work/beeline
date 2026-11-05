import { describe, expect, it, vi, LiveHub, announceAgentLifecycle, ConnectionPresence, POSTGRES_LIVE_CHANNEL, PostgresLiveListener, AUTHOR, WORKSPACE, ROOM, PgliteListenClient, eventually, fixtureScope1, type LiveEvent } from './postgres-live.test-support.js';

describe('Postgres live fanout', () => {
const scope1 = fixtureScope1();


  it('delivers a phone-side model/effort change as an agent-config invalidation', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    received.length = 0;

    // PhoneService.updateAgentModel writes this synthetic payload directly
    // inside the selection transaction — the agents table has no Room for a
    // row trigger, so the wake rides the same pg_notify channel.
    await scope1.database.query(`SELECT pg_notify($1, $2)`, [
      POSTGRES_LIVE_CHANNEL,
      JSON.stringify({ table: 'agent_config', operation: 'UPDATE', roomId: ROOM, agentId: AUTHOR }),
    ]);

    await eventually(
      () =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'agent-config' &&
            event.targetAgentId === AUTHOR &&
            event.roomId === ROOM,
        ),
    );
  });


  it('fans an agent presence fact to every joined Room on another server', async () => {
    const otherRoom = '33333333-3333-4333-8333-333333333333';
    const agent = 'b'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await scope1.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other')`, [
      otherRoom,
      WORKSPACE,
    ]);
    await scope1.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$4,'member'),($1,$3,$4,'member')`,
      [WORKSPACE, ROOM, otherRoom, agent],
    );
    const liveB = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, liveB, () => client);
    scope1.listeners.push(listener);
    void listener.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await announceAgentLifecycle(scope1.database, new LiveHub(), ROOM, agent, { lifecycleId: 'boot' });
    await eventually(() => liveB.latestAgentPresence(agent, ROOM)?.status === 'online');
    expect(liveB.latestAgentPresence(agent, otherRoom)?.status).toBe('online');
    await announceAgentLifecycle(scope1.database, new LiveHub(), otherRoom, agent, {
      lifecycleId: 'boot',
    });
    await eventually(() => liveB.latestAgentPresence(agent, otherRoom)?.status === 'online');
    const presenceRows = await scope1.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM live_outputs
       WHERE agent_id=$1 AND kind='presence'`,
      [agent],
    );
    expect(presenceRows.rows[0]?.count).toBe('1');
    await scope1.database.query(
      `UPDATE live_outputs SET body=body || jsonb_build_object(
      'status','offline','observedAt',(body->>'observedAt')::bigint+1) WHERE agent_id=$1`,
      [agent],
    );
    await eventually(() => liveB.latestAgentPresence(agent, otherRoom)?.status === 'offline');
    expect(liveB.latestAgentPresence(agent, ROOM)?.status).toBe('offline');
  });


  it('fans one canonical presence notification across thirty Rooms on each listener', async () => {
    const agent = 'b'.repeat(64);
    const roomIds = Array.from(
      { length: 30 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    for (const roomId of roomIds) {
      await scope1.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Load')`, [
        roomId,
        WORKSPACE,
      ]);
      await scope1.database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'member')`,
        [WORKSPACE, roomId, agent],
      );
    }
    for (const roomId of roomIds)
      await scope1.database.query(
        `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
         VALUES($1,$2,'presence','presence',$3::jsonb)`,
        [
          roomId,
          agent,
          JSON.stringify({
            status: 'online',
            observedAt: 1,
            evidenceNonce: 'before',
            lifecycleId: 'boot',
          }),
        ],
      );
    const queryA = vi.fn(scope1.database.query.bind(scope1.database));
    const queryB = vi.fn(scope1.database.query.bind(scope1.database));
    const liveA = new LiveHub();
    const liveB = new LiveHub();
    const clientA = new PgliteListenClient(scope1.database);
    const clientB = new PgliteListenClient(scope1.database);
    const listenerA = new PostgresLiveListener(
      { query: queryA, transaction: scope1.database.transaction.bind(scope1.database) },
      liveA,
      () => clientA,
    );
    const listenerB = new PostgresLiveListener(
      { query: queryB, transaction: scope1.database.transaction.bind(scope1.database) },
      liveB,
      () => clientB,
    );
    scope1.listeners.push(listenerA, listenerB);
    void listenerA.run();
    void listenerB.run();
    await eventually(() => queryA.mock.calls.length > 0 && queryB.mock.calls.length > 0);
    queryA.mockClear();
    queryB.mockClear();

    const publishA = vi.spyOn(liveA, 'publish');
    const publishB = vi.spyOn(liveB, 'publish');
    const evidence = new ConnectionPresence(scope1.database, new LiveHub());
    await evidence.evidence(roomIds[0], agent);

    await eventually(
      () =>
        liveA.latestAgentPresence(agent, roomIds[0])?.status === 'online' &&
        liveB.latestAgentPresence(agent, roomIds[0])?.status === 'online',
    );
    await evidence.stop();
    const stored = await scope1.database.query<{ body: { evidenceNonce?: string } }>(
      `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
      [agent],
    );
    expect(stored.rows.filter((row) => row.body.evidenceNonce !== 'before')).toHaveLength(1);
    expect(clientA.payloads).toHaveLength(1);
    expect(clientB.payloads).toHaveLength(1);
    expect(queryA).toHaveBeenCalledTimes(1);
    expect(queryB).toHaveBeenCalledTimes(1);
    for (const query of [queryA.mock.calls[0]?.[0], queryB.mock.calls[0]?.[0]]) {
      expect(query).toContain('SELECT membership.room_id,presence.body');
      expect(query?.match(/SELECT body FROM live_outputs/g)).toHaveLength(1);
    }
    expect(publishA).toHaveBeenCalledTimes(roomIds.length);
    expect(publishB).toHaveBeenCalledTimes(roomIds.length);
    expect([...queryA.mock.calls, ...queryB.mock.calls].map(([sql]) => sql)).toContainEqual(
      expect.stringContaining('room_access'),
    );
    for (const roomId of roomIds) {
      expect(liveA.latestAgentPresence(agent, roomId)?.status).toBe('online');
      expect(liveB.latestAgentPresence(agent, roomId)?.status).toBe('online');
    }
  });




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
