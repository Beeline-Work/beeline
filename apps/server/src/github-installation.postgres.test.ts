import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {GitHubAppClient,GitHubOAuthClient} from '@beeline/auth/github';
import {migrate,PostgresDatabase,type SqlDatabase} from './database.js';
import {GitHubOperations} from './github-operations.js';
import {concurrentWriters} from './test-fixtures/concurrent-writers.js';

const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Isolated loopback PostgreSQL required');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
describe.skipIf(!url)('GitHub one-use installation claims',()=>{
  const name='github_install_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
  const target=new URL(url??'postgresql://localhost/postgres');target.pathname='/'+name;
  const config={connectionString:target.toString(),max:1,options:'-c statement_timeout=8000'};
  const first=new PostgresDatabase('',1,{pool:new Pool(config)}),second=new PostgresDatabase('',1,{pool:new Pool(config)});
  const owners=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)];
  const identity=(subject='42')=>({subject,issuer:'https://github.com',login:'owner',name:'Owner',accessToken:'fixture-token'});
  const app=(subject='42')=>({installationAccount:async()=>({id:subject,login:'owner',type:'User',repositorySelection:'selected'}),
    userCanAccessInstallation:async()=>true,listRepositories:async()=>[{id:Number(subject),installationId:Number(subject),fullName:'owner/widgets-'+subject,
      defaultBranch:'main',private:false,allowAutoMerge:false}]}) as unknown as GitHubAppClient;
  const oauth=(subject='42')=>({exchangeCode:async()=>identity(subject),authorizationUrl:({state}:{state:string})=>`https://test.invalid/oauth?state=${state}`}) as unknown as GitHubOAuthClient;
  const seed=async(owner:string,state='github_bind_'+randomUUID())=>{
    await first.query(`INSERT INTO github_auth_flows(state_hash,identity_id,redirect_uri,purpose,expires_at)
      VALUES($1,$2,'beeline://github-installation','installation',now()+interval '1 day')`,[hash(state),owner]);
    return state;
  };
  beforeAll(async()=>{
    await admin.query(`CREATE DATABASE ${name}`);await migrate(first);
    await first.query(`INSERT INTO identities(id,kind,name) SELECT id,'human','Owner' FROM unnest($1::text[]) id`,[owners]);
  },60_000);
  afterAll(async()=>{await first.close();await second.close();await admin.query(`DROP DATABASE IF EXISTS ${name} WITH(FORCE)`);await admin.end();});
  it('consumes before HTTP, frees the callback row during HTTP and refuses concurrent replay without calling OAuth again',async()=>{
    const state=await seed(owners[0]!),entered=deferred(),release=deferred();let calls=0;
    const provider={...oauth(),exchangeCode:async()=>{calls++;entered.resolve();await release.promise;return identity();}} as GitHubOAuthClient;
    const operations=new GitHubOperations(first,provider,app(),'proof');
    const completing=operations.completeInstallation(state,42,'code','https://test.invalid/callback');
    try {
      await entered.promise;
      await second.transaction(async tx=>{
        await tx.query("SET LOCAL lock_timeout='100ms'");
        expect((await tx.query('SELECT consumed_at FROM github_auth_flows WHERE state_hash=$1 FOR UPDATE',[hash(state)])).rows[0]!.consumed_at).not.toBeNull();
      });
      await expect(new GitHubOperations(second,provider,app(),'proof').completeInstallation(state,42,'code','https://test.invalid/callback'))
        .rejects.toThrow('flow not found or expired');
      expect(calls).toBe(1);
    } finally {release.resolve();}
    expect(await completing).toBe('beeline://github-installation?installed=1');
  });
  it('two different owners cannot bind one GitHub subject or overwrite its credential',async()=>{
    const states=await Promise.all([seed(owners[1]!),seed(owners[2]!)]);let writer=0;
    const results=await concurrentWriters(first,second,db=>new GitHubOperations(db,oauth('43'),app('43'),'proof')
      .completeInstallation(states[writer++]!,43,'code','https://test.invalid/callback'),'WITH linked AS');
    expect(results[0]).toBe('beeline://github-installation?installed=1');
    expect(new URL(results[1]!).searchParams.get('error')).toBe('github_account_already_linked');
    expect((await first.query(`SELECT identity_id FROM identity_external_links WHERE provider='github' AND subject='43'`)).rows)
      .toEqual([{identity_id:owners[1]}]);
  });
  it('failed callback writes roll back, replay is refused, and a fresh Connect flow succeeds',async()=>{
    const state=await seed(owners[2]!),failure=Object.assign(new Error('deadlock detected'),{code:'40P01'});
    let fail=true;
    const wrap=(db:SqlDatabase):SqlDatabase=>({
      ...db,transaction:work=>db.transaction(tx=>work(wrap(tx))),query:async(sql,values)=>{
        if(fail&&sql.startsWith('INSERT INTO github_repositories(')){fail=false;throw failure;}
        return db.query(sql,values);
      },
    });
    const operations=new GitHubOperations(wrap(first),oauth('44'),app('44'),'proof');
    expect(new URL(await operations.completeInstallation(state,44,'code','https://test.invalid/callback')).searchParams.get('error')).toBe('github_connection_failed');
    expect((await first.query(`SELECT subject FROM identity_external_links WHERE provider='github' AND subject='44'`)).rowCount).toBe(0);
    expect((await first.query('SELECT installation_id FROM github_installations WHERE installation_id=44')).rowCount).toBe(0);
    await expect(operations.completeInstallation(state,44,'code','https://test.invalid/callback')).rejects.toThrow('flow not found or expired');
    const fresh=await operations.beginInstallation(owners[2]!,{redirectUri:'beeline://github-installation'});
    expect(await operations.completeInstallation(new URL(fresh.url).searchParams.get('state')!,44,'code','https://test.invalid/callback'))
      .toBe('beeline://github-installation?installed=1');
  });
});
