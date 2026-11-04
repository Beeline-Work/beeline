import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {DURABLE_LIVE_SCHEMA,LIVE_REPLAY_BYTE_LIMIT,LIVE_REPLAY_LIMIT} from './durable-live.js';
const postgresUrl=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(postgresUrl && !['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))throw new Error('journal proofs require isolated loopback PostgreSQL');

describe.skipIf(!postgresUrl)('P5 journal retention generic-plan work bound',()=>{
  it('selects victims through both composite ranges and never scans retained history',async()=>{
    const schema=`journal_${randomUUID().replaceAll('-','')}`,pool=new Pool({connectionString:postgresUrl,max:1});
    try{
      await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`SET search_path TO ${schema},public`);
      await pool.query(DURABLE_LIVE_SCHEMA);
      await pool.query(`INSERT INTO live_streams(id,sequence,byte_total) VALUES('workspace:synthetic',6,6000),('room:synthetic',6,6000)`);
      await pool.query(`INSERT INTO live_journal(stream_id,sequence,event,byte_start)
        SELECT stream,n,jsonb_build_object('type','invalidate','roomId','','reason','synthetic'),n*1000
        FROM unnest(ARRAY['workspace:synthetic','room:synthetic']) stream CROSS JOIN generate_series(1,6)n`);
      await pool.query('ANALYZE live_journal');await pool.query('SET plan_cache_mode=force_generic_plan');
      const config=(await pool.query(`SELECT proconfig FROM pg_proc WHERE oid='beeline_journal(text,jsonb)'::regprocedure`)).rows[0].proconfig;
      expect(config).toContain('enable_seqscan=off');
      // Reproduce the production function's private planner configuration.
      await pool.query('SET enable_seqscan=off');
      // Explain the actual production function's DELETE, not a remembered
      // duplicate. Generic plans are the path used after repeated appends.
      const body=(await pool.query<{body:string}>(`SELECT pg_get_functiondef('beeline_journal(text,jsonb)'::regprocedure) body`)).rows[0]!.body;
      const deletion=body.match(/WITH count_victim AS MATERIALIZED[\s\S]*?;/)![0]
        .replace(/\bstream\b/g,'$1').replace(/\bposition\b/g,'$2').replace(/\btotal\b/g,'$3').replace(/\bbytes\b/g,'$4');
      await pool.query(`PREPARE prune(text,bigint,bigint,integer) AS ${deletion}`);
      const nodes:any[]=[];const visit=(node:any)=>{nodes.push(node);for(const child of node.Plans??[])visit(child);};
      const cold=(await pool.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE prune('workspace:synthetic',6,6000,1000)`)).rows[0]['QUERY PLAN'][0];
      visit(cold.Plan);expect(nodes.some(n=>n['Node Type']==='Seq Scan')).toBe(false);nodes.length=0;
      // Grow the relation inside one transaction without refreshing statistics;
      // the cold generic plan must remain bounded throughout the source write.
      await pool.query('BEGIN');
      await pool.query(`INSERT INTO live_journal(stream_id,sequence,event,byte_start)
        SELECT stream,n,'{}'::jsonb,n*1000 FROM unnest(ARRAY['workspace:synthetic','room:synthetic']) stream
        CROSS JOIN generate_series(7,1025)n`);
      const root=(await pool.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE prune('workspace:synthetic',1025,1025000,1000)`)).rows[0]['QUERY PLAN'][0];
      visit(root.Plan);
      expect(nodes.some(n=>n['Node Type']==='Seq Scan')).toBe(false);
      expect(nodes.some(n=>n['Index Name']==='live_journal_pkey')).toBe(true);
      expect(nodes.some(n=>n['Index Name']==='live_journal_byte_start_idx')).toBe(true);
      expect((await pool.query(`SELECT min(sequence)::int oldest,count(*)::int n FROM live_journal WHERE stream_id='workspace:synthetic'`)).rows[0]).toEqual({oldest:2,n:1024});
      await pool.query('COMMIT');
    }finally{await pool.query('ROLLBACK');await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
  });
  it('matches an independent bounded trailing-history model across count limits, byte gaps and oversized entries',async()=>{
    const schema=`journal_model_${randomUUID().replaceAll('-','')}`,pool=new Pool({connectionString:postgresUrl,max:1});
    try{
      await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`SET search_path TO ${schema},public`);await pool.query(DURABLE_LIVE_SCHEMA);
      const sizes=[40,200000,LIVE_REPLAY_BYTE_LIMIT+1],bodies=sizes.map(n=>JSON.stringify({type:'invalidate',roomId:'',reason:'synthetic',padding:'x'.repeat(n)}));
      const bytes=await Promise.all(bodies.map(body=>pool.query<{n:number}>('SELECT octet_length($1::jsonb::text)::int n',[body]).then(result=>result.rows[0]!.n)));
      const sequence=[...Array(1050).fill(0),...Array(70).fill(1),2,...Array(5).fill(0)] as number[];
      const model:Array<{sequence:number;bytes:number}>=[];let retainedBytes=0;
      await pool.query('BEGIN');
      for(let index=0;index<sequence.length;index++){
        const kind=sequence[index]!;
        await pool.query(`SELECT beeline_journal('workspace:synthetic',$1::jsonb)`,[bodies[kind]]);
        model.push({sequence:index+1,bytes:bytes[kind]!});retainedBytes+=bytes[kind]!;
        while(model.length>LIVE_REPLAY_LIMIT || retainedBytes>LIVE_REPLAY_BYTE_LIMIT)retainedBytes-=model.shift()!.bytes;
        if(index%50===0 || kind===2 || index===sequence.length-1){
          const rows=(await pool.query<{sequence:string}>(`SELECT sequence::text FROM live_journal WHERE stream_id='workspace:synthetic' ORDER BY live_journal.sequence`)).rows;
          expect(rows.map(row=>Number(row.sequence))).toEqual(model.map(row=>row.sequence));
        }
      }
      await pool.query('COMMIT');
    }finally{await pool.query('ROLLBACK');await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
  });

});
