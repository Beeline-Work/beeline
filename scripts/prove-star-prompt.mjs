/** STAR-PROMPT-3: built local server, authenticated HTTP + live socket, isolated PostgreSQL engine. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const db = new PgliteDatabase(), live = new LiveHub();
const auth = new TokenAuth(db, async subject => ({ subject, login: subject, name: subject }));
const phone = new PhoneService(db, 'http://proof', undefined, undefined, live);
const server = createBeelineServer({ database: db, auth, phone, live,
  daemon: new DaemonService(db, live), mediaMaximumBytes: 1024 });
const sockets = [];
const hash = value => createHash('sha256').update(value).digest('hex');
try {
  await migrate(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const runtime of ['helper', 'free/hosted']) for (const path of ['atomic', 'transactional']) {
    const label = `${runtime}-${path}`, human = hash(`${label}-human`), agent = hash(`${label}-agent`);
    const workspace = randomUUID(), room = randomUUID(), daemonToken = `bdt_${hash(label)}`;
    await db.query(`INSERT INTO identities(id,kind,name,handle)
      VALUES($1,'human','Proof person',$3),($2,'agent','Proof agent',$4)`,
      [human, agent, `person${sockets.length}`, `agent${sockets.length}`]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Star prompt proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof Room')`, [room, workspace]);
    for (const member of [human, agent]) for (const place of [null, room])
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [workspace, place, member]);
    await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
      VALUES($1,$2,'presence','presence','{"status":"online"}')`, [room, agent]);
    if (runtime === 'free/hosted') await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys,state)
      VALUES($1,$2,$3,'fixture','running')`, [agent, workspace, human]);
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(daemonToken), agent]);
    await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
      VALUES('github',$1,$2,'https://github.com','beeline',$1)`, [label, human]);
    const phoneToken = (await auth.exchangeGitHubOidc(label)).accessToken;
    async function call(surface, op, input) {
      const response = await fetch(`${origin}/v1/${surface}/operations/${op}`, {
        method: 'POST', headers: { authorization: `Bearer ${surface === 'phone' ? phoneToken : daemonToken}`,
          'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      const body = await response.json();
      assert.equal(response.status, 200, `${op}: ${JSON.stringify(body)}`);
      return body;
    }
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`, [`bearer.${phoneToken}`]);
    sockets.push(socket);
    const frames = [];
    socket.on('message', raw => frames.push(JSON.parse(String(raw))));
    async function waitFor(predicate, description) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const frame = frames.find(predicate);
        if (frame) return frame;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw Error(`Timed out: ${description}; frames=${JSON.stringify(frames)}`);
    }
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'viewing', roomId: room, viewing: true }));
    socket.send(JSON.stringify({ type: 'subscribe', roomId: room }));
    await waitFor(frame => frame.type === 'subscribed', 'subscription');
    assert.deepEqual(await call('phone', 'readStarPrompt', {}), { prompt: null });
    for (let reply = 1; reply <= 3; reply++) {
      await call('phone', 'sendRoomMessage', { roomId: room, text: `@agent${sockets.length - 1} reply ${reply}` });
      const command = (await call('daemon', 'getAgentCommands', { roomId: room })).commands.at(-1);
      const context = { roomId: room, requestId: command.turnRequestId, generationId: `proof-${reply}` };
      await call('daemon', 'claimAgentCommand', { roomId: room, commandId: command.id, generationId: context.generationId });
      await call('daemon', 'postAgentTurnReceipt', { ...context, status: 'working' });
      // A human mention takes the ordinary transactional writer; plain prose takes the atomic CTE.
      const text = `${path === 'transactional' ? `@person${sockets.length - 1} ` : ''}Completed reply ${reply}`;
      const saved = await call('daemon', 'postRoomMessage', { ...context, text });
      const delta = await waitFor(frame => frame.type === 'message-delta' && frame.message?.id === saved.id, 'reply delta');
      const eligibility = await call('phone', 'readStarPrompt', {});
      assert.equal((await db.query(`SELECT replies FROM github_star_prompts WHERE identity_id=$1`, [human])).rows[0].replies, reply);
      assert.equal(eligibility.prompt?.milestone ?? null, reply === 3 ? 3 : null);
      assert.equal(delta.starPrompt?.milestone ?? null, reply === 3 ? 3 : null);
    }
    await call('phone', 'answerStarPrompt', { milestone: 3, action: 'dismiss' });
    assert.deepEqual(await call('phone', 'readStarPrompt', {}), { prompt: null });
    console.log(`STAR-PROMPT-3 PASS: ${label}: replies 1/2 hidden; reply 3 immediately visible in authenticated read AND live delta; close persists. No artifacts, reactions, clock advances or external services.`);
  }
} finally {
  for (const socket of sockets) socket.terminate();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await db.close();
}
