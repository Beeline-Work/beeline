import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { authorizeResourceMessage } from './resource-mcp-facade.js';
import { TurnStoppedError } from './turn-stop.js';

it.each(['command output authority rejected', 'command turn cancelled', 'command already completed'])(
  'ends a stale MCP generation on %s instead of authorizing queued pings', async error => {
    const root = await mkdtemp(join(process.cwd(), '.resource-facade-'));
    const calls: unknown[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        calls.push(JSON.parse(body));
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(join(root, 'context.json'), JSON.stringify({
      roomId: 'room', requestId: 'cancelled-command', generationId: 'dead-generation',
    }));
    await writeFile(join(root, 'auth.json'), JSON.stringify({
      baseUrl, daemonToken: 'test-token', turnContextPath: join(root, 'context.json'),
    }));
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./resource-mcp-facade.ts', import.meta.url))], {
      env: { ...process.env, BEELINE_RESOURCE_TARGET: 'squire',
        BEELINE_RESOURCE_AUTH_FILE: join(root, 'auth.json'),
        BEELINE_RESOURCE_LAUNCH: JSON.stringify({ url: `${baseUrl}/never-called` }) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const exited = once(child, 'exit');
      child.stdin.end(Array.from({ length: 4 }, (_, id) =>
        JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })).join('\n') + '\n');
      await exited;
      expect(calls).toEqual([expect.objectContaining({ generationId: 'dead-generation', consume: false })]);
    } finally {
      child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

// A resource that ignores graceful shutdown must still end with its facade.
it.each(['revocation', 'stdin close', 'SIGTERM'] as const)('kills the resource transport on %s', async ending => {
  const root = await mkdtemp(join(process.cwd(), '.resource-facade-'));
  let revoked = false;
  let calls = 0;
  const server = createServer((_request, response) => {
    calls++;
    response.writeHead(revoked ? 403 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(revoked ? { error: 'command output authority rejected' } : { allowed: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const contextPath = join(root, 'context.json');
  const authPath = join(root, 'auth.json');
  await writeFile(contextPath, JSON.stringify({ roomId: 'room', requestId: 'command', generationId: 'generation' }));
  await writeFile(authPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, daemonToken: 'test', turnContextPath: contextPath }));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./resource-mcp-facade.ts', import.meta.url))], {
    env: { ...process.env, BEELINE_RESOURCE_TARGET: 'files', BEELINE_RESOURCE_AUTH_FILE: authPath,
      BEELINE_RESOURCE_LAUNCH: JSON.stringify({ command: process.execPath, args: ['-e', `
        process.on('SIGTERM', () => {});
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const message = JSON.parse(line);
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { pid: process.pid } }) + '\\n');
        });
      `] }) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = createInterface({ input: child.stdout });
  let resourcePid: number | undefined;
  try {
    const reply = once(output, 'line');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    resourcePid = JSON.parse((await reply)[0]).result.pid;
    const exited = once(child, 'exit');
    if (ending === 'revocation') {
      revoked = true;
      child.stdin.write(Array.from({ length: 4 }, (_, id) => JSON.stringify({ jsonrpc: '2.0', id: id + 2, method: 'ping' })).join('\n') + '\n');
    } else if (ending === 'stdin close') child.stdin.end();
    else child.kill('SIGTERM');
    await exited;
    expect(calls).toBe(ending === 'revocation' ? 2 : 1);
    expect(() => process.kill(resourcePid!, 0)).toThrow();
  } finally {
    child.kill('SIGKILL');
    if (resourcePid) { try { process.kill(resourcePid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    output.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps permission denial per-call and ends an invalidated local generation without HTTP', async () => {
  const root = await mkdtemp(join(process.cwd(), '.resource-facade-'));
  const contextPath = join(root, 'context.json');
  const authPath = join(root, 'auth.json');
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ allowed: calls > 1 }), { status: 200 });
  }) as typeof fetch;
  try {
    await writeFile(authPath, JSON.stringify({ baseUrl: 'https://unused.test', daemonToken: 'test', turnContextPath: contextPath }));
    await writeFile(contextPath, JSON.stringify({ roomId: 'room', requestId: 'command', generationId: 'generation' }));
    expect(await authorizeResourceMessage(message, 'files', authPath, true, fetchImpl)).toBe(false);
    expect(await authorizeResourceMessage(message, 'files', authPath, true, fetchImpl)).toBe(true);
    await writeFile(contextPath, '{}');
    await expect(authorizeResourceMessage(message, 'files', authPath, true, fetchImpl)).rejects.toBeInstanceOf(TurnStoppedError);
    expect(calls).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
