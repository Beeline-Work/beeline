/** Isolated native proof: real phone request, NOTIFY, helper socket and Cursor reader.
 * Only the test identities and local database are written. No production sign-in.
 */
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/src/database.ts';
import { PhoneService } from '../apps/server/src/phone-service.ts';
import { DaemonService } from '../apps/server/src/daemon-service.ts';
import { LiveHub } from '../apps/server/src/live.ts';
import { PostgresLiveListener, POSTGRES_LIVE_CHANNEL } from '../apps/server/src/postgres-live.ts';
import { createBeelineServer } from '../apps/server/src/server.ts';
import { DaemonApiClient } from '../apps/body/src/daemon-api-client.ts';
import { createUsageRefresh } from '../apps/body/src/agent-usage-refresh.ts';
const AGENT = 'c'.repeat(64), OWNER = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const database = new PgliteDatabase();
await migrate(database);
await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES ($1,'human','Owner','owner'),($2,'agent','Nerd','nerd')`, [OWNER, AGENT]);
await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Usage proof')`, [WORKSPACE]);
await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [ROOM, WORKSPACE]);
await database.query(`INSERT INTO agents(agent_id,owner_id,harness) VALUES($1,$2,'cursor')`, [AGENT, OWNER]);
for (const [id,role] of [[OWNER,'owner'],[AGENT,'member']])
  for (const room of [null,ROOM]) await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,[WORKSPACE,room,id,role]);
await mkdir('.scratch/usage-refresh', { recursive: true });
const baseline = JSON.parse(await readFile(process.env.USAGE_PROOF_SNAPSHOT ?? 'apps/mobile/scripts/agent-usage-cursor.json','utf8'));
await database.query(`UPDATE agents SET usage_snapshot=$2::jsonb WHERE agent_id=$1`, [AGENT, JSON.stringify(baseline)]);
const live = new LiveHub();
class ListenClient extends EventEmitter {
  async connect() {}
  async query() { this.release = await database.client.listen(POSTGRES_LIVE_CHANNEL,payload=>this.emit('notification',{channel:POSTGRES_LIVE_CHANNEL,payload})); }
  async end() { await this.release?.(); }
}
const listener = new PostgresLiveListener(database, live, () => new ListenClient(), 10);
void listener.run();
const phone = new PhoneService(database,'http://local.test',undefined,undefined,live);
const daemon = new DaemonService(database,live);
const server = createBeelineServer({ database, live, phone, daemon,
  auth: { authenticateDaemon: async () => AGENT, authenticatePhone: async () => null }, mediaMaximumBytes: 1 });
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const api = new DaemonApiClient(baseUrl, `bdt_${'y'.repeat(43)}`, AGENT, fetch, (url,protocols)=>new WebSocket(url,protocols));
const refresh = createUsageRefresh({api,agentId:AGENT,kind:'cursor',env:process.env});
let finishRefresh, failRefresh, requests=0, helperFrames=0;
api.setUsageRefreshListener(()=>{
  helperFrames++;
  void refresh().then(()=>finishRefresh?.(),reason=>failRefresh?.(reason));
});
await new Promise((resolve,reject)=>{
  const timeout = setTimeout(()=>reject(new Error('helper subscription timeout')),10000);
  api.liveSubscribe(ROOM,undefined,()=>undefined, connected=>{
    if(connected){clearTimeout(timeout);resolve();}
  });
});
const app = createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  try {
    if(req.url==='/refresh'){
      requests++;
      const before = (await phone.readAgent(WORKSPACE,AGENT,OWNER)).usage.updatedAt;
      const completed = new Promise((resolve,reject)=>{finishRefresh=resolve;failRefresh=reject;});
      await phone.execute('refreshAgentUsage',{workspaceId:WORKSPACE,agentId:AGENT},OWNER);
      await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('refresh timeout')),15000).unref())]);
      const usage=(await phone.readAgent(WORKSPACE,AGENT,OWNER)).usage;
      if(usage.updatedAt===before)throw new Error('timestamp did not change');
      await writeFile('.scratch/usage-refresh/live-proof.json',JSON.stringify({requests,helperFrames,before,after:usage.updatedAt,windows:usage.windows.map(w=>w.label)},null,2));
      console.log(JSON.stringify({requests,helperFrames,before,after:usage.updatedAt}));
      res.end(JSON.stringify(usage));return;
    }
    res.end(JSON.stringify((await phone.readAgent(WORKSPACE,AGENT,OWNER)).usage));
  } catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
});
await new Promise(resolve=>app.listen(8140,'127.0.0.1',resolve));
console.log('Usage proof ready on 8140');
const stop=async()=>{api.closeLive();await listener.stop();app.close();server.close();await database.close();process.exit(0);};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
