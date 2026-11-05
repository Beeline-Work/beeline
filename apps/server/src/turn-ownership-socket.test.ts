import { DaemonApiClient } from '../../body/src/daemon-api-client.js';
import { MachineLink } from '../../body/src/machine-link.js';
import type { AddressInfo } from 'node:net';
import { setTimeout as realTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentCommand } from './agent-command.js';
import type { TokenAuth } from './auth.js';
import { ConnectionPresence, expireOwnedAgentTurns } from './connection-presence.js';
import { MACHINE_SOCKET_PROTOCOL } from './daemon-live.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import type { PostgresDatabase } from './database.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
import { PostgresLiveListener } from './postgres-live.js';

const agent = 'a'.repeat(64), owner = 'b'.repeat(64);
const room = '11111111-1111-4111-8111-111111111111', workspace = '22222222-2222-4222-8222-222222222222';
type Frame = Record<string, any>;
const postgresUrl = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.each(['pglite', ...(postgresUrl ? ['postgres'] : [])])('P12 actual selected turn control socket (%s)', backend => {
  let db: PgliteDatabase | PostgresDatabase, live: LiveHub, presence: ConnectionPresence, daemon: DaemonService;
  let closeDatabase: () => Promise<void>;
  let connectionString: string | undefined;
  let listener: PostgresLiveListener | undefined, listening: Promise<void> | undefined;
  let server: ReturnType<typeof createBeelineServer> | undefined;
  const sockets: WebSocket[] = [], releases: Promise<void>[] = [];
  const controls = new Set<{ run: () => void; interval: number; next: number }>();
  let elapsed = 0;
  const connectionWork = (run: () => void, interval: number) => {
    const control = { run, interval, next: elapsed + interval }; controls.add(control);
    return () => { controls.delete(control); };
  };
  let command: NonNullable<Awaited<ReturnType<typeof createAgentCommand>>>;
  beforeEach(async () => {
    if (backend === 'postgres') {
      const fixture = await groupBPostgresDatabase(postgresUrl!);
      db = fixture.database; closeDatabase = fixture.close;
      connectionString = fixture.connectionString;
    } else { db = await migratedDatabase(); closeDatabase = () => db.close(); connectionString = undefined; }
    live = new LiveHub();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic owner'),($2,'agent','Synthetic agent')`, [owner, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,NULL,$4,'member'),($1,$3,$4,'member')`, [workspace, owner, room, agent]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('synthetic-request',$1,$2,'Synthetic work')`, [room, owner]);
    command = (await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: 'synthetic-request', reason: 'human_mention' }))!;
    expect(command).toBeDefined();
    // Only Date and the two actual connection control owners are driven.
    // PostgreSQL's pool, socket and transaction timers keep real time.
    elapsed = 0; controls.clear(); vi.useFakeTimers({ toFake: ['Date'] });
    presence = new ConnectionPresence(db, live, undefined, undefined, { connectionWork });
    const release = presence.releaseConnection.bind(presence);
    vi.spyOn(presence, 'releaseConnection').mockImplementation((...args) => {
      const work = release(...args); releases.push(work); return work;
    });
    daemon = new DaemonService(db, live);
  }, 60_000);
  afterEach(async () => {
    // Node HTTP and pg pool shutdown use real control timers. Business-clock
    // assertions finish before teardown; never freeze connection cleanup.
    vi.useRealTimers();
    for (const socket of sockets.splice(0)) socket.terminate();
    if (server) { await new Promise<void>(done => server!.close(() => done())); server = undefined; }
    await listener?.stop(); await listening; listener = undefined; listening = undefined;
    await Promise.all(releases.splice(0)); await presence?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await closeDatabase?.();
  });
  async function connect(enabled = true, identity = agent) {
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1', enabled ? '1' : '0');
    if (!server) {
      server = createBeelineServer({ database: db, live, daemon, connectionPresence: presence, liveHeartbeatMs: 30_000,
        connectionWork,
        auth: { authenticateDaemon: async (token: string) => token === 'bdt_synthetic' ? agent : token === 'bdt_synthetic_peer' ? 'c'.repeat(64) : null,
          retiredDaemonAgent: async () => null, authenticatePhone: async () => null } as unknown as TokenAuth,
        phone: { canReadRooms: async () => new Set([room]) } as unknown as PhoneService });
      await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
    }
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/live`, [MACHINE_SOCKET_PROTOCOL]);
    sockets.push(socket); const frames: Frame[] = [];
    let closed: { code: number; reason: string } | undefined;
    socket.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((done, reject) => { socket.once('open', done); socket.once('error', reject); });
    const next = async (predicate: (frame: Frame) => boolean, label = predicate.toString()) => {
      const current = frames.find(predicate); if (current) return current;
      return new Promise<Frame>((resolve, reject) => {
        const release = () => { realClearTimeout(deadline); socket.off('message', observe); };
        const observe = () => { const result = frames.find(predicate); if (result) { release(); resolve(result); } };
        const deadline = realTimeout(() => { release(); reject(new Error(
          `Missing ${label}; state=${socket.readyState}; close=${JSON.stringify(closed)}; frames=${JSON.stringify(frames)}`)); }, 2_000);
        socket.on('message', observe);
      });
    };
    const send = (frame: Frame) => socket.send(JSON.stringify({ agentId: identity, ...frame }));
    send({ type: 'register', token: identity === agent ? 'bdt_synthetic' : 'bdt_synthetic_peer', lifecycleId: 'synthetic-lifecycle', turnOwnershipV1: true, intakeHeartbeat: true });
    const registered = await next(frame => frame.type === 'registered');
    return { socket, frames, send, next, registered };
  }
  async function claim(client: Awaited<ReturnType<typeof connect>>, generationId = 'generation', requestId = 'claim') {
    client.send({ type: 'turn-operation', operation: 'claimAgentCommand', requestId,
      input: { roomId: room, commandId: command.id, generationId } });
    return client.next(frame => frame.type === 'turn-result' && frame.requestId === requestId, `turn result ${requestId}`);
  }

  it('SOCKET-CONTINUE: completes one generation across repeated machine socket kills and keeps Squire connected', async () => {
    const bootstrap = await connect();
    bootstrap.socket.terminate();
    const helperSockets: WebSocket[] = [];
    const log = vi.fn();
    let vaultRevision = 0;
    const vault = vi.fn(async () => ({ connections: [{
      reference: 'synthetic-credential', service: 'example', label: `revision-${vaultRevision}`,
      fieldNames: ['password'], allowedHosts: ['example.test'], createdAt: 1,
      stale: false, state: 'active' as const,
    }] }));
    const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const machine = new MachineLink({ baseUrl, readVault: vault, log,
      factory: (url, protocols, options) => {
        const socket = new WebSocket(url, protocols, options);
        helperSockets.push(socket); sockets.push(socket); return socket;
      } });
    const api = new DaemonApiClient(baseUrl, 'bdt_synthetic', agent, fetch,
      undefined, undefined, machine);
    const lost = vi.fn();
    const turn = {roomId:room,requestId:command.turn_request_id,generationId:'socket-continuation'};
    const report = async () => {
      // Join the actual observation/delivery. An already-connected server
      // verdict cannot prove that an asynchronous vault report has settled.
      await machine.refreshVault();
      await vi.waitFor(async () => expect((await daemon.execute('getConnectorStatus',
        {agentId:agent,connectorId:`squire:${agent}`},agent)).status).toBe('connected'));
    };
    try {
      await api.execute('getAgentCommands',{roomId:room});
      await api.execute('claimAgentCommand',{roomId:room,commandId:command.id,generationId:turn.generationId});
      const source = api.turnOwnershipScope()!;
      api.noteOwnedTurnClaim(turn,source,lost);
      await report();
      const execute = daemon.execute.bind(daemon);
      let cut: string | undefined;
      vi.spyOn(daemon,'execute').mockImplementation(async (name,input,...rest) => {
        const result = await execute(name,input,...rest);
        if (name === cut) {
          cut = undefined;
          helperSockets.at(-1)!.terminate();
        }
        return result;
      });
      await api.runWithTurnOwnership(turn,async () => {
        for(let drop=0;drop<3;drop++) {
          // Kill after the control committed but before its reply can reach the
          // helper. Registration must reconcile this same command/generation.
          cut='claimAgentCommand';
          await api.execute('claimAgentCommand',{roomId:room,commandId:command.id,generationId:turn.generationId});
          expect(api.turnOwnershipScope()).toEqual(source);
          expect(lost).not.toHaveBeenCalled();
          expect(await expireOwnedAgentTurns(db,live,agent)).toBe(0);
          // A lost broker report is not a new broker failure verdict.
          // Only changed machine observations are sent. Exercise a real new
          // vault revision so every cut reaches a committed report.
          vaultRevision += 1;
          cut='postConnectorVault';
          await machine.refreshVault();
          expect(cut).toBeUndefined();
          await vi.waitFor(()=>expect(log.mock.calls.filter(([line])=>String(line).includes('machine report unavailable'))).toHaveLength(drop+1));
          await api.execute('getAgentCommands',{roomId:room});
          await report();
        }
        // A failed local observation must also retain the last connected fact.
        const observations = vault.mock.calls.length;
        vault.mockRejectedValueOnce(new Error('Squire MCP session closed'));
        await machine.refreshVault();
        expect(vault).toHaveBeenCalledTimes(observations + 1);
        expect(log.mock.calls.some(([line])=>String(line).includes('Squire MCP session closed'))).toBe(true);
        expect((await daemon.execute('getConnectorStatus',{agentId:agent,connectorId:`squire:${agent}`},agent)).status).toBe('connected');
        await api.execute('postRoomMessage',{...turn,text:'Finished despite seven socket drops.'});
        cut='postAgentTurnReceipt';
        await api.execute('postAgentTurnReceipt',{agentId:agent,...turn,status:'complete'});
      });
      expect(lost).not.toHaveBeenCalled();
      expect((await db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1',[command.id])).rows[0])
        .toMatchObject({state:'complete',generation_id:turn.generationId});
      expect((await db.query('SELECT status,generation_id FROM agent_turns WHERE request_id=$1',[turn.requestId])).rows[0])
        .toMatchObject({status:'complete',generation_id:turn.generationId});
      expect((await db.query('SELECT count(*)::int n FROM messages WHERE author_id=$1 AND text=$2',[agent,'Finished despite seven socket drops.'])).rows[0]).toEqual({n:1});
      expect(helperSockets.length).toBe(8);
      console.info('SOCKET-CONTINUE: 7 killed machine sockets; 1 command; 1 generation; 1 final reply; complete; Squire connected; 0 cancellations');
    } catch(error) {
      console.info(`SOCKET-CONTINUE interrupted: cancellations=${lost.mock.calls.length}; sockets=${helperSockets.length}; error=${error instanceof Error?error.message:String(error)}`);
      throw error;
    } finally { api.closeLive(); machine.stop(); }
  });

  it('binds the actual registration, replays without row writes, and rejects freshness/legacy receipt paths', async () => {
    const client = await connect();
    expect(client.registered.capabilities).toMatchObject({ turnOwnershipV1: true, intakeHeartbeat: false });
    expect(await claim(client)).toHaveProperty('result');
    const current = (await db.query(`SELECT turn_owner_connection_id,turn_owner_epoch::integer turn_owner_epoch,lease_expires_at FROM agent_commands WHERE id=$1`, [command.id])).rows[0]!;
    expect(current).toMatchObject({ turn_owner_connection_id: client.registered.capabilities.turnConnectionId,
      turn_owner_epoch: client.registered.capabilities.turnConnectionEpoch, lease_expires_at: null });
    const versions = async () => (await db.query(`SELECT command.xmin::text command_version,turn.xmin::text turn_version,
      turn.created_at::text,turn.started_at::text,binding.xmin::text binding_version
      FROM agent_commands command JOIN agent_turns turn ON turn.room_id=command.room_id AND turn.agent_id=command.agent_id
        AND turn.request_id=command.turn_request_id JOIN agent_command_generation_owners binding ON binding.command_id=command.id
        AND binding.generation_id=command.generation_id WHERE command.id=$1`, [command.id])).rows;
    const before = await versions();
    for (let i = 0; i < 10; i += 1) expect(await claim(client, 'generation', `replay-${i}`)).toHaveProperty('result');
    expect(await versions()).toEqual(before);
    client.send({ type: 'turn-operation', operation: 'postAgentTurnReceipt', requestId: 'freshness',
      input: { agentId: agent, roomId: room, requestId: command.turn_request_id, generationId: 'generation', status: 'working', heartbeat: true } });
    expect(await client.next(frame => frame.requestId === 'freshness')).toHaveProperty('error');
    await expect(daemon.execute('postAgentTurnReceipt', { agentId: agent, roomId: room,
      requestId: command.turn_request_id, generationId: 'generation', status: 'working', heartbeat: true }, agent)).rejects.toThrow('negotiated machine owner');
    expect(await versions()).toEqual(before);
    const event = (name: 'ping' | 'pong') => new Promise<void>((resolve, reject) => {
      const deadline = realTimeout(() => { client.socket.off(name, observed); reject(new Error(`Missing controlled ${name}`)); }, 2_000);
      const observed = () => { realClearTimeout(deadline); resolve(); }; client.socket.once(name, observed);
    });
    const queries = vi.spyOn(db, 'query');
    const published: unknown[] = [];
    const stopLive = live.subscribeAll(event => published.push(event));
    for (let i = 0; i < 20; i += 1) {
      const ping = event('ping');
      elapsed += 30_000; vi.setSystemTime(Date.now() + 30_000);
      for (const control of controls) if (control.next <= elapsed) {
        control.next += control.interval; control.run();
      }
      await ping;
      // FIFO control frames prove the server processed its automatic pong
      // before the next clock edge; CPU processing latency is not a failure.
      const pong = event('pong'); client.socket.ping(); await pong;
      await presence.renewLease(); // Join the admitted aggregate lease write.
    }
    expect(await versions()).toEqual(before);
    expect(client.frames.some(frame => frame.type === 'intake-ready')).toBe(false);
    expect(queries.mock.calls.filter(([sql]) => /(?:INSERT INTO|UPDATE)\s+agent_turns/i.test(sql))).toHaveLength(0);
    expect(published.filter(event => (event as Frame).reason === 'postgres:agent_turns' || (event as Frame).type === 'turn-delta')).toHaveLength(0);
    expect(queries.mock.calls.filter(([sql]) => sql.includes('INSERT INTO live_server_instances')).length).toBeLessThanOrEqual(20);
    stopLive(); queries.mockRestore();
  });

  it('F14 scopes 1,000 irrelevant facts to zero inbox reads and sends one targeted command', async () => {
    const peer = 'c'.repeat(64);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Peer')`, [peer]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, owner]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [workspace, peer, room]);
    if (connectionString) {
      const ready = new Promise<void>(resolve => { const stop = live.subscribeResync(() => { stop(); resolve(); }); });
      listener = PostgresLiveListener.forConnectionString(connectionString, db, live); listening = listener.run(); await ready;
    }
    const client = await connect();
    client.send({ type: 'subscribe', roomId: room, inbox: false });
    expect(await client.next(frame => frame.type === 'subscribed')).toMatchObject({ capabilities: { inboxSnapshot: false } });
    const other = await connect(true, peer);
    other.send({ type: 'subscribe', roomId: room, inbox: false }); await other.next(frame => frame.type === 'subscribed');
    const execute = vi.spyOn(daemon, 'execute');
    for (let i = 0; i < 1000; i++) live.publish({ type: 'invalidate', roomId: room,
      reason: i % 2 ? 'postgres:agent_turns' : 'postgres:agent_activity', messageId: `unrelated-${i}` });
    const after = client.frames.length;
    const otherBefore = other.frames.filter(frame => frame.type === 'commands').length;
    let expected = [command.id];
    if (connectionString) {
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('new-command-source',$1,$2,'New targeted work')`, [room, owner]);
      const nextCommand = await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: 'new-command-source', reason: 'human_mention' });
      expect(nextCommand).toBeDefined(); expected.push(nextCommand!.id);
    } else live.publish({ type: 'invalidate', roomId: room, reason: 'postgres:agent_commands', targetAgentId: agent });
    const delivered = await client.next(frame => client.frames.indexOf(frame) >= after && frame.type === 'commands');
    expect(delivered.commands.map((value: Frame) => value.id).sort()).toEqual(expected.sort());
    expect(other.frames.filter(frame => frame.type === 'commands')).toHaveLength(otherBefore);
    expect(execute.mock.calls.filter(([name]) => name === 'getRoomInbox')).toHaveLength(0);
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(1);
    expect(await claim(client)).toHaveProperty('result');
  });

  it('F22 repeated hosting readiness uses the known verdict with zero PostgreSQL probes', async () => {
    await connect();
    const queries = vi.spyOn(db, 'query');
    const before = queries.mock.calls.length;
    const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    for (let i = 0; i < 60; i++) {
      const response = await fetch(`${origin}/readyz`, { headers: { connection: 'close' } });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    }
    expect(queries.mock.calls.slice(before)).toEqual([]);
  });

  it('keeps the disabled cohort legacy and refuses closed-shape/source forgery before dispatch', async () => {
    const legacy = await connect(false), execute = vi.spyOn(daemon, 'execute');
    expect(legacy.registered.capabilities).not.toHaveProperty('turnOwnershipV1');
    legacy.send({ type: 'turn-operation', operation: 'claimAgentCommand', requestId: 'unsupported',
      input: { roomId: room, commandId: command.id, generationId: 'generation' } });
    legacy.send({ type: 'subscribe', roomId: room });
    await legacy.next(frame => frame.type === 'subscribed');
    expect(execute.mock.calls.some(([name]) => name === 'claimAgentCommand')).toBe(false);
    const selected = await connect(true); execute.mockClear();
    selected.send({ type: 'turn-operation', operation: 'claimAgentCommand', requestId: 'forged',
      input: { roomId: room, commandId: command.id, generationId: 'generation', source: { connectionId: 'forged', epoch: 1 } } });
    expect(await selected.next(frame => frame.requestId === 'forged')).toHaveProperty('error');
    expect(execute).not.toHaveBeenCalled();
  });

  it('applies owner loss once and keeps the generation bound after its active row is requeued', async () => {
    const first = await connect(); expect(await claim(first)).toHaveProperty('result');
    first.socket.terminate();
    await vi.waitFor(async () => expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [command.id])).rows[0]!.state).toBe('pending'));
    const facts = (await db.query(`SELECT count(*)::int count FROM messages WHERE presentation='system'`)).rows;
    expect(await expireOwnedAgentTurns(db, live, agent)).toBe(0);
    expect((await db.query(`SELECT count(*)::int count FROM messages WHERE presentation='system'`)).rows).toEqual(facts);
    const second = await connect();
    expect(await claim(second, 'generation', 'same-generation')).toHaveProperty('error');
    expect(await claim(second, 'new-generation', 'new-owner')).toHaveProperty('result');
    expect((await db.query(`SELECT turn_owner_epoch::integer turn_owner_epoch FROM agent_commands WHERE id=$1`, [command.id])).rows[0]!.turn_owner_epoch)
      .toBe(second.registered.capabilities.turnConnectionEpoch);
    await expect(daemon.execute('postAgentTurnReceipt', { agentId: agent, roomId: room,
      requestId: command.turn_request_id, generationId: 'generation', status: 'complete' }, agent)).rejects.toThrow();
  });
});
