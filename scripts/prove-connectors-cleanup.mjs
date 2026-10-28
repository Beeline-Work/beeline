/** CONNECTORS-1: disposable owner-shaped database, built PhoneService and native UI fixture. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { migrate } from '../apps/server/dist/database.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { connectMcp } from '../apps/server/dist/rooms-mcp-connections.js';
import { cleanupUnfinishedAppSignIns } from '../apps/server/dist/unfinished-app-sign-ins.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
const db = new PgliteDatabase();
const owner = 'a'.repeat(64), workspace = '11111111-1111-4111-8111-111111111111';
await migrate(db);
await db.query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Fixture Owner','fixture-owner')", [owner]);
await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Fixture')", [workspace]);
await db.query("INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')", [workspace,owner]);
for (const [index,name] of ['Slack','Supabase','WhatsApp','Notion'].entries()) {
  await db.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,
    transport,route,composio_account_id,composio_link_expires_at,authorised_at)
    VALUES($1,$2,$3,$4,$5,'composio','composio',$6,now()-interval '1 day',
      CASE WHEN $7 THEN now()-interval '2 days' ELSE NULL END)`,
  [`99999999-9999-4999-8999-99999999999${index}`,workspace,owner,name.toLowerCase(),name,`account-${index}`,index===3]);
}
console.log('CONNECTORS-1 dry-run:', await cleanupUnfinishedAppSignIns(db));
assert.equal(await cleanupUnfinishedAppSignIns(db,true),3);
for (const [id,name] of [['grok-fixture','Grok Bot'],['muse-fixture','Meta Muse']]) {
  await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES($1,$2,$3::jsonb)`, [id,name,JSON.stringify(['https://example.invalid/callback'])]);
  await connectMcp(db,{client_id:id,identity_id:owner,scope:'rooms:read rooms:write'});
}
const provider = { accountStatus: async()=>({status:'failed',reason:'Token revoked'}) };
const phone = new PhoneService(db,'http://127.0.0.1',undefined,undefined,undefined,false,db,undefined,undefined,undefined,provider);
const read=()=>phone.execute('readWorkbench',{workspaceId:workspace},owner);
let view=await read();
assert.deepEqual(view.companies.rows.filter(row=>row.section==='attention').map(row=>row.name),['Notion']);
assert.deepEqual(view.companies.rows.filter(row=>row.section==='apps').map(row=>row.name),['Grok Bot','Meta Muse']);
console.log('CONNECTORS-1 PASS: abandoned apps absent; broken Notion preserved; Grok Bot and Meta Muse in Connected apps.');
if(process.argv.includes('--serve')) {
  const server=createServer(async(request,response)=>{
    response.setHeader('access-control-allow-origin','*');
    response.setHeader('access-control-allow-headers','content-type');
    response.setHeader('content-type','application/json');
    if(request.method==='OPTIONS'){response.end();return;}
    try {
      let body='';for await(const chunk of request)body+=chunk;
      const {operation,input}=body?JSON.parse(body):{operation:'readWorkbench'};
      if(operation==='disconnectAiClient')await phone.execute(operation,input,owner);
      response.end(JSON.stringify(await read()));
    }catch(error){response.statusCode=500;response.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise(resolve=>server.listen(18167,'0.0.0.0',resolve));
  console.log('Fixture listening on 18167; no production account access.');
  await new Promise(resolve=>process.once('SIGTERM',resolve));
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
await db.close();
