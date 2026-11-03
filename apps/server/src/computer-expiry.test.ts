import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import { migratedDatabase,type PgliteDatabase } from './test-support.js';
import type { SqlDatabase } from './database.js';
import { COMPUTER_EXPIRY_SCHEMA } from './computer-expiry-schema.js';
import { COMMAND_COMPLETION_CHANNEL,notifyCommandCompletion } from './command-completion.js';
import { createComputerSession,endComputerSession,expireComputerSessions,getComputerSession,refreshComputerSession,startComputerExpirySweep } from './computer-session.js';
import { LiveHub } from './live.js';
import type { PostgresDatabase } from './database.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
import { GroupBClock } from './test-fixtures/router-group-b-clock.js';
import { SquireShareRenewals } from '../../body/src/squire-share-renewals.js';
import type { StdioSquireMcpClient } from '../../body/src/squire-mcp-client.js';
const owner='a'.repeat(64),agent='b'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const upstream=`https://synthetic.trycloudflare.com/s/${'c'.repeat(43)}/`;
const postgresUrl=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.each(['pglite',...(postgresUrl?['postgres']:[])])('P12 computer share actual source expiry (%s)',backend=>{
  let db:PgliteDatabase|PostgresDatabase,release:()=>Promise<void>,closeDatabase:()=>Promise<void>;const live=new LiveHub(),stops:Array<()=>void>=[];
  beforeAll(async()=>{
    if(backend==='postgres'){
      const fixture=await groupBPostgresDatabase(postgresUrl!);db=fixture.database;closeDatabase=fixture.close;
      release=await fixture.listenToCompletions();
    }else{
      const local=await migratedDatabase();db=local;closeDatabase=()=>local.close();
      release=await local.client.listen(COMMAND_COMPLETION_CHANNEL,notifyCommandCompletion);
    }
    await db.query(COMPUTER_EXPIRY_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic owner'),($2,'agent','Synthetic agent')`,[owner,agent]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Computer expiry')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`,[room,workspace]);
  },60000);
  afterEach(()=>{for(const stop of stops.splice(0))stop();vi.useRealTimers();vi.unstubAllGlobals();});
  afterAll(async()=>{await release?.();await closeDatabase?.();});
  const create=(sessionId:string,expiresAt?:number)=>createComputerSession(db,live,{roomId:room,agentId:agent,sessionId,upstreamUrl:upstream,...(expiresAt===undefined?{}:{expiresAt})});
  it('does one acquisition pass and zero queue/provider observations over an empty idle day',async()=>{
    vi.useFakeTimers({toFake:['Date']});const clock=new GroupBClock(),queries:string[]=[],fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    let initial!:()=>void;const ready=new Promise<void>(resolve=>{initial=resolve;});
    const observed:SqlDatabase={transaction:work=>db.transaction(work),query:async(sql,values)=>{
      queries.push(sql);const result=await db.query(sql,values);if(sql.includes('delay_ms FROM computer_sessions'))initial();return result;
    }};
    stops.push(startComputerExpirySweep(observed,live,1,clock));await ready;await Promise.resolve();await Promise.resolve();
    const initialized=queries.length;expect(initialized).toBe(2);
    vi.setSystemTime(Date.now()+86_400_000);clock.advanceBy(86_400_000);
    expect(queries).toHaveLength(initialized);expect(fetcher).not.toHaveBeenCalled();expect(clock.size).toBe(0);
  });
  it('arms an actual committed future expiry, ends once, and never calls the upstream status page',async()=>{
    const fetcher=vi.fn(()=>{throw new Error('Upstream status must not be observed');});vi.stubGlobal('fetch',fetcher);
    const queries:string[]=[];let initial!:()=>void;const ready=new Promise<void>(resolve=>{initial=resolve;});
    const observed:SqlDatabase={transaction:work=>db.transaction(work),query:async(sql,values)=>{
      queries.push(sql);const result=await db.query(sql,values);if(sql.includes('delay_ms FROM computer_sessions'))initial();return result;
    }};
    stops.push(startComputerExpirySweep(observed,live));await ready;
    const share=await create('committed-expiry',Date.now()+400);
    await vi.waitFor(async()=>{expect((await getComputerSession(db,share.id))?.status).toBe('ended');},{timeout:3000,interval:25});
    expect(fetcher).not.toHaveBeenCalled();
    expect((await db.query(`SELECT card->>'status' status FROM messages WHERE id=$1`,[share.messageId])).rows).toEqual([{status:'ended'}]);
    const ended=(await db.query('SELECT ended_at FROM computer_sessions WHERE id=$1',[share.id])).rows;
    expect(await expireComputerSessions(db,live)).toBe(0);expect((await db.query('SELECT ended_at FROM computer_sessions WHERE id=$1',[share.id])).rows).toEqual(ended);
    expect(queries.some(sql=>sql.includes('ORDER BY expires_at LIMIT 1'))).toBe(true);
  });
  it('F21: a delayed old persistence refusal leaves the replacement lease owner able to renew the actual share', async () => {
    const sessionId = `held-persistence-${backend}`;
    const share = await create(sessionId, Date.now() + 10_000);
    let release!: () => void, entered!: () => void, renewed!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const committed = new Promise<void>(resolve => { renewed = resolve; });
    let writes = 0;
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({
      url: upstream, expires_at: new Date(Date.now() + 20_000).toISOString(),
    }) }] }));
    const client = { requestMcp: call } as unknown as StdioSquireMcpClient;
    const reaped = vi.fn();
    const renewals = new SquireShareRenewals(() => true, async lease => {
      if (++writes === 1) { entered(); await held; return false; }
      const result = await refreshComputerSession(db, { roomId: room, agentId: agent, ...lease });
      expect(result.live).toBe(true); renewed(); return result.live;
    }, reaped);
    const lease = () => ({ content: [{ type: 'text', text: JSON.stringify({
      url: upstream, expires_at: new Date(Date.now() + 200).toISOString(),
    }) }] });
    try {
      renewals.track(sessionId, client, lease()); await pending;
      renewals.track(sessionId, client, lease()); release(); await committed;
      expect(call).toHaveBeenCalledTimes(2); expect(writes).toBe(2);
      expect(reaped).not.toHaveBeenCalled();
      expect((await db.query<{ future: boolean }>(`SELECT expires_at>clock_timestamp()+interval '10 seconds' future
        FROM computer_sessions WHERE id=$1`, [share.id])).rows[0]?.future).toBe(true);
    } finally { release(); renewals.close(); await endComputerSession(db, live, (await getComputerSession(db, share.id))!); }
  });
  it('fences a selected old expiry against a newer source version and a successful renewal',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const share=await create('versioned-expiry',Date.now()-2000);let changed=false;
    const racing:SqlDatabase={transaction:work=>db.transaction(work),query:async(sql,values)=>{
      const result=await db.query(sql,values);
      if(!changed&&sql.includes('FROM computer_sessions WHERE expires_at<=now()')){
        changed=true;await db.query(`UPDATE computer_sessions SET expires_at=clock_timestamp()-interval '500 milliseconds' WHERE id=$1`,[share.id]);
      }
      return result;
    }};
    await expireComputerSessions(racing,live);expect((await getComputerSession(db,share.id))?.status).toBe('live');
    expect(await refreshComputerSession(db,{roomId:room,agentId:agent,sessionId:'versioned-expiry',upstreamUrl:upstream,expiresAt:Date.now()+60_000})).toEqual({live:true});
    expect(await expireComputerSessions(db,live)).toBe(0);expect(fetcher).not.toHaveBeenCalled();
    await endComputerSession(db,live,(await getComputerSession(db,share.id))!);
  });
});
