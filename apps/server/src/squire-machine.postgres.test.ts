import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {migrate,PostgresDatabase,type SqlDatabase} from './database.js';
import {applyVaultList} from './workbench.js';
import {backfillSquireMachines,ensureSquireMachine,queueSquireWork,recordSquireSignIn,forgetSquireSignIn,reportSquireWork,squireAssignments,unpairSquireMachine} from './squire-machine.js';
import {createAgentCommand} from './agent-command.js';
import {completeSquireMachineOffers} from './connector-offer-completion.js';
import {concurrentWriters} from './test-fixtures/concurrent-writers.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('Machine races require isolated loopback PostgreSQL');
const owner='a'.repeat(64),one='b'.repeat(64),two='c'.repeat(64),machine='shared-machine';
const workspace='11111111-1111-4111-8111-111111111111';
const entry=(reference:string)=>({reference,service:'example',label:reference,state:'active' as const,fieldNames:[],createdAt:1});

describe.skipIf(!url)('canonical machine installation concurrency',()=>{
  const name='machine_cas_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
  const isolated=new URL(url??'postgresql://localhost/postgres');isolated.pathname='/'+name;
  const config={connectionString:isolated.toString(),options:'-c statement_timeout=8000',max:1};
  const a=new PostgresDatabase('',1,{pool:new Pool(config)}),b=new PostgresDatabase('',1,{pool:new Pool(config)});
  const target={owner_identity_id:owner,machine_id:machine,workspace_id:workspace};
  beforeAll(async()=>{
    await admin.query(`CREATE DATABASE ${name}`);await migrate(a);
    await a.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','First'),($3,'agent','Second')`,[owner,one,two]);
    await a.query(`INSERT INTO workspaces(id,name) VALUES($1,'Machine source')`,[workspace]);
    await a.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$3,$4),($2,$3,$4)`,[one,two,owner,machine]);
  },60_000);
  beforeEach(async()=>{
    await a.query('DELETE FROM workspace_connections');await a.query('DELETE FROM squire_machines');
    await a.query(`UPDATE agents SET squire_work='{}'::jsonb`);
  });
  afterAll(async()=>{await a.close();await b.close();await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();});

  it.each([['A','B'],['B','A']])('overlapping %s and %s snapshots leave exactly the winning snapshot',async(first,second)=>{
    await ensureSquireMachine(a,owner,machine);
    let writer=0;
    const result=await concurrentWriters(a,b,db=>{
      const prefix=[first,second][writer++]!;
      return db.transaction(tx=>applyVaultList(tx,target,[entry(prefix+'1'),entry(prefix+'2')],{status:'connected',reportedAt:prefix==='A'?101:102}));
    },'WITH accepted AS');
    expect(result).toEqual([true,false]);
    expect((await a.query('SELECT reference FROM workspace_connections ORDER BY reference')).rows)
      .toEqual([{reference:first+'1'},{reference:first+'2'}]);
    expect((await a.query('SELECT squire_report FROM squire_machines')).rows)
      .toEqual([{squire_report:{status:'connected',reportedAt:first==='A'?101:102}}]);
  });

  it.each([false,true])('report and unpair apply only the winning intent (unpair first: %s)',async(unpairFirst)=>{
    await ensureSquireMachine(a,owner,machine);
    let writer=0;
    const results=await concurrentWriters(a,b,db=>{
      const unpair=writer++===0?unpairFirst:!unpairFirst;
      const work=unpair?unpairSquireMachine(db,owner,machine).then(()=> 'unpaired'):
        db.transaction(tx=>applyVaultList(tx,target,[entry('A')])).then(applied=>applied?'reported':'ignored');
      return work.catch(error=>{expect(error.status).toBe(409);return 'superseded';});
    },'squire_machines SET');
    expect(results).toEqual(unpairFirst?['unpaired','ignored']:['reported','unpaired']);
    expect((await a.query('SELECT reference FROM workspace_connections')).rows).toEqual([]);
    const state=await ensureSquireMachine(a,owner,machine);
    expect(state.squire_work.disconnected).toBe(true);
    expect(await applyVaultList(a,target,[entry('late')])).toBe(false);
  });

  it('two pairing requests choose one generation and one installation helper',async()=>{
    await ensureSquireMachine(a,owner,machine);
    let writer=0;
    const results=await concurrentWriters(a,b,db=>{
      const agent=[one,two][writer++]!;
      return db.transaction(tx=>queueSquireWork(tx,agent,{install:true})).then(value=>value,error=>{expect(error.status).toBe(409);return 'superseded';});
    },'UPDATE squire_machines SET generation=generation+1');
    expect(results).toEqual([1,'superseded']);
    expect(await squireAssignments(a,two)).toEqual([]);
    expect(await squireAssignments(a,one)).toEqual([{kind:'install',connectorId:'squire:'+machine,connectorType:'trusty-squire',pairingGeneration:1}]);
    await expect(reportSquireWork(a,two,{connectorId:'squire:'+machine,pairingGeneration:1,steps:[]})).rejects.toThrow('not found');
    await expect(reportSquireWork(a,one,{connectorId:'squire:'+machine,pairingGeneration:0,steps:[]})).rejects.toThrow('not found');
    await reportSquireWork(a,one,{connectorId:'squire:'+machine,pairingGeneration:1,steps:[]},true);
    expect(await squireAssignments(a,one)).toEqual([]);
  });

  it('simultaneous helper-local operations keep both inbox entries',async()=>{
    await ensureSquireMachine(a,owner,machine);
    let writer=0;
    await concurrentWriters(a,b,db=>db.transaction(tx=>queueSquireWork(tx,one,{op:['sync','revoke-grants:ref'][writer++]!})),
      'UPDATE agents SET squire_work=jsonb_set');
    expect(await squireAssignments(a,one)).toEqual([
      {kind:'sync',connectorId:'squire:'+machine,connectorType:'trusty-squire'},
      {kind:'revoke-grants',connectorId:'squire:'+machine,connectorType:'trusty-squire',reference:'ref'},
    ]);
  });

  it('concurrent app sign-outs both remove their own current entry',async()=>{
    await recordSquireSignIn(a,one,'first','first.example');
    await recordSquireSignIn(a,one,'second','second.example');
    let writer=0;
    await concurrentWriters(a,b,db=>db.transaction(tx=>forgetSquireSignIn(tx,one,{appKey:['first','second'][writer++]!})),
      'UPDATE agents agent SET squire_work=jsonb_set');
    expect((await a.query('SELECT squire_work FROM agents WHERE agent_id=$1',[one])).rows)
      .toEqual([{squire_work:{signedInApps:{}}}]);
  });

  it('one report completes every waiting offer and resumes each original command exactly once',async()=>{
    await ensureSquireMachine(a,owner,machine);
    const parents:string[]=[];
    for(const agent of [one,two]){
      const room=randomUUID(),offer=randomUUID(),message=randomUUID();
      await a.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Connection')`,[room,workspace,owner]);
      await a.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'member')`,[workspace,room,agent]);
      await a.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Connect')`,[message,room,owner]);
      const command=await createAgentCommand(a,{roomId:room,agentId:agent,sourceMessageId:message,reason:'human_tag'});
      parents.push(command!.id);
      await a.query(`INSERT INTO connector_offers(id,agent_id,workspace_id,room_id,addressee_id,connector_type,
        reason,machine_id,status,accepted_by,accepted_at,command_id)
        VALUES($1,$2,$3,$4,$5,'trusty-squire','Connect',$6,'connecting',$5,now(),$7)`,
        [offer,agent,workspace,room,owner,machine,command!.id]);
      await a.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card)
        VALUES($1,$2,$3,'Connecting','connector-offer',$4::jsonb)`,
        [randomUUID(),room,agent,JSON.stringify({offerId:offer,status:'connecting'})]);
    }
    const completed=await concurrentWriters(a,b,db=>db.transaction(async tx=>{
      const applied=await applyVaultList(tx,target,[entry('ready')]);
      return applied?completeSquireMachineOffers(tx,owner,machine):[];
    }),'WITH accepted AS');
    expect(completed.map(offers=>offers.length)).toEqual([2,0]);
    expect((await a.query(`SELECT status FROM connector_offers WHERE command_id=ANY($1::text[])`,[parents])).rows)
      .toEqual([{status:'accepted'},{status:'accepted'}]);
    const resumes=(await a.query(`SELECT parent_command_id,root_command_id,agent_depth FROM agent_commands
      WHERE parent_command_id=ANY($1::text[]) ORDER BY parent_command_id`,[parents])).rows;
    expect(resumes).toEqual([...parents].sort().map(id=>({parent_command_id:id,root_command_id:id,agent_depth:0})));
    expect((await a.query(`SELECT card->>'status' status FROM messages WHERE card_type='connector-offer-decision'`)).rows)
      .toEqual([{status:'accepted'},{status:'accepted'}]);
  });

  it('backfills installation intent once without reading or dropping retired helper reports',async()=>{
    await a.query(`UPDATE agents SET squire_work=$2::jsonb,squire_report=$3::jsonb WHERE agent_id=$1`,[one,
      JSON.stringify({generation:4,install:true,reportedAt:10,ops:['sync'],signedInApps:{example:{domain:'example.com',checkedAt:1}}}),
      JSON.stringify({status:'connected',reportedAt:100})]);
    await a.query(`UPDATE agents SET squire_work=$2::jsonb,squire_report=$3::jsonb WHERE agent_id=$1`,[two,
      JSON.stringify({generation:3,errorMessage:'Old failure',ops:['revoke-grants:old']}),JSON.stringify({status:'error',errorMessage:'Broker failed',reportedAt:200})]);
    await migrate(a);
    const source=await ensureSquireMachine(a,owner,machine);
    expect(source).toMatchObject({generation:4,helper_agent_id:one,squire_work:{install:true,reportedAt:10},squire_report:null});
    expect((await a.query(`SELECT column_name FROM information_schema.columns WHERE table_name='agents' AND column_name='squire_report'`)).rows).toEqual([{column_name:'squire_report'}]);
    expect((await a.query('SELECT squire_report FROM agents WHERE agent_id=$1',[two])).rows)
      .toEqual([{squire_report:{status:'error',errorMessage:'Broker failed',reportedAt:200}}]);
    expect((await a.query('SELECT squire_work FROM agents WHERE agent_id=$1',[one])).rows)
      .toEqual([{squire_work:{ops:['sync'],signedInApps:{example:{domain:'example.com',checkedAt:1}}}}]);
    await backfillSquireMachines(a);
    expect(await ensureSquireMachine(a,owner,machine)).toEqual(source);
  },30_000);

  it('backfills an explicit unpair ahead of an older sibling install',async()=>{
    await a.query(`UPDATE agents SET squire_work=$2::jsonb WHERE agent_id=$1`,[one,JSON.stringify({generation:4,install:true})]);
    await a.query(`UPDATE agents SET squire_work=$2::jsonb WHERE agent_id=$1`,[two,JSON.stringify({generation:5,disconnected:true})]);
    await backfillSquireMachines(a);
    expect(await ensureSquireMachine(a,owner,machine)).toMatchObject({generation:5,helper_agent_id:null,squire_work:{disconnected:true}});
    expect(await applyVaultList(a,target,[entry('stale report')])).toBe(false);
  });
});
