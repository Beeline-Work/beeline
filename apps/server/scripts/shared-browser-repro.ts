/**
 * Shared-browser viewer reproduction: serves a live Squire share through this
 * checkout's viewer proxy, embeds it the way the web app does (cross-origin
 * iframe), and drives headless Chrome through paste, copy, zoom and centering.
 *
 *   SQUIRE_SHARE_URL=https://….trycloudflare.com/s/<token>/ OUT=/tmp/out \
 *     npm run repro:shared-browser --prefix apps/server
 *
 * SCENARIO=desktop|phone|paste-without-text runs one part (default: desktop
 * and phone).
 */
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { migrate } from '../src/database.js';
import { PgliteDatabase } from '../src/test-support.js';
import { LiveHub } from '../src/live.js';
import { computerViewToken, createComputerSession, serveComputerSession, serveComputerStatus, upgradeComputerSession } from '../src/computer-session.js';

const HUMAN = 'a'.repeat(64), AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111119', ROOM = '22222222-2222-4222-8222-222222222229';
const share = process.env.SQUIRE_SHARE_URL!;
const out = process.env.OUT ?? join(tmpdir(), 'shared-browser-repro');
const allow = process.env.IFRAME_ALLOW ?? '';
const chromeBinary = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer() {
  const database = new PgliteDatabase();
  const live = new LiveHub();
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Human'),($2,'agent','Agent')`, [HUMAN, AGENT]);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','System')`, [SYSTEM_IDENTITY_ID]);
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Repro')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [ROOM, WORKSPACE]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, ROOM, AGENT]);
  await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, HUMAN]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [WORKSPACE, ROOM, HUMAN]);
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://beeline.local').pathname;
    const status = /^\/s\/([A-Za-z0-9_-]{43})\/status$/.exec(path)?.[1];
    if (status) { void serveComputerStatus(request, response, database, status); return; }
    const id = /^\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(path)?.[1];
    if (!id) { response.writeHead(404).end(); return; }
    void serveComputerSession(request, response, database, live, id);
  });
  server.on('upgrade', (request, socket, head) => {
    const match = /^\/s\/([A-Za-z0-9_-]{43})\/stream$/.exec(new URL(request.url ?? '/', 'http://beeline.local').pathname);
    if (!match) { socket.destroy(); return; }
    void upgradeComputerSession(request, socket, head, database, live, match[1]!);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const created = await createComputerSession(database, live, { roomId: ROOM, agentId: AGENT, sessionId: `repro-${Date.now()}`, upstreamUrl: share });
  const access = await computerViewToken(database, created.id, HUMAN);
  const viewer = `http://127.0.0.1:${port}/s/${created.id}/?access=${access}&embedded=1`;
  // The web app embeds the viewer from another origin on the same site.
  const host = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#000}</style>
      <iframe id="frame" src="${viewer}" ${allow ? `allow="${allow}"` : ''} style="width:100%;height:100%;border:0;display:block"></iframe>`);
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  return { hostUrl: `http://127.0.0.1:${(host.address() as AddressInfo).port}/`, close: () => { server.close(); host.close(); } };
}

async function launch(url: string) {
  const profile = await mkdtemp(join(tmpdir(), 'sb-repro-'));
  const chrome = spawn(chromeBinary, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-features=IsolateOrigins,site-per-process', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port = 0;
  for (let index = 0; index < 100 && !port; index++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await sleep(100); }
  }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const socket = new WebSocket(pages.find((page) => page.type === 'page')!.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.once('open', resolve));
  let serial = 0;
  const pending = new Map<number, (value: { result?: Record<string, unknown>; error?: unknown }) => void>();
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as { id?: number; method?: string; result?: Record<string, unknown>; error?: unknown };
    if (process.env.TRACE && message.method) console.error(`[event] ${message.method}`);
    if (message.id && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
  });
  const command = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++serial;
    if (process.env.TRACE) console.error(`[cdp] ${method}`);
    pending.set(id, (message) => message.error ? reject(new Error(`${method} ${JSON.stringify(message.error)}`)) : resolve(message.result ?? {}));
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
  return {
    command, url,
    async open(metrics: { width: number; height: number; mobile: boolean }) {
      await command('Emulation.setDeviceMetricsOverride', { width: metrics.width, height: metrics.height, deviceScaleFactor: metrics.mobile ? 2 : 1, mobile: metrics.mobile });
      if (metrics.mobile) {
        await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await command('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }] });
      }
      await command('Page.navigate', { url });
      await sleep(5_000);
    },
    async frameEval<T>(expression: string): Promise<T> {
      const tree = await command('Page.getFrameTree') as { frameTree: { childFrames?: { frame: { id: string } }[] } };
      const frameId = tree.frameTree.childFrames![0]!.frame.id;
      const world = await command('Page.createIsolatedWorld', { frameId, worldName: 'repro' }) as { executionContextId: number };
      const result = await command('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true }) as { result: { value: T } };
      return result.result.value;
    },
    async topEval<T>(expression: string): Promise<T> {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }) as { result: { value: T } };
      return result.result.value;
    },
    async shot(name: string) {
      console.error(`[repro] ${name}`);
      const { data } = await command('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile(join(out, `${name}.png`), Buffer.from(data, 'base64'));
    },
    async close() { socket.close(); chrome.kill('SIGTERM'); await sleep(300); await rm(profile, { recursive: true, force: true }); },
  };
}

const canvasBox = `(() => { const c = document.getElementById('canvas'), s = document.getElementById('screen');
  const r = c.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height),
  remoteWidth: c.width, remoteHeight: c.height, viewportWidth: s.clientWidth, viewportHeight: s.clientHeight }; })()`;
type Box = { left: number; top: number; width: number; height: number; remoteWidth: number; remoteHeight: number; viewportWidth: number; viewportHeight: number };
const centered = (box: Box) => Math.abs(box.left - (box.viewportWidth - box.width) / 2) <= 1;
const contained = (box: Box) => box.width <= box.viewportWidth + 1 && box.height <= box.viewportHeight + 1;

async function desktop(browser: Awaited<ReturnType<typeof launch>>) {
  const results: Record<string, unknown> = {};
  await browser.open({ width: 900, height: 700, mobile: false });
  const opened = await browser.frameEval<Box>(canvasBox);
  await browser.shot('desktop-1-open');
  results.center = { opened, centered: centered(opened) };
  const toRemote = (box: Box, x: number, y: number) => ({ x: box.left + x * box.width / box.remoteWidth, y: box.top + y * box.height / box.remoteHeight });
  const mouse = async (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    browser.command('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  // Trackpad pinch arrives as ctrl+wheel.
  const middle = { x: opened.left + Math.min(opened.width, opened.viewportWidth) / 2, y: 300 };
  for (let index = 0; index < 6; index++) await mouse('mouseWheel', middle.x, middle.y, { deltaX: 0, deltaY: -60, modifiers: 2, button: 'none' });
  await sleep(400);
  const zoomedIn = await browser.frameEval<Box>(canvasBox);
  for (let index = 0; index < 40; index++) await mouse('mouseWheel', middle.x, middle.y, { deltaX: 0, deltaY: 120, modifiers: 2, button: 'none' });
  await sleep(400);
  const zoomedOut = await browser.frameEval<Box>(canvasBox);
  await browser.shot('desktop-2-zoomed-out');
  results.zoom = { zoomedIn: zoomedIn.width, opened: opened.width, zoomedOut, zoomInWorks: zoomedIn.width > opened.width,
    reachesContain: contained(zoomedOut), centeredWhenOut: centered(zoomedOut) };
  // Paste: own clipboard text into the focused remote textarea.
  const box = zoomedOut;
  await browser.topEval(`navigator.clipboard.writeText('PASTE-4412')`);
  const field = toRemote(box, 300, 150);
  await mouse('mousePressed', field.x, field.y); await mouse('mouseReleased', field.x, field.y);
  await sleep(800);
  await browser.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
  await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
  await sleep(2_500);
  await browser.shot('desktop-3-after-paste');
  // Copy: double-click a word in the remote page, Ctrl+C, read our own clipboard.
  await browser.topEval(`navigator.clipboard.writeText('EMPTY')`);
  const word = toRemote(box, 110, 58);
  await mouse('mousePressed', word.x, word.y, { clickCount: 1 }); await mouse('mouseReleased', word.x, word.y, { clickCount: 1 });
  await mouse('mousePressed', word.x, word.y, { clickCount: 2 }); await mouse('mouseReleased', word.x, word.y, { clickCount: 2 });
  await sleep(1_200);
  await browser.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2, commands: ['copy'] });
  await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
  await sleep(2_500);
  results.copy = { localClipboard: await browser.topEval<string>(`navigator.clipboard.readText()`) };
  await browser.shot('desktop-4-after-copy');
  // Resize: the page re-centres after the frame changes size.
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 760, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const resized = await browser.frameEval<Box>(canvasBox);
  results.resize = { resized, centered: centered(resized) };
  return results;
}

// Ctrl+V with no text on this device's clipboard (empty, then an image only)
// must leave the remote field alone, never paste the remote clipboard.
async function pasteWithoutText(browser: Awaited<ReturnType<typeof launch>>) {
  await browser.open({ width: 900, height: 700, mobile: false });
  const box = await browser.frameEval<Box>(canvasBox);
  const x = box.left + 300 * box.width / box.remoteWidth, y = box.top + 150 * box.height / box.remoteHeight;
  await browser.command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await browser.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(800);
  const paste = async () => {
    await browser.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
    await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await sleep(2_500);
  };
  await browser.topEval(`navigator.clipboard.writeText('')`);
  await paste();
  await browser.shot('empty-1-after-empty-paste');
  const imageOnly = await browser.topEval<string>(`(async () => { const image = new OffscreenCanvas(2, 2); image.getContext('2d').fillRect(0, 0, 2, 2);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await image.convertToBlob({ type: 'image/png' }) })]);
    return (await navigator.clipboard.read()).flatMap((item) => item.types).join(); })()`);
  await paste();
  await browser.shot('empty-2-after-image-paste');
  return { localClipboardTypes: imageOnly };
}

async function phone(browser: Awaited<ReturnType<typeof launch>>) {
  const results: Record<string, unknown> = {};
  await browser.open({ width: 390, height: 800, mobile: true });
  const opened = await browser.frameEval<Box>(canvasBox);
  await browser.shot('phone-1-open');
  results.center = { opened, centered: centered(opened) };
  const touch = async (type: string, touchPoints: Record<string, number>[]) => {
    await browser.command('Input.dispatchTouchEvent', { type, touchPoints }); await sleep(30);
  };
  const pinch = async (step: number) => {
    const points = [{ x: 150, y: 400, id: 0 }, { x: 240, y: 400, id: 1 }];
    await touch('touchStart', points);
    for (let index = 1; index <= 8; index++)
      await touch('touchMove', points.map((point, position) => ({ ...point, x: point.x + (position === 0 ? -index * step : index * step) })));
    await touch('touchEnd', []); await sleep(300);
  };
  await pinch(10);
  const zoomedIn = await browser.frameEval<Box>(canvasBox);
  await browser.shot('phone-2-pinched-out');
  for (let index = 0; index < 4; index++) await pinch(-5);
  const zoomedOut = await browser.frameEval<Box>(canvasBox);
  await browser.shot('phone-3-pinched-in');
  results.pinch = { opened: opened.width, zoomedIn: zoomedIn.width, zoomedOut, zoomInWorks: zoomedIn.width > opened.width,
    zoomOutBelowOpen: zoomedOut.width < opened.width, reachesContain: contained(zoomedOut), centeredWhenOut: centered(zoomedOut) };
  // Paste from a phone: tap the remote field, then the viewer's paste button.
  await browser.topEval(`navigator.clipboard.writeText('PHONE-PASTE-58')`);
  const tap = async (x: number, y: number) => { await touch('touchStart', [{ x, y, id: 0 }]); await touch('touchEnd', []); await sleep(600); };
  await tap(zoomedOut.left + 300 * zoomedOut.width / zoomedOut.remoteWidth, zoomedOut.top + 150 * zoomedOut.height / zoomedOut.remoteHeight);
  const button = await browser.frameEval<{ x: number; y: number } | null>(`(() => { const b = document.getElementById('beeline-paste');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  results.pasteButton = Boolean(button);
  if (button) await tap(button.x, button.y);
  await sleep(2_000);
  await browser.shot('phone-5-after-paste-button');
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 800, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(800);
  const rotated = await browser.frameEval<Box>(canvasBox);
  await browser.shot('phone-4-rotated');
  results.rotate = { rotated, centered: centered(rotated) };
  results.scale = await browser.frameEval<number>('visualViewport.scale');
  return results;
}

await mkdir(out, { recursive: true });
const served = await startServer();
const browser = await launch(served.hostUrl);
try {
  const scenario = process.env.SCENARIO ?? 'both';
  const report: Record<string, unknown> = {};
  if (scenario === 'paste-without-text') report.pasteWithoutText = await pasteWithoutText(browser);
  else {
    if (scenario !== 'phone') report.desktop = await desktop(browser);
    if (scenario !== 'desktop') report.phone = await phone(browser);
  }
  console.log(JSON.stringify(report, null, 2));
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  served.close();
  process.exit(0);
}
