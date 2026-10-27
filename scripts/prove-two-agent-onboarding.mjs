import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/dist/database.js';
import { FreeAgentService } from '../apps/server/dist/free-agents.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { ObjectService } from '../apps/server/dist/object-service.js';
import { dashboardPeriods } from '../apps/server/dist/operator-dashboard-periods.js';
import { recordSigninFunnelEvent, recordOnboardingEvent } from '../apps/server/dist/signin-funnel.js';
const output = process.env.ONBOARDING_PROOF_OUTPUT ?? '/tmp/beeline-two-agent-proof';
await mkdir(output, { recursive: true });
const db = new PgliteDatabase();
try {
  await migrate(db);
  const owner = 'a'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Maya','maya')`, [owner]);
  const event = { event: 'signed_in', provider: 'google', installId: randomUUID(), attemptId: randomUUID(), platform: 'android', version: '0.2.22', environment: 'production', timestamp: new Date().toISOString() };
  await recordSigninFunnelEvent(db, event, 'server', owner);
  await db.query(`INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,source,occurred_at) VALUES($1,$2,'signup','android','0.2.22','server',now())`, [event.installId, event.attemptId]);
  const bytes = new Map();
  const storage = { putObject: async (key, data) => { bytes.set(key, Buffer.from(data)); } };
  const objects = new ObjectService(db, storage, 'http://127.0.0.1:8127');
  const machines = { create: async () => { throw new Error('No Machine should start during onboarding choices'); } };
  const free = new FreeAgentService(db, {
    model: 'deepseek/deepseek-v4.1-flash-1017', lunaModel: 'openai/gpt-6-luna', idleSeconds: 60, maxPerOwner: 3,
    dailyTokenCap: 3e6, firstDayTokenCap: 10e6, lifetimeTokenCap: 0, sealSecret: 'isolated-proof',
    publicOrigin: 'http://127.0.0.1:8127', image: 'proof', region: 'iad', cpus: 1, memoryMb: 2048,
    reapIdleMs: 300000, deleteAfterMs: 30*86400000,
  }, machines, async () => { throw new Error('No daemon exchange expected'); });
  const phone = new PhoneService(db, 'http://127.0.0.1:8127', undefined, undefined, undefined, false, db, objects);
  phone.setFreeAgents(free);
  const workspace = await phone.execute('createWorkspace', { name: 'Maya’s team' }, owner);
  const read = () => phone.readRoom(workspace.roomId, owner);
  const snapshot = async name => { const value = await read(); await writeFile(`${output}/${name}.json`, JSON.stringify(value, null, 2)); return value; };
  const welcome = await snapshot('welcome');
  const card = welcome.messages.find(m => m.choice)?.choice;
  assert.deepEqual(card.options.map(o => o.optionId), ['A','B','C','D']);
  await recordOnboardingEvent(db, owner, 'welcome_shown');
  await phone.execute('sendRoomMessage', { roomId: workspace.roomId, text: 'I have a question before choosing.' }, owner);
  await phone.execute('answerChoice', { choiceId: card.choiceId, optionId: 'D' }, owner);
  const beforeAnswer = await dashboardPeriods(db, new Date().toISOString());
  assert.equal(beforeAnswer['24h'].onboardingFunnel.steps.find(step => step.key === 'answered_after_pick').count, 0);
  await phone.execute('sendRoomMessage', { roomId: workspace.roomId, text: 'Here is my answer after choosing.' }, owner);
  const afterAnswer = await dashboardPeriods(db, new Date().toISOString());
  assert.equal(afterAnswer['24h'].onboardingFunnel.steps.find(step => step.key === 'answered_after_pick').count, 1,
    'ONBOARDING-ANSWER-1: a message before the pick must not block the first answer after it');
  const messageCommands = (await db.query(`SELECT 1 FROM agent_commands`)).rowCount;
  const explained = await snapshot('explanation');
  const explanation = explained.messages.find(m => m.text.startsWith('Most AI apps')).text;
  assert(explanation.includes('**Big jobs get their own corner.**'));
  assert(!explanation.includes('side thread'));
  const second = explained.messages.find(m => m.choice?.status === 'open').choice;
  await phone.execute('answerChoice', { choiceId: second.choiceId, optionId: 'B' }, owner);
  const played = await snapshot('game');
  const attachment = played.messages.flatMap(m => m.attachments ?? []).find(a => a.mimeType === 'application/vnd.beeline.game+html');
  assert(attachment, 'Luna posts an interactive attachment');
  const game = [...bytes.values()][0].toString();
  assert.equal((game.match(/class="cell"/g) ?? []).length, 9);
  assert(game.includes('data:image/png;base64,'));
  assert(!/__GAME_DATA__|__ALLY_FACE__|https?:\/\//.test(game));
  assert(!game.includes('Invite a friend'));
  await writeFile(`${output}/game.html`, game);
  const gameData = JSON.parse(game.match(/id="beeline-game-data" type="application\/json">(.*?)<\/script>/s)[1]);
  const faces = Object.fromEntries(played.messages.filter(m => m.author.kind === 'agent').map(m => [m.author.pubkey, (m.author.name === gameData.rival.name ? gameData.rival : gameData.ally).face]));
  await writeFile(`${output}/faces.json`, JSON.stringify(faces));
  const next = played.messages.find(m => m.choice?.status === 'open').choice;
  assert.equal(next.prompt, 'After your game, what next?');
  const invite = await phone.execute('answerChoice', { choiceId: next.choiceId, optionId: 'A' }, owner);
  assert(!('share' in invite));
  const invited = await snapshot('invite');
  const printed = invited.messages.find(message => message.text.startsWith("Here's your invite link."));
  assert.equal(printed.author.name, 'Beebee');
  assert(printed.text.includes('/join/'));
  assert(card.options.every(option => !option.consequence || option.consequence === option.label));
  assert.equal(card.options[3].label, 'Tell me what makes Beeline different');
  assert.equal((await db.query(`SELECT 1 FROM agent_commands`)).rowCount, messageCommands);
  const periods = await dashboardPeriods(db, new Date().toISOString());
  const funnel = periods['24h'].onboardingFunnel;
  assert.equal(funnel.cohort, 'welcome_shown_in_window');
  assert.equal(funnel.steps[0].count, 1);
  assert.equal(funnel.byOption.special.steps[1].count, 1);
  assert.equal(funnel.paths.game[0].count, 1);
  assert.equal(funnel.paths.invite[1].count, 1);
  await writeFile(`${output}/funnel.json`, JSON.stringify(funnel, null, 2));
  await snapshot('invite');
  console.log(`Demonstrated ONBOARDING-2: built PhoneService createWorkspace → D → B → next-card invite; two teammates, static game faces/board, no model turns, printed invite link, funnel split. Output: ${output}`);
} finally { await db.close(); }
