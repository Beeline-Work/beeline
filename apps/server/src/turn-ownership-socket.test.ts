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

const agent = 'a'.repeat(64), owner = 'b'.repeat(64);
const room = '11111111-1111-4111-8111-111111111111', workspace = '22222222-2222-4222-8222-222222222222';
type Frame = Record<string, any>;
describe('actual selected turn control socket', () => {
  let db: PgliteDatabase, live: LiveHub, presence: ConnectionPresence, daemon: DaemonService;
  let server: ReturnType<typeof createBeelineServer> | undefined;
  const sockets: WebSocket[] = [], releases: Promise<void>[] = [];
  let command: NonNullable<Awaited<ReturnType<typeof createAgentCommand>>>;
  beforeEach(async () => {
    db = await migratedDatabase(); live = new LiveHub();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic owner'),($2,'agent','Synthetic agent')`, [owner, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,NULL,$4,'member'),($1,$3,$4,'member')`, [workspace, owner, room, agent]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('synthetic-request',$1,$2,'Synthetic work')`, [room, owner]);
    command = (await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: 'synthetic-request', reason: 'human_mention' }))!;
    expect(command).toBeDefined();
    // Install before either control owner starts; no real interval can escape
    // the ten-minute clock proof. Socket waits below use bounded native events.
    vi.useFakeTimers();
    presence = new ConnectionPresence(db, live);
    const release = presence.releaseConnection.bind(presence);
    vi.spyOn(presence, 'releaseConnection').mockImplementation((...args) => {
      const work = release(...args); releases.push(work); return work;
    });
    daemon = new DaemonService(db, live);
  }, 60_000);
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    if (server) { await new Promise<void>(done => server!.close(() => done())); server = undefined; }
    await Promise.all(releases.splice(0)); await presence.stop(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await db.close();
  });
  async function connect(enabled = true) {
    vi.stubEnv('BEELINE_TURN_OWNERSHIP_V1', enabled ? '1' : '0');
    if (!server) {
      server = createBeelineServer({ database: db, live, daemon, connectionPresence: presence, liveHeartbeatMs: 30_000,
        auth: { authenticateDaemon: async (token: string) => token === 'bdt_synthetic' ? agent : null,
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
    const send = (frame: Frame) => socket.send(JSON.stringify({ agentId: agent, ...frame }));
    send({ type: 'register', token: 'bdt_synthetic', lifecycleId: 'synthetic-lifecycle', turnOwnershipV1: true, intakeHeartbeat: true });
    const registered = await next(frame => frame.type === 'registered');
    return { socket, frames, send, next, registered };
  }
  async function claim(client: Awaited<ReturnType<typeof connect>>, generationId = 'generation', requestId = 'claim') {
    client.send({ type: 'turn-operation', operation: 'claimAgentCommand', requestId,
      input: { roomId: room, commandId: command.id, generationId } });
    return client.next(frame => frame.type === 'turn-result' && frame.requestId === requestId, `turn result ${requestId}`);
  }

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
    for (let i = 0; i < 20; i += 1) {
      const ping = event('ping'); await vi.advanceTimersByTimeAsync(30_000); await ping;
      // FIFO control frames prove the server processed its automatic pong
      // before the next clock edge; CPU processing latency is not a failure.
      const pong = event('pong'); client.socket.ping(); await pong;
      await db.query('SELECT 1'); // Drain the admitted aggregate lease write.
    }
    expect(await versions()).toEqual(before);
    expect(client.frames.some(frame => frame.type === 'intake-ready')).toBe(false);
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
