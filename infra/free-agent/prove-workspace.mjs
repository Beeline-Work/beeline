#!/usr/bin/env node
// Explicit local integration proof. Creates disposable Postgres and Pi-helper
// containers, a private server, and a deterministic model upstream. The real
// DeepSeek performance proof is separate; no external key is used here.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import pg from 'pg';

const repo = resolve(new URL('../../', import.meta.url).pathname);
const prefix = `beeline-pi-workspace-${Date.now().toString(36)}`;
const fixture = resolve(repo, 'node_modules/.cache', prefix);
const containers = [];
const children = [];
const modelCalls = [];
let db;
let upstream;
let machines;
const expected = 'PI_GENERAL_PROOF_OK';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pause = () => new Promise((accept) => setTimeout(accept, 250));
async function until(check, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(); }
  throw new Error('local proof timed out');
}
async function listen(server) { await new Promise((accept) => server.listen(0, '127.0.0.1', accept)); return server.address().port; }
async function runServer(args, env, logName) {
  const child = spawn(process.execPath, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.proofLogName = logName; child.proofOutput = () => output;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', () => void writeFile(resolve(fixture, logName), output));
  return { child, getOutput: () => output };
}
try {
  await mkdir(resolve(fixture, 'bin'), { recursive: true });
  await mkdir(resolve(fixture, 'server-home'), { recursive: true });
  await writeFile(resolve(fixture, 'bin/mcp'), '#!/bin/sh\nexec node /opt/repo/apps/body/dist/read-only-mcp.js "$@"\n');
  await chmod(resolve(fixture, 'bin/mcp'), 0o755);
  const dbName = `${prefix}-db`;
  docker('run', '-d', '--name', dbName, '--memory', '1g', '-e', 'POSTGRES_PASSWORD=local-proof-only',
    '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16');
  containers.push(dbName);
  const dbPort = docker('port', dbName, '5432/tcp').split(':').at(-1);
  const databaseUrl = `postgres://postgres:local-proof-only@127.0.0.1:${dbPort}/postgres`;
  await until(async () => { try { const c = new pg.Client({ connectionString: databaseUrl }); await c.connect(); await c.end(); return true; } catch { return false; } });
  const processEnv = { PATH: process.env.PATH, HOME: resolve(fixture, 'server-home'),
    XDG_CONFIG_HOME: resolve(fixture, 'server-home/config'), XDG_STATE_HOME: resolve(fixture, 'server-home/state'),
    DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl };
  const migration = await runServer(['apps/server/dist/index.js', '--migrate'], processEnv, 'migration.log');
  await new Promise((accept, reject) => migration.child.once('close', (code) => code === 0 ? accept() : reject(new Error(`migration failed: ${migration.getOutput().slice(-1500)}`))));
  console.log('local database migrated');
  upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    modelCalls.push({ model: body.model, maxTokens: body.max_tokens ?? body.max_completion_tokens, messages: body.messages.length, requestBytes: Buffer.byteLength(raw) });
    if (body.max_tokens > 65_536) { res.writeHead(400).end(); return; }
    const base = { id: 'local-pi-proof', model: body.model, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const delta of [{ choices: [{ index: 0, delta: { role: 'assistant', content: expected }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }])
      res.write(`data: ${JSON.stringify({ ...base, ...delta })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const upstreamPort = await listen(upstream);
  const helperContainers = new Map();
  machines = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://local');
    const match = /\/machines(?:\/([^/]+))?(?:\/(start|stop|suspend|wait))?$/.exec(url.pathname);
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (!match) return send(404, {});
    const [, id, action] = match;
    try {
      if (!id && req.method === 'POST') {
        const name = `${prefix}-helper-${helperContainers.size + 1}`;
        const home = resolve(fixture, name); await mkdir(home);
        const env = { ...body.config.env, HOME: '/root', XDG_CONFIG_HOME: '/root/.config',
          XDG_STATE_HOME: '/root/.local/state', BUZZ_DEV_MCP_BIN: '/opt/proof/bin/mcp',
          BEELINE_SHARED_ASSETS_ENABLED: '0', BEELINE_READONLY_MCP_BIN: '/opt/proof/bin/mcp' };
        docker('run', '-d', '--name', name, '--network', 'host', '--memory', '2048m', '--cpus', '1',
          '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined', '--cap-add', 'SYS_ADMIN',
          '-v', `${repo}:/opt/repo:ro`, '-v', `${fixture}:/opt/proof:ro`, '-v', `${home}:/root`,
          ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
          '--entrypoint', 'node', 'beeline-free-agent-pi:corner-d14835c5', '/opt/repo/apps/body/dist/cli.js', 'free-agent');
        containers.push(name); helperContainers.set(name, body.config.metadata.beeline_agent);
        return send(200, { id: name });
      }
      if (!id && req.method === 'GET') return send(200, [...helperContainers].filter(([, agent]) => agent === url.searchParams.get('metadata.beeline_agent')).map(([name]) => ({ id: name, state: 'started' })));
      if (id && req.method === 'DELETE') { docker('rm', '-f', id); helperContainers.delete(id); return send(200, {}); }
      if (action === 'stop' || action === 'suspend') { docker('stop', '-t', '2', id); return send(200, {}); }
      if (action === 'start') { docker('start', id); return send(200, {}); }
      return send(200, { id, state: 'started' });
    } catch { return send(500, { error: 'local docker Machine operation failed' }); }
  });
  const machinesPort = await listen(machines);
  const portProbe = createServer(); const port = await listen(portProbe); await new Promise((accept) => portProbe.close(accept));
  const origin = `http://127.0.0.1:${port}`;
  const authTenantsJson = JSON.stringify([{ host: `127.0.0.1:${port}`, community: 'pi-proof', roomCommunityIds: ['pi-proof'], origin }]);
  const server = await runServer(['apps/server/dist/index.js'], { ...processEnv, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin,
    NODE_ENV: 'test',
    BEELINE_AUTH_TENANTS_JSON: authTenantsJson,
    BUZZY_AUTH_TENANTS_JSON: authTenantsJson,
    BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.invalid', BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.invalid/authorize',
    BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.invalid/token', BEELINE_AUTH_OIDC_JWKS_URI: 'https://accounts.invalid/jwks', BEELINE_AUTH_OIDC_CLIENT_ID: 'proof-only',
    BEELINE_FREE_AGENTS: '1', BEELINE_FREE_AGENT_SEAL_KEY: 'local-seal-only',
    FLY_FREE_AGENT_API_TOKEN: 'local-machine-shim-only', FLY_FREE_AGENT_API_ORIGIN: `http://127.0.0.1:${machinesPort}`,
    FLY_FREE_AGENT_IMAGE: 'beeline-free-agent-pi:corner-d14835c5',
    BEELINE_FREE_AGENT_MODEL_KEY: 'deterministic-local-model-only', BEELINE_FREE_AGENT_MODEL_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
  }, 'server.log');
  await until(async () => { if (server.child.exitCode !== null || server.getOutput().includes('[server] startup failed')) throw new Error(`server failed: ${server.getOutput().slice(-1500)}`); try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
  db = new pg.Client({ connectionString: databaseUrl }); await db.connect();
  const owner = randomBytes(32).toString('hex'); const phoneToken = `bpt_${randomBytes(32).toString('base64url')}`;
  await db.query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Pi Proof Owner','pi_proof_owner')", [owner]);
  await db.query("INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,gen_random_uuid(),now()+interval '1 hour')", [createHash('sha256').update(phoneToken).digest('hex'), owner]);
  const request = async (path, input) => {
    const response = await fetch(origin + path, { method: input ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${phoneToken}`, ...(input ? { 'content-type': 'application/json' } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    const value = await response.json(); if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(value)}`); return value;
  };
  const workspace = await request('/v1/phone/operations/createWorkspace', { name: 'Isolated Pi Workspace proof' });
  const { roomId } = workspace;
  const agent = (await db.query('SELECT a.agent_id,a.harness,i.handle FROM agents a JOIN free_agents f ON f.agent_id=a.agent_id JOIN identities i ON i.id=a.agent_id WHERE f.workspace_id=$1', [workspace.id])).rows[0];
  if (!agent || agent.harness !== 'pi') throw new Error('new Workspace did not create a Pi agent');
  const sentId = randomBytes(32).toString('hex');
  await request('/v1/phone/operations/sendRoomMessage', { roomId, messageId: sentId, text: `@${agent.handle} reply with ${expected}`, mentions: [agent.agent_id] });
  console.log('Workspace created through phone API; #general message sent to Pi free agent');
  const reply = await until(async () => (await db.query("SELECT id,text FROM messages WHERE room_id=$1 AND author_id=$2 AND text=$3", [roomId, agent.agent_id, expected])).rows[0], 120_000);
  const room = await request(`/v1/phone/rooms/${roomId}`);
  if (!JSON.stringify(room).includes(reply.id) || !JSON.stringify(room).includes(expected)) throw new Error('phone Room read did not show the reply');
  const completed = (await db.query("SELECT state FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2", [agent.agent_id, sentId])).rows;
  const followups = [];
  for (let turn = 1; turn <= 6; turn++) {
    const messageId = randomBytes(32).toString('hex');
    await request('/v1/phone/operations/sendRoomMessage', { roomId, messageId,
      text: `@${agent.handle} retained-history check ${turn}: ${'context '.repeat(1000)} Reply with ${expected}`,
      mentions: [agent.agent_id] });
    const at = (await db.query('SELECT created_at FROM messages WHERE id=$1', [messageId])).rows[0].created_at;
    const nextReply = await until(async () => (await db.query(
      'SELECT id,text FROM messages WHERE room_id=$1 AND author_id=$2 AND text=$3 AND created_at>$4 ORDER BY created_at LIMIT 1',
      [roomId, agent.agent_id, expected, at])).rows[0], 90_000);
    const nextRoom = await request(`/v1/phone/rooms/${roomId}`);
    if (!JSON.stringify(nextRoom).includes(nextReply.id)) throw new Error('phone read missed a history-followup reply');
    followups.push({ turn, messageId, visibleReplyId: nextReply.id });
    console.log(`history followup ${turn} visible through phone Room read`);
  }
  if (modelCalls.length < 7 || modelCalls.some((call) => call.maxTokens > 65_536) ||
      modelCalls.at(-1).requestBytes <= modelCalls[0].requestBytes)
    throw new Error('history growth or bounded output was not demonstrated');
  const result = { proof: 'PI-WORKSPACE-1', upstream: 'deterministic local stand-in', workspaceId: workspace.id, roomId,
    harness: agent.harness, sentMessageId: sentId, visibleReplyId: reply.id, visibleReply: reply.text, commands: completed,
    followups, modelCalls, isolatedDatabase: true, isolatedHelperHome: true, realPiAndAcp: true };
  await writeFile(resolve(fixture, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await db?.end().catch(() => {});
  for (const child of children) {
    await writeFile(resolve(fixture, child.proofLogName), child.proofOutput());
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  for (const name of [...containers].reverse()) {
    try { if (name.includes('-helper-')) await writeFile(resolve(fixture, `${name}.log`), docker('logs', name)); } catch { /* Container may already be gone. */ }
    try { docker('rm', '-f', name); } catch { /* Removed by normal retirement. */ }
  }
  upstream?.closeAllConnections(); machines?.closeAllConnections();
  await new Promise((accept) => upstream ? upstream.close(accept) : accept());
  await new Promise((accept) => machines ? machines.close(accept) : accept());
  console.log(`fixture ${fixture}; disposable containers removed`);
}
