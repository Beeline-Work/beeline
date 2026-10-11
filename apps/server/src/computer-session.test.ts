import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { findChromiumPage, shareChromiumPage, waitForComputerHandback } from '../../body/src/browser-share.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import {
  computerViewToken, createComputerSession, endComputerSession, getComputerSession, serveComputerSession, serveComputerStatus,
  upgradeBodyComputerSource, upgradeComputerSession, upgradeComputerWaiter,
} from './computer-session.js';

const HUMAN = 'a'.repeat(64);
const OTHER = 'c'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111119';
const ROOM = '22222222-2222-4222-8222-222222222229';

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
}
function next(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once('message', (data) => resolve(data.toString())));
}
function nextType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const listen = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === type) { socket.off('message', listen); resolve(message); }
    };
    socket.on('message', listen);
  });
}
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
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
      response.end('<!doctype html><title>Start</title><button onclick="document.title=\'clicked\'">Click</button>');
      return;
    }
    const path = new URL(request.url ?? '/', 'http://beeline.local').pathname;
    const status = /^\/s\/([A-Za-z0-9_-]{43})\/status$/.exec(path)?.[1];
    if (status) { void serveComputerStatus(request, response, database, status); return; }
    const id = /^\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(path)?.[1];
    if (!id) { response.writeHead(404).end(); return; }
    void serveComputerSession(request, response, database, live, id);
  });
  let origin: string;

  beforeAll(async () => {
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Human'),($2,'agent','Agent'),($3,'human','Other')`, [HUMAN, AGENT, OTHER]);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','System')`, [SYSTEM_IDENTITY_ID]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Computer')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, ROOM, AGENT]);
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, HUMAN]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [WORKSPACE, ROOM, HUMAN]);
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [WORKSPACE, OTHER]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, ROOM, OTHER]);
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://beeline.local');
      const match = /^\/s\/([A-Za-z0-9_-]{43})\/(source|ws|stream|wait)$/.exec(url.pathname);
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
    const access = await computerViewToken(database, share.id, HUMAN);
    expect(access).toBeTruthy();
    expect(row?.status).toBe('live');
    const card = await database.query<{ card: { status: string; url: string } }>(
      'SELECT card FROM messages WHERE id=$1', [row!.message_id]);
    expect(card.rows[0]?.card).toMatchObject({ status: 'live', url: share.url });
    expect((await phone.readRoom(ROOM, HUMAN))?.messages.find((message) => message.id === row!.message_id)?.computerSession)
      .toMatchObject({ id: share.id, status: 'live', url: share.url });
    expect((await fetch(`${origin}/s/${share.id}`)).status).toBe(403);
    const page = await fetch(`${origin}/s/${share.id}?access=${access}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Page.screencastFrame');
    const source = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/source`);
    await opened(source);
    const frame = JSON.stringify({ method: 'Page.screencastFrame', params: { data: 'abc', sessionId: 1 } });
    source.send(frame); // A static tab can send its first frame before the phone opens it.
    let viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
    const receivedFrame = next(viewer);
    await opened(viewer);
    const waiter = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/wait?since=0`);
    await opened(waiter);
    expect(await receivedFrame).toBe(frame);
    viewer.close(); // A transport drop is not a deliberate handback.
    await new Promise<void>((resolve) => viewer.once('close', resolve));
    expect((await (await fetch(`${origin}/s/${share.id}/status?access=${access}`)).json()).status).toBe('live');
    viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
    const reconnectFrame = next(viewer);
    await opened(viewer);
    expect(await reconnectFrame).toBe(frame);
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
    source.send(frame);
    expect(await resumedFrame).toBe(frame);
    const takeover = next(source);
    viewer.send(JSON.stringify({ type: 'takeover' }));
    expect(JSON.parse(await takeover)).toEqual({ type: 'takeover' });
    const click = next(source);
    viewer.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10, y: 12 } }));
    expect(JSON.parse(await click).method).toBe('Input.dispatchMouseEvent');
    const release = next(source);
    const handback = nextType(waiter, 'handoff');
    viewer.send(JSON.stringify({ type: 'leave' }));
    viewer.close();
    expect(JSON.parse(await release)).toEqual({ type: 'release' });
    await new Promise<void>((resolve) => setTimeout(resolve, 5_100));
    expect((await getComputerSession(database, share.id))?.handoff_count).toBe(0);
    viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
    await opened(viewer);
    await phone.execute('handbackComputerSession', { id: share.id }, HUMAN);
    expect(await handback).toMatchObject({ type: 'handoff', note: 'Human handed the browser back' });
    const activity = await until(async () => {
      const result = await database.query<{ id: string; system_event: { payload: { activity: string } } }>(
        `SELECT id,system_event FROM messages WHERE room_id=$1
         AND system_event->>'kind'='computer-session-activity' ORDER BY created_at`, [ROOM],
      );
      return result.rows.some((event) => event.system_event.payload.activity === 'handback') ? result.rows : undefined;
    });
    expect(activity.map((event) => event.system_event.payload.activity))
      .toEqual(expect.arrayContaining(['viewer-opened', 'viewer-closed', 'takeover', 'input', 'handback']));
    expect((await database.query(
      `SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`,
      [activity.find((event) => event.system_event.payload.activity === 'handback')!.id, AGENT],
    )).rowCount).toBe(1);
    viewer.close();
    expect((await getComputerSession(database, share.id))?.status).toBe('live');
    source.close();
    await new Promise<void>((resolve) => source.once('close', resolve));
    // The close handler writes the ended card asynchronously after the socket closes.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect((await getComputerSession(database, share.id))?.status).toBe('ended');
    expect((await phone.readRoom(ROOM, HUMAN))?.messages.find((message) => message.id === row!.message_id)?.computerSession?.status)
      .toBe('ended');
    const ended = await fetch(`${origin}/s/${share.id}?access=${access}`);
    expect(ended.status).toBe(410);
    expect((await fetch(`${origin}/s/${share.id}/last.jpg`)).status).toBe(404);
  }, 60_000);

  it('keeps the card readable while refusing a reader who cannot steer the agent', async () => {
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'restricted-browser', upstreamUrl: 'body:',
    });
    await database.query(`UPDATE agents SET access_policy='{"type":"creator"}'::jsonb WHERE agent_id=$1`, [AGENT]);
    try {
      const room = await phone.readRoom(ROOM, OTHER);
      expect(room?.messages.some((message) => message.computerSession?.id === share.id)).toBe(true);
      await expect(phone.execute('openComputerSession', { id: share.id }, OTHER)).rejects.toThrow('access denied');
      await expect(phone.execute('handbackComputerSession', { id: share.id }, OTHER)).rejects.toThrow('access denied');
      expect(await computerViewToken(database, share.id, OTHER)).toBeNull();
      expect((await fetch(`${origin}/s/${share.id}`)).status).toBe(403);
      expect((await fetch(`${origin}/s/${share.id}/status`)).status).toBe(403);
      const { access } = await phone.execute('openComputerSession', { id: share.id }, HUMAN);
      expect((await fetch(`${origin}/s/${share.id}?access=${access}`)).status).toBe(200);
      const refused = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws`);
      await new Promise<void>((resolve) => { refused.once('error', () => resolve()); });
      const allowed = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
      await opened(allowed);
      allowed.close();
      await new Promise<void>((resolve) => allowed.once('close', resolve));
      await database.query(`UPDATE agents SET access_policy='{"type":"allowlist","allow":[]}'::jsonb WHERE agent_id=$1`, [AGENT]);
      expect((await fetch(`${origin}/s/${share.id}?access=${access}`)).status).toBe(403);
      expect((await fetch(`${origin}/s/${share.id}/status?access=${access}`)).status).toBe(403);
      const revoked = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
      await new Promise<void>((resolve) => { revoked.once('error', () => resolve()); });
      await database.query(`UPDATE agents SET access_policy='{"type":"everyone"}'::jsonb WHERE agent_id=$1`, [AGENT]);
      await database.query(`UPDATE memberships SET role='spectator' WHERE room_id IS NULL AND identity_id=$1`, [OTHER]);
      expect(await computerViewToken(database, share.id, OTHER)).toBeNull();
    } finally {
      await database.query(`UPDATE memberships SET role='member' WHERE room_id IS NULL AND identity_id=$1`, [OTHER]);
      await database.query(`UPDATE agents SET access_policy='{"type":"everyone"}'::jsonb WHERE agent_id=$1`, [AGENT]);
      await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
    }
  });

  it('proxies Squire page and stream without exposing its bearer URL, then hands back and expires', async () => {
    const token = 's'.repeat(43);
    let expired = false;
    let failOnce = true;
    const squire = createServer((request, response) => {
      if (request.url !== `/s/${token}/`) { response.writeHead(404).end(); return; }
      if (expired) { response.writeHead(410).end(); return; }
      if (failOnce) { failOnce = false; response.writeHead(503).end(); return; }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><div id="bar"></div><script>const socket = new WebSocket(new URL("stream", location.href));</script></body>');
    });
    const upstreamSockets = new WebSocketServer({ noServer: true });
    squire.on('upgrade', (request, socket, head) => {
      if (request.url !== `/s/${token}/stream`) { socket.destroy(); return; }
      upstreamSockets.handleUpgrade(request, socket, head, (client) => upstreamSockets.emit('connection', client, request));
    });
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/${token}/`;
    let upstream: WebSocket | undefined;
    upstreamSockets.on('connection', (socket) => { upstream ??= socket; });
    try {
      const share = await createComputerSession(database, live, {
        roomId: ROOM, agentId: AGENT, sessionId: 'squire-operate-1', upstreamUrl, title: 'Squire tab',
      });
      const access = await computerViewToken(database, share.id, HUMAN);
      const loading = await (await fetch(`${origin}/s/${share.id}/?access=${access}`)).text();
      expect(loading).toContain('Connecting to browser');
      expect(loading).toContain('location.replace(next.href)');
      const html = await (await fetch(`${origin}/s/${share.id}/?access=${access}`)).text();
      expect(html).not.toContain(upstreamUrl);
      expect(html).not.toContain(token);
      expect(html).toContain('new URL("stream" + location.search, location.href)');
      expect(html).toContain('(beelinePreview?Math.max:Math.min)');
      const viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      await opened(viewer);
      await until(async () => upstream);
      const frame = JSON.stringify({ type: 'frame', data: Buffer.from('frame').toString('base64') });
      const received = next(viewer);
      upstream!.send(frame);
      expect(await received).toBe(frame);
      const secondViewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      const cachedFrame = next(secondViewer);
      await opened(secondViewer);
      expect(await cachedFrame).toBe(frame);
      secondViewer.close();
      await new Promise<void>((resolve) => secondViewer.once('close', resolve));
      expect((await getComputerSession(database, share.id))?.handoff_count).toBe(0);
      const waiter = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/wait?since=0`);
      await opened(waiter);
      const input = next(upstream!);
      viewer.send(JSON.stringify({ type: 'text', text: 'human' }));
      expect(JSON.parse(await input)).toEqual({ type: 'text', text: 'human' });
      upstream!.send(JSON.stringify({ type: 'control', state: 'human' }));
      const handback = nextType(waiter, 'handoff');
      upstream!.send(JSON.stringify({ type: 'control', state: 'agent' }));
      viewer.send(JSON.stringify({ type: 'handback' }));
      expect(await handback).toMatchObject({ type: 'handoff' });
      const endedNotice = next(viewer);
      expired = true;
      upstream!.close(1000, 'session ended');
      expect(JSON.parse(await endedNotice)).toEqual({ type: 'ended' });
      await until(async () => (await getComputerSession(database, share.id))?.status === 'ended' ? true : undefined);
      expect((await fetch(`${origin}/s/${share.id}?access=${access}`)).status).toBe(410);
      expect((await fetch(`${origin}/s/${share.id}/last.jpg`)).status).toBe(404);
    } finally {
      for (const client of upstreamSockets.clients) client.close();
      await new Promise<void>((resolve) => upstreamSockets.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
    }
  }, 60_000);

  it('ends an unanswered Squire handoff wait at the upstream share expiry', async () => {
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'squire-expiry', upstreamUrl: 'body:',
    });
    const answer = await waitForComputerHandback({
      serverBaseUrl: origin, shareId: share.id, daemonToken: 'test-token', expiresAt: Date.now() + 100,
    });
    expect(answer).toEqual({ type: 'ended', note: 'Squire live share expired', events: [] });
    await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
  });

  it('delivers a screenshot when Chromium accepts screencast but emits no frames', async () => {
    const debuggerServer = createServer();
    const debuggerSockets = new WebSocketServer({ noServer: true });
    debuggerServer.on('upgrade', (request, socket, head) =>
      debuggerSockets.handleUpgrade(request, socket, head, (client) => debuggerSockets.emit('connection', client, request)));
    debuggerSockets.on('connection', (socket) => socket.on('message', (data) => {
      const command = JSON.parse(data.toString()) as { id: number; method: string };
      if (command.method === 'Page.captureScreenshot')
        socket.send(JSON.stringify({ id: command.id, result: { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') } }));
      else socket.send(JSON.stringify({ id: command.id, result: {} }));
    }));
    await new Promise<void>((resolve) => debuggerServer.listen(0, '127.0.0.1', resolve));
    try {
      const share = await createComputerSession(database, live, {
        roomId: ROOM, agentId: AGENT, sessionId: 'silent-cdp', upstreamUrl: 'body:',
      });
      const port = (debuggerServer.address() as AddressInfo).port;
      await shareChromiumPage({ page: { id: 'silent-cdp', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/` },
        serverBaseUrl: origin, shareId: share.id, daemonToken: 'test-token', onEnded: async () => {} });
      const access = await computerViewToken(database, share.id, HUMAN);
      const viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
      const message = next(viewer);
      await opened(viewer);
      expect(JSON.parse(await message)).toMatchObject({ method: 'Page.screencastFrame', params: { data: '/9j/2Q==' } });
      viewer.close();
      for (const client of debuggerSockets.clients) client.close();
      await until(async () => (await getComputerSession(database, share.id))?.status === 'ended' ? true : undefined);
    } finally {
      for (const client of debuggerSockets.clients) client.close();
      await new Promise<void>((resolve) => debuggerSockets.close(() => resolve()));
      await new Promise<void>((resolve) => debuggerServer.close(() => resolve()));
    }
  });

  const chromeBinary = process.env.CHROME_BIN || '/usr/bin/google-chrome';
  it.skipIf(!existsSync(chromeBinary))('hands an actual agent-owned Chromium tab to a viewer and waits for handback', async () => {
    let profile = '';
    let chrome!: ReturnType<typeof spawn>;
    let spawnFailed = false;
    try {
      let port = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        profile = await mkdtemp(join(process.cwd(), '.computer-e2e-'));
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
          port = await until(async () => {
            try {
              const found = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
              return found > 0 ? found : undefined;
            } catch { return undefined; }
          }, 15_000);
          break;
        } catch (error) {
          if (!spawnFailed && chrome.exitCode === null && chrome.signalCode === null) {
            chrome.kill('SIGTERM');
            await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
          }
          await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
          profile = '';
          if (attempt === 3) throw new Error(`Chromium startup failed after 3 attempts: ${startupError || String(error)}`);
        }
      }
      const debugUrl = `http://127.0.0.1:${port}`;
      const page = await until(async () => {
        try { return await findChromiumPage(debugUrl, '/page'); } catch { return undefined; }
      });
      // A browser automation client may already be attached to the shared tab.
      const existingDevtools = new WebSocket(page.webSocketDebuggerUrl!);
      await opened(existingDevtools);
      existingDevtools.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
      const share = await createComputerSession(database, live, {
        roomId: ROOM, agentId: AGENT, sessionId: page.id, upstreamUrl: 'body:', title: 'Live Chrome',
      });
      const access = await computerViewToken(database, share.id, HUMAN);
      await shareChromiumPage({ page, serverBaseUrl: origin, shareId: share.id,
        daemonToken: 'test-token', onEnded: async () => {} });
      const viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
      await opened(viewer);
      const screen = await until(async () => {
        const message = await Promise.race([
          new Promise<{ text: string; binary: boolean }>((resolve) =>
            viewer.once('message', (data, binary) => resolve({ text: data.toString(), binary }))),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
        ]);
        if (!message) return undefined;
        const decoded = JSON.parse(message.text) as { method?: string; params?: { data?: string } };
        return decoded.method === 'Page.screencastFrame' && decoded.params?.data
          ? { decoded, binary: message.binary } : undefined;
      });
      expect(screen.binary).toBe(false);
      expect(Buffer.from(screen.decoded.params!.data!, 'base64').subarray(0, 3).toString('hex')).toBe('ffd8ff');
      const agentWait = waitForComputerHandback({ serverBaseUrl: origin, shareId: share.id, daemonToken: 'test-token' });
      viewer.send(JSON.stringify({ type: 'takeover' }));
      viewer.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 30, y: 20, button: 'left', clickCount: 1 } }));
      viewer.send(JSON.stringify({ id: 2, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 30, y: 20, button: 'left', clickCount: 1 } }));
      await until(async () => (await findChromiumPage(debugUrl, page.id)).title === 'clicked' ? true : undefined);
      viewer.send(JSON.stringify({ type: 'handback' }));
      viewer.close();
      const answer = await agentWait;
      expect(answer).toMatchObject({ type: 'handoff' });
      expect(answer.events.map((event) => event.name)).toEqual(expect.arrayContaining(['viewer-opened', 'takeover', 'input', 'handback']));
      expect(answer.events.every((event) => Number.isFinite(Date.parse(event.at)))).toBe(true);
      expect((await getComputerSession(database, share.id))?.status).toBe('live');
      chrome.kill('SIGTERM');
      await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      await until(async () => (await getComputerSession(database, share.id))?.status === 'ended' ? true : undefined);
      const ended = await fetch(`${origin}/s/${share.id}?access=${access}`);
      expect(ended.status).toBe(410);
      expect((await fetch(`${origin}/s/${share.id}/last.jpg`)).status).toBe(404);
      existingDevtools.close();
    } finally {
      if (chrome && !spawnFailed && chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGTERM');
        await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      }
      if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});
