import type { AddressInfo } from 'node:net';
import { setTimeout as realTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { createAgentCommand } from './agent-command.js';
import type { TokenAuth } from './auth.js';
import type { ConnectionPresence } from './connection-presence.js';
import { MACHINE_SOCKET_PROTOCOL } from './daemon-live.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { OwnedModelAttempts } from './owned-model-attempt.js';
import type { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { MODEL_AGENT, MODEL_CLAIM, MODEL_OWNER, MODEL_ROOM, MODEL_WORKSPACE, ownedModelFixture } from './test-fixtures/owned-model.js';

type Frame = Record<string, unknown> & { capabilities?: Record<string, unknown>; result?: DaemonOperationMap['claimAgentCommand']['output'] };
const TOKEN = 'bdt_' + 's'.repeat(43);
describe('actual selected model credential claim socket', () => {
  let f: Awaited<ReturnType<typeof ownedModelFixture>>, daemon: DaemonService, server: ReturnType<typeof createBeelineServer>;
  let socket: WebSocket, origin: string, commandId: string, epoch: number;
  let frames: Frame[];
  beforeEach(async () => {
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1', '1'); f = await ownedModelFixture(); epoch = 1; frames = [];
    await f.db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [MODEL_CLAIM.commandId]);
    await f.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [MODEL_WORKSPACE, MODEL_OWNER, MODEL_ROOM]);
    await f.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('model-socket-request',$1,$2,'Synthetic socket claim')`, [MODEL_ROOM, MODEL_OWNER]);
    commandId = (await createAgentCommand(f.db, { roomId: MODEL_ROOM, agentId: MODEL_AGENT, sourceMessageId: 'model-socket-request', reason: 'human_mention' }))!.id;
    const live = new LiveHub(); daemon = new DaemonService(f.db, live); daemon.setOwnedModel({ credentials: f.credentials, ready: () => true });
    const presence = { instanceId: 'synthetic-server', holdServerConnection: () => () => {},
      claimConnection: async (agent: string, input: { connectionId: string }) => {
        epoch++; await f.db.query(`UPDATE agent_connections SET connection_id=$2,epoch=$3,released_at=NULL WHERE agent_id=$1`, [agent, input.connectionId, epoch]); return epoch;
      }, releaseConnection: async () => {}, evidence: async () => {},
    } as unknown as ConnectionPresence;
    server = createBeelineServer({ database: f.db, daemon, live, connectionPresence: presence,
      auth: { authenticateDaemon: async (token: string) => token === TOKEN ? MODEL_AGENT : null,
        retiredDaemonAgent: async () => null, authenticatePhone: async () => null } as unknown as TokenAuth,
      phone: { canReadRooms: async () => new Set([MODEL_ROOM]) } as unknown as PhoneService });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/phone/live', [MACHINE_SOCKET_PROTOCOL]);
    socket.on('message', raw => frames.push(JSON.parse(raw.toString()) as Frame));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  });
  afterEach(async () => {
    socket?.terminate(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await f.db.close();
  });
  const send = (frame: Record<string, unknown>) => socket.send(JSON.stringify({ agentId: MODEL_AGENT, ...frame }));
  const next = async (predicate: (frame: Frame) => boolean): Promise<Frame> => {
    const current = frames.find(predicate); if (current) return current;
    return new Promise((resolve, reject) => {
      const done = () => { realClearTimeout(deadline); socket.off('message', changed); };
      const changed = () => { const found = frames.find(predicate); if (found) { done(); resolve(found); } };
      const deadline = realTimeout(() => { done(); reject(new Error(`Missing model claim frame; state=${socket.readyState}; types=${frames.map(frame => frame.type).join(',')}`)); }, 5_000);
      socket.on('message', changed);
    });
  };
  async function register(installed = true) {
    const from = frames.length;
    send({ type: 'register', token: TOKEN, turnOwnershipV1: true, ownedModelV1: installed, intakeHeartbeat: true });
    return next(frame => frame.type === 'registered' && frames.indexOf(frame) >= from);
  }
  async function claim(requestId = 'model-claim') {
    send({ type: 'turn-operation', operation: 'claimAgentCommand', requestId,
      input: { roomId: MODEL_ROOM, commandId, generationId: 'model-socket-generation' } });
    return next(frame => frame.type === 'turn-result' && frame.requestId === requestId);
  }

  it('negotiates only a boolean and returns the bearer solely on the authorized bounded source-bound claim response', async () => {
    const registered = await register(); expect(registered.capabilities).toMatchObject({ ownedModelV1: true, turnOwnershipV1: true, intakeHeartbeat: false });
    expect(JSON.stringify(registered)).not.toContain('bfmc_'); expect(registered).not.toHaveProperty('modelCredential');
    const reply = await claim(); expect(reply.error).toBeUndefined(); expect(reply.result?.modelCredential).toBeDefined();
    const actor = await f.credentials.authenticate(f.db, reply.result!.modelCredential!.token);
    expect(actor.binding).toMatchObject({ commandId, generationId: 'model-socket-generation', connectionId: registered.capabilities?.turnConnectionId,
      connectionEpoch: registered.capabilities?.turnConnectionEpoch });
    const replay = await claim('same-claim-recovery'); expect(replay.result?.modelCredential).toEqual(reply.result!.modelCredential);
    expect(frames.filter(frame => frame.type !== 'turn-result').some(frame => JSON.stringify(frame).includes('bfmc_'))).toBe(false);
  });

  it.each(['unknown','succeeded'] as const)('acknowledges exact owner end over the socket without changing the %s provider outcome', async outcome => {
    await register(); const claimed=await claim();
    const actor=await f.credentials.authenticate(f.db,claimed.result!.modelCredential!.token);
    const attempts=new OwnedModelAttempts(f.db,f.credentials);
    const modelRequestId='11111111-1111-4111-8111-111111111111';
    await attempts.reserve(actor,modelRequestId,{step:'synthetic terminal request'},async()=>({
      reservation:{day:'2026-11-02',reserved:16,maxOutput:8,reservedUsd:0.01,credit:0},
      payload:{model:actor.binding.model,max_tokens:8,messages:[]},
    }));
    if(outcome==='succeeded')await attempts.settleUsage(actor,modelRequestId,{tokens:2,usd:0},'succeeded',async()=>{});
    send({type:'turn-operation',operation:'postAgentTurnReceipt',requestId:'owner-end',input:{
      roomId:MODEL_ROOM,agentId:MODEL_AGENT,requestId:'model-socket-request',generationId:'model-socket-generation',
      status:'failed',modelOwnerEnd:{requestId:modelRequestId},
    }});
    const ended=await next(frame=>frame.type==='turn-result'&&frame.requestId==='owner-end');
    expect(ended.error).toBeUndefined();expect(ended.result).toBeDefined();
    expect((await f.db.query('SELECT model_request_id FROM agent_command_owner_ends WHERE command_id=$1',[commandId])).rows)
      .toEqual([{model_request_id:modelRequestId}]);
    expect((await f.db.query('SELECT state FROM owned_model_attempts WHERE command_id=$1',[commandId])).rows).toEqual([{state:outcome}]);
    expect((await f.db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1',[commandId])).rows)
      .toEqual([{state:'claimed',generation_id:'model-socket-generation'}]);
    expect((await f.db.query("SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND status='working'",[MODEL_ROOM,MODEL_AGENT])).rowCount).toBe(0);
    const replay=await claim('claim-after-owner-end');expect(replay.error).toBe('turn_operation_unconfirmed');
  });

  it('ends a selected owner with an unreadable journal before any provider dispatch without creating an attempt',async()=>{
    await register();expect((await claim()).error).toBeUndefined();
    send({type:'turn-operation',operation:'postAgentTurnReceipt',requestId:'journal-end',input:{
      roomId:MODEL_ROOM,agentId:MODEL_AGENT,requestId:'model-socket-request',generationId:'model-socket-generation',
      status:'failed',modelOwnerEnd:{journalUnavailable:true},
    }});
    const ended=await next(frame=>frame.type==='turn-result'&&frame.requestId==='journal-end');
    expect(ended.error).toBeUndefined();expect(ended.result).toBeDefined();
    expect((await f.db.query('SELECT model_request_id FROM agent_command_owner_ends WHERE command_id=$1',[commandId])).rows)
      .toEqual([{model_request_id:null}]);
    expect((await f.db.query('SELECT 1 FROM owned_model_attempts WHERE command_id=$1',[commandId])).rowCount).toBe(0);
    expect((await claim('claim-after-journal-end')).error).toBe('turn_operation_unconfirmed');
  });

  it('keeps helpers without installed model support and a server without signer configuration on the legacy claim wire', async () => {
    const old = await register(false); expect(old.capabilities).not.toHaveProperty('ownedModelV1'); expect(old.capabilities).not.toHaveProperty('turnOwnershipV1');
    expect(old.capabilities?.intakeHeartbeat).toBe(true);
    daemon.setOwnedModel(undefined);
    const unavailable = await register(true); expect(unavailable.capabilities).not.toHaveProperty('ownedModelV1'); expect(unavailable.capabilities).not.toHaveProperty('turnOwnershipV1');
    const response = await fetch(origin + '/v1/daemon/operations/claimAgentCommand', { method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: MODEL_ROOM, commandId, generationId: 'legacy-model-generation' }) });
    expect(response.status).toBe(200); expect(await response.json()).not.toHaveProperty('modelCredential');
    expect((await f.db.query('SELECT * FROM owned_model_credentials WHERE command_id=$1', [commandId])).rowCount).toBe(0);
  });

  it('does not enqueue an already committed credential response after current membership revocation wins the final reply fence', async () => {
    await register(); let bearer: string | undefined;
    const issue = f.credentials.issueInTransaction.bind(f.credentials);
    vi.spyOn(f.credentials, 'issueInTransaction').mockImplementation(async (...args) => { const value = await issue(...args); bearer = value.token; return value; });
    const fence = daemon.fenceOwnedTurnReply.bind(daemon);
    vi.spyOn(daemon, 'fenceOwnedTurnReply').mockImplementationOnce(async (...args) => {
      await f.db.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1 AND identity_id=$2', [MODEL_ROOM, MODEL_AGENT]);
      return fence(...args);
    });
    const refused = await claim(); expect(bearer).toBeDefined(); expect(refused).toHaveProperty('error'); expect(refused).not.toHaveProperty('result');
    expect(JSON.stringify(frames)).not.toContain(bearer!);
    expect((await f.db.query('SELECT * FROM owned_model_credentials WHERE command_id=$1', [commandId])).rowCount).toBe(1);
    expect((await f.db.query('SELECT state FROM agent_commands WHERE id=$1', [commandId])).rows).toEqual([{ state: 'claimed' }]);
  });

  it('keeps legacy HTTP and admission-off from reclaiming the same command across a durable model UNKNOWN', async () => {
    await register(); const first = await claim(), bearer = first.result!.modelCredential!.token;
    const actor = await f.credentials.authenticate(f.db, bearer);
    await new OwnedModelAttempts(f.db, f.credentials).reserve(actor, '11111111-1111-4111-8111-111111111111', { step: 'synthetic uncertain model request' }, async () => ({
      reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 },
      payload: { model: actor.binding.model, max_tokens: 8, messages: [] },
    }));
    await f.db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,lease_expires_at=NULL,
      turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id=$1`, [commandId]);
    await f.db.query(`UPDATE agent_turns SET status='failed' WHERE room_id=$1 AND agent_id=$2 AND request_id='model-socket-request'`, [MODEL_ROOM, MODEL_AGENT]);
    daemon.setOwnedModel(undefined);
    const response = await fetch(origin + '/v1/daemon/operations/claimAgentCommand', { method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: MODEL_ROOM, commandId, generationId: 'legacy-bypass-generation' }) });
    expect(response.status).toBe(409); const refusal = JSON.stringify(await response.json()); expect(refusal).toContain('UNKNOWN'); expect(refusal).not.toContain(bearer);
    expect((await f.db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1', [commandId])).rows).toEqual([{ state: 'pending', generation_id: null }]);
    expect((await f.db.query(`SELECT 1 FROM agent_command_generation_owners WHERE command_id=$1 AND generation_id='legacy-bypass-generation'`, [commandId])).rowCount).toBe(0);
    expect((await f.db.query('SELECT state FROM owned_model_attempts WHERE command_id=$1', [commandId])).rows).toEqual([{ state: 'unknown' }]);
  });
});
