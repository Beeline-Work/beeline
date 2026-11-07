import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimAgentCommand, createAgentCommand, readAgentCommands } from './agent-command.js';
import { claimAgentConnection } from './connection-presence.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { insertCornerFacts } from './test-support.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.skipIf(!url)('running turns survive answered and superseded sources (PostgreSQL)', () => {
  const human = 'a'.repeat(64), agent = 'b'.repeat(64), worker = 'c'.repeat(64), workspace = randomUUID();
  let fixture: Awaited<ReturnType<typeof groupBPostgresDatabase>>;
  let daemon: DaemonService, phone: PhoneService, owner: { connectionId: string; epoch: number };
  beforeAll(async () => {
    fixture = await groupBPostgresDatabase(url!);
    const db = fixture.database, live = new LiveHub();
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner','owner'),($2,'agent','Ruby','ruby'),($3,'agent','Worker','worker')`, [human,agent,worker]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [agent,worker,human]);
    await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Continuity proof')", [workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role)
      VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')`, [workspace,human,agent,worker]);
    await db.query("INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('continuity',clock_timestamp())");
    owner = { connectionId: 'continuity', epoch: await claimAgentConnection(db,live,agent,{},
      { connectionId: 'continuity', instanceId: 'continuity' }) };
    daemon = new DaemonService(db,live);
    phone = new PhoneService(db,'http://test');
  }, 60_000);
  afterAll(async () => { await fixture?.close(); });
  async function place() {
    const db = fixture.database, room = randomUUID(), corner = randomUUID();
    await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES
      ($1,$3,'Room',NULL),($2,$3,'Corner',$1)`, [room,corner,workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`, [workspace,room,human,agent,worker]);
    await insertCornerFacts(db, { cornerId: corner, ownerAgentId: worker,
      lifecycle: JSON.stringify({ pr: { number: 42, headSha: 'old-head' } }) });
    return { room, corner };
  }
  async function finish(roomId: string, requestId: string, text: string) {
    await daemon.execute('postRoomMessage', { roomId,requestId,generationId:'running',text },agent);
    await daemon.execute('postAgentTurnReceipt', { roomId,requestId,generationId:'running',status:'complete' },agent,owner);
    expect((await fixture.database.query(`SELECT status,failure_reason FROM agent_turns
      WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`, [roomId,requestId,agent])).rows)
      .toEqual([{ status:'complete',failure_reason:null }]);
    expect((await fixture.database.query('SELECT text FROM messages WHERE request_id=$1 AND author_id=$2',
      [requestId,agent])).rows).toEqual([{ text }]);
  }
  it('an answered running report posts its reply and leaves new input for the next turn', async () => {
    const db = fixture.database, { room } = await place(), source = randomUUID();
    await db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Handle the blocker')", [source,room,human]);
    const parent = (await createAgentCommand(db,{ roomId:room,agentId:agent,sourceMessageId:source,reason:'human_tag' }))!;
    await claimAgentCommand(db,room,agent,parent.id,'opening',owner);
    const opened = await daemon.execute('createCorner',{ roomId:room,requestId:parent.turn_request_id,generationId:'opening',
      targetRoomId:room,name:'Blocker',objective:'Publish the work',implementer:'worker',
      brief:{ spec:'Publish the work',repositoryWork:false,approval:{ sourceMessageId:source } } },agent);
    const assignment = (await readAgentCommands(db,opened.cornerId,worker)).commands[0]!;
    await claimAgentCommand(db,opened.cornerId,worker,assignment.id,'worker');
    await daemon.execute('report',{ roomId:opened.cornerId,requestId:assignment.turnRequestId,generationId:'worker',
      status:'blocked',text:'blocked: publish is pending' },worker);
    const report = (await readAgentCommands(db,room,agent)).commands.find(command => command.reason === 'report')!;
    await claimAgentCommand(db,room,agent,report.id,'running',owner);
    await phone.execute('sendRoomMessage', { roomId:room,text:'@ruby The blocker is resolved; check the next step' },human);
    expect((await db.query("SELECT private_payload->>'waitingAnswered' answered,state FROM agent_commands WHERE id=$1",
      [report.id])).rows).toEqual([{ answered:'true',state:'claimed' }]);
    const queued = (await readAgentCommands(db,room,agent)).commands;
    const next = queued.find(command => command.source.body.includes('The blocker is resolved'))!;
    expect(next).toBeDefined();
    await claimAgentCommand(db,room,agent,report.id,'running',owner);
    await finish(room,report.turnRequestId,'The blocker handling is complete.');
    expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[next.id])).rows).toEqual([{ state:'pending' }]);
    await claimAgentCommand(db,room,agent,next.id,'next',owner);
    expect((await db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1',[next.id])).rows)
      .toEqual([{ state:'claimed',generation_id:'next' }]);
  });
  it.each(['owned','legacy'] as const)('a superseded %s review finishes and the newer head is delivered next', async mode => {
    const db = fixture.database, { corner } = await place(), source = randomUUID();
    await db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@ruby Review this head')", [source,corner,human]);
    const running = (await createAgentCommand(db,{ roomId:corner,agentId:agent,sourceMessageId:source,reason:'human_tag' }))!;
    await db.query('UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1',
      [running.id,JSON.stringify({ cornerId:corner,headSha:'old-head',pullRequest:42,briefRevision:0 })]);
    const claimOwner = mode === 'owned' ? owner : undefined;
    await claimAgentCommand(db,corner,agent,running.id,'running',claimOwner);
    await db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"new-head"') WHERE corner_id=$1`, [corner]);
    const event = randomUUID();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,system_event)
      VALUES($1,$2,$3,'Checks passed on the newer head',$4::jsonb)`,
      [event,corner,human,JSON.stringify({ kind:'check-passed',object:{ headSha:'new-head' } })]);
    const newer = (await createAgentCommand(db,{ roomId:corner,agentId:agent,sourceMessageId:event,reason:'corner_check' }))!;
    const next = (await readAgentCommands(db,corner,agent)).commands.find(command => command.id === newer.id)!;
    expect(next).toBeDefined();
    expect(next.source.body).toContain('Checks passed on the newer head');
    // Legacy same-generation claim replays also pass through stale-wake admission.
    await claimAgentCommand(db,corner,agent,running.id,'running',claimOwner);
    await finish(corner,running.turn_request_id,'Review of the previous head is complete.');
    expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[newer.id])).rows).toEqual([{ state:'pending' }]);
    await claimAgentCommand(db,corner,agent,next.id,'next',owner);
    expect((await db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1',[newer.id])).rows)
      .toEqual([{ state:'claimed',generation_id:'next' }]);
  });
  it('an unstarted superseded review is still dropped and explicit Stop still cancels running work', async () => {
    const db = fixture.database, { room,corner } = await place();
    const stale = (await createAgentCommand(db,{ roomId:corner,agentId:agent,sourceMessageId:null,reason:'system' }))!;
    await db.query('UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1',
      [stale.id,JSON.stringify({ cornerId:corner,headSha:'obsolete',pullRequest:42,briefRevision:0 })]);
    await expect(claimAgentCommand(db,corner,agent,stale.id,'stale',owner)).rejects.toThrow();
    expect((await db.query('SELECT state,cancellation_reason FROM agent_commands WHERE id=$1',[stale.id])).rows)
      .toEqual([{ state:'cancelled',cancellation_reason:'superseded_wake' }]);
    const message = await phone.execute('sendRoomMessage',{ roomId:room,text:'@ruby Do some work' },human);
    const running = (await readAgentCommands(db,room,agent)).commands.find(command => command.sourceMessageId === message.messageId)!;
    await claimAgentCommand(db,room,agent,running.id,'running',owner);
    await phone.execute('cancelAgentTurn',{ roomId:room,agentId:agent,requestId:running.turnRequestId },human);
    expect((await db.query('SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2',
      [room,running.turnRequestId])).rows).toEqual([{ status:'cancelled' }]);
  });
});
