import { createHash,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe,expect,it } from 'vitest';
import type { AgentUsage } from '@beeline/api-contract/daemon';
import { canonicalUsageAccountSnapshot } from '@beeline/api-contract/helper-usage';
import { PostgresDatabase,type SqlDatabase } from './database.js';
import { COMMITTED_JOURNAL_SCHEMA } from './committed-journal-schema.js';
import { HELPER_USAGE_SCHEMA,publishUsageAccount } from './helper-usage.js';
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Usage proofs require isolated loopback PostgreSQL');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};};
const owner='a'.repeat(64),other='b'.repeat(64),first='c'.repeat(64),second='d'.repeat(64);
describe.skipIf(!url)('usage real PostgreSQL publication and final owner contention',()=>{
  it('shares one account revision under competing publishers and blocks private enqueue behind real owner reassignment',async()=>{
    const schema='usage_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public`,max:3};
    const left=new PostgresDatabase('',3,{pool:new Pool(config)}),right=new PostgresDatabase('',3,{pool:new Pool(config)});
    const inserted=deferred(),allowCommit=deferred(),contending=deferred(),ownerHeld=deferred(),allowOwnerCommit=deferred(),fenceEntered=deferred();
    let original:Promise<unknown>|undefined,competing:Promise<unknown>|undefined,reassign:Promise<unknown>|undefined,fencing:Promise<void>|undefined;
    let firstWrittenAt:unknown;
    try{
      await left.query(`CREATE TABLE identities(id text PRIMARY KEY,name text,hidden_from_roster boolean NOT NULL DEFAULT false);
        CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text,usage_snapshot jsonb,usage_account_id bigint,machine_name text,updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE usage_accounts(id bigserial PRIMARY KEY,owner_id text NOT NULL,provider text NOT NULL,account_key text NOT NULL,usage jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,provider,account_key));
        CREATE INDEX agents_usage_account ON agents(usage_account_id);
        CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,released_at timestamptz);
        CREATE TABLE free_agents(agent_id text,owner_id text,removed_at timestamptz);
        CREATE TABLE free_agent_usage(owner_id text,day date,tokens bigint);
        CREATE TABLE free_agent_budget(day date,usd numeric);
        CREATE TABLE free_agent_events(agent_id text,kind text,at timestamptz);`);
      await left.query(COMMITTED_JOURNAL_SCHEMA);await left.query(HELPER_USAGE_SCHEMA);
      await left.query(`INSERT INTO identities(id,name) VALUES($1,'First'),($2,'Second')`,[first,second]);
      await left.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)',[first,second,owner]);
      await left.query(`INSERT INTO agent_connections VALUES($1,'first-source',1,NULL),($2,'second-source',1,NULL)`,[first,second]);
      const usage:AgentUsage={updatedAt:Date.now()/1000-1,windows:[{rateLimitType:'five_hour',status:'allowed',utilization:0.4,updatedAt:Date.now()/1000-1}],
        read:{status:'fresh',at:Date.now()/1000-1},account:{provider:'claude',key:'id:'+'e'.repeat(32)}};
      const revision=createHash('sha256').update(canonicalUsageAccountSnapshot(usage,owner)).digest('hex');
      const firstDb:SqlDatabase={query:(sql,values)=>left.query(sql,values),transaction:work=>left.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),query:async(sql,values)=>{
          const result=await tx.query(sql,values);
          if(sql.includes('INSERT INTO usage_accounts(')){
            firstWrittenAt=(await tx.query('SELECT updated_at FROM usage_accounts')).rows[0]?.updated_at;
            inserted.resolve();await allowCommit.promise;
          }
          return result;
        },
      }))};
      const secondDb:SqlDatabase={query:(sql,values)=>right.query(sql,values),transaction:work=>right.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),query:(sql,values)=>{
          const pending=tx.query(sql,values);if(sql.includes('SELECT pg_advisory_xact_lock('))contending.resolve();return pending;
        },
      }))};
      original=publishUsageAccount(firstDb,first,{ownerId:owner,usage,revision,source:{connectionId:'first-source',epoch:1}});
      await inserted.promise;
      competing=publishUsageAccount(secondDb,second,{ownerId:owner,usage,revision,source:{connectionId:'second-source',epoch:1}});
      await contending.promise;
      expect((await right.query('SELECT count(*)::integer count FROM usage_accounts')).rows).toEqual([{count:0}]);
      allowCommit.resolve();const results=await Promise.all([original,competing]);expect(results[0]).toEqual(results[1]);
      const accounts=(await left.query('SELECT id::text,updated_at,source_revision FROM usage_accounts')).rows;
      expect(accounts).toHaveLength(1);expect(accounts[0]?.source_revision).toBe(revision);expect(accounts[0]?.updated_at).toEqual(firstWrittenAt);
      expect((await left.query('SELECT usage_account_id::text account FROM agents ORDER BY agent_id')).rows).toEqual([{account:accounts[0]!.id},{account:accounts[0]!.id}]);
      await right.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1',[second,other]);
      await expect(publishUsageAccount(left,second,{ownerId:owner,usage,revision,source:{connectionId:'second-source',epoch:1}})).rejects.toThrow('owner changed');
    }finally{
      allowCommit.resolve();allowOwnerCommit.resolve();await Promise.allSettled([original,competing,reassign,fencing].filter((value):value is Promise<unknown>=>value!==undefined));
      await Promise.all([left.close(),right.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  },20000);
});
