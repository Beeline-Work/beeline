/** Real unlisted acceptance upload through the built Room preview gate and multipart provider boundary. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { strict as assert } from 'node:assert';
import { PgliteDatabase, MemoryObjectStorage } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/dist/database.js';
import { FreeAgentService, freeAgentConfigFromEnv } from '../apps/server/dist/free-agents.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { StarterOnboardingService } from '../apps/server/dist/starter-onboarding-run.js';
import { postStarterVideoPreview, consumeStarterVideoPost } from '../apps/server/dist/starter-onboarding.js';
import { ObjectService } from '../apps/server/dist/object-service.js';
import { ComposioApps, resolveAppFiles } from '../apps/server/dist/composio-apps.js';
if (process.env.ONBOARDING_REAL_UPLOAD !== '1') throw new Error('Set ONBOARDING_REAL_UPLOAD=1 only for an explicitly authorized unlisted upload test.');
const out = process.env.ONBOARDING_UPLOAD_OUTPUT ?? '/tmp/jellybean-youtube-acceptance';
await mkdir(out, { recursive: true });
let sequence = 0;
const transport = async (url, init) => {
  if (new URL(String(url)).hostname !== 'backend.composio.dev') return fetch(url, init);
  const id = ++sequence;
  await writeFile(`${out}/request-${id}.json`, JSON.stringify({ url: String(url), method: init.method, body: init.body }));
  await writeFile(`${out}/pending.json`, JSON.stringify({ id }));
  for (;;) {
    try {
      const reply = JSON.parse(await readFile(`${out}/response-${id}.json`, 'utf8'));
      return Response.json(reply.body, { status: reply.status });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(100);
  }
};
const db = new PgliteDatabase();
try {
  await migrate(db);
  const owner = '34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334';
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Charles','acceptance-owner')`, [owner]);
  const storage = new MemoryObjectStorage();
  const objects = new ObjectService(db, storage.asStorage(), 'http://127.0.0.1:8127');
  const phone = new PhoneService(db, 'http://127.0.0.1:8127', undefined, undefined, undefined, false, db, objects);
  const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENT_SEAL_KEY: 'isolated-acceptance', FLY_FREE_AGENT_IMAGE: 'proof' }, 'http://127.0.0.1');
  phone.setFreeAgents(new FreeAgentService(db, config, { create: async () => { throw new Error('No Fly call'); } }, async () => { throw new Error('No exchange'); }));
  const workspace = await phone.execute('createWorkspace', { name: 'Unlisted acceptance' }, owner);
  await new StarterOnboardingService(db).enter(workspace.roomId, owner);
  const view = await phone.readRoom(workspace.roomId, owner);
  const welcome = view.messages.find(message => message.choice).choice;
  await phone.execute('answerChoice', { choiceId: welcome.choiceId, optionId: 'B' }, owner);
  const beebee = welcome.agent.pubkey;
  const clipBytes = await readFile('docs/evidence/starter-onboarding/test-clip.mp4');
  const frameBytes = await readFile('docs/evidence/starter-onboarding/test-frame.jpg');
  const clip = await objects.uploadArtifact(owner, clipBytes, 'video/mp4', 'onboarding-test.mp4');
  const frame = await objects.uploadArtifact(owner, frameBytes, 'image/jpeg', 'onboarding-test-frame.jpg');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'Acceptance clip and extracted frame',$4::jsonb)`, ['f'.repeat(64),workspace.roomId,owner,JSON.stringify([clip,frame].map(file=>({url:file.url,name:file.title,mimeType:file.mimeType,size:file.size}))) ]);
  const title = 'Beeline onboarding acceptance — temporary unlisted test';
  const description = 'Temporary unlisted multipart acceptance clip. Deleted after file-size and processing verification.';
  const preview = await db.transaction(tx => postStarterVideoPreview(tx, objects, {roomId:workspace.roomId,agentId:beebee,videoObjectId:clip.objectId,frameObjectId:frame.objectId,title,description,visibility:'unlisted'}));
  const snapshot = await phone.readRoom(workspace.roomId,owner);
  await writeFile(`${out}/preview.json`,JSON.stringify(snapshot,null,2));
  await mkdir(`/tmp/beeline-two-agent-proof/v1/media`,{recursive:true});
  await writeFile(`/tmp/beeline-two-agent-proof/v1/media/${frame.objectId}`,frameBytes);
  await writeFile(`/tmp/beeline-two-agent-proof/youtube-preview.json`,JSON.stringify(snapshot,null,2));
  const args={title,description,categoryId:'22',privacyStatus:'unlisted',videoFile:{beelineObjectId:clip.objectId}};
  await assert.rejects(db.transaction(tx=>consumeStarterVideoPost(tx,workspace.roomId,beebee,args)),/tap Post/);
  await phone.execute('answerChoice',{choiceId:preview.choiceId,optionId:'A'},owner);
  await db.transaction(tx=>consumeStarterVideoPost(tx,workspace.roomId,beebee,args));
  const files=await resolveAppFiles(args,id=>objects.readRoomObject(workspace.roomId,beebee,id));
  const provider=new ComposioApps('sealed-controller-injects-key',transport);
  const uploaded=await provider.execute({accountId:'ca_7GLSGlRRwrWU',userId:owner,toolkit:'youtube',tool:'YOUTUBE_MULTIPART_UPLOAD_VIDEO',arguments:args,files});
  await writeFile(`${out}/uploaded.json`,JSON.stringify({expectedBytes:clipBytes.length,uploaded},null,2));
  console.log(`Uploaded acceptance response saved; expected bytes (${clipBytes.length}). Verify processing/size and delete using the connected channel.`);
} finally {await db.close();}
