import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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
import { systemLine } from './system-line.js';
import { createAgentCommand, claimAgentCommand, readAgentCommands } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { noteFirstSilence } from './turn-silence-notice.js';
import { backfillComputerObservations } from './system-line.js';
import { PhoneService } from './phone-service.js';
import { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';
import { assembleTurnPrompt } from '../../body/src/prompt-assembly.js';
import type { DaemonApiClient } from '../../body/src/daemon-api-client.js';
import {
  computerViewToken, createComputerSession, endComputerSession, expireComputerSessions, getComputerSession, refreshComputerSession, serveComputerSession,
  serveComputerStatus, startComputerExpirySweep, upgradeBodyComputerSource, upgradeComputerSession, upgradeComputerWaiter,
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

  it('keeps passive viewer context for the next agent read without a wake or human transcript line', async () => {
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'passive-view', upstreamUrl: 'body:',
    });
    const access = await computerViewToken(database, share.id, HUMAN);
    const viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
    await opened(viewer); viewer.close();
    await new Promise<void>(resolve => viewer.once('close', resolve));
    await until(async () => (await database.query(`SELECT 1 FROM messages WHERE
      system_event->'payload'->>'sessionId'=$1 AND system_event->'payload'->>'activity'='viewer-closed'`, [share.id])).rowCount ? true : undefined);
    const commands = await database.query(`SELECT 1 FROM agent_commands command JOIN messages source
      ON source.id=command.source_message_id WHERE source.system_event->'payload'->>'sessionId'=$1`, [share.id]);
    expect(commands.rowCount).toBe(0);
    const conversation = await new DaemonService(database, live).execute('getRoomConversation', { roomId: ROOM }, AGENT);
    const context = conversation.items.filter(item =>
      (item.systemEvent?.payload as { sessionId?: string } | undefined)?.sessionId === share.id);
    expect(context.map(item => item.body)).toEqual(['Human opened the shared browser', 'Human closed the shared browser view']);
    expect(context.every(item => item.type === 'activity')).toBe(true);
    for (const item of context) expect(await phone.readLiveDelta(ROOM, HUMAN, {
      type: 'message', messageId: item.id,
    })).toBeNull();
    expect((await phone.readRoom(ROOM, HUMAN))?.messages.some(message =>
      message.systemEvent?.kind === 'computer-session-activity')).toBe(false);
    await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
  });

  it('retires all unclaimed browser wakes while preserving sent messages', async () => {
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'old-view', upstreamUrl: 'body:',
    });
    const meaningfulShare = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'old-input', upstreamUrl: 'body:',
    });
    const observation = (activity: string) => systemLine(database, {
      roomId: ROOM, authorId: SYSTEM_IDENTITY_ID, subject: { kind: 'system', name: 'A person' },
      verb: activity === 'input' ? 'used' : 'opened', object: 'the shared browser',
      kind: 'computer-session-activity', payload: { sessionId: activity === 'input' ? meaningfulShare.id : share.id, activity }, wakes: [AGENT],
    });
    const passive = await observation('viewer-opened');
    // Legacy pre-coalescing commands had the normal subscribed-event reason.
    await database.query(`UPDATE agent_commands SET reason='subscribed_event' WHERE source_message_id=$1`, [passive.id]);
    const meaningful = await observation('input');
    const humanId = randomUUID();
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please check this screen')`, [humanId, ROOM, HUMAN]);
    const human = await createAgentCommand(database, { roomId: ROOM, agentId: AGENT, sourceMessageId: humanId, reason: 'human_tag' });
    await backfillComputerObservations(database);
    expect((await database.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [human!.id])).rows[0]?.state).toBe('pending');
    await database.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [human!.id]);
    const commands = await database.query<{source_message_id: string;state: string}>(
      `SELECT source_message_id,state FROM agent_commands WHERE source_message_id=ANY($1::text[])`, [[passive.id,meaningful.id]]);
    expect(commands.rows).toEqual(expect.arrayContaining([
      {source_message_id: passive.id,state:'cancelled'}, {source_message_id: meaningful.id,state:'cancelled'},
    ]));
    const rows = await database.query<{text: string;presentation: string}>(
      `SELECT text,presentation FROM messages WHERE id=ANY($1::text[])`, [[passive.id,meaningful.id]]);
    expect(rows.rows.every(row => row.presentation === 'activity' && !row.text.includes('A person'))).toBe(true);
    await backfillComputerObservations(database);
    await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
    await endComputerSession(database, live, (await getComputerSession(database, meaningfulShare.id))!);
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
    const viewerHtml = await page.text();
    expect(viewerHtml).toContain('Page.screencastFrame');
    expect(viewerHtml).toContain('viewer-snapshot-request');
    expect(viewerHtml).toContain('computer-snapshot');
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
    await until(async () => (await database.query(`SELECT 1 FROM messages
      WHERE system_event->'payload'->>'sessionId'=$1
      AND system_event->'payload'->>'activity'='viewer-closed'`, [share.id])).rowCount ? true : undefined);
    expect((await database.query(`SELECT 1 FROM agent_commands command JOIN messages source ON source.id=command.source_message_id
      WHERE source.system_event->'payload'->>'sessionId'=$1`, [share.id])).rowCount).toBe(0);
    expect((await phone.readRoom(ROOM, HUMAN))?.messages.some(message =>
      message.systemEvent?.kind === 'computer-session-activity')).toBe(false);

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
    expect((await phone.readRoom(ROOM, HUMAN))?.messages.some(message =>
      message.systemEvent?.kind === 'computer-session-activity')).toBe(false);
    expect(activity.map((event) => event.system_event.payload.activity))
      .toEqual(expect.arrayContaining(['viewer-opened', 'viewer-closed', 'takeover', 'input', 'handback']));
    expect((await database.query(
      `SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`,
      [activity.find((event) => event.system_event.payload.activity === 'handback')!.id, AGENT],
    )).rowCount).toBe(0);
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
      expect(html).toContain('const scale=Math.max(');
      expect(html).not.toContain('beeline-handback');
      expect(html).not.toContain('beeline-end');
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

  for (const navigation of [{ url: 'https://httpbin.org/post?custname=private' }, { origin: 'https://httpbin.org' }]) {
    it(`keeps Squire's human input/navigation/handback quiet until a composer message (${'url' in navigation ? 'URL' : 'origin'})`, async () => {
      const roomId = randomUUID();
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Navigation proof')`, [roomId, WORKSPACE]);
      for (const identityId of [AGENT, HUMAN]) await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, roomId, identityId]);
      const squire = createServer((_request, response) => response.writeHead(200).end('live'));
      const streams = new WebSocketServer({ noServer: true });
      let upstream: WebSocket | undefined;
      squire.on('upgrade', (request, socket, head) => streams.handleUpgrade(request, socket, head, client => { upstream = client; }));
      await new Promise<void>(resolve => squire.listen(0, '127.0.0.1', resolve));
      const share = await createComputerSession(database, live, {
        roomId, agentId: AGENT, sessionId: `form-submit-${roomId}`,
        upstreamUrl: `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/form/`,
      });
      let viewer: WebSocket | undefined;
      try {
        const access = await computerViewToken(database, share.id, HUMAN);
        viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
        await opened(viewer);
        await until(async () => upstream);
        // Squire announces page state on stream start too. Agent/preview
        // navigation must not masquerade as a human's action.
        upstream!.send(JSON.stringify({ type: 'navigation', ...navigation }));
        const input = next(upstream!);
        viewer.send(JSON.stringify({ type: 'click', x: 0.1, y: 0.8 }));
        expect(JSON.parse(await input)).toMatchObject({ type: 'click' });
        upstream!.send(JSON.stringify({ type: 'control', state: 'human' }));
        upstream!.send(JSON.stringify({ type: 'frame', data: Buffer.from('form-response').toString('base64') }));
        await until(async () => (await database.query(`SELECT 1 FROM computer_session_events WHERE session_id=$1 AND name='input'`,
          [share.id])).rowCount ? true : undefined);
        expect((await database.query(`SELECT 1 FROM computer_session_events WHERE session_id=$1 AND name='navigation'`, [share.id])).rowCount).toBe(0);
        for (const message of [{ type: 'wheel', delta_y: 100 }, { type: 'text', text: 'private page input' }]) {
          const forwarded = next(upstream!);
          viewer.send(JSON.stringify(message));
          expect(JSON.parse(await forwarded)).toEqual(message);
        }
        await until(async () => (await database.query(`SELECT 1 FROM messages WHERE system_event->'payload'->>'sessionId'=$1
          AND system_event->'payload'->>'detail'='typing'`, [share.id])).rowCount ? true : undefined);
        expect((await database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1`, [roomId])).rowCount).toBe(0);
        // Only Squire's explicit main-frame navigation notification supplies
        // navigation evidence; pointer events and changed pixels cannot.
        upstream!.send(JSON.stringify({ type: 'navigation', ...navigation }));
        await until(async () => (await database.query(`SELECT 1 FROM messages WHERE
          system_event->'payload'->>'sessionId'=$1 AND system_event->'payload'->>'activity'='navigation'`, [share.id])).rowCount ? true : undefined);
        await phone.execute('handbackComputerSession', { id: share.id }, HUMAN);
        await until(async () => (await database.query(`SELECT 1 FROM messages WHERE
          system_event->'payload'->>'sessionId'=$1 AND system_event->'payload'->>'activity'='handback'`, [share.id])).rowCount ? true : undefined);
        expect((await database.query(`SELECT id FROM agent_commands WHERE room_id=$1`, [roomId])).rowCount).toBe(0);
        await database.query(`UPDATE identities SET handle='computer-agent' WHERE id=$1`, [AGENT]);
        await phone.execute('sendRoomMessage', { roomId, text: '@computer-agent Please check this screen' }, HUMAN);
        const commands = (await readAgentCommands(database, roomId, AGENT)).commands;
        expect(commands).toHaveLength(1);
        const command = commands[0]!;
        expect(command.reason).toBe('human_tag');
        const destination = new URL(navigation.url ?? navigation.origin!).href;
        const contextDir = await mkdtemp(join(process.cwd(), '.navigation-turn-'));
        const abort = new AbortController();
        const daemon = new DaemonService(database, live);
        let finalInput = '';
        try {
          await runServerCommandIntake({
            api: {
              execute: (name: string, input: unknown) => name === 'getAgentCommands'
                ? Promise.resolve({ commandProtocol: 1, commands: [command] })
                : daemon.execute(name as 'claimAgentCommand', input as { roomId: string; commandId: string; generationId: string }, AGENT),
              liveSubscribe: () => () => {},
            } as unknown as DaemonApiClient,
            roomId, agentId: AGENT, signal: abort.signal,
            context: new CommandExecutionContext(contextDir), stop: async () => {},
            run: async delivered => {
              finalInput = assembleTurnPrompt({ surface: 'room', task: {
                body: delivered.source.body, outsideEvent: delivered.source.systemEvent,
                commandReason: delivered.reason,
              } }).text;
              abort.abort();
            },
          });
          expect(finalInput).toContain('@computer-agent Please check this screen');
          const conversation = await daemon.execute('getRoomConversation', { roomId }, AGENT);
          expect(conversation.items.some(item => item.body === `Human navigated the shared browser to ${destination}`)).toBe(true);
        } finally { await rm(contextDir, { recursive: true, force: true }); }
        const events = await database.query<{ detail: string }>(
          `SELECT detail FROM computer_session_events WHERE session_id=$1 AND name='navigation'`, [share.id]);
        expect(events.rows).toEqual([{ detail: destination }]);
      } finally {
        await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
        viewer?.terminate();
        for (const client of streams.clients) client.terminate();
        await new Promise<void>(resolve => streams.close(() => resolve()));
        await new Promise<void>(resolve => squire.close(() => resolve()));
      }
    });
  }

  it('keeps renewed leases live, binds renewal to owner/source, and never revives an ended card', async () => {
    const upstreamUrl = `https://squire.test/s/${'r'.repeat(43)}/`;
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'rolling-share', upstreamUrl, expiresAt: Date.now() + 1_000,
    });
    const daemon = new DaemonService(database, live);
    const renew = (expiresAt: number) => daemon.execute('refreshComputerSession', {
      roomId: ROOM, sessionId: 'rolling-share', upstreamUrl, expiresAt,
    }, AGENT);
    for (let lifetime = 0; lifetime < 3; lifetime++) {
      // Cross each prior upstream deadline; the persisted renewal wins the sweep.
      await database.query(`UPDATE computer_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`, [share.id]);
      expect(await renew(Date.now() + 60_000)).toEqual({ live: true });
      await expireComputerSessions(database, live);
      expect((await getComputerSession(database, share.id))?.status).toBe('live');
    }
    const lease = { roomId: ROOM, agentId: AGENT, sessionId: 'rolling-share', upstreamUrl, expiresAt: Date.now() + 120_000 };
    expect(await refreshComputerSession(database, { ...lease, agentId: OTHER })).toEqual({ live: false });
    expect(await refreshComputerSession(database, { ...lease, upstreamUrl: 'https://another.test/' })).toEqual({ live: false });
    await expect(renew(NaN)).rejects.toThrow('expiry is invalid');
    await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
    expect(await renew(Date.now() + 120_000)).toEqual({ live: false });
    expect((await getComputerSession(database, share.id))?.status).toBe('ended');
  });

  it('rechecks expiry when renewal races a sweep that already selected the old lease', async () => {
    const gone = createServer((_request, response) => response.writeHead(410).end());
    await new Promise<void>(resolve => gone.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(gone.address() as AddressInfo).port}/s/${'r'.repeat(43)}/`;
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'renewal-race', upstreamUrl, expiresAt: Date.now() + 1_000,
    });
    await database.query(`UPDATE computer_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`, [share.id]);
    const racing = new Proxy(database, { get(target, property) {
      if (property === 'query') return async (sql: string, values?: unknown[]) => {
        const selected = await target.query(sql, values);
        if (sql.includes('FROM computer_sessions WHERE expires_at<=now()'))
          await refreshComputerSession(database, {
            roomId: ROOM, agentId: AGENT, sessionId: 'renewal-race', upstreamUrl, expiresAt: Date.now() + 60_000,
          });
        return selected;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expireComputerSessions(racing, live);
    expect((await getComputerSession(database, share.id))?.status).toBe('live');
    expect((await database.query<{ status: string }>(`SELECT card->>'status' AS status FROM messages WHERE id=$1`,
      [(await getComputerSession(database, share.id))!.message_id])).rows[0]?.status).toBe('live');
    await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
    await new Promise<void>(resolve => gone.close(() => resolve()));
  });

  it('keeps a stale lease live until Squire confirms the source was reaped, then closes viewers', async () => {
    const token = 'e'.repeat(43);
    let upstreamEnded = false;
    let upstreamUnavailable = false;
    const squire = createServer((_request, response) => {
      response.writeHead(upstreamEnded ? 410 : upstreamUnavailable ? 503 : 200).end('<!doctype html>');
    });
    const upstreamSockets = new WebSocketServer({ noServer: true });
    squire.on('upgrade', (request, socket, head) =>
      upstreamSockets.handleUpgrade(request, socket, head, (client) => upstreamSockets.emit('connection', client, request)));
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/${token}/`;
    try {
      const share = await createComputerSession(database, live, {
        roomId: ROOM, agentId: AGENT, sessionId: 'squire-expires', upstreamUrl, expiresAt: Date.now() + 1_500,
      });
      const lasting = await createComputerSession(database, live, {
        roomId: ROOM, agentId: AGENT, sessionId: 'squire-no-expiry', upstreamUrl,
      });
      const access = await computerViewToken(database, share.id, HUMAN);
      const viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      await opened(viewer);
      const viewerClosed = new Promise<void>((resolve) => viewer.once('close', () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 1_600));

      // Upstream leases roll independently of a delayed helper renewal.
      expect((await getComputerSession(database, share.id))?.status).toBe('live');
      await expireComputerSessions(database, live);
      expect((await getComputerSession(database, share.id))?.status).toBe('live');
      upstreamUnavailable = true;
      await expireComputerSessions(database, live);
      expect((await getComputerSession(database, share.id))?.status).toBe('live');
      upstreamUnavailable = false;
      const another = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      await opened(another);
      another.close();
      await new Promise<void>(resolve => another.once('close', resolve));

      upstreamEnded = true;
      expect((await fetch(`${origin}/s/${share.id}/?access=${access}`)).status).toBe(410);

      // A restarted server reconciles the source's actual end, not its old deadline.
      await migrate(database);
      const stop = startComputerExpirySweep(database, live, 60_000);
      try {
        await until(async () => (await database.query<{ status: string }>(
          'SELECT status FROM computer_sessions WHERE id=$1', [share.id])).rows[0]?.status === 'ended' ? true : undefined);
      } finally { stop(); }
      await viewerClosed;
      const refused = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      await expect(opened(refused)).rejects.toThrow();
      const card = (await database.query<{ card: { status: string } }>(
        `SELECT m.card FROM messages m JOIN computer_sessions c ON c.message_id=m.id WHERE c.id=$1`, [share.id])).rows[0];
      expect(card?.card.status).toBe('ended');
      const endedAt = (await database.query<{ ended_at: Date }>(
        'SELECT ended_at FROM computer_sessions WHERE id=$1', [share.id])).rows[0]?.ended_at;

      // Repeated processing changes nothing.
      expect(await expireComputerSessions(database, live)).toBe(0);
      await endComputerSession(database, live, { ...(await getComputerSession(database, share.id))!, status: 'live' });
      expect((await database.query<{ ended_at: Date }>(
        'SELECT ended_at FROM computer_sessions WHERE id=$1', [share.id])).rows[0]?.ended_at).toEqual(endedAt);
      expect((await getComputerSession(database, lasting.id))?.status).toBe('live');
      await endComputerSession(database, live, (await getComputerSession(database, lasting.id))!);
    } finally {
      for (const client of upstreamSockets.clients) client.close();
      await new Promise<void>((resolve) => upstreamSockets.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
    }
  }, 60_000);

  it('coalesces each share into one latest observation, behind human requests, with silent failures', async () => {
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'activity-burst', upstreamUrl: 'body:',
    });
    const observe = (name: string) => systemLine(database, {
      roomId: ROOM, authorId: SYSTEM_IDENTITY_ID, subject: { kind: 'system', name: 'A person' },
      verb: 'used', object: `the shared browser ${name}`, kind: 'computer-session-activity',
      payload: { sessionId: share.id, activity: name }, wakes: [AGENT],
    });
    const opened = await observe('viewer-opened');
    const snapshot = (await readAgentCommands(database, ROOM, AGENT)).commands.find((c) => c.sourceMessageId === opened.id)!;
    await observe('pointer');
    const latest = await observe('navigation');
    const pending = await database.query<{ id: string; source_message_id: string }>(
      `SELECT id,source_message_id FROM agent_commands WHERE reason='computer_activity'
       AND source_message_id IN (SELECT id FROM messages WHERE system_event->'payload'->>'sessionId'=$1)
       AND state='pending'`, [share.id]);
    expect(pending.rows).toEqual([{ id: snapshot.id, source_message_id: latest.id }]);
    const humanId = '9'.repeat(64);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please answer')`, [humanId, ROOM, HUMAN]);
    const human = await createAgentCommand(database, { roomId: ROOM, agentId: AGENT, sourceMessageId: humanId, reason: 'human_tag' });
    const duringHumanRequest = (await readAgentCommands(database, ROOM, AGENT)).commands;
    expect(duringHumanRequest.some((c) => c.id === human!.id)).toBe(true);
    expect(duringHumanRequest.some((c) => c.id === snapshot.id)).toBe(false);
    await expect(claimAgentCommand(database, ROOM, AGENT, snapshot.id, 'activity-generation')).rejects.toThrow('command claim conflict');
    await claimAgentCommand(database, ROOM, AGENT, human!.id, 'human-generation');
    await expect(claimAgentCommand(database, ROOM, AGENT, snapshot.id, 'activity-generation')).rejects.toThrow('command claim conflict');
    await database.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [human!.id]);
    const daemon = new DaemonService(database, live, origin);
    const claimed = await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: snapshot.id, generationId: 'activity-generation' }, AGENT);
    expect(claimed.activitySource).toMatchObject({ body: 'A person used the shared browser navigation',
      systemEvent: { payload: { sessionId: share.id, activity: 'navigation' } } });
    expect(claimed.recoveryContext).toBe('A person used the shared browser viewer-opened\nA person used the shared browser pointer\nA person used the shared browser navigation');
    await observe('typing');
    await observe('handback');
    // Lost claim responses remain replayable even when a person arrives next.
    const anotherHumanId = '8'.repeat(64);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Another request')`, [anotherHumanId, ROOM, HUMAN]);
    const anotherHuman = await createAgentCommand(database, { roomId: ROOM, agentId: AGENT, sourceMessageId: anotherHumanId, reason: 'human_tag' });
    await expect(claimAgentCommand(database, ROOM, AGENT, snapshot.id, 'activity-generation')).resolves.toMatchObject({ id: snapshot.id });
    await database.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [anotherHuman!.id]);
    expect((await readAgentCommands(database, ROOM, AGENT)).commands.filter((c) =>
      (c.source.systemEvent?.payload as { sessionId?: string })?.sessionId === share.id)).toHaveLength(1);
    const silence = await noteFirstSilence(database, live, { roomId: ROOM, agentId: AGENT,
      requestId: snapshot.turnRequestId, generationId: 'activity-generation', reason: 'harness returned no text' });
    expect(silence).toMatchObject({ hiccupRestart: false, updateRequeued: false });
    expect((await database.query(`SELECT id FROM messages WHERE room_id=$1 AND card_type='turn-failed'
      AND card->>'requestId'=$2`, [ROOM, snapshot.turnRequestId])).rowCount).toBe(0);
    await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
    await database.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1 AND reason='computer_activity'`, [ROOM]);
  });

  it('replays authorized HTML to the source machine that owns the preview cache', async () => {
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'machine-cache', upstreamUrl: 'body:',
    });
    const access = await computerViewToken(database, share.id, HUMAN);
    const previous = process.env.FLY_MACHINE_ID;
    try {
      await database.query(`UPDATE computer_sessions SET relay_instance_id='source-machine' WHERE id=$1`, [share.id]);
      process.env.FLY_MACHINE_ID = 'other-machine';
      const denied = await fetch(`${origin}/s/${share.id}/`, { redirect: 'manual' });
      expect(denied.status).toBe(403);
      expect(denied.headers.get('fly-replay')).toBeNull();
      const replay = await fetch(`${origin}/s/${share.id}/?access=${access}`, { redirect: 'manual' });
      expect(replay.status).toBe(307);
      expect(replay.headers.get('fly-replay')).toBe('instance=source-machine');
    } finally {
      if (previous === undefined) delete process.env.FLY_MACHINE_ID;
      else process.env.FLY_MACHINE_ID = previous;
      await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
    }
  });

  it('keeps one Squire tunnel and cached HTML/frame through five full-view reopenings beside a preview', async () => {
    let htmlReads = 0;
    const frame = JSON.stringify({ type: 'frame', data: Buffer.from('warm preview').toString('base64') });
    const squire = createServer((_request, response) => {
      htmlReads++;
      response.end('<!doctype html><head></head><body><script>const socket=new WebSocket(new URL("stream", location.href));</script></body>');
    });
    const streams = new WebSocketServer({ noServer: true });
    let tunnels = 0;
    let source: WebSocket | undefined;
    squire.on('upgrade', (request, socket, head) => streams.handleUpgrade(request, socket, head, (client) => {
      tunnels++;
      source = client;
      client.on('message', data => {
        const message = JSON.parse(data.toString());
        client.send(JSON.stringify({ type: 'control', state: message.type === 'release' ? 'agent' : 'human' }));
      });
      client.send(frame);
    }));
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'warm-squire',
      upstreamUrl: `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/warm/`,
    });
    const access = await computerViewToken(database, share.id, HUMAN);
    const url = `${origin}/s/${share.id}/?access=${access}`;
    await fetch(url + '&preview=1');
    const preview = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}&preview=1`);
    const ready = next(preview);
    await opened(preview);
    expect(await ready).toBe(frame);
    try {
      for (let sample = 0; sample < 5; sample++) {
        const html = await fetch(url);
        expect(html.headers.get('server-timing')).toContain('cached');
        expect(await html.text()).toContain(`atob('${Buffer.from(frame).toString('base64')}')`);
        const viewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
        const cached = next(viewer);
        await opened(viewer);
        expect(await Promise.race([cached, new Promise((r) => setTimeout(() => r('no cached frame'), 1000))])).toBe(frame);
        const liveFrame = next(viewer);
        source!.send(frame);
        expect(await liveFrame).toBe(frame);
        const input = next(source!);
        viewer.send(JSON.stringify({ type: 'text', text: `sample ${sample}` }));
        expect(JSON.parse(await input)).toEqual({ type: 'text', text: `sample ${sample}` });
        viewer.close();
        await new Promise<void>((resolve) => viewer.once('close', resolve));
      }
      expect(tunnels).toBe(1);
      expect(htmlReads).toBe(1);
      // The upstream web canvas sends pointer; touch is the phone path.
      const pointerViewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      await opened(pointerViewer);
      const pointer = next(source!);
      pointerViewer.send(JSON.stringify({ type: 'pointer', phase: 'down', x: 0.5, y: 0.5 }));
      expect(JSON.parse(await pointer)).toMatchObject({ type: 'pointer' });
      await until(async () => (await database.query(
        `SELECT 1 FROM computer_session_events WHERE session_id=$1 AND name='input' AND detail='pointer'`, [share.id],
      )).rowCount ? true : undefined);
      const release = next(source!);
      pointerViewer.close();
      await new Promise<void>((resolve) => pointerViewer.once('close', resolve));
      expect(JSON.parse(await release)).toEqual({ type: 'release' });
      const blockedInput: string[] = [];
      source!.on('message', (data) => blockedInput.push(data.toString()));
      preview.send(JSON.stringify({ type: 'text', text: 'preview cannot control' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(blockedInput).toEqual([]);
      const warmViewer = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}&warm=1`);
      await opened(warmViewer);
      warmViewer.send(JSON.stringify({ type: 'text', text: 'hidden viewer' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(blockedInput).toEqual([]);
      warmViewer.send(JSON.stringify({ type: 'viewer-mode', interactive: true }));
      warmViewer.send(JSON.stringify({ type: 'text', text: 'visible viewer' }));
      await until(async () => blockedInput.length ? true : undefined);
      expect(JSON.parse(blockedInput[0]!)).toEqual({ type: 'text', text: 'visible viewer' });
      warmViewer.send(JSON.stringify({ type: 'viewer-mode', interactive: false }));
      warmViewer.send(JSON.stringify({ type: 'text', text: 'closed viewer' }));
      await until(async () => blockedInput.length >= 2 ? true : undefined);
      expect(blockedInput.map(value => JSON.parse(value))).toEqual([
        { type: 'text', text: 'visible viewer' }, { type: 'release' },
      ]);
      warmViewer.close();
      await new Promise<void>((resolve) => warmViewer.once('close', resolve));
      expect(tunnels).toBe(1);
    } finally {
      await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
      preview.close();
      for (const client of streams.clients) client.close();
      await new Promise<void>((resolve) => streams.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
    }
  });

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
