import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
const { DaemonService } = await import(process.env.BEELINE_REPLAY_BUILT_PROOF ? '../dist/daemon-service.js' : './daemon-service.js');
const { PhoneService } = await import(process.env.BEELINE_REPLAY_BUILT_PROOF ? '../dist/phone-service.js' : './phone-service.js');
import { LiveHub } from './live.js';
import { createAgentCommand } from './agent-command.js';
import { runMaintenance } from './background.js';
import { AcpClient, type ToolCallEntry } from '../../body/src/acp.js';
import type { TurnReplay } from '@beeline/api-contract/daemon';
const { MonolithRoomTurnLoop } = await import(process.env.BEELINE_REPLAY_BUILT_PROOF ? '../../body/dist/monolith-room-turn.js' : '../../body/src/monolith-room-turn.js');
const { MonolithCornerTurnLoop } = await import(process.env.BEELINE_REPLAY_BUILT_PROOF ? '../../body/dist/monolith-corner-turn.js' : '../../body/src/monolith-corner-turn.js');
import { identityFromKey, type AgentRuntimeRecord } from '../../body/src/runtime.js';
import { SessionScheduler } from '../../body/src/session-scheduler.js';
import type { BodyConfig } from '../../body/src/config.js';
import type { DaemonApiClient } from '../../body/src/daemon-api-client.js';
vi.mock('../../body/src/corner-branch-sync.js', () => ({ syncCornerBranch: vi.fn(async () => 'unchanged') }));
vi.mock('../../body/dist/corner-branch-sync.js', () => ({ syncCornerBranch: vi.fn(async () => 'unchanged') }));
const identity = identityFromKey('11'.repeat(32), 'Bee');
const AGENT = identity.publicKey, HUMAN = '22'.repeat(32), WS = randomUUID(), ROOM = randomUUID();
let db: PgliteDatabase, daemon: InstanceType<typeof DaemonService>, phone: InstanceType<typeof PhoneService>;
beforeAll(async () => {
  db = await migratedDatabase();
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Captain','captain'),($2,'agent','Bee','bee')`, [HUMAN, AGENT]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT,HUMAN]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Trace proof')`, [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Trace proof',$3)`, [ROOM,WS,HUMAN]);
  for (const person of [HUMAN, AGENT]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [WS,ROOM,person]);
}, 30000);
afterAll(async () => db.close());

it.each([
  {scope: 'room', limited: false}, {scope: 'corner', limited: false},
  {scope: 'room', limited: true}, {scope: 'corner', limited: true},
] as const)('replays a production $scope turn from trigger through visible reply (time limit: $limited)', async ({scope, limited}) => {
  const roomId = scope === 'room' ? ROOM : randomUUID();
  if (scope === 'corner') {
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Trace corner',$4)`, [roomId,WS,ROOM,HUMAN]);
    await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,worker_agent_id,objective) VALUES($1,$2,$2,'Trace proof')`,[roomId,AGENT]);
    for (const person of [HUMAN,AGENT]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[WS,roomId,person]);
  }
  if (limited) await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,state,sealed_keys) VALUES($1,$2,$3,'running','fixture')`, [AGENT,WS,HUMAN]);
  const trigger = randomUUID();
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please run the trace proof')`, [trigger,roomId,HUMAN]);
  await createAgentCommand(db, {roomId,agentId:AGENT,sourceMessageId:trigger,reason:'human_tag'});
  const root = await mkdtemp(join(tmpdir(),'turn-replay-'));
  const abort = new AbortController(), scheduler = new SessionScheduler({maxLiveSessions:1});
  let settled = false;
  let activeAuthority: Record<string,unknown> = {};
  const api = {
    execute: async (name: string, input: Record<string,unknown>) => {
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getRoomRepositoryState') return {resolution:'none'};
      if (name === 'getRoomGitHubToken') return {token:'fixture',expiresAt:Date.now()+60000};
      if (name === 'claimAgentCommand') {
        const command = (await daemon.execute('getAgentCommands',{roomId},AGENT)).commands.find(c=>c.id===input.commandId)!;
        activeAuthority = {roomId,requestId:command.turnRequestId,generationId:input.generationId};
      }
      if (limited && name === 'postAgentTurnReceipt' && input.status === 'failed') {
        await expect(daemon.execute(name, {...input, generationId:'stale'} as never, AGENT)).rejects.toThrow();
        await expect(daemon.execute(name, {...input, reason:'runtime failure'} as never, AGENT)).rejects.toThrow();
      }
      const result = await daemon.execute(name as never,input as never,AGENT);
      if (name === 'postAgentTurnReceipt' && input.status !== 'working') settled = true;
      return result;
    },
    connection:()=>({baseUrl:'http://fixture',daemonToken:'fixture',agentId:AGENT}),
  } as unknown as DaemonApiClient;
  const acp = new AcpClient({agentBinary:'/fake',agentEnv:{}});
  vi.spyOn(acp,'isAlive','get').mockReturnValue(true);
  vi.spyOn(acp,'start').mockResolvedValue(undefined);
  vi.spyOn(acp,'sessionNew').mockResolvedValue({sessionId:'proof-session',raw:{}});
  vi.spyOn(acp,'canPromptWithImages').mockReturnValue(false);
  vi.spyOn(acp,'sessionPrompt').mockImplementation(async (_id,_prompt,_timeout,onChunk,_activity,onTools)=>{
    const calls: ToolCallEntry[] = [{id:'read',title:'read',status:'in_progress'}];
    onTools?.(calls);
    await daemon.execute('getRoomConversation',{roomId,limit:10},AGENT);
    calls[0]!.status='completed';
    onTools?.(calls);
    const refused = {id:'post',title:'post',status:'in_progress',content:''};
    calls.push(refused);onTools?.(calls);
    await expect(daemon.execute('postRoomMessage',{...activeAuthority,roomId,generationId:'wrong-generation',text:'Refused write'} as never,AGENT)).rejects.toThrow();
    refused.status='rejected';refused.content='permission denied';onTools?.(calls);
    onChunk?.('Proof completed.','Proof completed.');
    return {stopReason:limited ? 'free-agent-time-limit' : 'end_turn',agentText:'Proof completed.',updates:[],toolCalls:calls};
  });
  const config = {agentBinary:'/fake',agentCommand:'/fake',agentKind:'codex',agentArgs:[],agentEnv:limited ? {BEELINE_FREE_AGENT_ID: AGENT} : {},
    workspaceRoot:root,agentHomeRoot:join(root,'home'),operatorHome:join(root,'operator'),
    mcpBinary:'/fake',readonlyMcpCommand:'/fake',autoApprovePermissions:true,accessPolicy:'everyone'} as BodyConfig;
  const common = {roomId,workspaceId:WS,cwd:root,api,config,runtime:{agent:{name:'Bee',publicKey:AGENT,
    secretKeyHex:Buffer.from(identity.secretKey).toString('hex')},rooms:[],supervisorRoot:root,
    transport:{kind:'monolith',baseUrl:'http://fixture',daemonToken:'fixture'}} as unknown as AgentRuntimeRecord,
    scheduler,signal:abort.signal,pollMs:5,createAcpClient:()=>acp,health:{poll:vi.fn(),failure:vi.fn(),presence:vi.fn()}};
  const loop = scope==='room' ? new MonolithRoomTurnLoop(common) : new MonolithCornerTurnLoop({...common,
    cornerId:roomId,parentRoomId:ROOM,objective:'Trace proof',worktreePath:root,
    repository:{featureBranch:'feature/proof',targetBranch:'main',gitCommonDir:join(root,'.git')},
    onPoll:vi.fn(),onFailure:vi.fn(),onCloseRequested:vi.fn(async()=>undefined)});
  const running = loop.run();
  try {
    await vi.waitFor(()=>expect(settled).toBe(true),{timeout:15000});
    const rows = await db.query<{trigger_message_id:string;reply_message_ids:string[];outcome:string;trace:TurnReplay}>(
      `SELECT * FROM agent_turn_traces WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,[roomId,AGENT,trigger]);
    expect(rows.rows).toHaveLength(1);
    const record=rows.rows[0]!;
    expect(record.trigger_message_id).toBe(trigger);
    expect(record.outcome).toBe(limited ? 'failed' : 'complete');
    if (limited) {
      expect((await db.query(`SELECT status,failure_reason FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,[roomId,trigger,AGENT])).rows).toMatchObject([{status:'failed',failure_reason:'free-agent-time-limit'}]);
    }
    expect(record.trace.attempts[0]!.tools.map(c=>[c.name,c.outcome])).toEqual([['read','ok'],['post','refused']]);
    if (!limited) expect(record.trace.attempts[0]!.phases.publish).toBeGreaterThanOrEqual(0);
    expect(record.reply_message_ids).toHaveLength(1);
    const visible=await phone.readRoom(roomId,HUMAN);
    expect(JSON.stringify(visible)).toContain('Proof completed.');
    expect(JSON.stringify(visible)).toContain(record.reply_message_ids[0]);
    if (limited) {
      expect(JSON.stringify(visible)).toContain('send continue');
      expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND request_id=$2 AND author_id=$3 AND presentation='message'`,[roomId,trigger,AGENT])).rowCount).toBe(1);
    }
    console.log(`TURN-REPLAY ${scope}: trigger → read ok → post refused → visible reply → ${limited ? 'FREE-CONTINUE-1 failed with saved checkpoint' : 'complete'} persisted.`);
  } finally {
    abort.abort();await running.catch(()=>undefined);await scheduler.dispose();await rm(root,{recursive:true,force:true});
    if (limited) await db.query('DELETE FROM free_agents WHERE agent_id=$1',[AGENT]);
  }
},30000);

it('expires diagnostics and cascades with their room',async()=>{
  await db.query(`UPDATE agent_turn_traces SET created_at=now()-interval '31 days' WHERE room_id=$1`,[ROOM]);
  await runMaintenance(db);
  expect((await db.query(`SELECT 1 FROM agent_turn_traces WHERE room_id=$1`,[ROOM])).rowCount).toBe(0);
  await db.query(`DELETE FROM rooms WHERE parent_id=$1`,[ROOM]);
  expect((await db.query(`SELECT 1 FROM agent_turn_traces`)).rowCount).toBe(0);
});

async function claimedTurn() {
  const messageId=randomUUID();
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Proof')`,[messageId,ROOM,HUMAN]);
  const command=(await createAgentCommand(db,{roomId:ROOM,agentId:AGENT,sourceMessageId:messageId,reason:'human_tag'}))!;
  const generationId=randomUUID();
  await daemon.execute('claimAgentCommand',{roomId:ROOM,commandId:command.id,generationId},AGENT);
  return {roomId:ROOM,requestId:command.turn_request_id,generationId};
}
const emptyTrace={totalMs:12,attempts:[{attempt:1,phases:{publish:1},tools:[]}]};
it('stores no replies and multiple replies, and never trusts supplied message ids',async()=>{
  const silent=await claimedTurn();
  await daemon.execute('postAgentTurnReceipt',{...silent,status:'complete',completionKind:'no-reply',trace:emptyTrace},AGENT);
  expect((await db.query(`SELECT reply_message_ids FROM agent_turn_traces WHERE request_id=$1`,[silent.requestId])).rows[0]!.reply_message_ids).toEqual([]);
  expect((await db.query(`SELECT trace FROM agent_turn_traces WHERE request_id=$1`,[silent.requestId])).rows[0]!.trace).toEqual(emptyTrace);
  const multiple=await claimedTurn();
  const first=await daemon.execute('postRoomMessage',{...multiple,text:'First reply'},AGENT);
  // Historical narration can precede a final reply under the same request.
  const second={id:randomUUID()};
  await db.query(`INSERT INTO messages(id,room_id,author_id,request_id,text,presentation)
    VALUES($1,$2,$3,$4,'Earlier narration','message')`,[second.id,ROOM,AGENT,multiple.requestId]);
  await daemon.execute('postAgentTurnReceipt',{...multiple,status:'complete',trace:{...emptyTrace,replyMessageIds:['forged']} as never},AGENT);
  expect((await db.query(`SELECT reply_message_ids FROM agent_turn_traces WHERE request_id=$1`,[multiple.requestId])).rows[0]!.reply_message_ids).toEqual(expect.arrayContaining([first.id,second.id]));
});

it('drops a failed diagnostic insert without failing the terminal receipt',async()=>{
  const turn=await claimedTurn();
  await db.query(`CREATE FUNCTION refuse_trace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'diagnostic unavailable'; END $$`);
  await db.query(`CREATE TRIGGER refuse_trace BEFORE INSERT ON agent_turn_traces FOR EACH ROW EXECUTE FUNCTION refuse_trace()`);
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  try {
    await daemon.execute('postAgentTurnReceipt',{...turn,status:'complete',trace:emptyTrace},AGENT);
    expect((await db.query(`SELECT status FROM agent_turns WHERE request_id=$1`,[turn.requestId])).rows[0]!.status).toBe('complete');
    expect((await db.query(`SELECT 1 FROM agent_turn_traces WHERE request_id=$1`,[turn.requestId])).rowCount).toBe(0);
    expect(warning).toHaveBeenCalledWith('[turn-trace] trace dropped');
  } finally {warning.mockRestore();await db.query('DROP TRIGGER refuse_trace ON agent_turn_traces');}
});

it('accepts only the stopped generation diagnostics and never restores output authority',async()=>{
  const turn=await claimedTurn();
  await db.query(`UPDATE agent_turns SET status='cancelled' WHERE request_id=$1`,[turn.requestId]);
  await db.query(`UPDATE agent_commands SET state='cancelled' WHERE turn_request_id=$1`,[turn.requestId]);
  await daemon.execute('postAgentTurnReceipt',{...turn,status:'cancelled',trace:emptyTrace},AGENT);
  expect((await db.query(`SELECT outcome FROM agent_turn_traces WHERE request_id=$1`,[turn.requestId])).rows[0]!.outcome).toBe('cancelled');
  await expect(daemon.execute('postAgentTurnReceipt',{...turn,generationId:'stale',status:'cancelled',trace:emptyTrace},AGENT)).rejects.toThrow();
  await expect(daemon.execute('postRoomMessage',{...turn,text:'Must stay stopped'},AGENT)).rejects.toThrow();
  expect((await db.query(`SELECT status FROM agent_turns WHERE request_id=$1`,[turn.requestId])).rows[0]!.status).toBe('cancelled');
});

it('redacts pre-session diagnostics at persistence and preserves startup classification', async () => {
  const { recordStartupWakeOutcome } = await import('./startup-wake-backoff.js');
  const { redactReplayError } = await import('@beeline/api-contract/daemon');
  const reason = 'worktree failed https://private.example/path token=super-private';
  const turn = await claimedTurn();
  const trace = {totalMs:0, attempts:[], reason, reasonKind:'workspace-failure'};
  await daemon.execute('postAgentTurnReceipt', {...turn,status:'failed',reasonKind:'workspace-failure',trace}, AGENT);
  const rows = await db.query(`SELECT outcome,trace FROM agent_turn_traces WHERE request_id=$1`, [turn.requestId]);
  expect(rows.rows).toEqual([{outcome:'failed',trace:{...trace,reason:redactReplayError(reason)}}]);
  expect((await db.query(`SELECT failures FROM agent_startup_backoff WHERE agent_id=$1`,[AGENT])).rows[0]!.failures).toBe(1);
  const ordinary = await claimedTurn();
  await recordStartupWakeOutcome(db,{...ordinary,status:'failed',trace:{totalMs:0,attempts:[]}},AGENT);
  expect((await db.query(`SELECT failures FROM agent_startup_backoff WHERE agent_id=$1`,[AGENT])).rows[0]!.failures).toBe(0);
});
