import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { browserIsHumanControlled, findChromiumPage, shareChromiumPage } from './browser-share.js';

const chromeBinary = process.env.CHROME_BIN || '/usr/bin/google-chrome';

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Chromium did not start');
}

describe('agent-owned Chromium sharing', () => {
  const websocket = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><button onclick="document.title=\'clicked\'">Click</button>');
    } else response.writeHead(404).end();
  });
  let origin: string;
  let profile: string;
  let chrome: ChildProcess;
  let debugPort: number;
  let spawnFailed = false;
  let source: WebSocket | undefined;

  beforeAll(async () => {
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/s/share-test/source' || request.headers.authorization !== 'Bearer test-token') {
        socket.destroy(); return;
      }
      websocket.handleUpgrade(request, socket, head, (accepted) => { source = accepted; });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      profile = await mkdtemp(join(process.cwd(), '.browser-share-test-'));
      chrome = spawn(chromeBinary, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        `--user-data-dir=${profile}`, `${origin}/page`,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      spawnFailed = false;
      let startupError = '';
      chrome.stderr?.on('data', (data: Buffer) => { startupError = (startupError + data.toString()).slice(-4_000); });
      chrome.on('error', (error) => { startupError = error.message; spawnFailed = true; });
      try {
        debugPort = await until(async () => {
          try {
            const port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
            return port > 0 ? port : undefined;
          } catch { return undefined; }
        }, 15_000);
        return;
      } catch (error) {
        if (!spawnFailed && chrome.exitCode === null && chrome.signalCode === null) {
          chrome.kill('SIGTERM');
          await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
        }
        await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        if (attempt === 3) throw new Error(`Chromium startup failed after 3 attempts: ${startupError || String(error)}`);
      }
    }
  }, 90_000);
  afterAll(async () => {
    source?.close();
    if (chrome && !spawnFailed && chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill('SIGTERM');
      await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
    }
    websocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Chromium's helper processes can finish writing the profile just after
    // the parent exits. Retry the transient ENOTEMPTY race during cleanup.
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('streams real screencast frames and tracks human control until release', async () => {
    const page = await until(async () => {
      try { return await findChromiumPage(`http://127.0.0.1:${debugPort}`, '/page'); }
      catch { return undefined; }
    });
    await shareChromiumPage({ page, serverBaseUrl: origin, shareId: 'share-test', daemonToken: 'test-token', onEnded: async () => {} });
    expect(source).toBeDefined();
    const frame = await until(async () => new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 300);
      source!.once('message', (data) => { clearTimeout(timer); resolve(data.toString()); });
    }));
    expect(JSON.parse(frame).method).toBe('Page.screencastFrame');
    source!.send(JSON.stringify({ type: 'takeover' }));
    await until(async () => browserIsHumanControlled(page.id) ? true : undefined);
    source!.send(JSON.stringify({ type: 'release' }));
    await until(async () => !browserIsHumanControlled(page.id) ? true : undefined);
  }, 30_000);
});
