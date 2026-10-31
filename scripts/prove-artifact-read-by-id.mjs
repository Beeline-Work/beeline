// ARTIFACT-READ-BY-ID: isolated built server and agent read tool; no production data.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgliteDatabase, MemoryObjectStorage } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { ObjectService } from '../apps/server/dist/object-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { callAgentTool } from '../apps/body/dist/read-only-mcp.js';

const db = new PgliteDatabase(), storage = new MemoryObjectStorage();
const human = 'a'.repeat(64), agent = 'b'.repeat(64), outsider = 'c'.repeat(64);
const workspace = randomUUID(), room = randomUUID(), source = randomUUID(), sibling = randomUUID(), dm = randomUUID();
const token = 'bdt_isolated_artifact_proof';
const scratch = await mkdtemp(join(tmpdir(), 'artifact-read-proof-'));
let server;
try {
  await migrate(db);
  await storage.listen();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Reader','reader'),($3,'human','Other','other')`, [human,agent,outsider]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent,human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Attachment proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id,created_by,direct_participants) VALUES
    ($1,$4,'Parent',NULL,$5,NULL),($2,$4,'Source',$1,$5,NULL),($3,$4,'Reader',$1,$5,NULL),
    ($6,$4,'Private',NULL,$5,jsonb_build_array($5::text,$7::text))`, [room,source,sibling,workspace,human,dm,outsider]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'member'),($1,$4,$3,'member')`, [workspace,human,agent,room]);
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token),agent]);
  const live = new LiveHub(), daemon = new DaemonService(db,live);
  const objects = new ObjectService(db,storage.asStorage(),'http://proof');
  const bytes = Buffer.from('Sibling report opened by attachment id alone.');
  const files = [];
  for (const roomId of [source,dm]) {
    const file = await objects.uploadArtifact(agent,roomId === source ? bytes : Buffer.from('private report'),'text/plain','report.txt');
    files.push(file.url.split('/').at(-1));
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'Report',$4::jsonb)`,
      [randomBytes(32).toString('hex'),roomId,agent,JSON.stringify([{...file,name:'report.txt'}])]);
  }
  server = createBeelineServer({database:db,daemon,phone:new PhoneService(db,'http://proof'),live,objectService:objects,
    auth:new TokenAuth(db,async () => { throw new Error('unused'); }),mediaMaximumBytes:1024*1024});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  process.env.BEELINE_DAEMON_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.BEELINE_DAEMON_TOKEN = token;
  process.env.BEELINE_DAEMON_CORNER_ID = '';
  process.env.BEELINE_TURN_CONTEXT_FILE = '';
  process.env.BEELINE_ATTACH_SCRATCH_ROOT = scratch;
  for (const [place,roomId] of [['sibling',sibling],['parent',room]]) {
    process.env.BEELINE_DAEMON_ROOM_ID = roomId;
    const args = {facet:'attachment',attachmentId:files[0]};
    const result = JSON.parse(await callAgentTool('read',args,'artifact-proof'));
    assert.deepEqual(await readFile(result.path),bytes);
    console.log(JSON.stringify({reproduction:'ARTIFACT-READ-BY-ID',place,tool:'read',args,result,contents:bytes.toString()}));
    for (const attachmentId of [files[1],randomUUID()]) {
      await assert.rejects(callAgentTool('read',{facet:'attachment',attachmentId},'private-proof'),/no attachment with this id/);
    }
  }
  console.log('PASS: sibling and parent downloads match; private and missing ids both return not_found.');
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await storage.close();
  await db.close();
  await rm(scratch,{recursive:true,force:true});
}
