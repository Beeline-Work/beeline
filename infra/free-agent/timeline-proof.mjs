import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import pg from 'pg';
import { summarizeTimeline } from './timeline-summary.mjs';

// Read ephemeral backend grants from stdin; never save or print them.
const input = createInterface({ input: process.stdin });
const config = await new Promise((resolve) =>
  input.once('line', (line) => resolve(JSON.parse(line))),
);
input.close();
if (!process.env.PROOF_IMAGE) throw new Error('PROOF_IMAGE must name the exact proof image');
const app = process.env.PROOF_FLY_APP ?? 'beeline-free-agents';
const serverEntrypoint = process.env.PROOF_SERVER_ENTRYPOINT ?? 'apps/server/dist/index.js';
const prefix = `beeline-timeline-${Date.now()}`;
const directory = `.scratch/${prefix}`;
await mkdir(directory, { recursive: true });
const children = [];
const machines = new Set();
const workspaces = [];
const marks = [];
const results = [];
let cancelled = false;
process.on('SIGINT', () => {
  cancelled = true;
});
process.on('SIGTERM', () => {
  cancelled = true;
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const mark = (step, fields = {}) => {
  const row = { at: new Date().toISOString(), step, ...fields };
  marks.push(row);
  console.log(JSON.stringify(row));
};
function launch(command, args, env, label) {
  const child = spawn(command, args, {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      log += chunk;
      appendFile(`${directory}/${label}.log`, chunk);
    });
  children.push(child);
  return { child, log: () => log };
}
async function waitFor(what, check, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (cancelled) throw new Error('proof cancelled');
    const value = await check();
    if (value) return value;
    await pause(250);
  }
  throw new Error(`deadline: ${what}`);
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function fly(path, method = 'GET', body) {
  const response = await fetch(
    `${config.machines.base_url}/v1/apps/${encodeURIComponent(app)}/machines${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${config.machines.token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(90000),
    },
  );
  const text = await response.text();
  if (!response.ok)
    throw Object.assign(
      new Error(`Fly ${method} ${path}: ${response.status} ${text.slice(0, 200)}`),
      { status: response.status },
    );
  return text ? JSON.parse(text) : {};
}
let db, api, model, token;
try {
  // Check the scoped grant before starting resources.
  const existing = await fly('');
  mark('fly-ready', { existingMachineCount: existing.length });
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
  const databaseUrl = `postgres://postgres:proof@${docker('port', `${prefix}-pg`, '5432/tcp')}/postgres`;
  db = new pg.Client({ connectionString: databaseUrl });
  await waitFor('database', async () => {
    try {
      await db.connect();
      return true;
    } catch {
      db = new pg.Client({ connectionString: databaseUrl });
      return false;
    }
  });
  const migration = launch(
    process.execPath,
    [serverEntrypoint, '--migrate'],
    { MIGRATION_DATABASE_URL: databaseUrl },
    'migration',
  );
  await new Promise((resolve, reject) =>
    migration.child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('migration failed')),
    ),
  );
  api = createServer(async (req, res) => {
    try {
      const path = req.url.replace(`/v1/apps/${encodeURIComponent(app)}/machines`, '');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      if (req.method === 'GET' && path.startsWith('?metadata.beeline_agent=')) {
        const agentId = new URLSearchParams(path.slice(1)).get('metadata.beeline_agent');
        const row = (
          await db.query('SELECT provision_started_at FROM free_agents WHERE agent_id=$1', [
            agentId,
          ])
        ).rows[0];
        mark('provision-wake-requested', { agentId, requestedAt: row?.provision_started_at });
      }
      const provisioning = req.method === 'POST' && path === '';
      if (provisioning) {
        body.name = `${prefix}-${body.config.env.BEELINE_FREE_AGENT_ID.slice(0, 8)}`;
        body.config.init = {
          exec: [
            '/bin/sh',
            '-c',
            '/bin/sh /opt/beeline/entrypoint.sh > /tmp/proof-helper.log 2>&1',
          ],
        };
        mark('fly-create-request', { agentId: body.config.env.BEELINE_FREE_AGENT_ID });
      }
      if (path.endsWith('/start')) mark('fly-start-request', { machineId: path.split('/')[1] });
      const result = await fly(path, req.method, body);
      if (provisioning) {
        machines.add(result.id);
        mark('fly-create-accepted', { machineId: result.id, events: result.events });
      }
      if (path.endsWith('/start')) mark('fly-start-accepted', { machineId: path.split('/')[1] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      mark('fly-proxy-error', { message: String(error) });
      res.writeHead(error.status ?? 502);
      res.end(String(error));
    }
  });
  const machinesPort = await listen(api);
  model = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      mark('model-request-sent');
      const upstream = await fetch(`${config.model.base_url}/api/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.model.token}`,
          'content-type': 'application/json',
        },
        body: Buffer.concat(chunks),
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      let first = true;
      for await (const chunk of upstream.body) {
        if (first) {
          mark('model-first-byte', { status: upstream.status });
          first = false;
        }
        res.write(chunk);
      }
      res.end();
    } catch (error) {
      mark('model-proxy-error', { message: String(error) });
      res.destroy();
    }
  });
  const modelPort = await listen(model);
  const portAllocator = createServer();
  const serverPort = await listen(portAllocator);
  await new Promise((resolve) => portAllocator.close(resolve));
  const origin = `http://127.0.0.1:${serverPort}`;
  const tunnel = launch(
    'cloudflared',
    ['tunnel', '--url', origin, '--no-autoupdate'],
    {},
    'tunnel',
  );
  const publicOrigin = await waitFor(
    'tunnel',
    () => tunnel.log().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0],
  );
  mark('tunnel-ready', { publicOrigin });
  launch(
    process.execPath,
    [serverEntrypoint],
    {
      DATABASE_URL: databaseUrl,
      PORT: String(serverPort),
      PUBLIC_ORIGIN: publicOrigin,
      BUZZY_AUTH_TENANTS_JSON: JSON.stringify([
        {
          host: new URL(publicOrigin).host,
          community: 'proof',
          roomCommunityIds: ['proof'],
          origin: publicOrigin,
        },
      ]),
      BEELINE_AUTH_OIDC_ISSUER: 'https://accounts.example',
      BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
      BEELINE_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
      BEELINE_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
      BEELINE_AUTH_OIDC_CLIENT_ID: 'proof',
      BEELINE_FREE_AGENTS: '1',
      BEELINE_FREE_AGENT_SEAL_KEY: randomBytes(32).toString('hex'),
      FLY_FREE_AGENT_IMAGE: process.env.PROOF_IMAGE,
      FLY_FREE_AGENT_APP: app,
      FLY_FREE_AGENT_API_TOKEN: 'local-proof-proxy',
      FLY_FREE_AGENT_API_ORIGIN: `http://127.0.0.1:${machinesPort}`,
      BEELINE_FREE_AGENT_MODEL_KEY: 'local-proof-proxy',
      BEELINE_FREE_AGENT_MODEL_UPSTREAM: `http://127.0.0.1:${modelPort}`,
      BEELINE_MIN_HELPER_VERSION: 'v0.0.0',
    },
    'server',
  );
  await waitFor('server', async () => {
    try {
      return (await fetch(`${origin}/health`)).ok;
    } catch {
      return false;
    }
  });
  const person = randomBytes(32).toString('hex');
  token = `bpt_${randomBytes(32).toString('base64url')}`;
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Timeline proof',$2)`,
    [person, `timeline${person.slice(0, 8)}`],
  );
  await db.query(
    `INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,gen_random_uuid(),now()+interval '2 hours')`,
    [createHash('sha256').update(token).digest('hex'), person],
  );
  async function operation(name, body) {
    const response = await fetch(`${origin}/v1/phone/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
  for (let sample = 1; sample <= 3; sample++) {
    const workspace = await operation('createWorkspace', { name: `${prefix}-${sample}` });
    workspaces.push(workspace);
    const agent = (
      await db.query(
        `SELECT f.agent_id,i.handle FROM free_agents f JOIN identities i ON i.id=f.agent_id WHERE f.workspace_id=$1`,
        [workspace.id],
      )
    ).rows[0];
    for (const mode of ['first-boot', 'resume']) {
      if (mode === 'resume')
        await waitFor('suspended', async () => {
          const machineId = (
            await db.query(`SELECT fly_machine_id FROM free_agents WHERE agent_id=$1`, [
              agent.agent_id,
            ])
          ).rows[0].fly_machine_id;
          return (await fly(`/${machineId}`)).state === 'suspended';
        });
      const messageId = randomBytes(32).toString('hex');
      const before = new Date().toISOString();
      await operation('sendRoomMessage', {
        roomId: workspace.roomId,
        messageId,
        text: `@${agent.handle} Reply with just pong.`,
        mentions: [agent.agent_id],
      });
      const mention = (await db.query(`SELECT created_at FROM messages WHERE id=$1`, [messageId]))
        .rows[0].created_at;
      mark('mention-committed', { sample, mode, messageId, mention });
      const reply = await waitFor(
        'reply',
        async () =>
          (
            await db.query(
              `SELECT id,text,created_at FROM messages WHERE room_id=$1 AND author_id=$2 AND presentation='message' AND created_at>$3 ORDER BY created_at LIMIT 1`,
              [workspace.roomId, agent.agent_id, mention],
            )
          ).rows[0],
      );
      const events = (
        await db.query(
          `SELECT kind,at,detail FROM free_agent_events WHERE agent_id=$1 AND at>$2 ORDER BY at`,
          [agent.agent_id, before],
        )
      ).rows;
      const commands = (
        await db.query(
          `SELECT id,created_at,claimed_at,state FROM agent_commands WHERE agent_id=$1 AND created_at>$2 ORDER BY created_at`,
          [agent.agent_id, before],
        )
      ).rows;
      const machineId = (
        await db.query(`SELECT fly_machine_id FROM free_agents WHERE agent_id=$1`, [agent.agent_id])
      ).rows[0].fly_machine_id;
      const machine = await fly(`/${machineId}`);
      const log = await fly(`/${machineId}/exec`, 'POST', {
        command: ['cat', '/tmp/proof-helper.log'],
        timeout: 10,
      });
      await writeFile(
        `${directory}/${sample}-${mode}-helper.log`,
        log.stdout ?? JSON.stringify(log),
      );
      const row = {
        sample,
        mode,
        image: machine.image_ref,
        workspaceId: workspace.id,
        roomId: workspace.roomId,
        agentId: agent.agent_id,
        machineId,
        messageId,
        mention,
        reply,
        events,
        commands,
        flyEvents: machine.events,
        marks: marks.filter((x) => x.at >= before),
        replyMs: reply.created_at - mention,
      };
      if (
        !row.marks.some((x) => x.step === 'model-first-byte' && x.status === 200) ||
        !/pong/i.test(reply.text)
      )
        throw new Error('proof did not obtain the requested model reply');
      results.push(row);
      await writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2));
      mark('sample-complete', { sample, mode, replyMs: row.replyMs });
    }
    const machineId = (
      await db.query(`SELECT fly_machine_id FROM free_agents WHERE agent_id=$1`, [agent.agent_id])
    ).rows[0].fly_machine_id;
    await fly(`/${machineId}?force=true`, 'DELETE');
    machines.delete(machineId);
    mark('machine-destroyed', { machineId });
    await operation('deleteWorkspace', { workspaceId: workspace.id });
    workspace.deleted = true;
    mark('workspace-deleted', { workspaceId: workspace.id });
  }
  console.log(JSON.stringify(await summarizeTimeline(directory), null, 2));
} catch (error) {
  mark('failed', { message: String(error) });
  process.exitCode = 1;
} finally {
  // Adopt any create whose response was interrupted, using this run's unique name.
  try {
    for (const machine of await fly(''))
      if (machine.name?.startsWith(`${prefix}-`)) machines.add(machine.id);
  } catch (error) {
    mark('cleanup-list-failed', { message: String(error) });
    process.exitCode = 1;
  }
  for (const machineId of machines) {
    try {
      await fly(`/${machineId}?force=true`, 'DELETE');
      mark('machine-destroyed', { machineId });
    } catch (error) {
      mark('cleanup-machine-failed', { machineId, message: String(error) });
      process.exitCode = 1;
    }
  }
  for (const child of children) child.kill('SIGTERM');
  if (db) {
    for (const workspace of workspaces.filter((x) => !x.deleted)) {
      try {
        await db.query('DELETE FROM workspaces WHERE id=$1', [workspace.id]);
        mark('workspace-deleted', { workspaceId: workspace.id });
      } catch (error) {
        mark('cleanup-workspace-failed', { workspaceId: workspace.id, message: String(error) });
        process.exitCode = 1;
      }
    }
    await db.end();
  }
  api?.closeAllConnections();
  api?.close();
  model?.closeAllConnections();
  model?.close();
  try {
    docker('rm', '-f', `${prefix}-pg`);
  } catch {}
  await writeFile(`${directory}/marks.json`, JSON.stringify(marks, null, 2));
  console.log(`proof artifacts: ${directory}`);
}
