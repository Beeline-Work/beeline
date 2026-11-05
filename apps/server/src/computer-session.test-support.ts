import { claimAgentConnection } from './connection-presence.js';

import { createServer } from 'node:http';

import { createHmac, randomUUID } from 'node:crypto';

import { AddressInfo } from 'node:net';

import { spawn } from 'node:child_process';

import { existsSync } from 'node:fs';

import { mkdtemp, readFile, rm } from 'node:fs/promises';

import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WebSocket, WebSocketServer } from 'ws';

import { findChromiumPage, shareChromiumPage, waitForComputerHandback } from '../../body/src/browser-share.js';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { migrate } from './database.js';

import { PgliteDatabase } from './test-support.js';

import { LiveHub } from './live.js';

import { systemLine } from './system-line.js';

import { createAgentCommand, claimAgentCommand, readAgentCommands } from './agent-command.js';

import { DaemonService } from './daemon-service.js';


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


export const HUMAN = 'a'.repeat(64);

export const OTHER = 'c'.repeat(64);

export const AGENT = 'b'.repeat(64);

export const WORKSPACE = '11111111-1111-4111-8111-111111111119';

export const ROOM = '22222222-2222-4222-8222-222222222229';

/** Test Squire servers listen on loopback, which production shares reject. */
export const testSquire = (upstream: URL) => ['127.0.0.1', 'squire.test'].includes(upstream.hostname);


export function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
}

export function next(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once('message', (data) => resolve(data.toString())));
}

export function nextType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const listen = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === type) { socket.off('message', listen); resolve(message); }
    };
    socket.on('message', listen);
  });
}

export async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Computer session did not reach the expected state');
}
export type ViewerLayout = { fitted: boolean; zoom: number; minZoom: number; scale: number; width: number; height: number;
    left: number; top: number; viewWidth: number; viewHeight: number; remoteWidth: number; remoteHeight: number };
export function fixtureScope1() {

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

  let helperSource:{connectionId:string;epoch:number};


  beforeAll(async () => {
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Human'),($2,'agent','Agent'),($3,'human','Other')`, [HUMAN, AGENT, OTHER]);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','System')`, [SYSTEM_IDENTITY_ID]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('computer-helper',clock_timestamp())`);
    helperSource={connectionId:'computer-helper',epoch:await claimAgentConnection(database,live,AGENT,{}, {connectionId:'computer-helper',instanceId:'computer-helper'})};
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Computer')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, ROOM, AGENT]);
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, HUMAN]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [WORKSPACE, ROOM, HUMAN]);
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [WORKSPACE, OTHER]);
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [WORKSPACE, AGENT]);
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

  beforeEach(async()=>{await database.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp() WHERE instance_id='computer-helper'`);});

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  });


  const chromeBinary = process.env.CHROME_BIN || '/usr/bin/google-chrome';


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

  const viewerLayoutMath = new Function(`${VIEWER_LAYOUT_SCRIPT}; return { viewerLayout, viewerZoomAt };`)() as {
    viewerLayout: (state: Partial<ViewerLayout>, viewWidth: number, viewHeight: number, remoteWidth: number, remoteHeight: number) => ViewerLayout;
    viewerZoomAt: (state: ViewerLayout, zoom: number, x: number, y: number) => ViewerLayout;
  };
return {
database,
live,
phone,
server,
get origin(){return origin;}, set origin(value: typeof origin){origin=value;},
get helperSource(){return helperSource;}, set helperSource(value: typeof helperSource){helperSource=value;},
chromeBinary,
gestureViewer,
isForwardedInput,
forwardedTapPoint,
expectViewerGesture,
viewerLayoutMath,
};
}
export { claimAgentConnection } from './connection-presence.js';
export { createServer } from 'node:http';
export { createHmac, randomUUID } from 'node:crypto';
export { AddressInfo } from 'node:net';
export { spawn } from 'node:child_process';
export { existsSync } from 'node:fs';
export { mkdtemp, readFile, rm } from 'node:fs/promises';
export { join } from 'node:path';
export { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
export { WebSocket, WebSocketServer } from 'ws';
export { findChromiumPage, shareChromiumPage, waitForComputerHandback } from '../../body/src/browser-share.js';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { migrate } from './database.js';
export { PgliteDatabase } from './test-support.js';
export { LiveHub } from './live.js';
export { systemLine, backfillComputerObservations } from './system-line.js';
export { createAgentCommand, claimAgentCommand, readAgentCommands } from './agent-command.js';
export { DaemonService } from './daemon-service.js';
export { PhoneService } from './phone-service.js';
export { createBeelineServer } from './server.js';
export { readRoomViewMessage } from '@beeline/api-contract/phone';
export { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';
export { assembleTurnPrompt } from '../../body/src/prompt-assembly.js';
export { VIEWER_LAYOUT_SCRIPT, computerViewToken, computerViewerHtml, createComputerSession, endComputerSession, expireComputerSessions, getComputerSession, refreshComputerSession, serveComputerSession, serveComputerStatus, startComputerExpirySweep, trustedComputerShareUpstream, upgradeBodyComputerSource, upgradeComputerSession, upgradeComputerWaiter } from './computer-session.js';
export type { TokenAuth } from './auth.js';
export type { DaemonApiClient } from '../../body/src/daemon-api-client.js';
