import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
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
import type { TokenAuth } from './auth.js';
import { createBeelineServer } from './server.js';
import { readRoomViewMessage } from '@beeline/api-contract/phone';
import { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';
import { assembleTurnPrompt } from '../../body/src/prompt-assembly.js';
import type { DaemonApiClient } from '../../body/src/daemon-api-client.js';
import {
  VIEWER_LAYOUT_SCRIPT, computerViewToken, computerViewerHtml, createComputerSession, endComputerSession, expireComputerSessions, getComputerSession, refreshComputerSession, serveComputerSession,
  serveComputerStatus, startComputerExpirySweep, trustedComputerShareUpstream, upgradeBodyComputerSource, upgradeComputerSession, upgradeComputerWaiter,
} from './computer-session.js';

const HUMAN = 'a'.repeat(64);
const OTHER = 'c'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111119';
const ROOM = '22222222-2222-4222-8222-222222222229';
/** Test Squire servers listen on loopback, which production shares reject. */
const testSquire = (upstream: URL) => ['127.0.0.1', 'squire.test'].includes(upstream.hostname);

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

  it('Reproduction 2026-10-20: public links open Beeline and token failures explain access', async () => {
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'public-link', upstreamUrl: 'body:',
    });
    const publicPage = await fetch(`${origin}/s/${share.id}/`);
    expect(publicPage.status).toBe(200);
    const html = await publicPage.text();
    expect(html).toContain(`https://web.usebeeline.app/beeline/browser-share?id=${share.id}`);
    expect(html).toContain(`beeline://beeline/browser-share?id=${share.id}`);
    expect(html).not.toContain(ROOM);
    const unknown = await fetch(`${origin}/s/${'z'.repeat(43)}/`);
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toContain('Open Beeline and sign in');
    const invalid = await fetch(`${origin}/s/${share.id}/?access=invalid`);
    expect(invalid.status).toBe(403);
    expect(await invalid.text()).toContain('You do not have access');
    const row = (await getComputerSession(database, share.id))!;
    const expires = Date.now() - 1000;
    const signature = createHmac('sha256', row.view_secret!).update(`${share.id}.${HUMAN}.${expires}`).digest('hex');
    const expired = await fetch(`${origin}/s/${share.id}/?access=${HUMAN}.${expires}.${signature}`);
    expect(expired.status).toBe(403);
    expect(await expired.text()).toContain('has expired');
    const access = await computerViewToken(database, share.id, HUMAN);
    const allowed = await fetch(`${origin}/s/${share.id}/?access=${access}`);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('Page.screencastFrame');
    const otherAccess = await computerViewToken(database, share.id, OTHER);
    await database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, OTHER]);
    try {
      const refused = await fetch(`${origin}/s/${share.id}/?access=${otherAccess}`);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain('You do not have access');
    } finally {
      await database.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [ROOM, OTHER]);
    }
    await endComputerSession(database, live, row);
    const ended = await fetch(`${origin}/s/${share.id}/?access=${access}`);
    expect(ended.status).toBe(410);
    expect(await ended.text()).toContain('has ended');
  });

  it('Reproduction SHARE-CARD-DM-1: delivers the committed card directly to an open owner DM', async () => {
    const dm = '33333333-3333-4333-8333-333333333339';
    await database.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants)
      VALUES($1,$2,'Direct message',$3::jsonb)`, [dm, WORKSPACE, JSON.stringify([HUMAN, AGENT])]);
    for (const member of [HUMAN, AGENT]) await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, dm, member]);
    const mounted = createBeelineServer({ database, live, phone,
      auth: { authenticatePhone: async (token: string) => token === 'owner' ? HUMAN : OTHER } as unknown as TokenAuth,
      daemon: new DaemonService(database, live), mediaMaximumBytes: 1024 });
    await new Promise<void>((resolve) => mounted.listen(0, '127.0.0.1', resolve));
    const port = (mounted.address() as AddressInfo).port;
    const owner = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.owner']);
    const outsider = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.outsider']);
    const received: Array<Record<string, any>> = [];
    const forbidden: Array<Record<string, any>> = [];
    owner.on('message', raw => received.push(JSON.parse(raw.toString())));
    outsider.on('message', raw => forbidden.push(JSON.parse(raw.toString())));
    try {
      await Promise.all([opened(owner), opened(outsider)]);
      const subscribed = nextType(owner, 'subscribed');
      owner.send(JSON.stringify({ type: 'subscribe', roomIds: [dm] }));
      outsider.send(JSON.stringify({ type: 'subscribe', roomIds: [dm] }));
      await subscribed;
      const share = await createComputerSession(database, live, {
        roomId: dm, agentId: AGENT, sessionId: 'dm-card-delivery', upstreamUrl: 'body:', title: 'Shared browser',
      });
      // No LISTEN bridge and no covering Room read: the publishing service
      // must deliver the card itself to an already-open transcript.
      for (let attempt = 0; attempt < 100 && !received.some(frame => frame.type === 'message-delta'); attempt++)
        await new Promise(resolve => setTimeout(resolve, 10));
      const delta = received.find(frame => frame.type === 'message-delta');
      expect(delta?.message.id).toBe(share.messageId);
      expect(readRoomViewMessage(delta?.message)?.computerSession).toMatchObject({ id: share.id, status: 'live' });
      expect(forbidden.some(frame => frame.type === 'message-delta')).toBe(false);
      expect((await phone.readRoom(dm, HUMAN))?.messages.find(message => message.id === share.messageId)?.computerSession)
        .toMatchObject({ id: share.id, status: 'live' });
    } finally {
      owner.terminate(); outsider.terminate();
      await new Promise<void>(resolve => mounted.close(() => resolve()));
      await database.query('DELETE FROM rooms WHERE id=$1', [dm]);
    }
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
    expect((await fetch(`${origin}/s/${share.id}`)).status).toBe(200);
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
      expect((await fetch(`${origin}/s/${share.id}`)).status).toBe(200);
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
      response.end('<!doctype html><head><meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=yes"></head><body><div id="bar"></div><script>const socket = new WebSocket(new URL("stream", location.href));</script></body>');
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
      }, testSquire);
      const access = await computerViewToken(database, share.id, HUMAN);
      const loading = await (await fetch(`${origin}/s/${share.id}/?access=${access}`)).text();
      expect(loading).toContain('Connecting to browser');
      expect(loading).toContain('location.replace(next.href)');
      const html = await (await fetch(`${origin}/s/${share.id}/?access=${access}`)).text();
      expect(html).not.toContain(upstreamUrl);
      expect(html).not.toContain(token);
      expect(html).toContain('new URL("stream" + location.search, location.href)');
      expect(html).toContain('function viewerLayout(');
      // The viewer owns the gesture: no document zoom and no upstream viewport.
      expect(html).toContain('maximum-scale=1,user-scalable=no');
      expect(html).toContain('html,body{background:#1b1320!important;touch-action:none!important');
      expect(html).not.toContain('shrink-to-fit=yes');
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
      }, testSquire);
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

  it('rejects share upstreams outside the trusted Squire tunnel hosts', async () => {
    const token = 'r'.repeat(43);
    for (const upstreamUrl of [
      'http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.1/', 'http://[fdaa::1]/', 'http://x.internal/',
      'http://169.254.169.254/', 'https://127.0.0.1/', 'https://[fdaa::1]/', 'https://localhost/',
      'https://db.internal/', 'https://printer.local/', 'https://evil.example/', 'https://trycloudflare.com/',
      'https://faketrycloudflare.com/', `http://share.trycloudflare.com/s/${token}/`,
      `https://user:pass@share.trycloudflare.com/s/${token}/`, 'not a url',
    ]) {
      await expect(createComputerSession(database, live, {
        roomId: ROOM, agentId: AGENT, sessionId: `rejected-${upstreamUrl}`, upstreamUrl,
      }), upstreamUrl).rejects.toThrow('computer share URL is invalid');
    }
    const trusted = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'trusted-tunnel',
      upstreamUrl: `https://quiet-river-1.trycloudflare.com/s/${token}/`,
    });
    expect((await getComputerSession(database, trusted.id))?.upstream_url).toBe(`https://quiet-river-1.trycloudflare.com/s/${token}/`);
    expect((await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'trusted-body', upstreamUrl: 'body:',
    })).id).toBeTruthy();
    expect(trustedComputerShareUpstream(new URL(`https://share.squire.example/s/${token}/`))).toBe(false);
    expect(trustedComputerShareUpstream(new URL(`https://quiet-river-1.trycloudflare.com/s/${token}/`))).toBe(true);
    await database.query(`UPDATE computer_sessions SET status='ended' WHERE source_session_id IN ('trusted-tunnel','trusted-body')`);
  });

  it('keeps renewed leases live, binds renewal to owner/source, and never revives an ended card', async () => {
    const upstreamUrl = `https://squire.test/s/${'r'.repeat(43)}/`;
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'rolling-share', upstreamUrl, expiresAt: Date.now() + 1_000,
    }, testSquire);
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
    }, testSquire);
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
      }, testSquire);
      const lasting = await createComputerSession(database, live, {
        roomId: ROOM, agentId: AGENT, sessionId: 'squire-no-expiry', upstreamUrl,
      }, testSquire);
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
      expect(denied.status).toBe(200);
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
    }, testSquire);
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
      // Copy returns the shared tab's selection to the controlling viewer.
      existingDevtools.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'getSelection().selectAllChildren(document.body)' } }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const copied = nextType(viewer, 'clipboard');
      viewer.send(JSON.stringify({ type: 'copy' }));
      expect(await copied).toEqual({ type: 'clipboard', text: 'Click' });
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

  /**
   * Drives a real touchscreen into the served viewer with Chrome DevTools
   * Protocol. It runs a two-finger pinch-out, a pinch-in, a second pinch-out,
   * a one-finger pan and then a tap, recording the viewer surface box at each
   * phase so a test can prove the gesture zooms and pans. It returns the
   * surface rect and remote size at tap time so the test can check the mapped
   * tap coordinate.
   */
  async function gestureViewer(pageUrl: string, options: {
    pinch: { x: number; y: number }[];
    /** Remote viewport size the viewer maps against, when it is not a canvas. */
    remote?: { width: number; height: number };
    onPhase?: (name: string) => void;
  }) {
    const profile = await mkdtemp(join(process.cwd(), '.pinch-e2e-'));
    const chrome = spawn(chromeBinary, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, pageUrl,
    ], { stdio: 'ignore' });
    try {
      const port = await until(async () => {
        try {
          const found = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
          return found > 0 ? found : undefined;
        } catch { return undefined; }
      }, 15_000);
      const page = await until(async () => {
        try { return await findChromiumPage(`http://127.0.0.1:${port}`); } catch { return undefined; }
      });
      const socket = new WebSocket(page.webSocketDebuggerUrl!);
      await opened(socket);
      let serial = 0;
      const pending = new Map<number, (value: Record<string, unknown>) => void>();
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; result?: Record<string, unknown>; error?: unknown };
        if (message.id && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
      });
      const command = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++serial;
        pending.set(id, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result ?? {}));
        socket.send(JSON.stringify({ id, method, params }));
      });
      const evaluate = async <T>(expression: string) => {
        const result = await command('Runtime.evaluate', { expression, returnByValue: true });
        return (result as { result?: { value?: T } }).result?.value;
      };
      await command('Runtime.enable');
      await command('Page.enable');
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
      await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await command('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }] });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
      const reload = async () => {
        await command('Page.reload');
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      };
      const touch = async (type: string, points: Record<string, number>[]) => {
        await command('Input.dispatchTouchEvent', { type, touchPoints: points });
        await new Promise((resolve) => setTimeout(resolve, 30));
      };
      const spread = async (points: Record<string, number>[], step: number) => {
        await touch('touchStart', points);
        for (let index = 1; index <= 8; index++) {
          await touch('touchMove', points.map((point, position) => ({
            x: point.x + (position === 0 ? -index * step : index * step), y: point.y,
          })));
        }
        await touch('touchEnd', []);
        await settle();
      };
      const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        await touch('touchStart', [{ x: from.x, y: from.y, id: 0 }]);
        for (let index = 1; index <= 6; index++) {
          await touch('touchMove', [{ x: from.x + (to.x - from.x) * index / 6, y: from.y + (to.y - from.y) * index / 6, id: 0 }]);
        }
        await touch('touchEnd', []);
        await settle();
      };
      const tap = async (point: { x: number; y: number }) => {
        await touch('touchStart', [{ x: point.x, y: point.y, id: 0 }]);
        await touch('touchEnd', []);
        await settle();
      };
      const surfaceBox = () => evaluate<{ width: string; left: string; top: string }>(
        `(() => { const el = document.getElementById('canvas') || document.getElementById('screen');
          return { width: el.style.width, left: el.style.left, top: el.style.top }; })()`);
      const surfaceRect = () => evaluate<{ left: number; top: number; width: number; height: number }>(
        `(() => { const el = document.getElementById('canvas') || document.getElementById('screen');
          const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
      const phase = (name: string) => options.onPhase?.(name);
      await reload();
      const before = await surfaceBox();
      phase('start');
      await spread(options.pinch, 10);
      const afterPinchOut = await surfaceBox();
      phase('pinch-out');
      await spread(options.pinch, -8);
      const afterPinchIn = await surfaceBox();
      phase('pinch-in');
      await spread(options.pinch, 14);
      const afterPinchOutAgain = await surfaceBox();
      phase('pinch-out-2');
      const origin = options.pinch[0]!;
      await drag({ x: origin.x, y: origin.y }, { x: origin.x - 80, y: origin.y - 60 });
      const afterPan = await surfaceBox();
      phase('pan');
      const tapPoint = { x: 200, y: 350 };
      const tapRect = await surfaceRect();
      const tapRemote = options.remote ?? await evaluate<{ width: number; height: number }>(
        `(() => { const c = document.getElementById('canvas'); return { width: c.width, height: c.height }; })()`);
      phase('before-tap');
      await tap(tapPoint);
      phase('tap');
      const scale = await evaluate<number>('visualViewport.scale');
      // The viewer must own the gesture: no document page-zoom and no native
      // pinch target, or the host WebView cancels the second finger.
      const viewport = await evaluate<string>(`document.querySelector('meta[name="viewport"]')?.content ?? ''`);
      const bodyTouchAction = await evaluate<string>(`getComputedStyle(document.body).touchAction`);
      socket.close();
      return { before, afterPinchOut, afterPinchIn, afterPinchOutAgain, afterPan,
        tapPoint, tapRect, tapRemote, scale, viewport, bodyTouchAction };
    } finally {
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGTERM');
        await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }

  /** True when a viewer message would reach the remote as real input. */
  function isForwardedInput(raw: string): boolean {
    try {
      const message = JSON.parse(raw) as { type?: string; method?: string };
      if (message.type === 'touch' || message.type === 'wheel') return true;
      return typeof message.method === 'string' && message.method.startsWith('Input.');
    } catch { return false; }
  }

  /** The remote coordinate a forwarded tap targeted, in either viewer's wire shape. */
  function forwardedTapPoint(raw: string): { x: number; y: number } | undefined {
    try {
      const message = JSON.parse(raw) as { type?: string; phase?: string; x?: number; y?: number;
        method?: string; params?: { type?: string; x?: number; y?: number } };
      if (message.type === 'touch' && message.phase === 'start'
        && typeof message.x === 'number' && typeof message.y === 'number') return { x: message.x, y: message.y };
      if (message.method === 'Input.dispatchMouseEvent' && message.params?.type === 'mousePressed'
        && typeof message.params.x === 'number' && typeof message.params.y === 'number')
        return { x: message.params.x, y: message.params.y };
      return undefined;
    } catch { return undefined; }
  }

  /** Shared assertions for both served-viewer touch proofs. */
  function expectViewerGesture(
    gesture: Awaited<ReturnType<typeof gestureViewer>>,
    forwarded: string[],
    inputCounts: Record<string, number>,
  ): void {
    // The viewer owns the gesture: no document page-zoom and no native pinch target.
    expect(gesture.scale).toBe(1);
    expect(gesture.viewport).toContain('maximum-scale=1');
    expect(gesture.viewport).toContain('user-scalable=no');
    expect(gesture.bodyTouchAction).toBe('none');
    // Pinch-out, pinch-in and a second pinch-out each change the viewer zoom.
    expect(gesture.afterPinchOut.width).not.toBe(gesture.before.width);
    expect(gesture.afterPinchIn.width).not.toBe(gesture.afterPinchOut.width);
    expect(gesture.afterPinchOutAgain.width).not.toBe(gesture.afterPinchIn.width);
    // A one-finger drag after zoom pans the surface.
    expect(`${gesture.afterPan.left},${gesture.afterPan.top}`)
      .not.toBe(`${gesture.afterPinchOutAgain.left},${gesture.afterPinchOutAgain.top}`);
    // Criterion 2: no real input reaches the remote during pinch-out, pinch-in
    // or pan. The tap's own input is counted so the zeroes are not vacuous.
    expect(inputCounts['pinch-out']).toBe(inputCounts['start']);
    expect(inputCounts['pinch-in']).toBe(inputCounts['pinch-out']);
    expect(inputCounts['pan']).toBe(inputCounts['pinch-out-2']);
    expect(inputCounts['tap']).toBeGreaterThan(inputCounts['before-tap']!);
    // The detector catches both wire shapes, including the body viewer's CDP
    // Input.* messages, so a leaked pinch would fail the zero counts above.
    expect(isForwardedInput(JSON.stringify({ type: 'touch', phase: 'move', x: 1, y: 2 }))).toBe(true);
    expect(isForwardedInput(JSON.stringify({ type: 'wheel', delta_x: 1, delta_y: 2 }))).toBe(true);
    expect(isForwardedInput(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 1, y: 2 } }))).toBe(true);
    expect(isForwardedInput(JSON.stringify({ type: 'takeover' }))).toBe(false);
    // Tap-to-click after zoom maps the screen point through the zoomed/panned rect.
    const taps = forwarded.map(forwardedTapPoint).filter((point): point is { x: number; y: number } => Boolean(point));
    expect(taps).toHaveLength(1);
    const scale = gesture.tapRemote.width / gesture.tapRect.width;
    expect(taps[0]!.x).toBeCloseTo((gesture.tapPoint.x - gesture.tapRect.left) * scale, 0);
    expect(taps[0]!.y).toBeCloseTo((gesture.tapPoint.y - gesture.tapRect.top) * scale, 0);
  }

  type ViewerLayout = { fitted: boolean; zoom: number; minZoom: number; scale: number; width: number; height: number;
    left: number; top: number; viewWidth: number; viewHeight: number; remoteWidth: number; remoteHeight: number };
  const viewerLayoutMath = new Function(`${VIEWER_LAYOUT_SCRIPT}; return { viewerLayout, viewerZoomAt };`)() as {
    viewerLayout: (state: Partial<ViewerLayout>, viewWidth: number, viewHeight: number, remoteWidth: number, remoteHeight: number) => ViewerLayout;
    viewerZoomAt: (state: ViewerLayout, zoom: number, x: number, y: number) => ViewerLayout;
  };

  it('Reproduction SB-CENTER-1 and SB-ZOOM-1: opens centred, zooms from the whole page to 4x and stays centred', () => {
    const { viewerLayout, viewerZoomAt } = viewerLayoutMath;
    // A 1279x936 Squire page in a 900x700 desktop frame opens filling the
    // frame, with the overflow split evenly instead of pinned to the left.
    const opened = viewerLayout({ zoom: 1, left: 0, top: 0, fitted: false }, 900, 700, 1279, 936);
    expect(opened.height).toBeCloseTo(700);
    expect(opened.left).toBeCloseTo((900 - opened.width) / 2);
    expect(opened.top).toBe(0);
    // Zooming out stops at the whole page in view, centred on both axes.
    const out = viewerLayout(viewerZoomAt(opened, 0.01, 450, 350), 900, 700, 1279, 936);
    expect(out.zoom).toBeCloseTo(opened.minZoom);
    expect(out.zoom).toBeLessThan(1);
    expect(out.width).toBeCloseTo(900);
    expect(out.height).toBeLessThan(700);
    expect(out.left).toBeCloseTo(0);
    expect(out.top).toBeCloseTo((700 - out.height) / 2);
    // Zooming in keeps the point under the cursor and stops at 4x.
    const inside = viewerLayout(viewerZoomAt(opened, 2, 300, 200), 900, 700, 1279, 936);
    expect((300 - inside.left) / inside.scale).toBeCloseTo((300 - opened.left) / opened.scale);
    expect(viewerLayout(viewerZoomAt(inside, 50, 300, 200), 900, 700, 1279, 936).zoom).toBe(4);
    // A narrower frame or a phone rotation keeps the page centred.
    const narrower = viewerLayout(opened, 760, 700, 1279, 936);
    expect(narrower.left).toBeCloseTo((760 - narrower.width) / 2);
    const phone = viewerLayout({ zoom: 1, left: 0, top: 0, fitted: false }, 390, 800, 1279, 936);
    expect(phone.left).toBeCloseTo((390 - phone.width) / 2);
    const rotated = viewerLayout(phone, 800, 390, 1279, 936);
    expect(rotated.left).toBeCloseTo((800 - rotated.width) / 2);
    // A new remote size opens centred again.
    const resized = viewerLayout({ ...inside }, 900, 700, 1600, 900);
    expect(resized.left).toBeCloseTo((900 - resized.width) / 2);
  });

  it('returns copied page text only to the controlling body viewer', async () => {
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'body-copy', upstreamUrl: 'body:', title: 'Body copy',
    });
    const source = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/source`);
    await opened(source);
    const toSource: Record<string, unknown>[] = [];
    source.on('message', (data) => toSource.push(JSON.parse(data.toString()) as Record<string, unknown>));
    const controller = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${await computerViewToken(database, share.id, HUMAN)}`);
    const watcher = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${await computerViewToken(database, share.id, OTHER)}`);
    await Promise.all([opened(controller), opened(watcher)]);
    const watched: string[] = [];
    watcher.on('message', (data) => watched.push(data.toString()));
    try {
      watcher.send(JSON.stringify({ type: 'copy' }));
      controller.send(JSON.stringify({ type: 'takeover' }));
      controller.send(JSON.stringify({ type: 'copy' }));
      await until(async () => toSource.some((message) => message.type === 'copy') ? true : undefined);
      expect(toSource.filter((message) => message.type === 'copy')).toHaveLength(1);
      const copied = nextType(controller, 'clipboard');
      source.send(JSON.stringify({ type: 'clipboard', text: 'selected words' }));
      expect(await copied).toEqual({ type: 'clipboard', text: 'selected words' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(watched.some((raw) => raw.includes('selected words'))).toBe(false);
    } finally {
      controller.close(); watcher.close(); source.close();
      await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
    }
  });

  it.skipIf(!existsSync(chromeBinary))('Reproduction SB-PASTE-1 and SB-ZOOM-1: pastes the viewer clipboard and zooms on trackpad pinch in the Squire bridge', async () => {
    // The input handlers below follow Squire's live viewer page: it forwards
    // Ctrl/Cmd+letter as a key, pastes clipboard text and forwards wheels.
    const squire = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        html,body{margin:0;width:100%;height:100%}body{display:flex;flex-direction:column}#screen{flex:1;min-height:0}</style></head><body>
        <div id="bar"><span id="state"></span><button id="focus"></button></div>
        <div id="screen"><canvas id="canvas" tabindex="0" width="1279" height="936"></canvas></div>
        <input id="keyboard" type="text">
        <script>const canvas=document.getElementById('canvas');const socket = new WebSocket(new URL("stream", location.href));
        function send(message){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));}
        function sendText(value){send({type:'text',text:value});}
        function point(event){const r=canvas.getBoundingClientRect();return {x:(event.clientX-r.left)/r.width,y:(event.clientY-r.top)/r.height};}
        canvas.addEventListener('pointerdown',event=>{event.preventDefault();canvas.focus();send({type:'pointer',phase:'down',...point(event)});});
        canvas.addEventListener('wheel',event=>{event.preventDefault();send({type:'wheel',delta_x:event.deltaX,delta_y:event.deltaY,...point(event)});},{passive:false});
        canvas.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey||event.altKey)&&/^[a-z]$/i.test(event.key)){
          event.preventDefault();send({type:'key',key:event.key,ctrl:event.ctrlKey,meta:event.metaKey});}});
        document.addEventListener('paste',event=>{if(document.activeElement!==canvas)return;const text=event.clipboardData?.getData('text/plain');
          if(text){event.preventDefault();sendText(text);}});</script></body>`);
    });
    const streams = new WebSocketServer({ noServer: true });
    const forwarded: Record<string, unknown>[] = [];
    squire.on('upgrade', (request, socket, head) => streams.handleUpgrade(request, socket, head, (client) => streams.emit('connection', client, request)));
    streams.on('connection', (socket) => socket.on('message', (data) => forwarded.push(JSON.parse(data.toString()) as Record<string, unknown>)));
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'squire-paste',
      upstreamUrl: `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/${'p'.repeat(43)}/`,
    }, testSquire);
    const access = await computerViewToken(database, share.id, HUMAN);
    const profile = await mkdtemp(join(process.cwd(), '.paste-e2e-'));
    const chrome = spawn(chromeBinary, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, `${origin}/s/${share.id}/?access=${access}&embedded=1`,
    ], { stdio: 'ignore' });
    try {
      const port = await until(async () => {
        try {
          const found = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
          return found > 0 ? found : undefined;
        } catch { return undefined; }
      }, 15_000);
      const page = await until(async () => {
        try { return await findChromiumPage(`http://127.0.0.1:${port}`, share.id); } catch { return undefined; }
      });
      const socket = new WebSocket(page.webSocketDebuggerUrl!);
      await opened(socket);
      let serial = 0;
      const pending = new Map<number, (value: { result?: Record<string, unknown>; error?: unknown }) => void>();
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; result?: Record<string, unknown>; error?: unknown };
        if (message.id && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
      });
      const command = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++serial;
        pending.set(id, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result ?? {}));
        socket.send(JSON.stringify({ id, method, params }));
      });
      const evaluate = async <T>(expression: string) =>
        ((await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })) as { result?: { value?: T } }).result?.value as T;
      const canvasBox = () => evaluate<{ left: number; width: number; height: number; view: number; viewHeight: number }>(
        `(() => { const r = document.getElementById('canvas').getBoundingClientRect(), s = document.getElementById('screen');
          return { left: r.left, width: r.width, height: r.height, view: s.clientWidth, viewHeight: s.clientHeight }; })()`);
      const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
        command('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
      await command('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
      await command('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
      await until(async () => { const box = await canvasBox(); return box.height === box.viewHeight ? true : undefined; });
      const start = await canvasBox();
      expect(start.left).toBeCloseTo((start.view - start.width) / 2, 0);
      // Trackpad pinch zooms in and back out to the whole page, centred, and
      // never reaches the remote page as a wheel.
      for (let index = 0; index < 4; index++) await mouse('mouseWheel', 450, 350, { deltaX: 0, deltaY: -60, modifiers: 2, button: 'none' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await canvasBox()).width).toBeGreaterThan(start.width);
      for (let index = 0; index < 30; index++) await mouse('mouseWheel', 450, 350, { deltaX: 0, deltaY: 120, modifiers: 2, button: 'none' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const zoomedOut = await canvasBox();
      expect(zoomedOut.width).toBeLessThanOrEqual(zoomedOut.view + 1);
      expect(zoomedOut.height).toBeLessThan(zoomedOut.viewHeight);
      expect(zoomedOut.left).toBeCloseTo((zoomedOut.view - zoomedOut.width) / 2, 0);
      expect(forwarded.filter((message) => message.type === 'wheel')).toHaveLength(0);
      // Ctrl+V pastes this device's clipboard as text, never the remote's.
      await mouse('mousePressed', 450, 300); await mouse('mouseReleased', 450, 300);
      const pasteShortcut = async () => {
        await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
      };
      // Reproduction SB-PASTE-2: with no text on this device's clipboard
      // (empty, or only an image) the shortcut sends nothing, so the remote
      // page cannot paste the remote machine's clipboard.
      await evaluate(`window.pastes = 0; document.addEventListener('paste', () => window.pastes++, true)`);
      await evaluate(`navigator.clipboard.writeText('')`);
      await pasteShortcut();
      await evaluate(`(async () => { const image = new OffscreenCanvas(2, 2); image.getContext('2d').fillRect(0, 0, 2, 2);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': await image.convertToBlob({ type: 'image/png' }) })]); })()`);
      expect(await evaluate<string>(`navigator.clipboard.read().then((items) => items.flatMap((item) => item.types).join())`)).toBe('image/png');
      await pasteShortcut();
      await until(async () => await evaluate<number>('window.pastes') === 2 ? true : undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(forwarded.filter((message) => message.type === 'key' || message.type === 'text')).toEqual([]);
      expect(await evaluate<string>('document.activeElement.id')).toBe('canvas');
      await evaluate(`navigator.clipboard.writeText('from the viewer clipboard')`);
      await pasteShortcut();
      await until(async () => forwarded.some((message) => message.type === 'text') ? true : undefined);
      expect(forwarded.filter((message) => message.type === 'text')).toEqual([{ type: 'text', text: 'from the viewer clipboard' }]);
      expect(forwarded.some((message) => message.type === 'key' && message.key === 'v')).toBe(false);
      // Focus returns to the page view, so other shortcuts still reach the remote.
      expect(await evaluate<string>('document.activeElement.id')).toBe('canvas');
      socket.close();
    } finally {
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGTERM');
        await new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      for (const client of streams.clients) client.close();
      await new Promise<void>((resolve) => streams.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
      await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
    }
  }, 120_000);

  it('locks the body viewer document so a native host cannot page-zoom it', () => {
    const html = computerViewerHtml('lock-id');
    expect(html).toContain('maximum-scale=1,user-scalable=no');
    expect(html).toContain('touch-action:none;overscroll-behavior:none');
  });

  it.skipIf(!existsSync(chromeBinary))('pinches, pans and maps a tap in the body-hosted viewer without forwarding the gesture', async () => {
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'body-pinch', upstreamUrl: 'body:', title: 'Body viewer',
    });
    const access = await computerViewToken(database, share.id, HUMAN);
    const source = new WebSocket(`${origin.replace('http:', 'ws:')}/s/${share.id}/source`);
    await opened(source);
    const forwarded: string[] = [];
    source.on('message', (data) => forwarded.push(data.toString()));
    source.send(JSON.stringify({ method: 'Page.screencastFrame',
      params: { data: '/9j/2Q==', sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } } }));
    const inputCounts: Record<string, number> = {};
    try {
      const gesture = await gestureViewer(`${origin}/s/${share.id}?access=${access}&embedded=1`, {
        pinch: [{ x: 150, y: 400 }, { x: 250, y: 400 }],
        remote: { width: 800, height: 600 },
        onPhase: (name) => { inputCounts[name] = forwarded.filter(isForwardedInput).length; },
      });
      expectViewerGesture(gesture, forwarded, inputCounts);
    } finally {
      source.close();
      await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
    }
  }, 120_000);

  it.skipIf(!existsSync(chromeBinary))('pinches, pans and maps a tap in the Squire bridge viewer without forwarding the gesture', async () => {
    const squire = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        html,body{margin:0;width:100%;height:100%}#screen{width:100vw;height:100vh}</style></head><body>
        <div id="bar"><button id="focus"></button></div>
        <div id="screen"><canvas id="canvas" width="800" height="600"></canvas></div>
        <script>const socket = new WebSocket(new URL("stream", location.href));
        function send(message){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));}
        function point(event){const canvas=document.getElementById('canvas');const r=canvas.getBoundingClientRect();
          const scale=r.width/canvas.width;return {x:(event.clientX-r.left)/scale,y:(event.clientY-r.top)/scale};}</script></body>`);
    });
    const streams = new WebSocketServer({ noServer: true });
    const forwarded: string[] = [];
    squire.on('upgrade', (request, socket, head) => streams.handleUpgrade(request, socket, head, (client) => streams.emit('connection', client, request)));
    streams.on('connection', (socket) => socket.on('message', (data) => forwarded.push(data.toString())));
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const share = await createComputerSession(database, live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'squire-pinch',
      upstreamUrl: `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/${'s'.repeat(43)}/`,
    }, testSquire);
    const access = await computerViewToken(database, share.id, HUMAN);
    const inputCounts: Record<string, number> = {};
    try {
      const gesture = await gestureViewer(`${origin}/s/${share.id}/?access=${access}&embedded=1`, {
        pinch: [{ x: 150, y: 250 }, { x: 250, y: 250 }],
        onPhase: (name) => { inputCounts[name] = forwarded.filter(isForwardedInput).length; },
      });
      expectViewerGesture(gesture, forwarded, inputCounts);
    } finally {
      for (const client of streams.clients) client.close();
      await new Promise<void>((resolve) => streams.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
      await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
    }
  }, 120_000);
});
