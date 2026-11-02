import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {PostgresDatabase,type SqlDatabase} from './database.js';
import {DURABLE_LIVE_SCHEMA} from './durable-live.js';
import {TRAY_CLOCK_SOURCE_SCHEMA} from './tray-clock-source.js';
import {TrayClockReadiness} from './tray-clock-readiness.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Traversal proof requires isolated loopback PostgreSQL');
const WS='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
type Plan={['Node Type']:string;['Index Name']?:string;['Relation Name']?:string;['Actual Rows']?:number;
  ['Rows Removed by Filter']?:number;['Shared Hit Blocks']?:number;['Shared Read Blocks']?:number;Plans?:Plan[]};
const nodes=(plan:Plan):Plan[]=>[plan,...(plan.Plans??[]).flatMap(nodes)];

describe.skipIf(!url)('actual PostgreSQL bounded Room→source readiness access',()=>{
  it('uses bounded keyset indexes for the actual lifecycle SQL amid4096 Rooms and unrelated33024-row source cohorts',async()=>{
    const schema=`tray_traversal_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    const database=new PostgresDatabase('',2,{pool:new Pool({connectionString:url,options:`-c search_path=${schema},public`,max:2})});
    try{
      await database.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY,name text);
        CREATE TABLE identities(id text PRIMARY KEY,kind text,handle text);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,removed_at timestamptz);
        CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,text text,presentation text DEFAULT 'message',card_type text,
          card jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT clock_timestamp());
        CREATE TABLE needs_you_marks(identity_id text,message_id text,workspace_id uuid,first_seen_at timestamptz,cleared_at timestamptz,PRIMARY KEY(identity_id,message_id));
        CREATE TABLE room_choices(id uuid PRIMARY KEY,workspace_id uuid,room_id uuid,status text,closes_at timestamptz);`);
      await database.query(DURABLE_LIVE_SCHEMA);
      await database.query(`INSERT INTO workspaces VALUES($1,'Target'),($2,'Unrelated')`,[WS,OTHER]);
      await database.query(`INSERT INTO rooms(id,workspace_id) SELECT md5('room:'||n)::uuid,CASE WHEN n=1 THEN $1::uuid ELSE $2::uuid END FROM generate_series(1,4096)n`,[WS,OTHER]);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text)
        SELECT 'message:'||md5('room:'||room_n)||':'||lpad(n::text,4,'0'),md5('room:'||room_n)::uuid,'synthetic','Ordinary'
        FROM generate_series(1,129)room_n CROSS JOIN generate_series(1,256)n`);
      await database.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,first_seen_at)
        SELECT lpad(to_hex(n),64,'0'),'message:'||md5('room:'||room_n)||':0001',CASE WHEN room_n=1 THEN $1::uuid ELSE $2::uuid END,clock_timestamp()
        FROM generate_series(1,129)room_n CROSS JOIN generate_series(1,256)n`,[WS,OTHER]);
      await database.query(`INSERT INTO room_choices(id,workspace_id,room_id,status)
        SELECT md5('choice:'||room_n||':'||n)::uuid,CASE WHEN room_n=1 THEN $1::uuid ELSE $2::uuid END,md5('room:'||room_n)::uuid,'closed'
        FROM generate_series(1,129)room_n CROSS JOIN generate_series(1,256)n`,[WS,OTHER]);
      await database.query(TRAY_CLOCK_SOURCE_SCHEMA);
      // No ANALYZE, disabled seqscan/index forcing, fake source functions or
      // handwritten replacement query. Inspect actual cold lifecycle SQL,
      // then the same SQL with PostgreSQL's generic prepared-plan mode.
      const samples=new Map<string,{sql:string;args?:unknown[];index:string}>();
      const observe=(db:SqlDatabase):SqlDatabase=>({query:async(sql,args)=>{
        const result=await db.query(sql,args);
        const kind=sql.startsWith('SELECT id::text FROM rooms WHERE workspace_id')?'rooms':
          sql.startsWith("SELECT 'message' kind,id source_id")?'messages':
          sql.startsWith("SELECT 'seen' kind,mark.message_id")?'marks':
          sql.startsWith("SELECT 'choice' kind,id::text source_id")?'choices':undefined;
        if(kind){
          // Keep both initial and resumed cursor shapes. Replacing an earlier
          // page sample can hide an unbounded first-page plan.
          const key=kind+(sql.includes(' DESC ')?'-bound:':'-page:')+sql;
          samples.set(key,{sql,args,index:`tray_clock_readiness_${kind}_idx`});
        }
        return result;
      },transaction:work=>db.transaction(tx=>work(observe(tx)))});
      const owner=new TrayClockReadiness(observe(database));await owner.initialize();await owner.seed();
      for(let n=0;n<20;n++){
        const result=await owner.step();expect(result?.workspaceId).toBe(WS);expect(result!.processed).toBeLessThanOrEqual(100);
        if([...samples.keys()].some(key=>key.startsWith('choices-page:')))break;
      }
      for(const kind of ['rooms','messages','marks','choices'])for(const direction of ['bound','page'])expect([...samples.keys()].some(key=>key.startsWith(`${kind}-${direction}:`))).toBe(true);
      const inspect=async(db:SqlDatabase,sql:string,args:unknown[]|undefined,index:string)=>{
        const result=await db.query<{'QUERY PLAN':Array<{Plan:Plan}>}>(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,args);
        const plan=result.rows[0]!['QUERY PLAN'][0]!.Plan,all=nodes(plan);
        expect(all.some(node=>node['Index Name']===index)).toBe(true);
        expect(all.some(node=>node['Node Type']==='Seq Scan'||node['Node Type']==='Sort'),JSON.stringify({sql,args,plan})).toBe(false);
        expect(Math.max(...all.map(node=>node['Actual Rows']??0))).toBeLessThanOrEqual(101);
        expect(all.reduce((sum,node)=>sum+(node['Rows Removed by Filter']??0),0)).toBeLessThanOrEqual(1);
        // Bound index/heap visits by the requested101 rows plus tree overhead,
        // not total cohort size. Fresh random UUID order may legitimately
        // revisit one heap block per returned row before visibility vacuum.
        expect((plan['Shared Hit Blocks']??0)+(plan['Shared Read Blocks']??0)).toBeLessThanOrEqual(2*101+16);
      };
      for(const sample of samples.values())await inspect(database,sample.sql,sample.args,sample.index);
      await database.transaction(async tx=>{
        await tx.query(`SET LOCAL plan_cache_mode=force_generic_plan`);let counter=0;
        for(const sample of samples.values()){
          const name=`tray_traversal_${counter++}`;await tx.query(`PREPARE ${name} AS ${sample.sql}`);
          const args=(sample.args??[]).map(value=>{
            if(value===null)return 'NULL';if(typeof value!=='string')throw new Error('Unexpected traversal fixture parameter');
            return "'"+value.replaceAll("'","''")+"'";
          });
          await inspect(tx,`EXECUTE ${name}(${args.join(',')})`,undefined,sample.index);await tx.query(`DEALLOCATE ${name}`);
        }
      });
    }finally{await database.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
  },30000);
});
