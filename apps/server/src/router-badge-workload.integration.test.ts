import {expect,it} from 'vitest';
import {ReadLanes} from '../../../packages/net/src/private/read-lanes.js';
import type {SqlDatabase} from './database.js';
import {migratedDatabase} from './test-support.js';
import {PhoneService} from './phone-service.js';
import {countNeedsYouItems} from './needs-you.js';

/** Scoped equal-journey measurement, not whole-router rollout approval. Real
 * pure builders and aggregate owner; no production data or invented events. */
it('measures cold and repeated badge focus separately against identical authorized data',async()=>{
  const db=await migratedDatabase(),viewer='a'.repeat(64),peer='b'.repeat(64);
  const workspace='11111111-1111-4111-8111-111111111111';
  try{
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Peer','peer')`,[viewer,peer]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workload')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name)
      SELECT ('22222222-2222-4222-8222-'||lpad(n::text,12,'0'))::uuid,$1,'Room'||n FROM generate_series(1,16)n`,[workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,[workspace,viewer,peer]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT $1,id,$2,'owner' FROM rooms WHERE workspace_id=$1`,[workspace,viewer]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      SELECT 'workload-'||room.id||'-'||n,room.id,$2,'@reader please review this synthetic question',now()-interval '1 hour'
      FROM rooms room CROSS JOIN generate_series(1,16)n WHERE workspace_id=$1`,[workspace,peer]);
    const head=async()=>(await db.query(`SELECT sequence FROM live_streams WHERE id=$1`,['workspace:'+workspace])).rows[0]?.sequence;
    const before=await head(),input={family:'needs-you-count' as const,workspaceId:workspace};
    const phone=new PhoneService(db,'https://synthetic.invalid');
    const measure=async(work:(observed:SqlDatabase)=>Promise<unknown>)=>{
      let statements=0,rows=0,queryBytes=0;
      const wrap=(database:SqlDatabase):SqlDatabase=>({
        transaction:run=>database.transaction(tx=>run(wrap(tx))),
        query:async(sql,args)=>{statements++;const result=await database.query(sql,args);rows+=result.rows.length;
          queryBytes+=Buffer.byteLength(JSON.stringify(result.rows));return result;},
      });
      const start=performance.now(),value=await work(wrap(db));
      return {value,statements,rows,queryBytes,elapsedMs:performance.now()-start,wireBytes:Buffer.byteLength(JSON.stringify(value))};
    };
    const legacy=[],candidate=[];
    for(let i=0;i<10;i++){
      legacy.push(await measure(async observed=>({count:await countNeedsYouItems(observed,workspace,viewer)})));
      candidate.push(await measure(observed=>new PhoneService(observed,'https://synthetic.invalid').readRouterSnapshot(input,viewer)));
    }
    for(const result of legacy)expect(result.value).toEqual({count:256});
    for(const result of candidate){expect(result.value).toMatchObject({value:{count:256}});expect(result.wireBytes).toBeLessThanOrEqual(1024);expect(result.statements).toBeLessThanOrEqual(legacy[0]!.statements);}
    const lanes=new ReadLanes({origin:'https://synthetic.invalid',principal:viewer,sessionEpoch:1},()=>true);
    let reads=0,legacyFocusReads=0,resolve!:()=>void;
    lanes.subscribe(input,()=>{if(lanes.peek(input).state==='LIVE')resolve();});
    lanes.connected(1,['needs-you-count'],async()=>{reads++;return phone.readRouterSnapshot(input,viewer);});
    for(let i=0;i<100;i++){
      expect(await countNeedsYouItems(db,workspace,viewer)).toBe(256);legacyFocusReads++;
      const installed=new Promise<void>(done=>{resolve=done;});
      const release=lanes.demand(input,{}, {isCurrent:()=>true});await installed;
      expect(lanes.peek(input)).toMatchObject({state:'LIVE',value:{count:256}});release();
    }
    expect(reads).toBe(1);expect(await head()).toBe(before);
    expect((await db.query('SELECT 1 FROM needs_you_marks')).rowCount).toBe(0);
    const stats=(samples:typeof legacy)=>({statements:samples[0]!.statements,resultRows:samples[0]!.rows,
      queryResultBytes:samples[0]!.queryBytes,wireBytes:samples[0]!.wireBytes,
      p95Ms:[...samples].map(row=>row.elapsedMs).sort((a,b)=>a-b)[Math.ceil(samples.length*.95)-1]});
    console.log('BADGE_EQUAL_WORKLOAD',JSON.stringify({cohort:'local PGlite; synthetic16Rooms/256asks',
      cold:{legacy:stats(legacy),candidate:stats(candidate)},hundredFocuses:{legacyReads:legacyFocusReads,candidateReads:reads},
      writes:0,journalAdvance:0,limits:'No real PostgreSQL WAL/CPU/enqueue or native parse/render claim; other families and actual committed changes not covered.'}));
  }finally{await db.close();}
},60000);
