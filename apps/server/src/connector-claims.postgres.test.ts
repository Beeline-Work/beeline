import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {DaemonOperationMap} from '@beeline/api-contract/daemon';
import {migrate,PostgresDatabase,type SqlDatabase} from './database.js';
import {DaemonService} from './daemon-service.js';
import {PhoneService} from './phone-service.js';
import {LiveHub} from './live.js';
import type {ComposioApps} from './composio-apps.js';
import type {LinkAgentWallet} from './link-agent-wallet.js';
import {seedSquireMachine} from './test-fixtures/squire-machines.js';
import {concurrentWriters} from './test-fixtures/concurrent-writers.js';

type Effects={
  offerConnector(input:DaemonOperationMap['offerConnector']['input'],agent:string):Promise<DaemonOperationMap['offerConnector']['output']>;
  squireLoginWall(input:DaemonOperationMap['postSquireLoginWall']['input'],agent:string):Promise<DaemonOperationMap['postSquireLoginWall']['output']>;
  connectAppFrontDoor(input:DaemonOperationMap['connectApp']['input'],agent:string):Promise<DaemonOperationMap['connectApp']['output']>;
};
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Isolated loopback PostgreSQL required');
describe.skipIf(!url)('connector and sign-in native claims',()=>{
  const name='connector_claims_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
  const target=new URL(url??'postgresql://localhost/postgres');target.pathname='/'+name;
  const config={connectionString:target.toString(),max:1,options:'-c statement_timeout=8000'};
  const first=new PostgresDatabase('',1,{pool:new Pool(config)}),second=new PostgresDatabase('',1,{pool:new Pool(config)});
  const workspace=randomUUID(),room=randomUUID(),owner='a'.repeat(64),agent='b'.repeat(64);
  const service=(db:SqlDatabase)=>{
    const args:ConstructorParameters<typeof DaemonService>=[db,new LiveHub()];
    args[13]={supportsOAuth:async()=>true,toolkit:async()=>undefined} as unknown as ComposioApps;
    args[16]={status:async()=>({connected:false})} as unknown as LinkAgentWallet;
    return new DaemonService(...args) as unknown as Effects;
  };
  beforeAll(async()=>{
    await admin.query(`CREATE DATABASE ${name}`);await migrate(first);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Helper')`,[owner,agent]);
    await first.query(`INSERT INTO workspaces(id,name) VALUES($1,'Native connector claims')`,[workspace]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`,[room,workspace]);
    await first.query(`INSERT INTO agents(agent_id,owner_id,machine_id,machine_name) VALUES($1,$2,'machine','Proof')`,[agent,owner]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,[workspace,owner,agent,room]);
  },60_000);
  afterAll(async()=>{
    await first.close();await second.close();await admin.query(`DROP DATABASE IF EXISTS ${name} WITH(FORCE)`);await admin.end();
  });
  it.each(['Link','Slack'])('two %s sign-in requests post one pending card',async app=>{
    const results=await concurrentWriters(first,second,db=>service(db).connectAppFrontDoor({roomId:room,app,reason:'Connect for the task'},agent),
      app==='Link'?'INSERT INTO messages(':'INSERT INTO workspace_apps(');
    expect(results.map(result=>result.status)).toEqual(['needs_sign_in','needs_sign_in']);
    const cards=await first.query(`SELECT id FROM messages WHERE room_id=$1 AND card_type='app-sign-in' AND card->>'appId'=$2`,
      [room,results[0]!.appId]);
    expect(cards.rowCount).toBe(1);
  });
  it('two connector offers reuse the winning id and card',async()=>{
    await seedSquireMachine(first,agent,{squire_report:null,squire_work:{}});
    const results=await concurrentWriters(first,second,db=>service(db).offerConnector({roomId:room,connectorType:'trusty-squire',reason:'Connect'},agent),
      'INSERT INTO connector_offers(');
    expect(results[0]!.offerId).toBe(results[1]!.offerId);
    expect(results[0]!.messageId).toBe(results[1]!.messageId);
    expect(results.map(result=>result.joined)).toEqual([false,true]);
    expect((await first.query(`SELECT id FROM connector_offers WHERE room_id=$1 AND status='pending'`,[room])).rowCount).toBe(1);
    await first.query(`DELETE FROM messages WHERE id=$1`,[results[0]!.messageId]);
    await first.query('DELETE FROM connector_offers WHERE room_id=$1',[room]);
  });
  it('concurrent acceptance admits one installation and refuses the stale generation',async()=>{
    await seedSquireMachine(first,agent,{generation:20,squire_report:null,squire_work:{}});
    const offered=await service(first).offerConnector({roomId:room,connectorType:'trusty-squire',reason:'Connect'},agent);
    const results=await concurrentWriters(first,second,db=>new PhoneService(db,'https://test.invalid')
      .execute('acceptConnectorOffer',{offerId:offered.offerId},owner)
      .then(value=>({value}),error=>({error})), 'UPDATE squire_machines SET generation=generation+1');
    expect(results.filter(result=>'value' in result)).toHaveLength(1);
    expect(results.find(result=>'error' in result)).toMatchObject({error:{status:409}});
    expect((await first.query(`SELECT status,accepted_by FROM connector_offers WHERE id=$1`,[offered.offerId])).rows)
      .toEqual([{status:'connecting',accepted_by:owner}]);
    expect((await first.query(`SELECT generation FROM squire_machines WHERE owner_id=$1 AND machine_id='machine'`,[owner])).rows)
      .toEqual([{generation:21}]);
    await first.query('DELETE FROM messages WHERE id=$1',[offered.messageId]);
    await first.query('DELETE FROM connector_offers WHERE room_id=$1',[room]);
  });

  it('two Google login walls create one reconnect card and one installation generation',async()=>{
    await seedSquireMachine(first,agent,{generation:10,squire_report:{status:'connected',reportedAt:Date.now()/1000},squire_work:{}});
    const results=await concurrentWriters(first,second,db=>service(db).squireLoginWall({roomId:room,wall:'google_session',message:'Sign in again'},agent),
      'UPDATE squire_machines SET generation=generation+1');
    expect(results.filter(result=>result.cardPosted)).toHaveLength(1);
    expect((await first.query(`SELECT id FROM connector_offers WHERE room_id=$1 AND status='connecting'`,[room])).rowCount).toBe(1);
    expect((await first.query(`SELECT generation FROM squire_machines WHERE owner_id=$1 AND machine_id='machine'`,[owner])).rows)
      .toEqual([{generation:11}]);
  });
});
