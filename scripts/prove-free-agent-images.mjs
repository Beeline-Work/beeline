/** Isolated built-handler proof. A local relay lets Squire inject the upstream
 * key without exposing it to this process. No production objects are created. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { migrate } from '../apps/server/dist/database.js';
import { handleFreeAgentModelRequest, freeAgentAllowance } from '../apps/server/dist/free-agent-model-proxy.js';
import { tokenHash } from '../apps/server/dist/free-agents.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';

const database = new PgliteDatabase();
const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const token = 'bfm_disposable_image_proof';
let pending;
let complete;
let server;
try {
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Proof'),($2,'agent','Proof')`, [owner, agent]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Image proof')`, [workspace]);
  await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name,visibility) VALUES($1,$2,$3,'Proof','public')`, [room, workspace, owner]);
  await database.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys,model_token_hash,state)
    VALUES($1,$2,$3,'disposable',$4,'running')`, [agent, workspace, owner, tokenHash(token)]);
  await database.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
    root_command_id,root_source_message_id,agent_depth,state,claimed_at,lease_expires_at)
    VALUES('proof',$1,$2,'proof','input','human_tag','proof','proof',0,'claimed',now(),now()+interval '5 minutes')`, [room, agent]);
  server = createServer(async (request, response) => {
    if (request.url === '/proof/upstream') {
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(pending ?? null));
      } else {
        let body = '';
        for await (const chunk of request) body += chunk;
        complete(JSON.parse(body));
        response.end('accepted');
      }
      return;
    }
    await handleFreeAgentModelRequest(request, response, request.url, {
      database,
      config: { model: 'unused', dailyTokenCap: 3_000_000, firstDayTokenCap: 3_000_000, lifetimeTokenCap: 0 },
      upstreamKey: 'vault-relay-only',
      fetchImpl: async (_url, init) => {
        pending = JSON.parse(init.body);
        const result = await new Promise(resolve => { complete = resolve; });
        pending = undefined;
        return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
      },
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({ relay: origin + '/proof/upstream' }));
  for (const model of ['deepseek/deepseek-v4.1-flash-1017', 'openai/gpt-6-luna']) {
    await database.query('UPDATE free_agents SET model=$1 WHERE agent_id=$2', [model, agent]);
    const before = (await freeAgentAllowance(database, owner, new Date())).today;
    const response = await fetch(origin + '/v1/free-agents/model/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: [
        { type: 'text', text: 'What is in this picture? Answer in one sentence.' },
        { type: 'image_url', image_url: { url: 'https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg' } },
      ] }], max_tokens: 1024, reasoning: { effort: 'minimal' } }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    const answer = result.choices?.[0]?.message?.content;
    assert.match(answer ?? '', /cat/i);
    const charged = (await freeAgentAllowance(database, owner, new Date())).today - before;
    const usage = result.usage;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    assert.equal(charged, usage.prompt_tokens - cached + Math.ceil(cached * 0.25) + usage.completion_tokens);
    console.log(JSON.stringify({ reproduction: 'free-agent-images-1', model, answer, usage, charged, result: 'PASS' }));
  }
} finally {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await database.close();
}
