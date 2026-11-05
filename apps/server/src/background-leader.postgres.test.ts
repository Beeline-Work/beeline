import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { BackgroundLeader } from './background-leader.js';
import { BackgroundWork } from './background-work.js';
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Leadership proof requires isolated loopback PostgreSQL');
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
describe.skipIf(!url)('real PostgreSQL blocking leader ownership',()=>{
  it('transfers the existing lock to a waiting peer and cancels another waiter without timed probes',async()=>{
    const pools=[0,1,2].map(()=>new Pool({connectionString:url,max:1,statement_timeout:2000,options:'-c lock_timeout=500ms'}));
    const waiting=[deferred(),deferred(),deferred()],entered=[deferred(),deferred(),deferred()],cycles=[0,0,0],statements:string[][]=[[],[],[]];
    const leaders=pools.map((pool,i)=>new BackgroundLeader({connectDedicated:async()=>{
      const client=await pool.connect();
      const query=client.query.bind(client);
      client.query=((sql:string,values?:unknown[])=>{
        statements[i]!.push(sql);const result=query(sql,values);
        if(sql.includes('pg_advisory_lock'))waiting[i]!.resolve();return result;
      }) as typeof client.query;
      return client;
    }},async initial=>{expect(initial).toBe(true);cycles[i]++;entered[i]!.resolve();return Infinity;}));
    try{
      void leaders[0]!.run();await entered[0]!.promise;
      void leaders[1]!.run();void leaders[2]!.run();
      // The third actual lock query is submitted while the first owner
      // holds it. Shutdown must cancel this blocked wait immediately.
      await waiting[2]!.promise;
      await leaders[2]!.stop();expect(cycles[2]).toBe(0);
      await leaders[0]!.stop();await entered[1]!.promise;
      expect(cycles).toEqual([1,1,0]);
      expect(statements[0]).toEqual(['SET statement_timeout=0; SET lock_timeout=60000','SELECT pg_advisory_lock($1)']);
      expect(statements[1]).toEqual(statements[0]);
      await leaders[1]!.stop();
    }finally{
      await Promise.all(leaders.map(leader=>leader.stop()));await Promise.all(pools.map(pool=>pool.end()));
    }
  });
  it('shares the unchanged lock with a polling old-server owner during a rolling deploy', async () => {
    const oldPool = new Pool({ connectionString: url, max: 1 });
    const newPool = new Pool({ connectionString: url, max: 1 });
    const old = await oldPool.connect();
    const waiting = deferred();
    const entered = deferred();
    const leader = new BackgroundLeader({ connectDedicated: async () => {
      const client = await newPool.connect();
      const query = client.query.bind(client);
      client.query = ((sql: string, values?: unknown[]) => {
        const result = query(sql, values);
        if (sql.includes('pg_advisory_lock')) waiting.resolve();
        return result;
      }) as typeof client.query;
      return client;
    } }, async () => { entered.resolve(); return Infinity; });
    try {
      const key = 0x0bee11;
      expect((await old.query('SELECT pg_try_advisory_lock($1) locked', [key])).rows[0].locked).toBe(true);
      void leader.run();
      await waiting.promise;
      await old.query('SELECT pg_advisory_unlock($1)', [key]);
      await entered.promise;
      expect((await old.query('SELECT pg_try_advisory_lock($1) locked', [key])).rows[0].locked).toBe(false);
      await leader.stop();
      // Pool release destroys the socket synchronously; PostgreSQL may process
      // EOF after another connection's next query. Wait on the same real lock.
      await old.query("SET lock_timeout='2s'");
      await old.query('SELECT pg_advisory_lock($1)', [key]);
      expect((await old.query('SELECT pg_try_advisory_lock($1) locked', [key])).rows[0].locked).toBe(true);
    } finally {
      await leader.stop();
      old.release(true);
      await Promise.all([oldPool.end(), newPool.end()]);
    }
  });

  it('ends admission for the rest of a repair cycle when its physical backend is lost', async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const admin = new Pool({ connectionString: url, max: 1 });
    const entered = deferred(), finish = deferred(), lost = deferred(), drained = deferred();
    const work = new BackgroundWork(() => 0, () => {});
    const calls: string[] = [];
    let backend = 0;
    let attempts = 0;
    work.addDeadline('held-provider', async () => {
      calls.push('held-provider'); entered.resolve(); await finish.promise;
    });
    work.addDeadline('later-repair', async () => { calls.push('later-repair'); });
    const leader = new BackgroundLeader({ connectDedicated: async () => {
      // Refuse the one incident replacement: loss cannot become a test-only
      // success path that runs the abandoned old owner's pending families.
      if (++attempts > 1) throw new Error('Synthetic replacement unavailable');
      const client = await pool.connect();
      backend = (await client.query('SELECT pg_backend_pid() id')).rows[0].id;
      return client;
    } }, async (initial, signal) => {
      const delay = await work.run(initial, signal); drained.resolve(); return delay;
    }, { acquired: async () => {}, lost: () => { lost.resolve(); } });
    try {
      void leader.run(); await entered.promise;
      await admin.query('SELECT pg_terminate_backend($1)', [backend]);
      await lost.promise;
      finish.resolve(); await drained.promise;
      expect(calls).toEqual(['held-provider']);
      // A separately acquired epoch still gets its one initial family pass.
      expect(await work.run(true, new AbortController().signal)).toBe(Infinity);
      expect(calls).toEqual(['held-provider', 'held-provider', 'later-repair']);
    } finally {
      finish.resolve(); await leader.stop(); await Promise.all([pool.end(), admin.end()]);
    }
  });

});
