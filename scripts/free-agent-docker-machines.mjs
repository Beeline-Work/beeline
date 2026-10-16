#!/usr/bin/env node
// Local stand-in for the Fly Machines API calls free agents make
// (`apps/server/src/fly-machines.ts`), backed by Docker containers on this
// host. For proofs only: point the server at it with
// FLY_FREE_AGENT_API_ORIGIN=http://127.0.0.1:<port>.
//   node scripts/free-agent-docker-machines.mjs <port> [container-prefix]
// suspend = docker pause, stop = docker stop, start resumes either.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4280);
const prefix = process.argv[3] ?? 'free-agent-proof';
let next = 0;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function state(id) {
  try {
    const status = docker('inspect', '-f', '{{.State.Status}}', id);
    return status === 'running' ? 'started' : status === 'paused' ? 'suspended' : 'stopped';
  } catch {
    return undefined;
  }
}

function log(line) {
  console.log(`${new Date().toISOString()} [machines] ${line}`);
}

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const url = new URL(request.url, 'http://local');
  const match = /^\/v1\/apps\/[^/]+\/machines(?:\/([^/]+))?(?:\/(start|suspend|stop))?$/.exec(url.pathname);
  const send = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (!match) return send(404, { error: 'not found' });
  const [, id, action] = match;
  try {
    if (!id && request.method === 'POST') {
      const machine = `${prefix}-${Date.now().toString(36)}-${++next}`;
      const config = body.config;
      const env = Object.entries(config.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      docker(
        'run', '-d', '--name', machine, '--network', 'host',
        '--memory', `${config.guest.memory_mb}m`, '--cpus', String(config.guest.cpus),
        '--label', `beeline_agent=${config.metadata.beeline_agent}`,
        // bwrap needs user namespaces inside the container, as on a Fly VM.
        '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined',
        '--cap-add', 'SYS_ADMIN',
        ...env, config.image,
      );
      log(`create ${machine}`);
      return send(200, { id: machine, state: 'created' });
    }
    if (!id && request.method === 'GET') {
      const agent = url.searchParams.get('metadata.beeline_agent');
      const names = docker('ps', '-a', '--filter', `label=beeline_agent=${agent}`, '--format', '{{.Names}}')
        .split('\n').filter(Boolean);
      return send(200, names.map((name) => ({ id: name, state: state(name) })));
    }
    if (id && !action && request.method === 'GET') {
      const current = state(id);
      return current ? send(200, { id, state: current }) : send(404, { error: 'not found' });
    }
    if (id && !action && request.method === 'DELETE') {
      docker('rm', '-f', id);
      log(`destroy ${id}`);
      return send(200, { ok: true });
    }
    if (action === 'start') {
      const current = state(id);
      if (current === 'suspended') docker('unpause', id);
      else if (current === 'stopped') docker('start', id);
      log(`start ${id} (was ${current})`);
      return send(200, { previous_state: current });
    }
    if (action === 'suspend') {
      docker('pause', id);
      log(`suspend ${id}`);
      return send(200, { ok: true });
    }
    if (action === 'stop') {
      docker('stop', '-t', '5', id);
      log(`stop ${id}`);
      return send(200, { ok: true });
    }
    return send(404, { error: 'not found' });
  } catch (error) {
    log(`${request.method} ${url.pathname} failed: ${error.message}`);
    return send(500, { error: String(error.message) });
  }
}).listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port}`));
