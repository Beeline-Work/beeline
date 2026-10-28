/** Built service stand-in for staging: no Fly Machines, provider account or public upload is used. */
import { strict as assert } from 'node:assert';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { PgliteDatabase, MemoryObjectStorage } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/dist/database.js';
import { FreeAgentService, freeAgentConfigFromEnv } from '../apps/server/dist/free-agents.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { StarterOnboardingService } from '../apps/server/dist/starter-onboarding-run.js';
import { consumeStarterVideoPost, postStarterVideoPreview } from '../apps/server/dist/starter-onboarding.js';
import { ObjectService } from '../apps/server/dist/object-service.js';

const output = process.env.ONBOARDING_PROOF_OUTPUT ?? '/tmp/beeline-two-agent-proof';
await mkdir(output, { recursive: true });
const db = new PgliteDatabase();
try {
  await migrate(db);
  const owner = 'a'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Maya Chen','maya')`, [owner]);
  const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENT_SEAL_KEY: 'isolated-proof', FLY_FREE_AGENT_IMAGE: 'proof' }, 'http://127.0.0.1');
  const free = new FreeAgentService(db, config, { create: async () => { throw new Error('No Fly calls allowed'); } }, async () => { throw new Error('No exchange allowed'); });
  const models = [];
  const lines = ['@luna Maya arrived. I hope my coffee can keep up.', '@beebee I hope Maya brings a video for their YouTube.', 'Maya is reading now. I should look busy.'];
  const onboarding = new StarterOnboardingService(db, { database: db, config, upstreamKey: 'fixture-only',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      models.push(body.model);
      return new Response(JSON.stringify({ choices: [{ message: { content: lines[(models.length - 1) % 3] } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
    } });
  const phone = new PhoneService(db, 'http://127.0.0.1');
  phone.setFreeAgents(free);
  phone.setStarterOnboarding(onboarding);
  const workspace = await phone.execute('createWorkspace', { name: 'Maya’s team', timeZone: 'America/New_York' }, owner);
  await phone.readRoom(workspace.roomId, owner);
  await db.backgroundWork.drain();
  const snapshot = async name => {
    const view = await phone.readRoom(workspace.roomId, owner);
    await writeFile(`${output}/${name}.json`, JSON.stringify(view, null, 2));
    return view;
  };
  const welcome = await snapshot('welcome');
  const card = welcome.messages.find(message => message.choice)?.choice;
  assert.deepEqual(models, [config.model, config.lunaModel, config.model]);
  assert.deepEqual(welcome.messages.filter(message => lines.includes(message.text)).map(message => message.author.name), ['Beebee', 'Luna', 'Beebee']);
  assert(welcome.messages.some(message => message.text.startsWith("Hi Maya, I'm Beebee and that's Luna.")));
  assert.deepEqual(card.options.map(option => option.label), ['Write code in your repo', 'Post a video to your YouTube', 'Something else']);
  assert(!welcome.messages.some(message => message.attachments?.length));
  await phone.execute('answerChoice', { choiceId: card.choiceId, optionId: 'A' }, owner);
  assert((await snapshot('repo')).messages.some(message => message.onboarding?.kind === 'repository'));
  const beebee = (await db.query(`SELECT agent_id FROM free_agents WHERE workspace_id=$1 AND starter_role='beebee'`, [workspace.id])).rows[0].agent_id;
  const rerun = async () => {
    await db.transaction(tx => onboarding.queueRerun(tx, workspace.roomId, owner, beebee));
    await onboarding.prepare(workspace.roomId);
    return onboarding.enter(workspace.roomId, owner);
  };
  const youtube = await rerun();
  await phone.execute('answerChoice', { choiceId: youtube.choiceId, optionId: 'B' }, owner);
  await assert.rejects(db.transaction(tx => consumeStarterVideoPost(tx, workspace.roomId, beebee)), /tap Post/);
  const objects = new ObjectService(db, new MemoryObjectStorage().asStorage(), 'http://127.0.0.1:8127');
  const clipBytes = await readFile('docs/evidence/starter-onboarding/test-clip.mp4');
  const frameBytes = await readFile('docs/evidence/starter-onboarding/test-frame.jpg');
  const clip = await objects.uploadArtifact(owner, clipBytes, 'video/mp4', 'test-clip.mp4');
  const frame = await objects.uploadArtifact(owner, frameBytes, 'image/jpeg', 'test-frame.jpg');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'clip and frame',$4::jsonb)`,
    ['f'.repeat(64), workspace.roomId, owner, JSON.stringify([clip,frame].map(file => ({url:file.url,name:file.title,mimeType:file.mimeType,size:file.size})))]);
  const preview = await db.transaction(tx => postStarterVideoPreview(tx, objects, {roomId:workspace.roomId, agentId:beebee,
    videoObjectId:clip.objectId, frameObjectId:frame.objectId, title:'Beeline onboarding upload test',
    description:'A short clip to verify the upload flow.', visibility:'unlisted'}));
  await mkdir(`${output}/v1/media`, {recursive:true});
  await writeFile(`${output}/v1/media/${frame.objectId}`,frameBytes);
  await snapshot('youtube-preview');
  await phone.execute('answerChoice', { choiceId: preview.choiceId, optionId: 'A' }, owner);
  await db.transaction(tx => consumeStarterVideoPost(tx, workspace.roomId, beebee));
  await assert.rejects(db.transaction(tx => consumeStarterVideoPost(tx, workspace.roomId, beebee)), /tap Post/);
  const other = await rerun();
  const before = (await db.query(`SELECT 1 FROM agent_commands`)).rowCount;
  await phone.execute('answerChoice', { choiceId: other.choiceId, optionId: 'C' }, owner);
  assert.equal((await db.query(`SELECT 1 FROM agent_commands`)).rowCount, before);
  await phone.execute('sendRoomMessage', { roomId: workspace.roomId, text: 'Plan a picnic' }, owner);
  assert.equal((await db.query(`SELECT 1 FROM agent_commands`)).rowCount, before + 1);
  await snapshot('something-else');
  console.log(`STARTER-3 demonstrated: built workspace creation → model proxy/allowance (fixture replies) → timed Beebee/Luna/Beebee messages → fixed hello and jobs → repository card, YouTube preview/Post gate, and composer task routing. Snapshots: ${output}. Built-service sign-up evidence is accepted by brief revision 3; the separate live unlisted upload and deletion are recorded in the acceptance evidence.`);
} finally { await db.close(); }
