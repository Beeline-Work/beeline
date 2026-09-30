import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { claimInstitutionalMemoryJob, completeInstitutionalMemoryJob,
  enqueueInstitutionalMemoryTurnReview } from './institutional-memory-shadow.js';
import { pgvectorLiteral } from './institutional-memory-embeddings.js';

const WORKSPACE = '10000000-0000-4000-8000-00000000a110';
const ROOM = '20000000-0000-4000-8000-00000000a110';
const HUMAN = 'a'.repeat(64);
const OTHER = 'c'.repeat(64);
const AGENT = 'b'.repeat(64);
const SOURCE = 'e'.repeat(64);
const MESSAGE = 'd'.repeat(64);
const OLD = '30000000-0000-4000-8000-00000000a110';
const EXPLICIT = '30000000-0000-4000-8000-00000000a111';
const config = { enabled: true, live: true, dailyJobLimit: 20, leaseMs: 60_000 } as const;
const vector = [1, ...new Array(1023).fill(0)];
let database: PgliteDatabase;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Human'),($2,'human','Other'),($3,'agent','Bee')`, [HUMAN, OTHER, AGENT]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Memory')`, [WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'host-1')`, [AGENT,HUMAN]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Shared')`, [ROOM,WORKSPACE]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
    ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member')`,
    [WORKSPACE,HUMAN,OTHER,AGENT,ROOM]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES
    ($1,$3,$4,'Daeun used to live in Tokyo.'),
    ($2,$3,$4,'Daeun moved from Tokyo to Seoul today.')`, [SOURCE,MESSAGE,ROOM,HUMAN]);
  await database.query(`INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live')`, [WORKSPACE]);
  await database.query(`INSERT INTO institutional_memory_items
    (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,audience_kind,
     confidence,version,embedding,explicit_save)
    VALUES($1,$2,'workspace_fact','daeun.city.tokyo','Daeun lives in Tokyo.',$3,$4,'workspace',0.9,1,$5::vector,false),
          ($6,$2,'workspace_fact','daeun.preference','Daeun likes ramen.',$3,$4,'workspace',0.9,1,$5::vector,true)`,
    [OLD,WORKSPACE,ROOM,SOURCE,pgvectorLiteral(vector),EXPLICIT]);
  await database.query(`INSERT INTO institutional_memory_item_sources(item_id,message_id) VALUES($1,$3),($2,$3)`,
    [OLD,EXPLICIT,SOURCE]);
  process.env.OPENROUTER_EMBEDDING_API_KEY = 'test-key';
  vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({data:[{embedding:vector,index:0}]}),
    {status:200,headers:{'content-type':'application/json'}})));
});
afterEach(async () => {
  delete process.env.OPENROUTER_EMBEDDING_API_KEY;
  vi.unstubAllGlobals();
  await database.close();
});

async function claim(version?: string) {
  await database.transaction(db => enqueueInstitutionalMemoryTurnReview(db,{
    roomId:ROOM,sourceMessageId:MESSAGE,requestId:'review-1',config,
  }));
  const job = await claimInstitutionalMemoryJob(database,AGENT,config,version);
  expect(job).toBeDefined();
  return job!;
}

async function complete(job: Awaited<ReturnType<typeof claim>>, proposal: unknown) {
  // The claim already exercised the network embedder. A background embed is
  // irrelevant here and would race pglite's single WASM connection.
  delete process.env.OPENROUTER_EMBEDDING_API_KEY;
  await completeInstitutionalMemoryJob(database,AGENT,{
    agentId:AGENT,jobId:job.id,leaseToken:job.leaseToken,
    proposal: proposal as never,
    usage:{inputBytes:100,outputBytes:100,model:'test',extractorVersion:'institutional-shadow-v2'},
  },config);
}

function proposal(action: 'supersede'|'retire', target: string, candidateType='correction_candidate') {
  return {
    proposalVersion:2,action,
    ...(action==='supersede' ? {
      candidateType,memoryKind:'workspace_fact',canonicalKey:'daeun.city.seoul',
      body:'Daeun lives in Seoul.',keywords:['daeun','seoul'],audience:'workspace',
      target:{itemId:target,baseVersion:1},
    } : {retire:[{itemId:target,baseVersion:1,reason:'obsolete'}]}),
    source:{roomId:ROOM,messageIds:[MESSAGE]},confidence:0.9,
    classification:{subjectIsRequester:false,rationale:'The turn explicitly changed the saved fact.'},
  };
}

it('offers nearest in-scope rows to a v2 worker and links a cross-key supersession while blanking the old text', async () => {
  await database.query(`UPDATE institutional_memory_items SET keywords=ARRAY['daeun'] WHERE id=$1`,[OLD]);
  const job=await claim('institutional-shadow-v2');
  expect(job.context?.alignment).toBe('nearest');
  expect(job.context?.offeredItemIds).toContain(OLD);
  expect(job.existingItems[0]?.distance).toBe(0);
  await complete(job,proposal('supersede',OLD));
  const old=(await database.query<{state:string;body:string;deleted_at:Date|null}>(
    `SELECT state,body,deleted_at FROM institutional_memory_items WHERE id=$1`,[OLD])).rows[0];
  expect(old).toMatchObject({state:'stale',body:''});
  expect(old?.deleted_at).not.toBeNull();
  const replacement=(await database.query<{canonical_key:string;supersedes_id:string;version:number;body:string}>(
    `SELECT canonical_key,supersedes_id,version,body FROM institutional_memory_items WHERE supersedes_id=$1`,[OLD])).rows[0];
  expect(replacement).toMatchObject({canonical_key:'daeun.city.seoul',supersedes_id:OLD,version:2,body:'Daeun lives in Seoul.'});
  console.log(`Memory correction: old body=${JSON.stringify(old?.body)}, new body=${JSON.stringify(replacement?.body)}, linked=${replacement?.supersedes_id===OLD}`);
});

it('keeps old workers on the recent payload and rejects an unoffered or stale target', async () => {
  const job=await claim();
  expect(job.context?.alignment).toBeUndefined();
  expect(job.existingItems).toHaveLength(2);
  await expect(complete(job,proposal('supersede','30000000-0000-4000-8000-00000000ffff')))
    .rejects.toThrow('CAS conflict');
  await database.query(`UPDATE institutional_memory_items SET version=2 WHERE id=$1`,[OLD]);
  await expect(complete(job,proposal('supersede',OLD))).rejects.toThrow('CAS conflict');
});

it('gives a v2 worker the recent payload when embedding is unavailable', async () => {
  delete process.env.OPENROUTER_EMBEDDING_API_KEY;
  const job=await claim('institutional-shadow-v2');
  expect(job.context?.alignment).toBe('recent');
  expect(job.existingItems).toHaveLength(2);
  expect(job.context?.offeredItemIds).toEqual(expect.arrayContaining([OLD,EXPLICIT]));
});

it('retires an ordinary item without replacement and protects an explicit save', async () => {
  const job=await claim('institutional-shadow-v2');
  await expect(complete(job,proposal('retire',EXPLICIT))).rejects.toThrow('CAS conflict');
  await complete(job,proposal('retire',OLD));
  expect((await database.query<{body:string;deleted_at:Date|null}>(
    `SELECT body,deleted_at FROM institutional_memory_items WHERE id=$1`,[OLD])).rows[0])
    .toMatchObject({body:''});
  expect((await database.query(`SELECT 1 FROM institutional_memory_items WHERE supersedes_id=$1`,[OLD])).rowCount).toBe(0);
});

it('replaces an explicit save only for a correction and carries its long-lived flag', async () => {
  const job=await claim('institutional-shadow-v2');
  await expect(complete(job,proposal('supersede',EXPLICIT,'fact_candidate'))).rejects.toThrow('CAS conflict');
  await complete(job,proposal('supersede',EXPLICIT));
  const row=(await database.query<{explicit_save:boolean}>(
    `SELECT explicit_save FROM institutional_memory_items WHERE supersedes_id=$1`,[EXPLICIT])).rows[0];
  expect(row?.explicit_save).toBe(true);
});

it('never offers another requester profile or another workspace fact', async () => {
  const profile='30000000-0000-4000-8000-00000000a112';
  const otherFact='30000000-0000-4000-8000-00000000a113';
  const otherWorkspace='10000000-0000-4000-8000-00000000a111';
  const otherRoom='20000000-0000-4000-8000-00000000a111';
  const otherMessage='f'.repeat(64);
  await database.query(`INSERT INTO institutional_memory_items
    (id,workspace_id,kind,subject_identity_id,canonical_key,body,source_room_id,source_message_id,
     audience_kind,confidence,version,embedding)
    VALUES($1,$2,'human_profile_fact',$3,'other.profile','Other person likes tea.',$4,$5,
      'human_profile',0.9,1,$6::vector)`,
    [profile,WORKSPACE,OTHER,ROOM,SOURCE,pgvectorLiteral(vector)]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other')`,[otherWorkspace]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other')`,[otherRoom,otherWorkspace]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Other source')`,
    [otherMessage,otherRoom,OTHER]);
  await database.query(`INSERT INTO institutional_memory_items
    (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,
     audience_kind,confidence,version,embedding)
    VALUES($1,$2,'workspace_fact','other.fact','Other workspace fact.',$3,$4,
      'workspace',0.9,1,$5::vector)`,
    [otherFact,otherWorkspace,otherRoom,otherMessage,pgvectorLiteral(vector)]);
  const job=await claim('institutional-shadow-v2');
  expect(job.context?.offeredItemIds).not.toContain(profile);
  expect(job.context?.offeredItemIds).not.toContain(otherFact);
  await database.query(`UPDATE institutional_memory_jobs
    SET context=jsonb_set(context,'{offeredItemIds}',(context->'offeredItemIds')||to_jsonb($2::text))
    WHERE id=$1`,[job.id,profile]);
  await expect(complete(job,proposal('retire',profile))).rejects.toThrow('CAS conflict');
});

it('excludes workspace facts from a direct-message review', async () => {
  const dm='20000000-0000-4000-8000-00000000a112';
  const dmMessage='1'.repeat(64);
  await database.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants)
    VALUES($1,$2,'DM',jsonb_build_array($3::text,$4::text))`,[dm,WORKSPACE,HUMAN,AGENT]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,$2,$3,'owner'),($1,$2,$4,'member')`,[WORKSPACE,dm,HUMAN,AGENT]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text)
    VALUES($1,$2,$3,'Daeun moved from Tokyo to Seoul today.')`,[dmMessage,dm,HUMAN]);
  await database.transaction(db => enqueueInstitutionalMemoryTurnReview(db,{
    roomId:dm,sourceMessageId:dmMessage,requestId:'dm-review',config,
  }));
  const job=await claimInstitutionalMemoryJob(database,AGENT,config,'institutional-shadow-v2');
  expect(job?.context?.offeredItemIds).not.toContain(OLD);
  expect(job?.context?.offeredItemIds).not.toContain(EXPLICIT);
});
