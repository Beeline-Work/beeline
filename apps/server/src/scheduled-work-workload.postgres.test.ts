import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Client,Pool,type QueryResultRow} from 'pg';
import {describe,expect,it} from 'vitest';
import {PostgresDatabase,type SqlDatabase,type QueryResult} from './database.js';
import {postgresLiveSchema} from './postgres-live.js';
import {ROUTER_PROJECTION_SCHEMA} from './router-projection-schema.js';
import {SCHEDULED_WORK_AUTHORITY_SCHEMA} from './scheduled-work-authority.js';
import {ROOM_SCHEDULES_CAPTURE_SCHEMA} from './room-schedules-capture.js';
import {CORNER_PERSON_STATE_SCHEMA} from './corner-person-state.js';
import {AGENT_SUBSCRIPTIONS_SCHEMA} from './agent-subscriptions.js';
import {SUBSCRIPTION_WEBHOOKS_SCHEMA} from './subscription-webhooks.js';
import {PhoneService} from './phone-service.js';
import {LiveHub} from './live.js';
import {routerSocketProtocol,type RouterProjectionPolicy} from './router-socket.js';
import {RouterBuildCoordinator} from './router-build-coordinator.js';
import {routerSourcePlan} from './router-source-plan.js';
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Scheduled Work workloads require isolated loopback PostgreSQL');
const OWNER='a'.repeat(64),AGENT='b'.repeat(64),WS='11111111-1111-4111-8111-111111111111',DM_WS='22222222-2222-4222-8222-222222222222';
const origin='https://synthetic.test';
const legacyRowSource=await readFile(new URL('./test-fixtures/scheduled-work-legacy-source.sql',import.meta.url),'utf8');
const room=(n:number,direct=false)=>`${direct?'4':'3'}3333333-3333-4333-8333-${String(n).padStart(12,'0')}`;
const schedule=(n:number,direct=false)=>`${direct?'6':'5'}5555555-5555-4555-8555-${String(n).padStart(12,'0')}`;
type Statement={sql:string;args:unknown[]};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
class Observed implements SqlDatabase{
  readonly statements:Statement[]=[];rows=0;resultBytes=0;private active=0;private waiters:Array<()=>void>=[];
  constructor(private readonly db:SqlDatabase,private readonly owner:Observed|undefined=undefined){}
  private get root():Observed{return this.owner??this;}
  async query<Row extends QueryResultRow=QueryResultRow>(sql:string,args:unknown[]=[]):Promise<QueryResult<Row>>{
    const root=this.root;root.active++;root.statements.push({sql,args});
    try{const result=await this.db.query<Row>(sql,args);root.rows+=result.rows.length;root.resultBytes+=Buffer.byteLength(JSON.stringify(result.rows));return result;}
    finally{root.complete();}
  }
  async transaction<T>(work:(tx:SqlDatabase)=>Promise<T>):Promise<T>{
    const root=this.root;root.active++;
    try{return await this.db.transaction(tx=>work(new Observed(tx,root)));}finally{root.complete();}
  }
  private complete(){if(!--this.active)for(const wake of this.waiters.splice(0))wake();}
  idle():Promise<void>{return this.active?new Promise(done=>this.waiters.push(done)):Promise.resolve();}
  reset(){if(this.active)throw new Error('Cannot reset an active workload observation');this.statements.length=0;this.rows=0;this.resultBytes=0;}
  stats(){return {statements:this.statements.length,returnedRows:this.rows,queryResultBytes:this.resultBytes};}
}
/** Only relevant production tables/functions are installed. This deliberately
 * excludes unrelated product schemas/extensions and their trigger overhead;
 * the report cannot stand in for whole-server CPU/WAL or native cohort proof.
 * The Room access view, both DTO readers, journal/authority/source functions,
 * coordinator and socket execution below are their actual implementations. */
async function fixture(db:SqlDatabase,count:number){
  await db.query(`CREATE TABLE identities(id text PRIMARY KEY,kind text NOT NULL,name text NOT NULL,hidden_from_roster boolean NOT NULL DEFAULT false);
    CREATE TABLE workspaces(id uuid PRIMARY KEY,name text,avatar text);
    CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id),name text,parent_id uuid REFERENCES rooms(id),
      created_by text,archived_at timestamptz,direct_participants jsonb,reviewer_agent_id text);
    CREATE INDEX rooms_workspace ON rooms(workspace_id);CREATE INDEX rooms_parent ON rooms(parent_id);
    CREATE TABLE memberships(id bigserial PRIMARY KEY,workspace_id uuid NOT NULL,room_id uuid,identity_id text NOT NULL,role text NOT NULL,
      generation bigint NOT NULL DEFAULT 1,identity_profile jsonb,invited_by text,joined_at timestamptz NOT NULL DEFAULT now(),removed_at timestamptz,
      push_muted boolean NOT NULL DEFAULT false,event_subscriptions jsonb NOT NULL DEFAULT '[]');
    CREATE INDEX memberships_room_identity ON memberships(room_id,identity_id);CREATE INDEX memberships_identity ON memberships(identity_id,workspace_id);
    CREATE TABLE corner_facts(corner_id uuid PRIMARY KEY REFERENCES rooms(id),reviewer_agent_id text);
    CREATE TABLE corner_github_cache(corner_id uuid PRIMARY KEY REFERENCES rooms(id),lifecycle jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text);
    CREATE TABLE workspace_apps(id uuid PRIMARY KEY);
    CREATE TABLE provider_webhooks(id uuid PRIMARY KEY,status text,signing_secret text);
    CREATE TABLE agent_schedules(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,room_id uuid NOT NULL REFERENCES rooms(id),agent_id text NOT NULL,
      creator_id text NOT NULL,title text,max_runs integer,cadence jsonb NOT NULL,message text NOT NULL,next_run_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),workflow_slug text,run_count integer NOT NULL DEFAULT 0,workflow_run text);
    CREATE INDEX agent_schedules_room ON agent_schedules(room_id);`);
  await db.query(CORNER_PERSON_STATE_SCHEMA);await db.query(AGENT_SUBSCRIPTIONS_SCHEMA);await db.query(SUBSCRIPTION_WEBHOOKS_SCHEMA);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Manager'),($2,'agent','Helper')`,[OWNER,AGENT]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Public managers'),($2,'Own DMs without Workspace membership')`,[WS,DM_WS]);
  for(const direct of [false,true]){
    const ids=Array.from({length:count},(_,n)=>room(n+1,direct)),tasks=Array.from({length:count},(_,n)=>schedule(n+1,direct));
    await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
      SELECT id,$2,'Synthetic Room '||n,$3::jsonb,$4 FROM unnest($1::uuid[]) WITH ORDINALITY AS source(id,n)`,[ids,direct?DM_WS:WS,direct?JSON.stringify([OWNER,AGENT]):null,OWNER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $2,id,$3,'member' FROM unnest($1::uuid[]) id`,[ids,direct?DM_WS:WS,AGENT]);
    if(direct)await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $2,id,$3,'member' FROM unnest($1::uuid[]) id`,[ids,DM_WS,OWNER]);
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,created_at)
      SELECT task,$3,id,$4,$5,'{"kind":"interval","everyMinutes":10}','Do this synthetic task','2099-01-01','2026-01-01'
      FROM unnest($1::uuid[],$2::uuid[]) source(task,id)`,[tasks,ids,direct?DM_WS:WS,AGENT,OWNER]);
  }
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,[WS,OWNER]);
  // Reuse the real existing journal/notification function. Its installer also
  // enumerates unrelated tables; only these actual exercised triggers belong
  // in this deliberately isolated workload schema.
  const end=(await postgresLiveSchema()).indexOf('-- Memory jobs');if(end<0)throw new Error('Production live installer boundary changed');
  await db.query((await postgresLiveSchema()).slice(0,end));
  for(const table of ['agent_schedules','agent_subscriptions','workspaces'])await db.query(`CREATE TRIGGER beeline_notify_live_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION beeline_notify_live()`);
  await db.query(ROUTER_PROJECTION_SCHEMA);await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);await db.query(ROOM_SCHEDULES_CAPTURE_SCHEMA);
  for(const workspace of [WS,DM_WS])await db.query(`SELECT beeline_journal($1,'{"sourceTable":"workspaces","operation":"INSERT"}'::jsonb)`,[`workspace:${workspace}`]);
  await db.query('ANALYZE');
}
async function plans(db:SqlDatabase,statements:readonly Statement[]){
  let executionMs=0,planningMs=0,sharedHits=0,sharedReads=0;const summaries:unknown[]=[];
  for(const {sql,args}of statements){
    if(!/^\s*(SELECT|WITH)\b/i.test(sql))continue;
    const row=(await db.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,args)).rows[0]!;
    const report=row['QUERY PLAN'][0],plan=report.Plan;executionMs+=report['Execution Time'];planningMs+=report['Planning Time'];
    sharedHits+=plan['Shared Hit Blocks']??0;sharedReads+=plan['Shared Read Blocks']??0;
    summaries.push({node:plan['Node Type'],executionMs:report['Execution Time'],planningMs:report['Planning Time'],sharedHits:plan['Shared Hit Blocks']??0,sharedReads:plan['Shared Read Blocks']??0});
  }
  return {executionMs,planningMs,sharedHits,sharedReads,statements:summaries};
}
describe.skipIf(!url)('real PostgreSQL equal Scheduled Work workload',()=>{
  it.each([16,128].flatMap(count=>[false,true].map(compact=>({count,compact}))))('records actual cold/read/source work for $count Rooms, compact=$compact, without hiding a regression',async ({count,compact})=>{
    const schema=`scheduled_workload_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public`,max:4};
    const db=new PostgresDatabase('',4,{pool:new Pool(config)}),listener=new Client(config),observed=new Observed(db);
    const protocols:Array<ReturnType<typeof routerSocketProtocol>>=[];let listening=false;
    try{
      await fixture(db,count);
      const head=async()=>(await db.query(`SELECT id,sequence::text FROM live_streams ORDER BY id`)).rows;
      const before=await head(),cold=[];
      for(const direct of [false,true]){
        const roomId=room(1,direct),input={family:'room-scheduled-work' as const,roomId},measure=async(candidate:boolean)=>{
          observed.reset();const start=performance.now(),phone=new PhoneService(observed,origin);
          const value=candidate?await phone.readRouterSnapshot(input,OWNER):await phone.execute('readScheduledWork',{roomId},OWNER);
          await observed.idle();return {value,...observed.stats(),elapsedMs:performance.now()-start,wireBytes:Buffer.byteLength(JSON.stringify(value)),queries:[...observed.statements]};
        };
        const legacy=await measure(false),candidate=await measure(true);
        expect(candidate.value).toMatchObject({value:legacy.value});expect(candidate.wireBytes).toBeLessThanOrEqual(64*1024);
        cold.push({cohort:direct?'ownDM-noWorkspaceMembership':'public-manager-noTranscriptMembership',
          legacy:{...legacy,value:undefined,queries:undefined,plans:await plans(db,legacy.queries)},
          candidate:{...candidate,value:undefined,queries:undefined,plans:await plans(db,candidate.queries)},
          budgets:{statements:candidate.statements<=legacy.statements,wireBytes:candidate.wireBytes<=legacy.wireBytes}});
      }
      expect(await head()).toEqual(before);
      // Compare frozen production legacy, previous duplicate capture and the
      // folded canonical owner. Installers run outside measured writes. Each
      // mode executes the real UPDATE/triggers, with no callback substitute.
      const writeStats=async(mode:'legacy'|'duplicate'|'folded')=>{
        await db.query(legacyRowSource);
        if(mode==='folded'){
          await db.query((await postgresLiveSchema()).slice(0,(await postgresLiveSchema()).indexOf('-- Memory jobs')));
          await db.query(ROOM_SCHEDULES_CAPTURE_SCHEMA);
        }else{
          await db.query(`ALTER TABLE agent_schedules DISABLE TRIGGER aa_beeline_scheduled_work_row_source`);
          if(mode==='legacy')await db.query(`ALTER TABLE agent_schedules DISABLE TRIGGER zz_beeline_scheduled_work_capture`);
        }
        const beforeRows=Number((await db.query(`SELECT sequence::text FROM live_streams WHERE id=$1`,[`workspace:${WS}`])).rows[0]!.sequence);
        const start=(await db.query(`SELECT pg_current_wal_insert_lsn()::text lsn`)).rows[0]!.lsn;
        const plan=(await db.query(`EXPLAIN(ANALYZE,BUFFERS,WAL,FORMAT JSON) UPDATE agent_schedules SET run_count=run_count+1 WHERE id=$1`,[schedule(1)])).rows[0]!['QUERY PLAN'][0];
        const wal=(await db.query(`SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::text bytes`,[start])).rows[0]!.bytes;
        const sourceRows=(await db.query(`SELECT sequence::text,event FROM live_journal WHERE stream_id=$1 AND sequence>$2 ORDER BY live_journal.sequence`,[`workspace:${WS}`,beforeRows])).rows;
        expect(sourceRows).toHaveLength(mode==='duplicate'?2:1);
        expect(routerSourcePlan(sourceRows.map(row=>row.event),OWNER).scheduledWorkCauses).toHaveLength(mode==='legacy'?0:1);
        return {executionMs:plan['Execution Time'],sharedHits:plan.Plan['Shared Hit Blocks']??0,sharedReads:plan.Plan['Shared Read Blocks']??0,
          nodeWalBytes:plan.Plan['WAL Bytes']??0,lsnIntervalBytes:Number(wal),workspaceRows:sourceRows.length,
          workspaceBytes:Buffer.byteLength(JSON.stringify(sourceRows)),triggers:plan.Triggers};
      };
      const legacyWrite=await writeStats('legacy'),duplicateWrite=await writeStats('duplicate'),candidateWrite=await writeStats('folded');
      const live=new LiveHub();listener.on('notification',event=>{if(event.channel==='beeline_live_v1'&&event.payload){const data=JSON.parse(event.payload);if(Array.isArray(data.journalStreams))live.journalChanged(data.journalStreams);}});
      await listener.connect();listening=true;await listener.query('LISTEN beeline_live_v1');
      const phone=new PhoneService(observed,origin),build=phone.buildRouterValue.bind(phone),buildRooms:string[]=[];
      phone.buildRouterValue=async(...args)=>{buildRooms.push(args[1].roomId??'');return build(...args);};
      const policy:RouterProjectionPolicy={families:['room-scheduled-work'],commandDedupV1:true,scheduledWorkCoverageV1:compact,listenerReady:()=>true,
        sharedBuilds:{coordinator:new RouterBuildCoordinator(),basis:{schema:1,databaseScope:schema,version:'scheduled-work-full-v1',publicOrigin:origin,clockVersion:'stored-fields-no-wallclock-v1'}}};
      const frames:Record<string,any>[][]=[[],[]],done=[deferred(),deferred()];
      for(let i=0;i<2;i++){
        const protocol=routerSocketProtocol(observed,OWNER,raw=>{const frame=JSON.parse(raw);frames[i]!.push(frame);if(frame.kind==='push-commit')done[i]!.resolve();},policy,{phone,live,rooms:()=>{throw new Error('No client inventory');}});
        protocols.push(protocol);await protocol.handle({type:'router-negotiate',protocol:1,families:['room-scheduled-work'],authorityFencesV1:true,scheduledWorkCoverageV1:compact});
        expect(Boolean(frames[i]![0]?.scheduledWorkCoverageV1)).toBe(compact);
      }
      const input={family:'room-scheduled-work' as const,roomId:room(1)};
      const first=await protocols[0]!.snapshot(input),second=await protocols[1]!.snapshot(input);expect(second).toEqual(first);expect(buildRooms).toEqual([room(1)]);
      expect(policy.sharedBuilds!.coordinator.stats()).toMatchObject({builds:1,hits:1});
      await observed.idle();observed.reset();buildRooms.length=0;
      const initialWireBytes=frames.map(items=>Buffer.byteLength(items.map(item=>JSON.stringify(item)).join('')));
      for(const items of frames)items.length=0;
      await db.query(`UPDATE agent_schedules SET run_count=run_count+1 WHERE id=$1`,[schedule(1)]);await Promise.all(done.map(item=>item.promise));await observed.idle();
      expect(buildRooms).toEqual([room(1)]);expect(policy.sharedBuilds!.coordinator.stats().builds).toBe(2);
      const pushes=frames.map(items=>items.filter(frame=>frame.kind==='push-part'||frame.kind==='push-commit'));
      const facts=pushes[0]!.filter(frame=>frame.kind==='push-part').flatMap(frame=>frame.facts);
      expect(facts).toHaveLength(compact?2:count);expect(facts.filter(fact=>fact.payload?.kind==='scope-replace')).toHaveLength(1);
      expect(facts.filter(fact=>fact.kind==='scheduled-work-classification')).toHaveLength(compact?1:0);
      expect(pushes.every(items=>items.every(frame=>frame.to.stream===`workspace:${WS}`))).toBe(true);
      expect(JSON.stringify(pushes)).not.toContain(DM_WS);
      const source={...observed.stats(),audienceQueries:observed.statements.filter(item=>item.sql.includes('WITH manager AS')).length,
        builders:buildRooms.length,unrelatedRoomBuilders:buildRooms.filter(id=>id!==room(1)).length,
        perSocket:frames.map((items,index)=>({frames:items.length,wireBytes:Buffer.byteLength(items.map(item=>JSON.stringify(item)).join('')),
          initialWireBytes:initialWireBytes[index],authorityFrames:items.filter(frame=>String(frame.kind).startsWith('scheduled-work-authority-')).length,
          facts:items.filter(frame=>frame.kind==='push-part').flatMap(frame=>frame.facts).length}))};
      expect(source.unrelatedRoomBuilders).toBe(0);expect(source.audienceQueries).toBe(2);
      const measuredBudgets={coldStatements:cold.every(row=>row.budgets.statements),coldWireBytes:cold.every(row=>row.budgets.wireBytes),
        sourceNodeWalBytes:candidateWrite.nodeWalBytes<=legacyWrite.nodeWalBytes,sourceLsnInterval:candidateWrite.lsnIntervalBytes<=legacyWrite.lsnIntervalBytes};
      console.log('SCHEDULED_WORK_EQUAL_WORKLOAD',JSON.stringify({roomsPerWorkspace:count,compact,cold,write:{legacy:legacyWrite,duplicate:duplicateWrite,candidate:candidateWrite},
        sharedSockets:policy.sharedBuilds!.coordinator.stats(),source,measuredBudgets,
        activationGate:Object.values(measuredBudgets).every(Boolean)?'whole-server/native/cohort-proofs-open':'measured-regression-open',
        limits:'Relevant production table/view/function slice only; EXPLAIN timings are local warm observations, not CPU p95. LSN is database-wide and can include concurrent writers. No physical/native/whole-server deployment claim; capability remains OFF.'}));
    }finally{for(const protocol of protocols)protocol.close();if(listening)await listener.end();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
  },60000);
});
