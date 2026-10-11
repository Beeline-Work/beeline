import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { findChromiumPage, shareChromiumPage, waitForComputerHandback } from '../../body/src/browser-share.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import {
  createComputerSession, getComputerSession, serveComputerLastFrame, serveComputerSession, serveComputerStatus,
  upgradeBodyComputerSource, upgradeComputerSession, upgradeComputerWaiter,
} from './computer-session.js';

const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111119';
const ROOM = '22222222-2222-4222-8222-222222222229';

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
}
function next(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once('message', (data) => resolve(data.toString())));
}
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Computer session did not reach the expected state');
}

describe('computer session handoff', () => {
  const database = new PgliteDatabase();
  const live = new LiveHub();
  const phone = new PhoneService(database, 'http://127.0.0.1');
  const server = createServer((request, response) => {
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Start</title><button onclick="document.title=\'clicked\'">Click</button><div id="tick"></div><script>let n=0;setInterval(()=>document.getElementById("tick").textContent=String(++n),100)</script>');
      return;
    }
    const last = /^\/s\/([A-Za-z0-9_-]{43})\/last\.jpg$/.exec(request.url ?? '')?.[1];
    if (last) { void serveComputerLastFrame(response, database, last); return; }
    const status = /^\/s\/([A-Za-z0-9_-]{43})\/status$/.exec(request.url ?? '')?.[1];
    if (status) { void serveComputerStatus(response, database, status); return; }
    const id = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(request.url ?? '')?.[1];
    if (!id) { response.writeHead(404).end(); return; }
    void serveComputerSession(request, response, database, live, id);
  });
  let origin: string;

  beforeAll(async () => {
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Human'),($2,'agent','Agent')`, [HUMAN, AGENT]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Computer')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, ROOM, AGENT]);
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, HUMAN]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [WORKSPACE, ROOM, HUMAN]);
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://beeline.local');
      const match = /^\/s\/([A-Za-z0-9_-]{43})\/(source|ws|wait)$/.exec(url.pathname);
      if (!match) { socket.destroy(); return; }
      void (match[2] === 'wait'
        ? upgradeComputerWaiter(request, socket, head, database, match[1]!, AGENT, Number(url.searchParams.get('since') ?? 0))
        : match[2] === 'source'
        ? upgradeBodyComputerSource(request, socket, head, database, live, match[1]!, AGENT)
        : upgradeComputerSession(request, socket, head, database, live, match[1]!));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  });

  it('posts a live card, relays frames and only the controller input, then ends the card', async () => {
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'chromium-page-1', upstreamUrl: 'body:', title: 'Dashboard',
    });
    const row = await getComputerSession(database, share.id);
    expect(row?.status).toBe('live');
    const card = await database.query<{ card: { status: string; url: string } }>(
      'SELECT card FROM messages WHERE id=$1', [row!.message_id]);
    expect(card.rows[0]?.card).toMatchObject({ status: 'live', url: share.url });
    expect((await phone.readRoom(ROOM, HUMAN))?.messages.find((message) => message.id === row!.message_id)?.computerSession)
      .toMatchObject({ id: share.id, status: 'live', url: share.url });
    const page = await fetch(`${origin}/s/${share.id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Page.screencastFrame');
    const source = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/source`);
    await opened(source);
    let viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws`);
    await opened(viewer);
    const waiter = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/wait?since=0`);
    await opened(waiter);
    const frame = JSON.stringify({ method: 'Page.screencastFrame', params: { data: 'abc', sessionId: 1 } });
    const receivedFrame = next(viewer);
    source.send(frame);
    expect(await receivedFrame).toBe(frame);
    viewer.close(); // A transport drop is not a deliberate handback.
    await new Promise<void>((resolve) => viewer.once('close', resolve));
    expect((await (await fetch(`${origin}/s/${share.id}/status`)).json()).status).toBe('live');
    viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws`);
    await opened(viewer);
    await new Promise<void>((resolve) => setTimeout(resolve, 5_100));
    expect((await getComputerSession(database, share.id))?.handoff_count).toBe(0);
    const pausedFrames: string[] = [];
    viewer.on('message', (data) => pausedFrames.push(data.toString()));
    viewer.send(JSON.stringify({ type: 'pause-view' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    source.send(frame);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(pausedFrames).toEqual([]);
    const resumedFrame = next(viewer);
    viewer.send(JSON.stringify({ type: 'resume-view' }));
    expect(await resumedFrame).toBe(frame);
    const takeover = next(source);
    viewer.send(JSON.stringify({ type: 'takeover' }));
    expect(JSON.parse(await takeover)).toEqual({ type: 'takeover' });
    const click = next(source);
    viewer.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10, y: 12 } }));
    expect(JSON.parse(await click).method).toBe('Input.dispatchMouseEvent');
    const release = next(source);
    const handback = next(waiter);
    viewer.send(JSON.stringify({ type: 'leave' }));
    viewer.close();
    expect(JSON.parse(await release)).toEqual({ type: 'release' });
    expect(JSON.parse(await handback)).toEqual({ type: 'handoff', note: 'Human handed the browser back' });
    expect((await getComputerSession(database, share.id))?.status).toBe('live');
    source.close();
    await new Promise<void>((resolve) => source.once('close', resolve));
    // The close handler writes the ended card asynchronously after the socket closes.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect((await getComputerSession(database, share.id))?.status).toBe('ended');
    expect((await phone.readRoom(ROOM, HUMAN))?.messages.find((message) => message.id === row!.message_id)?.computerSession?.status)
      .toBe('ended');
    const ended = await fetch(`${origin}/s/${share.id}`);
    expect(ended.status).toBe(410);
  }, 60_000);

  it('proxies a Squire CDP share without exposing its host and ends on upstream expiry', async () => {
    const upstreamSockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => upstreamSockets.once('listening', resolve));
    const upstreamAddress = upstreamSockets.address() as AddressInfo;
    const upstreamUrl = `ws://127.0.0.1:${upstreamAddress.port}/private-operate`;
    let upstream: WebSocket | undefined;
    upstreamSockets.on('connection', (socket) => { upstream = socket; });
    try {
      const share = await createComputerSession(database, live, {
        roomId: ROOM, agentId: AGENT, sessionId: 'squire-operate-1', upstreamUrl, title: 'Squire tab',
      });
      const html = await (await fetch(`${origin}/s/${share.id}`)).text();
      expect(html).not.toContain(upstreamUrl);
      expect(html).toContain(`/s/${share.id}/ws`);
      const viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws`);
      await opened(viewer);
      await until(async () => upstream);
      const frame = JSON.stringify({ method: 'Page.screencastFrame', params: { data: 'abc', sessionId: 2 } });
      const received = next(viewer);
      upstream!.send(frame);
      expect(await received).toBe(frame);
      const waiter = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/wait?since=0`);
      await opened(waiter);
      const takeover = next(upstream!);
      viewer.send(JSON.stringify({ type: 'takeover' }));
      expect(JSON.parse(await takeover)).toEqual({ type: 'takeover' });
      const input = next(upstream!);
      viewer.send(JSON.stringify({ method: 'Input.insertText', params: { text: 'human' } }));
      expect(JSON.parse(await input).method).toBe('Input.insertText');
      const endedNotice = next(waiter);
      upstream!.close(4004, 'session ended');
      expect(JSON.parse(await endedNotice)).toEqual({ type: 'ended' });
      await until(async () => (await getComputerSession(database, share.id))?.status === 'ended' ? true : undefined);
      expect((await fetch(`${origin}/s/${share.id}`)).status).toBe(410);
      expect((await fetch(`${origin}/s/${share.id}/last.jpg`)).status).toBe(200);
    } finally {
      for (const client of upstreamSockets.clients) client.close();
      await new Promise<void>((resolve) => upstreamSockets.close(() => resolve()));
    }
  }, 60_000);

  const chromeBinary = process.env.CHROME_BIN || '/usr/bin/google-chrome';
  it.skipIf(!existsSync(chromeBinary))('hands an actual agent-owned Chromium tab to a viewer and waits for handback', async () => {
    const profile = await mkdtemp(join(process.cwd(), '.computer-e2e-'));
    const chrome = spawn(chromeBinary, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, `${origin}/page`,
    ], { stdio: 'ignore' });
    try {
      const port = await until(async () => {
        try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
        catch { return undefined; }
      });
      const debugUrl = `http://127.0.0.1:${port}`;
      const page = await until(async () => {
        try { return await findChromiumPage(debugUrl, '/page'); } catch { return undefined; }
      });
      const share = await createComputerSession(database, live, {
        roomId: ROOM, agentId: AGENT, sessionId: page.id, upstreamUrl: 'body:', title: 'Live Chrome',
      });
      await shareChromiumPage({ page, serverBaseUrl: origin, shareId: share.id,
        daemonToken: 'test-token', onEnded: async () => {} });
      const viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws`);
      await opened(viewer);
      const screen = await until(async () => {
        const message = await Promise.race([
          next(viewer), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
        ]);
        if (!message) return undefined;
        const decoded = JSON.parse(message) as { method?: string; params?: { data?: string } };
        return decoded.method === 'Page.screencastFrame' && decoded.params?.data ? decoded : undefined;
      });
      expect(Buffer.from(screen.params!.data!, 'base64').subarray(0, 3).toString('hex')).toBe('ffd8ff');
      const agentWait = waitForComputerHandback({ serverBaseUrl: origin, shareId: share.id, daemonToken: 'test-token' });
      viewer.send(JSON.stringify({ type: 'takeover' }));
      viewer.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 30, y: 20, button: 'left', clickCount: 1 } }));
      viewer.send(JSON.stringify({ id: 2, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 30, y: 20, button: 'left', clickCount: 1 } }));
      await until(async () => (await findChromiumPage(debugUrl, page.id)).title === 'clicked' ? true : undefined);
      viewer.send(JSON.stringify({ type: 'leave' }));
      viewer.close();
      expect(await agentWait).toMatchObject({ type: 'handoff' });
      expect((await getComputerSession(database, share.id))?.status).toBe('live');
      chrome.kill('SIGTERM');
      await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      await until(async () => (await getComputerSession(database, share.id))?.status === 'ended' ? true : undefined);
      const ended = await fetch(`${origin}/s/${share.id}`);
      expect(ended.status).toBe(410);
      const last = await fetch(`${origin}/s/${share.id}/last.jpg`);
      expect(last.status).toBe(200);
      expect((await last.arrayBuffer()).byteLength).toBeGreaterThan(100);
    } finally {
      if (chrome.exitCode === null) {
        chrome.kill('SIGTERM');
        await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      }
      await rm(profile, { recursive: true, force: true });
    }
  }, 60_000);
});
