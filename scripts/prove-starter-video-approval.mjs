/** Isolated built-service proof of the phone preview approval boundary; no real upload. */
import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { PgliteDatabase, MemoryObjectStorage } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/dist/database.js';
import { FreeAgentService, freeAgentConfigFromEnv } from '../apps/server/dist/free-agents.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { StarterOnboardingService } from '../apps/server/dist/starter-onboarding-run.js';
import { postRoomChoice } from '../apps/server/dist/room-choice.js';
import { postStarterVideoPreview, consumeStarterVideoPost } from '../apps/server/dist/starter-onboarding.js';
import { ObjectService } from '../apps/server/dist/object-service.js';
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
  const args={title,description,categoryId:'22',privacyStatus:'unlisted',videoFile:{beelineObjectId:clip.objectId}};
  let uploads = 0;
  const upload = async args => {
    await db.transaction(tx=>consumeStarterVideoPost(tx,workspace.roomId,beebee,args));
    uploads++;
  };
  const unrelated = await postRoomChoice(db, {roomId:workspace.roomId,agentId:beebee,mode:'question',prompt:'Post a draft message to this Room?',options:[{label:'Post',consequence:'Post'},{label:'Cancel',consequence:'Cancel'}]});
  await phone.execute('answerChoice',{choiceId:unrelated.choiceId,optionId:'A'},owner);
  await assert.rejects(upload(args),/tap Post/);
  assert.equal(uploads,0);
  const preview = await db.transaction(tx => postStarterVideoPreview(tx, objects, {roomId:workspace.roomId,agentId:beebee,videoObjectId:clip.objectId,frameObjectId:frame.objectId,title,description,visibility:'unlisted'}));
  await assert.rejects(upload(args),/tap Post/);
  await phone.execute('answerChoice',{choiceId:preview.choiceId,optionId:'A'},owner);
  for (const change of [{title:'changed'},{description:'changed'},{privacyStatus:'public'},{videoFile:{beelineObjectId:frame.objectId}},{unexpected:true}]) {
    await assert.rejects(upload({...args,...change}),/match the approved video preview/);
  }
  assert.equal(uploads,0);
  await upload(args);
  assert.equal(uploads,1);
  await assert.rejects(upload(args),/tap Post/);
  console.log('R-STARTER-VIDEO-APPROVAL PASS: unrelated Post refused; changed clip/title/description/visibility refused; exact preview and phone Post accepted once. Provider stub calls (1); real uploads (0).');
} finally {await db.close();}
