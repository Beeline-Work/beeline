/** Built onboarding/model-proxy proof. A tool controller supplies authenticated upstream replies through a file bridge. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { strict as assert } from 'node:assert';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/dist/database.js';
import { FreeAgentService, freeAgentConfigFromEnv } from '../apps/server/dist/free-agents.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { StarterOnboardingService, createStarterOnboardingRun } from '../apps/server/dist/starter-onboarding-run.js';

const output = process.env.BANTER_PROOF_OUTPUT ?? '/tmp/beeline-starter-banter-proof';
await mkdir(output, { recursive: true });
const db = new PgliteDatabase();
let sequence = 0;
const fetchImpl = async (_url, request) => {
  const id = ++sequence;
  await writeFile(`${output}/request-${id}.json`, request.body);
  await writeFile(`${output}/pending.json`, JSON.stringify({ id }));
  for (;;) {
    request.signal.throwIfAborted();
    try {
      const reply = JSON.parse(await readFile(`${output}/response-${id}.json`, 'utf8'));
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(100);
  }
};
try {
  await migrate(db);
  const owner = 'a'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','proof-person')`, [owner]);
  const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENT_SEAL_KEY: 'isolated-proof', FLY_FREE_AGENT_IMAGE: 'proof' }, 'http://127.0.0.1');
  const free = new FreeAgentService(db, config, { create: async () => { throw new Error('No Fly calls allowed'); } }, async () => { throw new Error('No daemon exchange allowed'); });
  const phone = new PhoneService(db, 'http://127.0.0.1');
  phone.setFreeAgents(free);
  const workspace = await phone.execute('createWorkspace', { name: 'Banter proof', timeZone: 'America/New_York' }, owner);
  await new StarterOnboardingService(db).enter(workspace.roomId, owner);
  const team = (await db.query(`SELECT agent_id,starter_role FROM free_agents WHERE workspace_id=$1`, [workspace.id])).rows;
  const beebeeId = team.find(agent => agent.starter_role === 'beebee').agent_id;
  const lunaId = team.find(agent => agent.starter_role === 'luna').agent_id;
  const service = new StarterOnboardingService(db, { database: db, config, upstreamKey: 'injected-by-tool-controller', fetchImpl });
  const samples = [];
  for (const name of process.env.BANTER_PROOF_NAMES?.split(',') ?? ['Alex', 'Maya', 'Sam', 'Jordan', 'Taylor', 'Priya', 'Kai', 'Robin', 'Noor', 'Charlie']) {
    await db.query(`UPDATE identities SET name=$2 WHERE id=$1`, [owner, name]);
    const runId = await createStarterOnboardingRun(db, { roomId: workspace.roomId, userId: owner, beebeeId, lunaId, timeZone: 'America/New_York' });
    await service.prepare(workspace.roomId);
    let run;
    for (;;) {
      run = (await db.query(`SELECT status,lines FROM starter_onboarding_runs WHERE id=$1`, [runId])).rows[0];
      if (run.status === 'ready') break;
      await delay(100);
    }
    const usage = (await db.query(`SELECT i.name,e.detail FROM free_agent_events e JOIN identities i ON i.id=e.agent_id WHERE e.kind='model_usage' ORDER BY e.id`)).rows;
    samples.push({ name, lines: run.lines, usage });
    await writeFile(`${output}/samples.json`, JSON.stringify(samples, null, 2));
    assert.equal(run.lines?.length, 3, `No complete banter for ${name}`);
    await db.query(`UPDATE starter_onboarding_runs SET status='complete' WHERE id=$1`, [runId]);
  }
  console.log(`${samples.length} real exchanges generated through the built starter service and shared model proxy: ${output}/samples.json`);
} finally { await db.close(); }
