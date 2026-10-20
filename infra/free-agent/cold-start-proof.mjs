// Disposable local proof: real server, fresh Workspace, real image and Pi;
// Docker stands in for Fly, and an immediate local reply stands in for the model.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import pg from 'pg';
import WebSocket from 'ws';

const image = process.env.PROOF_IMAGE ?? 'beeline-cold-start-proof';
const prefix = `jellybean-cold-${Date.now()}`;
const directory = `/tmp/${prefix}`;
await mkdir(directory);
const children = [];
const timeline = [];
const note = (step) => {
  const event = { at: new Date().toISOString(), step };
  timeline.push(event);
  console.log(JSON.stringify(event));
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
let db;
let model;
let modelAt;
let socket;
function launch(args, env, label) {
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const collect = (chunk) => {
    log += chunk;
    appendFileSync(`${directory}/${label}.log`, chunk);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  children.push({ child, label, log: () => log });
  return child;
}
async function waitFor(check, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error('proof deadline exceeded');
}
try {
  docker(
    'run',
    '-d',
    '--name',
    `${prefix}-pg`,
    '--memory',
    '512m',
    '-e',
    'POSTGRES_PASSWORD=proof',
    '-p',
    '127.0.0.1::5432',
    'pgvector/pgvector:pg17',
  );
  const binding = docker('port', `${prefix}-pg`, '5432/tcp');
  const databaseUrl = `postgres://postgres:proof@${binding}/postgres`;
  await waitFor(async () => {
    try {
      docker('exec', `${prefix}-pg`, 'pg_isready', '-U', 'postgres');
      return true;
    } catch {
      return false;
    }
  });
  const migration = launch(
    ['apps/server/dist/index.js', '--migrate'],
    { MIGRATION_DATABASE_URL: databaseUrl },
    'migration',
  );
  await new Promise((resolve, reject) =>
    migration.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('migration failed')),
    ),
  );
  db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  model = createServer(async (req, res) => {
    for await (const _ of req) {
      /* Consume the bounded local prompt. */
    }
    modelAt ??= Date.now();
    note('first-model-call');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = {
      id: 'proof',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'deepseek/deepseek-v4.1-flash',
    };
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Cold start proof reply.' }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  // Allocate two loopback ports, then release them for the child services.
  const ports = [];
  for (let i = 0; i < 2; i++) {
    const socket = createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    ports.push(socket.address().port);
    await new Promise((resolve) => socket.close(resolve));
  }
  const [serverPort, machinesPort] = ports;
  const origin = `http://127.0.0.1:${serverPort}`;
  launch(['scripts/free-agent-docker-machines.mjs', String(machinesPort), prefix], {}, 'machines');
  launch(
    ['apps/server/dist/index.js'],
    {
      DATABASE_URL: databaseUrl,
      PORT: String(serverPort),
      PUBLIC_ORIGIN: origin,
      BUZZY_AUTH_TENANTS_JSON: JSON.stringify([
        { host: new URL(origin).host, community: 'proof', roomCommunityIds: ['proof'], origin },
      ]),
      BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.example',
      BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
      BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
      BEELINE_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
      BEELINE_AUTH_OIDC_CLIENT_ID: 'proof',
      BEELINE_FREE_AGENTS: '1',
      BEELINE_FREE_AGENT_SEAL_KEY: randomBytes(32).toString('hex'),
      FLY_FREE_AGENT_IMAGE: image,
      FLY_FREE_AGENT_API_TOKEN: 'local-proof',
      FLY_FREE_AGENT_API_ORIGIN: `http://127.0.0.1:${machinesPort}`,
      BEELINE_FREE_AGENT_MODEL_KEY: 'local-proof',
      BEELINE_FREE_AGENT_MODEL_UPSTREAM: `http://127.0.0.1:${model.address().port}/v1`,
    },
    'server',
  );
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/health`)).ok;
    } catch {
      return false;
    }
  });
  const person = randomBytes(32).toString('hex');
  const token = `bpt_${randomBytes(32).toString('base64url')}`;
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Cold proof','coldproof')`,
    [person],
  );
  await db.query(
    `INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,gen_random_uuid(),now()+interval '1 hour')`,
    [createHash('sha256').update(token).digest('hex'), person],
  );
  const operation = async (name, input) => {
    const response = await fetch(`${origin}/v1/phone/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const workspace = await operation('createWorkspace', { name: 'Disposable cold-start proof' });
  const agent = (
    await db.query(
      `SELECT f.agent_id,i.handle FROM free_agents f JOIN identities i ON i.id=f.agent_id WHERE f.workspace_id=$1`,
      [workspace.id],
    )
  ).rows[0];
  const messageId = randomBytes(32).toString('hex');
  let subscribed = false;
  let pushedAt;
  socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`, [`bearer.${token}`]);
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'subscribed') subscribed = true;
    if (
      frame.type === 'turn-delta' &&
      frame.turn?.requestId === messageId &&
      frame.turn.status === 'working'
    )
      pushedAt ??= Date.now();
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'subscribe', roomId: workspace.roomId }));
  await waitFor(() => subscribed, 5000);
  const mentionedAt = Date.now();
  note('mention');
  await operation('sendRoomMessage', {
    roomId: workspace.roomId,
    messageId,
    text: `@${agent.handle} Reply hello.`,
  });
  const view = await (
    await fetch(`${origin}/v1/phone/rooms/${workspace.roomId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  if (
    !view.latestAgentTurns?.some(
      (turn) => turn.requestId === messageId && turn.status === 'working',
    )
  )
    throw new Error('indicator missing from phone read before helper pickup');
  await waitFor(() => pushedAt, 3000);
  const indicatorMs = pushedAt - mentionedAt;
  note(`phone-live indicator ${indicatorMs}ms`);
  const reply = await waitFor(
    async () =>
      (
        await db.query(
          `SELECT text FROM messages WHERE room_id=$1 AND author_id=$2 AND presentation='message' AND created_at>to_timestamp($3/1000.0) ORDER BY created_at LIMIT 1`,
          [workspace.roomId, agent.agent_id, mentionedAt],
        )
      ).rows[0],
  );
  const replyMs = Date.now() - mentionedAt;
  note(`reply ${replyMs}ms`);
  await writeFile(
    `${directory}/result.json`,
    JSON.stringify(
      {
        reproduction: 'cold-beebee-first-reply',
        standIn: 'Docker Machines and deterministic local model',
        workspaceId: workspace.id,
        roomId: workspace.roomId,
        imageId: docker('image', 'inspect', '--format', '{{.Id}}', image),
        imageReleaseSha: docker(
          'image',
          'inspect',
          '--format',
          '{{index .Config.Labels "app.usebeeline.release.sha"}}',
          image,
        ),
        indicatorMs,
        firstModelMs: modelAt - mentionedAt,
        replyMs,
        reply: reply.text,
        timeline,
      },
      null,
      2,
    ),
  );
  if (indicatorMs > 3000 || replyMs > 30000) throw new Error('cold-start target missed');
} finally {
  socket?.terminate();
  for (const { child, label, log } of children) {
    child.kill('SIGTERM');
    await writeFile(`${directory}/${label}.log`, log());
  }
  const containers = docker('ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}')
    .split('\n')
    .filter(Boolean);
  for (const name of containers) {
    if (!name.endsWith('-pg')) {
      try {
        await writeFile(`${directory}/${name}.log`, docker('logs', '--timestamps', name));
      } catch {}
    }
    docker('rm', '-f', name);
  }
  await db?.end();
  model?.closeAllConnections();
  model?.close();
  console.log(`proof artifacts: ${directory}`);
}
