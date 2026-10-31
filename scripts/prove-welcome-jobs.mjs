/** Built-service proof: isolated database and storage; no real signup, film generation or upload. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { PgliteDatabase, MemoryObjectStorage } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/dist/database.js';
import { FreeAgentService, freeAgentConfigFromEnv } from '../apps/server/dist/free-agents.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { StarterOnboardingService } from '../apps/server/dist/starter-onboarding-run.js';
import { getWorkflowRun, handoff, assignWorkflowRole } from '../apps/server/dist/workflow-runs.js';
import { backfillWelcomeVideoWorkflow } from '../apps/server/dist/welcome-video-workflow.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
import { ObjectService } from '../apps/server/dist/object-service.js';
import { consumeStarterVideoPost, postStarterVideoPreview } from '../apps/server/dist/starter-onboarding.js';

const output = process.env.WELCOME_PROOF_OUTPUT ?? '/tmp/beeline-welcome-jobs';
await mkdir(output, { recursive: true });
const db = new PgliteDatabase();
try {
  await migrate(db);
  const owner = 'a'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Maya Chen','maya')`, [owner]);
  const storage = new MemoryObjectStorage();
  const objects = new ObjectService(db, storage.asStorage(), 'http://127.0.0.1:8127');
  const phone = new PhoneService(db, 'http://127.0.0.1', undefined, undefined, undefined, false, db, objects);
  const config = { ...freeAgentConfigFromEnv({ BEELINE_FREE_AGENT_SEAL_KEY: 'isolated-proof', FLY_FREE_AGENT_IMAGE: 'proof' }, 'http://127.0.0.1'), maxPerOwner: 20 };
  phone.setFreeAgents(new FreeAgentService(db, config,
    { create: async () => { throw new Error('No Fly calls in proof'); } },
    async () => { throw new Error('No real exchange in proof'); }));
  const create = async name => {
    const workspace = await phone.execute('createWorkspace', { name }, owner);
    assert.equal((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card->>'workflowSlug'='welcome-video'`, [workspace.roomId])).rowCount, 0);
    await new StarterOnboardingService(db).enter(workspace.roomId, owner);
    const view = await phone.readRoom(workspace.roomId, owner);
    return { ...workspace, view, choice: view.messages.find(message => message.choice)?.choice };
  };
  const video = await create('Welcome video');
  assert.deepEqual(video.choice.options.map(option => [option.label, option.consequence]), [
    ['Make a welcome video and post it to my YouTube', 'Beebee makes it, Luna checks it, you approve the post'],
    ['Play tic-tac-toe with me', 'You and Beebee against Luna'],
    ['Something else', 'Tell us the job in your own words'],
  ]);
  await writeFile(`${output}/welcome.json`, JSON.stringify(video.view, null, 2));
  await phone.execute('answerChoice', { choiceId: video.choice.choiceId, optionId: 'A' }, owner);
  await assert.rejects(phone.execute('answerChoice', { choiceId: video.choice.choiceId, optionId: 'A' }, owner), /already decided/);
  const runs = (await db.query(`SELECT id FROM messages WHERE room_id=$1 AND card->>'workflowSlug'='welcome-video' AND card->>'seq'='0'`, [video.roomId])).rows;
  assert.equal(runs.length, 1);
  const runId = runs[0].id;
  const team = (await db.query(`SELECT agent_id,starter_role FROM free_agents WHERE workspace_id=$1`, [video.id])).rows;
  const beebee = team.find(agent => agent.starter_role === 'beebee').agent_id;
  const luna = team.find(agent => agent.starter_role === 'luna').agent_id;
  const command = async agentId => {
    const source = randomBytes(32).toString('hex');
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Continue the isolated workflow proof')`, [source, video.roomId, owner]);
    return createAgentCommand(db, { roomId: video.roomId, agentId, sourceMessageId: source, reason: 'test' });
  };
  const advance = async (outcome, contents) => {
    const run = await getWorkflowRun(db, video.roomId, runId);
    return handoff(db, await command(run.boundAgentId), { runId, outcome, contents, attempt: run.attempt });
  };
  assert.equal((await getWorkflowRun(db, video.roomId, runId)).boundAgentId, beebee);
  await advance('ready', { facts: ['Person supplied facts'], evidence_urls: [] });
  await advance('ready', { script: 'Fixture only', shots: [] });
  assert.equal((await getWorkflowRun(db, video.roomId, runId)).boundAgentId, beebee);
  await advance('saved', { vault_reference: 'fixture only', minutes: 0 });
  await advance('saved', { vault_reference: 'fixture only', minutes: 0 });
  assert.equal((await getWorkflowRun(db, video.roomId, runId)).boundAgentId, luna);
  await assert.rejects(assignWorkflowRole(db, await command(beebee), { runId, role: 'checker', targetAgentId: beebee }), /must not be/);
  // A blocked checker must never fall back to its own film's maker.
  await advance('blocked', { reason: 'Independent checker unavailable in fixture' });
  assert.equal((await getWorkflowRun(db, video.roomId, runId)).state, 'stuck');

  const game = await create('Tic-tac-toe');
  await phone.execute('answerChoice', { choiceId: game.choice.choiceId, optionId: 'B' }, owner);
  const gameView = await phone.readRoom(game.roomId, owner);
  const posted = gameView.messages.find(message => message.text.startsWith('Game on.'));
  assert.equal(posted.author.name, 'Luna');
  const blob = [...storage.blobs.values()].find(blob => blob.type === 'application/vnd.beeline.game+html');
  const html = blob.bytes.toString();
  assert(!/__USER_FACE__|__ALLY_FACE__|__RIVAL_FACE__|__GAME_DATA__/.test(html));
  assert.equal((html.match(/src="data:image\/png;base64,/g) ?? []).length, 4);
  await writeFile(`${output}/game.html`, html);
  await writeFile(`${output}/game-room.json`, JSON.stringify(gameView, null, 2));
  assert.equal((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card->>'workflowSlug'='welcome-video'`, [game.roomId])).rowCount, 0);

  const other = await create('Something else');
  await phone.execute('answerChoice', { choiceId: other.choice.choiceId, optionId: 'C' }, owner);
  assert.equal((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card->>'workflowSlug'='welcome-video'`, [other.roomId])).rowCount, 0);
  const before = (await db.query(`SELECT count(*) n FROM workspace_skills WHERE slug='welcome-video'`)).rows[0].n;
  await db.query(`DELETE FROM workspace_skills WHERE workspace_id=$1 AND slug='welcome-video'`, [game.id]);
  await backfillWelcomeVideoWorkflow(db);
  await backfillWelcomeVideoWorkflow(db);
  assert.equal((await db.query(`SELECT count(*) n FROM workspace_skills WHERE slug='welcome-video'`)).rows[0].n, before);

  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card) VALUES($1,$2,$3,'Later non-video choice', '{"starterOnboarding":"welcome","starterVersion":2,"selectedOptionId":"C"}'::jsonb)`,
    [randomBytes(32).toString('hex'), video.roomId, beebee]);

  // A fallback maker is held to exactly the same Post approval boundary.
  const clip = await objects.uploadArtifact(owner, Buffer.from('fixture video'), 'video/mp4', 'fixture.mp4');
  const frame = await objects.uploadArtifact(owner, Buffer.from('fixture frame'), 'image/png', 'fixture.png');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'Fixture media',$4::jsonb)`,
    [randomBytes(32).toString('hex'), video.roomId, owner, JSON.stringify([clip, frame].map(file => ({ url: file.url, name: file.title, mimeType: file.mimeType, size: file.size })))]);
  const args = { title: 'Welcome Maya', description: 'Fixture', privacyStatus: 'unlisted', videoFile: { beelineObjectId: clip.objectId } };
  await assert.rejects(db.transaction(tx => consumeStarterVideoPost(tx, video.roomId, luna, args)), /tap Post/);
  const preview = await db.transaction(tx => postStarterVideoPreview(tx, objects, { roomId: video.roomId, agentId: luna,
    videoObjectId: clip.objectId, frameObjectId: frame.objectId, title: args.title, description: args.description, visibility: 'unlisted' }));
  await assert.rejects(db.transaction(tx => consumeStarterVideoPost(tx, video.roomId, luna, args)), /tap Post/);
  await phone.execute('answerChoice', { choiceId: preview.choiceId, optionId: 'A' }, owner);
  await assert.rejects(db.transaction(tx => consumeStarterVideoPost(tx, video.roomId, luna, { ...args, title: 'Changed' })), /match the approved/);
  assert(await db.transaction(tx => consumeStarterVideoPost(tx, video.roomId, luna, args)));
  await assert.rejects(db.transaction(tx => consumeStarterVideoPost(tx, video.roomId, luna, args)), /tap Post/);
  console.log(`WELCOME-JOBS PASS: built phone paths A/B/C, exactly one run, sleeping starter dispatch, independent checker exhaustion, inline-face game, idempotent backfill and fallback-maker Post guard. Artifacts: ${output}. Film/provider results are fixtures, not real generation or upload.`);
} finally { await db.close(); }
