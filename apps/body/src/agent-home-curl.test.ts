import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { prepareRoomAgentHome } from './agent-home.js';

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('identifies native curl requests and keeps explicit user agents authoritative', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-curl-'));
  roots.push(root);
  const operatorHome = resolve(root, 'operator');
  await mkdir(operatorHome);
  const env = await prepareRoomAgentHome({ root: resolve(root, 'agent'), operatorHome, agentKind: 'pi', failClosed: true });
  const server = createServer((request, response) => {
    response.end(request.headers['user-agent']);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const curlEnv = { ...process.env, ...env };
    delete curlEnv.CURL_HOME;
    const url = `http://127.0.0.1:${address.port}`;
    expect((await run('curl', ['-sS', '--noproxy', '*', url], { env: curlEnv })).stdout).toBe('Beeline/1.0');
    expect((await run('curl', ['-sS', '--noproxy', '*', '-A', 'explicit-client', url], { env: curlEnv })).stdout).toBe('explicit-client');
    await expect(readFile(resolve(operatorHome, '.curlrc'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(env.TMPDIR!, { force: true });
  }
});

it('replaces an agent curl config symlink without writing through it', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-curl-'));
  roots.push(root);
  const operatorHome = resolve(root, 'operator');
  const home = resolve(root, 'agent', 'user');
  await mkdir(operatorHome);
  await mkdir(home, { recursive: true });
  const outside = resolve(operatorHome, '.curlrc');
  await symlink(outside, resolve(home, '.curlrc'));
  const env = await prepareRoomAgentHome({ root: resolve(root, 'agent'), operatorHome, agentKind: 'pi', failClosed: true });
  expect((await lstat(resolve(home, '.curlrc'))).isSymbolicLink()).toBe(false);
  await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(env.TMPDIR!, { force: true });
});
